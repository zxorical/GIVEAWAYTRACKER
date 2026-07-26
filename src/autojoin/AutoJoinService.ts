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
  }

  // ─── PUBLIC API ──────────────────────────────────────────────────

  async handleGiveawayDetected(data: GiveawayToEnter): Promise<void> {
    const { messageId, channelId, guildId, buttonCustomId, prize } = data;

    console.log('[DEBUG] AutoJoinService.handleGiveawayDetected called:', {
      messageId,
      guildId,
      buttonCustomId,
      prize: prize?.slice(0, 50),
    });

    if (!buttonCustomId) {
      console.log('[DEBUG] ❌ No buttonCustomId, skipping autojoin');
      logger.debug('No button customId, skipping autojoin', { messageId });
      return;
    }

    const dedupKey = `${channelId}:${messageId}`;
    if (this.processing.has(dedupKey)) {
      console.log('[DEBUG] ⏭️ Already processing this giveaway:', dedupKey);
      return;
    }
    this.processing.add(dedupKey);

    try {
      this.stats.totalDetected++;

      const premiumUsers = await getAllPremiumUsers(guildId);
      console.log('[DEBUG] Found premium users:', {
        guildId,
        count: premiumUsers.length,
        users: premiumUsers.map(u => ({
          userId: u.userId,
          isPremium: u.isPremium,
          hasToken: !!u.token,
          tokenEntries: u.tokenEntries,
        })),
      });

      if (premiumUsers.length === 0) {
        console.log('[DEBUG] ❌ No premium users found for guild:', guildId);
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
    console.log('[DEBUG] 🔄 enterGiveawayForUser called:', {
      userId,
      guildId,
      messageId,
      buttonCustomId,
      prize: prize?.slice(0, 50),
    });

    this.stats.totalAttempted++;

    const hasPremium = await isPremiumUser(userId, guildId);
    console.log('[DEBUG] Premium check:', { userId, guildId, hasPremium });
    
    if (!hasPremium) {
      this.stats.totalSkipped++;
      console.log('[DEBUG] ❌ User is not premium, skipping');
      return false;
    }

    const lastEntry = this.rateLimits.get(userId) || 0;
    const timeSince = Date.now() - lastEntry;
    if (timeSince < RATE_LIMIT_PER_USER_MS) {
      await delay(RATE_LIMIT_PER_USER_MS - timeSince);
    }
    this.rateLimits.set(userId, Date.now());

    const tokenData = await getUserToken(userId, guildId);
    console.log('[DEBUG] Token data:', {
      userId,
      guildId,
      hasToken: !!tokenData.token,
      tokenLabel: tokenData.label,
      tokenPreview: tokenData.token ? tokenData.token.substring(0, 20) + '...' : null,
    });

    if (!tokenData.token) {
      console.log('[DEBUG] ❌ No token found for user:', userId);
      logger.debug(`No token for user ${userId}`);
      this.stats.totalSkipped++;
      return false;
    }

    let token: string;
    try {
      token = decryptToken(tokenData.token);
      console.log('[DEBUG] ✅ Token decrypted successfully, length:', token.length);
    } catch (err) {
      console.log('[DEBUG] ❌ Failed to decrypt token:', err);
      logger.error(`Failed to decrypt token for user ${userId}`, { 
        error: formatError(err) 
      });
      this.stats.totalFailed++;
      return false;
    }

    const sessionKey = `${userId}:${guildId}`;
    let session = this.sessions.get(sessionKey);

    if (!session) {
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
      } catch (err) {
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
        console.log(`[DEBUG] Attempt ${attempt}/${ENTRY_RETRY_ATTEMPTS} for user ${userId}`);
        
        // Try the specific button first
        await this.clickButton(session.client, channelId, messageId, buttonCustomId);
        
        // Success!
        await incrementTokenEntries(userId, guildId);
        await updateTokenLastUsed(userId, guildId);
        this.stats.totalSuccess++;
        session.entries++;

        console.log(`[DEBUG] ✅ Autojoined for user ${userId} on attempt ${attempt}`);
        logger.debug(`Autojoined for user ${userId}`, {
          component: 'AutoJoinService',
          prize: truncate(prize, 50),
          attempt,
        });

        return true;
      } catch (err) {
        lastError = formatError(err);
        console.log(`[DEBUG] ❌ Attempt ${attempt} failed for user ${userId}:`, lastError);
        
        // If the specific button fails, try ANY button on the last attempt
        if (attempt === ENTRY_RETRY_ATTEMPTS) {
          console.log('[DEBUG] Specific button failed, trying any entry button as fallback...');
          try {
            await this.clickAnyButton(session.client, channelId, messageId);
            
            // Success with fallback!
            await incrementTokenEntries(userId, guildId);
            await updateTokenLastUsed(userId, guildId);
            this.stats.totalSuccess++;
            session.entries++;

            console.log(`[DEBUG] ✅ Autojoined for user ${userId} via fallback`);
            logger.debug(`Autojoined for user ${userId} (fallback)`, {
              component: 'AutoJoinService',
              prize: truncate(prize, 50),
              attempt,
            });

            return true;
          } catch (fallbackErr) {
            lastError = formatError(fallbackErr);
            console.log('[DEBUG] ❌ Fallback button also failed:', lastError);
          }
        }
        
        if (lastError.includes('401') || lastError.includes('403') || lastError.includes('invalid')) {
          this.sessions.delete(sessionKey);
          this.stats.activeSessions = this.sessions.size;
          try { session.client.destroy(); } catch {}
          await setTokenActive(userId, guildId, false);
          
          logger.warn(`Invalid token for user ${userId}, removed session`);
          this.stats.totalFailed++;
          return false;
        }

        if (attempt < ENTRY_RETRY_ATTEMPTS) {
          const waitMs = ENTRY_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
          logger.debug(`Retry ${attempt}/${ENTRY_RETRY_ATTEMPTS} for user ${userId}`, {
            component: 'AutoJoinService',
            waitMs,
            error: lastError,
          });
          await delay(waitMs);
        }
      }
    }

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
    const client = new Client();

    client.on('messageCreate', async (message: Message) => {
      if (message.guild) {
        await this.checkGuildWin(message);
      } else {
        await this.checkDmWin(message);
      }
    });

    await client.login(token);

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Login timeout')), 15000);
      client.once('ready', () => {
        clearTimeout(timeout);
        resolve();
      });
      client.once('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    return client;
  }

  // ─── BUTTON CLICKING METHODS ──────────────────────────────────

  private async clickButton(
    client: Client,
    channelId: string,
    messageId: string,
    buttonCustomId: string,
  ): Promise<void> {
    try {
      // Get the token from the client
      const token = (client as any).token;
      if (!token) throw new Error('No token available');

      console.log('[DEBUG] clickButton called:', {
        channelId,
        messageId,
        buttonCustomId,
        hasToken: !!token,
      });

      // Method 1: Try the selfbot's built-in clickButton
      try {
        const channel = await client.channels.fetch(channelId);
        if (channel && 'messages' in channel) {
          const message = await channel.messages.fetch(messageId);
          if (message) {
            const msg = message as any;
            if (typeof msg.clickButton === 'function') {
              console.log('[DEBUG] Using selfbot clickButton method');
              await msg.clickButton(buttonCustomId);
              console.log('[DEBUG] Selfbot clickButton succeeded');
              return;
            }
          }
        }
      } catch (selfbotErr) {
        console.log('[DEBUG] Selfbot clickButton failed, falling back to API:', formatError(selfbotErr));
      }

      // Method 2: Direct API call with proper headers
      console.log('[DEBUG] Using direct API call for button click');
      
      // Get the message data from API
      const messageData = await this.fetchMessageData(token, channelId, messageId);
      if (!messageData) {
        throw new Error('Failed to fetch message data');
      }

      console.log('[DEBUG] Message data fetched, finding button...');

      // Find the button in the message data
      const button = this.findButtonInMessage(messageData, buttonCustomId);
      if (!button) {
        // Try to find ANY entry button
        const anyButton = this.findAnyEntryButtonInMessage(messageData);
        if (anyButton) {
          console.log('[DEBUG] Found alternative button:', anyButton.custom_id);
          const customId = anyButton.custom_id || anyButton.customId;
          await this.sendInteraction(token, channelId, messageId, customId, messageData);
          return;
        }
        throw new Error(`Button ${buttonCustomId} not found in message`);
      }

      console.log('[DEBUG] Found button:', {
        customId: button.custom_id || button.customId,
        label: button.label,
        type: button.type,
        style: button.style,
      });

      // Send the interaction
      await this.sendInteraction(token, channelId, messageId, buttonCustomId, messageData);
      console.log('[DEBUG] Button clicked successfully via API');

    } catch (err) {
      throw new Error(`Failed to click button: ${formatError(err)}`);
    }
  }

  private async clickAnyButton(
    client: Client,
    channelId: string,
    messageId: string,
  ): Promise<void> {
    try {
      const token = (client as any).token;
      if (!token) throw new Error('No token available');

      console.log('[DEBUG] clickAnyButton called:', { channelId, messageId });

      // Get the message data from API
      const messageData = await this.fetchMessageData(token, channelId, messageId);
      if (!messageData) {
        throw new Error('Failed to fetch message data');
      }

      // Find ANY button that looks like an entry button
      const button = this.findAnyEntryButtonInMessage(messageData);
      if (!button) {
        throw new Error('No entry button found in message');
      }

      const customId = button.custom_id || button.customId;
      console.log('[DEBUG] Found entry button:', {
        customId,
        label: button.label,
        type: button.type,
        style: button.style,
      });

      await this.sendInteraction(token, channelId, messageId, customId, messageData);
      console.log('[DEBUG] Entry button clicked successfully');

    } catch (err) {
      throw new Error(`Failed to click any button: ${formatError(err)}`);
    }
  }

  private async fetchMessageData(token: string, channelId: string, messageId: string): Promise<any> {
    const response = await fetch(
      `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`,
      {
        headers: {
          'Authorization': token,
          'Content-Type': 'application/json',
        },
      }
    );

    if (!response.ok) {
      const text = await response.text();
      console.log('[DEBUG] Fetch message failed:', {
        status: response.status,
        text: text,
      });
      throw new Error(`Failed to fetch message: ${response.status} - ${text}`);
    }

    return await response.json();
  }

  private findButtonInMessage(messageData: any, customId: string): any {
    const components = messageData.components || [];
    for (const row of components) {
      for (const comp of row.components || []) {
        if (comp.type === 2) {
          const id = comp.custom_id || comp.customId;
          if (id === customId && !comp.disabled) {
            return comp;
          }
        }
      }
    }
    return null;
  }

  private findAnyEntryButtonInMessage(messageData: any): any {
    const components = messageData.components || [];
    
    // Patterns for entry buttons
    const entryPatterns = [
      /enter/i,
      /join/i,
      /giveaway/i,
      /participate/i,
      /raffle/i,
      /sweepstakes/i,
    ];

    // Trusted custom IDs
    const trustedIds = [
      'giveaway_message',
      'giveaway-enter',
      'enter_giveaway',
      'giveaway_enter',
      'join_giveaway',
      'giveaway-join',
      'giveaway_participate',
      'participate_giveaway',
      'enter',
    ];

    for (const row of components) {
      for (const comp of row.components || []) {
        if (comp.type === 2 && !comp.disabled) {
          const customId = comp.custom_id || comp.customId;
          const label = (comp.label || '').toLowerCase();
          
          // Check trusted IDs
          if (customId && trustedIds.includes(customId)) {
            return comp;
          }
          
          // Check label patterns
          if (entryPatterns.some(pattern => pattern.test(label))) {
            return comp;
          }
          
          // Check bare number (GiveawayBoat style)
          if (label.match(/^\d[\d,]*$/)) {
            return comp;
          }
          
          // Check emoji patterns
          if (label.includes('🎉') || label.includes('🎁') || label.includes('🏆')) {
            return comp;
          }
        }
      }
    }
    
    return null;
  }

  private async sendInteraction(
    token: string,
    channelId: string,
    messageId: string,
    customId: string,
    messageData: any
  ): Promise<void> {
    // Get the session ID
    const sessionId = this.getSessionId();
    const nonce = `${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
    const applicationId = messageData.author?.id || messageData.application_id || messageData.webhook_id;

    if (!applicationId) {
      throw new Error('Could not determine application ID');
    }

    const payload = {
      type: 3,
      nonce: nonce,
      guild_id: messageData.guild_id || null,
      channel_id: channelId,
      message_id: messageId,
      application_id: applicationId,
      session_id: sessionId,
      data: {
        component_type: 2,
        custom_id: customId,
      },
    };

    console.log('[DEBUG] Sending interaction:', {
      channelId,
      messageId,
      customId,
      applicationId,
      sessionId,
      nonce,
    });

    const response = await fetch('https://discord.com/api/v10/interactions', {
      method: 'POST',
      headers: {
        'Authorization': token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text();
      console.log('[DEBUG] Interaction failed:', {
        status: response.status,
        text: text,
      });
      
      // If rate limited, retry after the specified time
      if (response.status === 429) {
        const data = await response.json();
        const retryAfter = data.retry_after || 1;
        console.log(`[DEBUG] Rate limited, waiting ${retryAfter}s...`);
        await delay(retryAfter * 1000);
        // Retry once
        const retryResponse = await fetch('https://discord.com/api/v10/interactions', {
          method: 'POST',
          headers: {
            'Authorization': token,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        });
        if (!retryResponse.ok) {
          const retryText = await retryResponse.text();
          throw new Error(`Interaction failed after retry: ${retryResponse.status} - ${retryText}`);
        }
        return;
      }
      
      throw new Error(`Interaction failed: ${response.status} - ${text}`);
    }

    console.log('[DEBUG] Interaction sent successfully');
  }

  private getSessionId(): string {
    // Try to get the session ID from the client
    // First check if we have a stored session ID
    if ((this as any)._sessionId) {
      return (this as any)._sessionId;
    }
    
    // Check if any session has a client with a session ID
    for (const [, session] of this.sessions) {
      try {
        const clientAny = session.client as any;
        if (clientAny._sessionId || clientAny.sessionId) {
          const id = clientAny._sessionId || clientAny.sessionId;
          // Store it for future use
          (this as any)._sessionId = id;
          return id;
        }
      } catch {}
    }
    
    // Fallback: generate a random session ID
    return Math.random().toString(36).substring(2, 15);
  }

  // ─── WEBHOOK & UTILITY METHODS ────────────────────────────────

  /**
   * Send clean win webhook - no emojis, just "GIVEAWAY WON" with the win message
   */
  private async sendWinWebhook(
    userId: string,
    guildId: string,
    message: Message,
    prize: string,
  ): Promise<void> {
    const webhookUrl = await getUserWebhook(userId, guildId);
    if (!webhookUrl) return;

    // Get the full win message content
    const winMessage = this.extractAllText(message);
    
    // Get jump URL if available
    const jumpUrl = message.guild
      ? `https://discord.com/channels/${message.guild.id}/${message.channel.id}/${message.id}`
      : null;

    // Get server and channel info
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
              { 
                name: 'Win Message', 
                value: truncate(winMessage, 1000), 
                inline: false 
              },
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
