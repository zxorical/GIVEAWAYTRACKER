// src/autojoin/AutoJoinService.ts
/**
 * @module autoJoinService
 * Complete autojoin system for premium users
 * 
 * Handles:
 * - Token storage & retrieval (encrypted)
 * - Session management per user
 * - Auto-entry on giveaway detection
 * - Win detection & notifications (clean webhook only)
 * - Rate limiting & retries
 * - Stats tracking
 */

import { Client, Message } from 'discord.js-selfbot-v13';
import { EventEmitter } from 'events';
import { logger } from '../logger.js';
import {
  getAllPremiumUsers,
  getUserToken,
  incrementTokenEntries,
  incrementTokenWins,
  updateTokenLastUsed,
  getUserWebhook,
  isPremiumUser,
  setTokenActive,
} from '../database.js';
import { decryptToken } from '../premium/tokenManager.js';
import { delay, formatError, truncate } from '../utils.js';

// ─── CONSTANTS ──────────────────────────────────────────────────────

const MAX_CONCURRENT_ENTRIES = 5;
const ENTRY_RETRY_ATTEMPTS = 3;
const ENTRY_RETRY_DELAY_MS = 1000;
const RATE_LIMIT_PER_USER_MS = 2000;
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const WIN_DEDUP_TTL_MS = 30 * 60 * 1000;

const WIN_PATTERNS: ReadonlyArray<RegExp> = [
  /congratulations?[^.!?\n]{0,60}(?:you|won)/i,
  /you(?:'ve|\s+have)\s+won/i,
  /you\s+won\s/i,
  /you\s+are\s+(?:a\s+)?(?:the\s+)?winner/i,
  /\bwinner[s]?\b/i,
  /has\s+won\s+(?:the\s+)?giveaway/i,
  /won\s+the\s+giveaway/i,
  /won\s+(?:a\s+)?(?:the\s+)?(?:prize|raffle|giveaway)/i,
];

// ─── INTERFACES ────────────────────────────────────────────────────

interface GiveawayToEnter {
  messageId: string;
  channelId: string;
  guildId: string;
  guildName: string;
  channelName: string;
  prize: string;
  buttonCustomId: string;
  detectedAt: number;
}

interface UserSession {
  client: Client;
  userId: string;
  guildId: string;
  token: string;
  lastUsed: number;
  entries: number;
  wins: number;
}

interface AutoJoinStats {
  totalDetected: number;
  totalAttempted: number;
  totalSuccess: number;
  totalFailed: number;
  totalSkipped: number;
  totalWins: number;
  activeSessions: number;
  startedAt: number;
}

interface ButtonComponent {
  type: number;
  customId?: string;
  custom_id?: string;
  label?: string;
  style?: number;
  disabled?: boolean;
}

// ─── AUTOJOIN SERVICE ─────────────────────────────────────────────

export class AutoJoinService extends EventEmitter {
  private sessions = new Map<string, UserSession>();
  private processing = new Set<string>();
  private rateLimits = new Map<string, number>();
  private recentWins = new Map<string, number>();
  
  private stats: AutoJoinStats = {
    totalDetected: 0,
    totalAttempted: 0,
    totalSuccess: 0,
    totalFailed: 0,
    totalSkipped: 0,
    totalWins: 0,
    activeSessions: 0,
    startedAt: Date.now(),
  };

  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    super();
    this.startCleanup();
    console.log('🔥 [AUTOJOIN] AutoJoinService initialized');
  }

  // ─── PUBLIC API ──────────────────────────────────────────────────

  async handleGiveawayDetected(data: GiveawayToEnter): Promise<void> {
    console.log(`🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥`);
    console.log(`🔥 [AUTOJOIN] 🎯 GIVEAWAY DETECTED!`);
    console.log(`🔥 [AUTOJOIN] Message: ${data.messageId}`);
    console.log(`🔥 [AUTOJOIN] Channel: ${data.channelId}`);
    console.log(`🔥 [AUTOJOIN] Guild: ${data.guildId}`);
    console.log(`🔥 [AUTOJOIN] Prize: ${data.prize?.slice(0, 50)}`);
    console.log(`🔥 [AUTOJOIN] Button: ${data.buttonCustomId}`);
    console.log(`🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥`);

    const { messageId, channelId, guildId, buttonCustomId, prize } = data;

    if (!buttonCustomId) {
      console.log('🔥 [AUTOJOIN] ❌ No buttonCustomId, skipping');
      logger.debug('No button customId, skipping autojoin', { messageId });
      return;
    }

    const dedupKey = `${channelId}:${messageId}`;
    if (this.processing.has(dedupKey)) {
      console.log('🔥 [AUTOJOIN] ⏭️ Already processing:', dedupKey);
      return;
    }
    this.processing.add(dedupKey);

    try {
      this.stats.totalDetected++;

      // ✅ Get ALL premium users with tokens (GLOBAL - not guild-specific)
      const allPremiumUsers = await getAllPremiumUsers();
      const premiumUsers = allPremiumUsers.filter(u => u.token && u.isPremium && u.tokenActive !== false);
      
      console.log('🔥 [AUTOJOIN] Found ALL premium users with tokens:', {
        total: premiumUsers.length,
        users: premiumUsers.map(u => ({
          userId: u.userId,
          guildId: u.guildId,
          hasToken: !!u.token,
          tokenEntries: u.tokenEntries,
          tokenActive: u.tokenActive,
        })),
      });

      if (premiumUsers.length === 0) {
        console.log('🔥 [AUTOJOIN] ❌ No premium users found with tokens');
        logger.info('No premium users with tokens found', { component: 'AutoJoinService' });
        return;
      }

      logger.info(`Auto-joining ${premiumUsers.length} premium users for "${truncate(prize, 50)}"`, {
        component: 'AutoJoinService',
        guildId,
      });

      const results = await this.processUsersConcurrently(
        premiumUsers,
        data,
        MAX_CONCURRENT_ENTRIES
      );

      const successCount = results.filter(r => r.success).length;
      console.log(`🔥 [AUTOJOIN] Complete: ${successCount}/${premiumUsers.length} users`);
      logger.debug(`Autojoin complete: ${successCount}/${premiumUsers.length} users`, {
        component: 'AutoJoinService',
        messageId,
        prize: truncate(prize, 50),
      });

    } finally {
      this.processing.delete(dedupKey);
    }
  }

  async handleWin(
    userId: string,
    guildId: string,
    message: Message,
    prize?: string,
  ): Promise<boolean> {
    const isPremium = await isPremiumUser(userId, guildId);
    if (!isPremium) return false;

    const dedupKey = `${message.channel.id}:${message.author?.id || 'unknown'}`;
    const lastWin = this.recentWins.get(dedupKey);
    if (lastWin && Date.now() - lastWin < WIN_DEDUP_TTL_MS) {
      logger.debug('Win dedup — suppressing duplicate', {
        component: 'AutoJoinService',
        userId,
        dedupKey,
      });
      return false;
    }
    this.recentWins.set(dedupKey, Date.now());

    const prizeText = prize || this.extractPrize(message);

    await incrementTokenWins(userId, guildId);
    this.stats.totalWins++;

    const sessionKey = `${userId}:${guildId}`;
    const session = this.sessions.get(sessionKey);
    if (session) session.wins++;

    logger.info('WIN DETECTED for premium user', {
      component: 'AutoJoinService',
      userId,
      guildId,
      prize: truncate(prizeText, 50),
      guildName: message.guild?.name || 'DM',
    });

    await this.sendWinWebhook(userId, guildId, message, prizeText);

    this.emit('winDetected', {
      userId,
      guildId,
      prize: prizeText,
      messageId: message.id,
      channelId: message.channel.id,
      guildName: message.guild?.name || 'DM',
      channelName: (message.channel as any).name || 'DM',
    });

    return true;
  }

  async checkGuildWin(message: Message): Promise<boolean> {
    if (!message.guild || !message.author?.bot) return false;

    const premiumUsers = await getAllPremiumUsers(message.guild.id);
    if (premiumUsers.length === 0) return false;

    const allText = this.extractAllText(message);
    if (!WIN_PATTERNS.some(re => re.test(allText))) return false;

    let detected = false;
    for (const user of premiumUsers) {
      const userId = user.userId;
      const mentioned = message.mentions?.users?.has(userId) ?? false;
      const contentMention = message.content?.includes(userId) ?? false;

      if (mentioned || contentMention) {
        const prize = this.extractPrize(message);
        await this.handleWin(userId, message.guild.id, message, prize);
        detected = true;
      }
    }

    return detected;
  }

  async checkDmWin(message: Message): Promise<boolean> {
    if (message.guild) return false;

    const allText = this.extractAllText(message);
    if (!WIN_PATTERNS.some(re => re.test(allText))) return false;

    const guilds = await this.getActiveGuilds();
    let detected = false;

    for (const guildId of guilds) {
      const premiumUsers = await getAllPremiumUsers(guildId);
      for (const user of premiumUsers) {
        if (message.author?.bot) {
          const prize = this.extractPrize(message);
          await this.handleWin(user.userId, guildId, message, prize);
          detected = true;
        }
      }
    }

    return detected;
  }

  getStats(): AutoJoinStats {
    return { ...this.stats };
  }

  getActiveSessions(): number {
    return this.sessions.size;
  }

  async shutdown(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    for (const [key, session] of this.sessions) {
      try {
        await session.client.destroy();
      } catch {}
      this.sessions.delete(key);
    }

    this.stats.activeSessions = 0;
    logger.info('AutoJoinService shutdown', { component: 'AutoJoinService' });
  }

  // ─── PRIVATE METHODS ─────────────────────────────────────────────

  private async processUsersConcurrently(
    users: Array<{ userId: string; guildId: string }>,
    data: GiveawayToEnter,
    concurrency: number,
  ): Promise<Array<{ userId: string; success: boolean }>> {
    const results: Array<{ userId: string; success: boolean }> = [];
    const chunks: Array<Array<{ userId: string; guildId: string }>> = [];

    for (let i = 0; i < users.length; i += concurrency) {
      chunks.push(users.slice(i, i + concurrency));
    }

    for (const chunk of chunks) {
      const chunkResults = await Promise.allSettled(
        chunk.map(async (user) => {
          const success = await this.enterGiveawayForUser(
            user.userId,
            user.guildId,
            data.messageId,
            data.channelId,
            data.buttonCustomId,
            data.prize,
            data.guildName,
            data.channelName,
          );

          return { userId: user.userId, success };
        })
      );

      for (const result of chunkResults) {
        if (result.status === 'fulfilled') {
          results.push(result.value);
        } else {
          const userId = (result as any).reason?.userId || 'unknown';
          results.push({ userId, success: false });
          this.stats.totalFailed++;
        }
      }

      if (chunks.indexOf(chunk) < chunks.length - 1) {
        await delay(500);
      }
    }

    return results;
  }

  private async enterGiveawayForUser(
    userId: string,
    guildId: string,
    messageId: string,
    channelId: string,
    buttonCustomId: string,
    prize: string,
    guildName: string,
    channelName: string,
  ): Promise<boolean> {
    console.log(`🔥 [AUTOJOIN] enterGiveawayForUser:`, {
      userId,
      guildId,
      messageId,
      buttonCustomId,
      prize: prize?.slice(0, 50),
    });

    this.stats.totalAttempted++;

    const hasPremium = await isPremiumUser(userId, guildId);
    console.log(`🔥 [AUTOJOIN] Premium check:`, { userId, guildId, hasPremium });
    
    if (!hasPremium) {
      this.stats.totalSkipped++;
      console.log(`🔥 [AUTOJOIN] ❌ User not premium, skipping`);
      return false;
    }

    const lastEntry = this.rateLimits.get(userId) || 0;
    const timeSince = Date.now() - lastEntry;
    if (timeSince < RATE_LIMIT_PER_USER_MS) {
      await delay(RATE_LIMIT_PER_USER_MS - timeSince);
    }
    this.rateLimits.set(userId, Date.now());

    const tokenData = await getUserToken(userId, guildId);
    console.log(`🔥 [AUTOJOIN] Token data:`, {
      userId,
      guildId,
      hasToken: !!tokenData.token,
      tokenLabel: tokenData.label,
      tokenPreview: tokenData.token ? tokenData.token.substring(0, 20) + '...' : null,
    });

    if (!tokenData.token) {
      console.log(`🔥 [AUTOJOIN] ❌ No token found for user`);
      this.stats.totalSkipped++;
      return false;
    }

    let token: string;
    try {
      token = decryptToken(tokenData.token);
      console.log(`🔥 [AUTOJOIN] ✅ Token decrypted successfully, length: ${token.length}`);
    } catch (err) {
      console.log(`🔥 [AUTOJOIN] ❌ Failed to decrypt token:`, err);
      logger.error(`Failed to decrypt token for user ${userId}`, { 
        error: formatError(err) 
      });
      this.stats.totalFailed++;
      return false;
    }

    const sessionKey = `${userId}:${guildId}`;
    let session = this.sessions.get(sessionKey);

    if (!session) {
      console.log(`🔥 [AUTOJOIN] Creating new session for user ${userId}`);
      try {
        const client = await this.createSession(userId, guildId, token);
        session = {
          client,
          userId,
          guildId,
          token,
          lastUsed: Date.now(),
          entries: 0,
          wins: 0,
        };
        this.sessions.set(sessionKey, session);
        this.stats.activeSessions = this.sessions.size;
        console.log(`🔥 [AUTOJOIN] ✅ Session created, total: ${this.sessions.size}`);
      } catch (err) {
        console.log(`🔥 [AUTOJOIN] ❌ Failed to create session:`, err);
        logger.error(`Failed to create session for user ${userId}`, {
          error: formatError(err),
        });
        this.stats.totalFailed++;
        return false;
      }
    }

    session.lastUsed = Date.now();
    session.entries++;

    let lastError: string | null = null;
    for (let attempt = 1; attempt <= ENTRY_RETRY_ATTEMPTS; attempt++) {
      try {
        console.log(`🔥 [AUTOJOIN] Attempt ${attempt}/${ENTRY_RETRY_ATTEMPTS} for ${userId}`);
        console.log(`🔥 [AUTOJOIN] Clicking button:`, {
          channelId,
          messageId,
          buttonCustomId,
          attempt,
        });
        
        await this.clickButton(session.client, channelId, messageId, buttonCustomId);
        
        console.log(`🔥 [AUTOJOIN] ✅ Button click succeeded on attempt ${attempt}`);
        
        await incrementTokenEntries(userId, guildId);
        await updateTokenLastUsed(userId, guildId);
        this.stats.totalSuccess++;
        session.entries++;

        logger.debug(`Autojoined for user ${userId}`, {
          component: 'AutoJoinService',
          prize: truncate(prize, 50),
          attempt,
        });

        return true;
      } catch (err) {
        lastError = formatError(err);
        console.log(`🔥 [AUTOJOIN] ❌ Attempt ${attempt} failed:`, lastError);
        
        if (lastError.includes('401') || lastError.includes('403')) {
          console.log(`🔥 [AUTOJOIN] ❌ Invalid token for user ${userId}, removing session`);
          this.sessions.delete(sessionKey);
          this.stats.activeSessions = this.sessions.size;
          try { session.client.destroy(); } catch {}
          await setTokenActive(userId, guildId, false);
          this.stats.totalFailed++;
          return false;
        }

        if (attempt < ENTRY_RETRY_ATTEMPTS) {
          const waitMs = ENTRY_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
          console.log(`🔥 [AUTOJOIN] Retrying in ${waitMs}ms...`);
          await delay(waitMs);
        }
      }
    }

    console.log(`🔥 [AUTOJOIN] ❌ All retries exhausted for user ${userId}`);
    this.stats.totalFailed++;
    logger.warn(`All retries exhausted for user ${userId}`, {
      component: 'AutoJoinService',
      error: lastError,
      prize: truncate(prize, 50),
    });

    return false;
  }

  private async createSession(
    userId: string,
    guildId: string,
    token: string,
  ): Promise<Client> {
    console.log(`🔥 [AUTOJOIN] 🚀 CREATING SESSION FOR ${userId}...`);
    console.log(`🔥 [AUTOJOIN] Token starts with: ${token.substring(0, 20)}...`);
    
    const client = new Client();

    client.once('ready', () => {
      console.log(`🔥 [AUTOJOIN] ✅ Session created for user: ${client.user?.username} (${client.user?.id})`);
      console.log(`🔥 [AUTOJOIN] This client is using token: ${token.substring(0, 20)}...`);
    });

    client.on('debug', (info) => {
      console.log(`🔥 [AUTOJOIN] [${userId}] Debug:`, info.slice(0, 100));
    });

    client.on('error', (err) => {
      console.log(`🔥 [AUTOJOIN] [${userId}] ❌ Client error:`, err);
    });

    client.on('disconnect', () => {
      console.log(`🔥 [AUTOJOIN] [${userId}] ⚠️ Disconnected`);
    });

    client.on('messageCreate', async (message: Message) => {
      if (message.author?.id === client.user?.id) return;
      if (message.guild) {
        await this.checkGuildWin(message);
      } else {
        await this.checkDmWin(message);
      }
    });

    console.log(`🔥 [AUTOJOIN] [${userId}] Calling client.login()...`);
    
    try {
      await client.login(token);
      console.log(`🔥 [AUTOJOIN] [${userId}] ✅ client.login() resolved`);
    } catch (err) {
      console.log(`🔥 [AUTOJOIN] [${userId}] ❌ client.login() failed:`, err);
      throw err;
    }

    console.log(`🔥 [AUTOJOIN] [${userId}] Waiting for client to be ready...`);
    
    let readyResolved = false;

    if (client.isReady()) {
      console.log(`🔥 [AUTOJOIN] [${userId}] ✅ Client is already ready!`);
      readyResolved = true;
    }

    if (!readyResolved) {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          console.log(`🔥 [AUTOJOIN] [${userId}] ⚠️ Ready timeout!`);
          if (client.isReady()) {
            console.log(`🔥 [AUTOJOIN] [${userId}] ✅ Client is ready despite timeout`);
            resolve();
          } else {
            console.log(`🔥 [AUTOJOIN] [${userId}] ❌ Client NOT ready after timeout`);
            reject(new Error(`Client ${userId} did not become ready after 15s`));
          }
        }, 15000);

        client.once('ready', () => {
          console.log(`🔥 [AUTOJOIN] [${userId}] ✅ Client ready event received!`);
          clearTimeout(timeout);
          resolve();
        });

        client.once('error', (err) => {
          console.log(`🔥 [AUTOJOIN] [${userId}] ❌ Client error during ready wait:`, err);
          clearTimeout(timeout);
          reject(err);
        });
      });
    }

    if (!client.isReady()) {
      console.log(`🔥 [AUTOJOIN] [${userId}] ⚠️ Client not ready, waiting 2 more seconds...`);
      await delay(2000);
    }

    console.log(`🔥 [AUTOJOIN] [${userId}] ✅✅✅ SESSION FULLY ESTABLISHED!`, {
      username: client.user?.username,
      userId: client.user?.id,
      guildCount: client.guilds.cache.size,
      isReady: client.isReady(),
    });

    return client;
  }

  // ─── BUTTON CLICKING - USING SELFBOBOT NATIVE METHODS ────────────

  private async clickButton(
    client: Client,
    channelId: string,
    messageId: string,
    buttonCustomId: string,
  ): Promise<void> {
    console.log(`🔥 [AUTOJOIN] clickButton called:`, {
      channelId,
      messageId,
      buttonCustomId,
      clientUserId: client.user?.id,
      clientUsername: client.user?.username,
      isReady: client.isReady(),
    });

    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !('messages' in channel)) {
        throw new Error('Channel not found or not text-based');
      }

      const message = await channel.messages.fetch(messageId);
      if (!message) {
        throw new Error('Message not found');
      }

      console.log(`🔥 [AUTOJOIN] Message fetched:`, {
        id: message.id,
        author: message.author?.username,
        hasComponents: !!(message as any).components?.length,
      });

      const components = (message as any).components || [];
      let targetComponent: ButtonComponent | null = null;
      
      for (const row of components) {
        for (const comp of row.components || []) {
          if (comp.type === 2) {
            const id = comp.customId || comp.custom_id;
            if (id === buttonCustomId) {
              targetComponent = comp as ButtonComponent;
              break;
            }
          }
        }
        if (targetComponent) break;
      }

      if (!targetComponent) {
        console.log(`🔥 [AUTOJOIN] Button ${buttonCustomId} not found, looking for any entry button...`);
        for (const row of components) {
          for (const comp of row.components || []) {
            if (comp.type === 2 && !comp.disabled) {
              const label = (comp.label || '').toLowerCase();
              if (
                label.includes('enter') ||
                label.includes('join') ||
                label.includes('participate') ||
                label.includes('🎉') ||
                label.includes('🎁') ||
                /^\d[\d,]*$/.test(label)
              ) {
                targetComponent = comp as ButtonComponent;
                console.log(`🔥 [AUTOJOIN] Found fallback entry button:`, {
                  customId: comp.customId || comp.custom_id,
                  label: comp.label,
                });
                break;
              }
            }
          }
          if (targetComponent) break;
        }
      }

      if (!targetComponent) {
        console.log(`🔥 [AUTOJOIN] No button component found`);
        throw new Error(`Button ${buttonCustomId} not found`);
      }

      const foundCustomId = targetComponent.customId || targetComponent.custom_id || 'unknown';
      console.log(`🔥 [AUTOJOIN] Found button:`, {
        customId: foundCustomId,
        label: targetComponent.label,
        style: targetComponent.style,
        disabled: targetComponent.disabled,
      });

      if (typeof (message as any).clickButton === 'function') {
        console.log(`🔥 [AUTOJOIN] Using selfbot clickButton method`);
        
        try {
          await (message as any).clickButton(targetComponent);
          console.log(`🔥 [AUTOJOIN] ✅ Selfbot clickButton succeeded (with component)`);
          return;
        } catch (err) {
          console.log(`🔥 [AUTOJOIN] clickButton with component failed:`, formatError(err));
          
          try {
            const id = targetComponent.customId || targetComponent.custom_id || buttonCustomId;
            await (message as any).clickButton(id);
            console.log(`🔥 [AUTOJOIN] ✅ Selfbot clickButton succeeded (with customId)`);
            return;
          } catch (err2) {
            console.log(`🔥 [AUTOJOIN] clickButton with customId failed:`, formatError(err2));
          }
        }
      }

      if (typeof (message as any).click === 'function') {
        console.log(`🔥 [AUTOJOIN] Using fallback click method`);
        try {
          await (message as any).click(targetComponent);
          console.log(`🔥 [AUTOJOIN] ✅ Fallback click succeeded`);
          return;
        } catch (err) {
          console.log(`🔥 [AUTOJOIN] Fallback click failed:`, formatError(err));
        }
      }

      if (typeof (message as any).clickButton === 'function') {
        try {
          await (message as any).clickButton(buttonCustomId);
          console.log(`🔥 [AUTOJOIN] ✅ Selfbot clickButton succeeded (direct customId)`);
          return;
        } catch (err) {
          console.log(`🔥 [AUTOJOIN] clickButton direct customId failed:`, formatError(err));
        }
      }

      throw new Error('Could not click button - no click method available');

    } catch (err) {
      console.log(`🔥 [AUTOJOIN] ❌ clickButton error:`, formatError(err));
      throw err;
    }
  }

  // ─── WEBHOOK & UTILITY METHODS ────────────────────────────────

  private async sendWinWebhook(
    userId: string,
    guildId: string,
    message: Message,
    prize: string,
  ): Promise<void> {
    const webhookUrl = await getUserWebhook(userId, guildId);
    if (!webhookUrl) return;

    const winMessage = this.extractAllText(message);
    const jumpUrl = message.guild
      ? `https://discord.com/channels/${message.guild.id}/${message.channel.id}/${message.id}`
      : null;
    const serverName = message.guild?.name || 'Direct Message';
    const channelName = (message.channel as any).name || 'DM';

    try {
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          embeds: [{
            title: 'GIVEAWAY WON',
            color: 0xFFD700,
            fields: [
              { name: 'Prize', value: truncate(prize, 200), inline: false },
              { name: 'Server', value: serverName, inline: true },
              { name: 'Channel', value: `#${channelName}`, inline: true },
              { name: 'Win Message', value: truncate(winMessage, 1000), inline: false },
              ...(jumpUrl ? [{ name: 'Link', value: `[View](${jumpUrl})`, inline: false }] : []),
            ],
            timestamp: new Date().toISOString(),
          }],
        }),
      });
    } catch (err) {
      logger.debug('Failed to send win webhook', { error: formatError(err) });
    }
  }

  private extractPrize(message: Message): string {
    const embed = message.embeds?.[0];
    if (embed?.title) return embed.title;
    if (embed?.description) return embed.description;
    return message.content || 'Unknown Prize';
  }

  private extractAllText(message: Message): string {
    return [
      message.content || '',
      ...(message.embeds || []).flatMap((e: any) => [
        e.title || '',
        e.description || '',
        e.footer?.text || '',
        ...(e.fields || []).flatMap((f: any) => [f.name, f.value]),
      ]),
    ].join(' ');
  }

  private async getActiveGuilds(): Promise<string[]> {
    const guilds = new Set<string>();
    for (const [key] of this.sessions) {
      const [, guildId] = key.split(':');
      guilds.add(guildId);
    }
    return Array.from(guilds);
  }

  // ─── CLEANUP ──────────────────────────────────────────────────────

  private startCleanup(): void {
    this.cleanupInterval = setInterval(() => {
      this.cleanupSessions();
      this.cleanupRateLimits();
      this.cleanupWinDedup();
    }, 60_000);
    this.cleanupInterval.unref();
  }

  private cleanupSessions(): void {
    const now = Date.now();
    let removed = 0;

    for (const [key, session] of this.sessions) {
      if (now - session.lastUsed > SESSION_TIMEOUT_MS) {
        try {
          session.client.destroy();
        } catch {}
        this.sessions.delete(key);
        removed++;
      }
    }

    if (removed > 0) {
      this.stats.activeSessions = this.sessions.size;
      logger.debug(`Cleaned up ${removed} idle sessions`, {
        component: 'AutoJoinService',
      });
    }
  }

  private cleanupRateLimits(): void {
    const now = Date.now();
    for (const [key, lastEntry] of this.rateLimits) {
      if (now - lastEntry > RATE_LIMIT_PER_USER_MS * 10) {
        this.rateLimits.delete(key);
      }
    }
  }

  private cleanupWinDedup(): void {
    const now = Date.now();
    for (const [key, timestamp] of this.recentWins) {
      if (now - timestamp > WIN_DEDUP_TTL_MS) {
        this.recentWins.delete(key);
      }
    }
  }
}
