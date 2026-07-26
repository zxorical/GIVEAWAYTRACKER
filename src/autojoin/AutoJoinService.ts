// src/autojoin/AutoJoinService.ts
/**
 * @module autoJoinService
 * Complete autojoin system for premium users
 * 
 * Handles:
 * - Token storage & retrieval (encrypted)
 * - Session management per user
 * - Auto-entry on giveaway detection (SELF-CONTAINED)
 * - Win detection & notifications
 * - Rate limiting & retries
 * - Stats tracking
 */

import { Client, Message, TextChannel } from 'discord.js-selfbot-v13';
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
import { delay, formatError, truncate, hasGiveawayKeyword } from '../utils.js';

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

// Giveaway detection constants
const ENTRY_BUTTON_PATTERNS: ReadonlyArray<RegExp> = [
  /\benter\b/i,
  /\bjoin\b/i,
  /\bparticipate\b/i,
  /\braffle\b/i,
  /\bsweepstakes\b/i,
  /\bsubmit\b/i,
  /count\s+me\s+in/i,
  /\bgiveaway\b/i,
  /🎉/,
  /🎁/,
  /🏆/,
  /^\d[\d,]*$/, // bare participant count — GiveawayBoat style
];

const TRUSTED_ENTRY_CUSTOM_IDS: ReadonlySet<string> = new Set([
  'giveaway_message',   // GiveawayBoat
  'giveaway-enter',
  'enter_giveaway',
  'giveaway_enter',
  'join_giveaway',
  'giveaway-join',
  'giveaway_participate',
  'participate_giveaway',
  'enter',
]);

const BLOCKED_BUTTON_LABELS: ReadonlyArray<RegExp> = [
  /\bleave\b/i,
  /\bquit\b/i,
  /\bexit\b/i,
  /\bunenter\b/i,
  /\bwithdraw\b/i,
  /remove\s+entry/i,
  /cancel\s+entry/i,
  /cancel\s+giveaway/i,
  /end\s+giveaway/i,
];

const BLOCKED_MESSAGE_CONTENT: ReadonlyArray<RegExp> = [
  /already\s+entered\s+this\s+giveaway/i,
  /you(?:'ve|\s+have)\s+already\s+entered/i,
  /you\s+are\s+already\s+(?:in|entered|participating)/i,
  /you(?:'ve|\s+have)\s+already\s+(?:joined|joined\s+this)/i,
  /leave\s+giveaway/i,
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
  isListening: boolean;
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
  private sessionRefreshInterval: NodeJS.Timeout | null = null;

  constructor() {
    super();
    this.startCleanup();
    this.startSessionRefresher();
    
    console.log('🔥 [AUTOJOIN] AutoJoinService initialized');
  }

  // ─── PUBLIC API ──────────────────────────────────────────────────

  /**
   * Start listening for giveaways on all premium user sessions
   * This is the main entry point - call this once after DB is ready
   */
  async startListening(): Promise<void> {
    console.log('🔥 [AUTOJOIN] Starting listening for all premium users...');
    
    try {
      // Get ALL premium users across ALL guilds
      // We need to query all guilds - this requires a different approach
      // For now, we'll listen on all sessions we create
      
      // We'll handle this in the session creation
      console.log('🔥 [AUTOJOIN] Listening started. Sessions will be created as giveaways are detected.');
    } catch (error) {
      console.error('🔥 [AUTOJOIN] Failed to start listening:', error);
    }
  }

  /**
   * Called when a giveaway is detected - either by external manager OR self-detected
   */
  async handleGiveawayDetected(data: GiveawayToEnter): Promise<void> {
    const { messageId, channelId, guildId, buttonCustomId, prize } = data;

    console.log('🔥 [AUTOJOIN] handleGiveawayDetected called:', {
      messageId,
      guildId,
      buttonCustomId,
      prize: prize?.slice(0, 50),
    });

    if (!buttonCustomId) {
      console.log('🔥 [AUTOJOIN] ❌ No buttonCustomId, skipping');
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

      const premiumUsers = await getAllPremiumUsers(guildId);
      console.log('🔥 [AUTOJOIN] Found premium users:', {
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
        console.log('🔥 [AUTOJOIN] ❌ No premium users found for guild:', guildId);
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
    if (this.sessionRefreshInterval) {
      clearInterval(this.sessionRefreshInterval);
      this.sessionRefreshInterval = null;
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
      console.log(`🔥 [AUTOJOIN] ❌ Not premium, skipping`);
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
      console.log(`🔥 [AUTOJOIN] ❌ No token found`);
      this.stats.totalSkipped++;
      return false;
    }

    let token: string;
    try {
      token = decryptToken(tokenData.token);
      console.log(`🔥 [AUTOJOIN] ✅ Token decrypted successfully`);
    } catch (err) {
      console.log(`🔥 [AUTOJOIN] ❌ Failed to decrypt:`, err);
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
          isListening: true,
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
        console.log(`🔥 [AUTOJOIN] Attempt ${attempt}/${ENTRY_RETRY_ATTEMPTS}`);
        
        // Try the specific button first
        await this.clickButton(session.client, channelId, messageId, buttonCustomId);
        
        // Success!
        await incrementTokenEntries(userId, guildId);
        await updateTokenLastUsed(userId, guildId);
        this.stats.totalSuccess++;
        session.entries++;

        console.log(`🔥 [AUTOJOIN] ✅ Success for user ${userId} on attempt ${attempt}`);
        logger.debug(`Autojoined for user ${userId}`, {
          component: 'AutoJoinService',
          prize: truncate(prize, 50),
          attempt,
        });

        return true;
      } catch (err) {
        lastError = formatError(err);
        console.log(`🔥 [AUTOJOIN] ❌ Attempt ${attempt} failed:`, lastError);
        
        // If specific button fails, try ANY button as fallback
        if (attempt === ENTRY_RETRY_ATTEMPTS) {
          console.log(`🔥 [AUTOJOIN] Trying fallback - any entry button...`);
          try {
            await this.clickAnyButton(session.client, channelId, messageId);
            
            await incrementTokenEntries(userId, guildId);
            await updateTokenLastUsed(userId, guildId);
            this.stats.totalSuccess++;
            session.entries++;

            console.log(`🔥 [AUTOJOIN] ✅ Success via fallback for user ${userId}`);
            return true;
          } catch (fallbackErr) {
            lastError = formatError(fallbackErr);
            console.log(`🔥 [AUTOJOIN] ❌ Fallback also failed:`, lastError);
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
          console.log(`🔥 [AUTOJOIN] Retrying in ${waitMs}ms...`);
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

  // ─── SESSION CREATION WITH SELF-DETECTION ──────────────────────

  private async createSession(
    userId: string,
    guildId: string,
    token: string,
  ): Promise<Client> {
    console.log(`🔥 [AUTOJOIN] Creating session for ${userId}...`);
    
    const client = new Client();

    // 🔥 SELF-CONTAINED MESSAGE DETECTION
    client.on('messageCreate', async (message: Message) => {
      // Check if this is from our own user
      if (message.author?.id === client.user?.id) return;
      
      // Check if it's a bot message (giveaway bots are bots)
      if (!message.author?.bot) return;
      
      console.log(`🔥 [AUTOJOIN-SESSION] ${userId} received message:`, {
        id: message.id,
        authorId: message.author?.id,
        authorName: message.author?.username,
        channelId: message.channel.id,
        guildId: message.guild?.id,
        contentPreview: message.content?.slice(0, 80),
        hasComponents: !!(message as any).components?.length,
      });

      // Handle guild messages
      if (message.guild) {
        // Check if this is a win notification
        await this.checkGuildWin(message);
        
        // Check if this is a giveaway
        await this.handlePotentialGiveaway(message, userId, guildId);
      } else {
        // DM message - check for wins
        await this.checkDmWin(message);
      }
    });

    client.on('ready', () => {
      console.log(`🔥 [AUTOJOIN] Session ready for ${userId} (${client.user?.username})`);
    });

    client.on('error', (err) => {
      console.log(`🔥 [AUTOJOIN] Session error for ${userId}:`, err);
    });

    await client.login(token);
    console.log(`🔥 [AUTOJOIN] Session logged in for ${userId}`);

    return client;
  }

  /**
   * Self-contained giveaway detection - doesn't rely on giveawayManager
   */
  private async handlePotentialGiveaway(
    message: Message,
    userId: string,
    guildId: string
  ): Promise<void> {
    // Only process messages from the guild we care about
    if (message.guild?.id !== guildId) return;

    // Check if message has giveaway keywords
    const allText = this.extractAllText(message);
    if (!hasGiveawayKeyword(allText)) return;

    console.log(`🔥 [AUTOJOIN-SESSION] ${userId} - Potential giveaway detected:`, {
      messageId: message.id,
      prize: this.extractPrize(message).slice(0, 50),
      hasComponents: !!(message as any).components?.length,
    });

    // Try to find an entry button
    const button = this.extractEntryButton(message);
    if (!button) {
      console.log(`🔥 [AUTOJOIN-SESSION] No entry button found, waiting...`);
      // Wait and retry
      await delay(500);
      try {
        const refreshed = await message.fetch();
        const refreshedButton = this.extractEntryButton(refreshed);
        if (refreshedButton) {
          console.log(`🔥 [AUTOJOIN-SESSION] Found button after refresh:`, refreshedButton);
          await this.handleGiveawayDetected({
            messageId: message.id,
            channelId: message.channel.id,
            guildId: message.guild.id,
            guildName: message.guild.name,
            channelName: (message.channel as any).name || 'unknown',
            prize: this.extractPrize(message),
            buttonCustomId: refreshedButton.customId,
            detectedAt: Date.now(),
          });
        }
      } catch (err) {
        console.log(`🔥 [AUTOJOIN-SESSION] Refresh failed:`, err);
      }
      return;
    }

    console.log(`🔥 [AUTOJOIN-SESSION] Found entry button:`, button);
    
    // Trigger autojoin for this giveaway
    await this.handleGiveawayDetected({
      messageId: message.id,
      channelId: message.channel.id,
      guildId: message.guild.id,
      guildName: message.guild.name,
      channelName: (message.channel as any).name || 'unknown',
      prize: this.extractPrize(message),
      buttonCustomId: button.customId,
      detectedAt: Date.now(),
    });
  }

  // ─── BUTTON EXTRACTION (SELF-CONTAINED) ────────────────────────

  private extractEntryButton(message: Message): { customId: string; label: string } | null {
    const components = (message as any).components as any[] | undefined;
    if (!components?.length) return null;

    for (const row of components) {
      const comps = row.components as any[] | undefined;
      if (!comps?.length) continue;

      for (const comp of comps) {
        if (comp.type !== 2 || comp.style === 5 || comp.disabled === true) continue;
        const customId = comp.customId || comp.custom_id;
        if (!customId) continue;

        const label = (comp.label || '').trim();

        if (BLOCKED_BUTTON_LABELS.some(re => re.test(label))) continue;

        if (TRUSTED_ENTRY_CUSTOM_IDS.has(customId)) {
          return { customId, label: label || customId };
        }
        if (ENTRY_BUTTON_PATTERNS.some(re => re.test(label))) {
          return { customId, label: label || 'Enter' };
        }
      }
    }
    return null;
  }

  // ─── BUTTON CLICKING METHODS ──────────────────────────────────

  private async clickButton(
    client: Client,
    channelId: string,
    messageId: string,
    buttonCustomId: string,
  ): Promise<void> {
    console.log(`🔥 [AUTOJOIN] clickButton:`, { channelId, messageId, buttonCustomId });

    try {
      const token = (client as any).token;
      if (!token) throw new Error('No token available');

      // Method 1: Try selfbot's built-in method
      try {
        const channel = await client.channels.fetch(channelId);
        if (channel && 'messages' in channel) {
          const message = await channel.messages.fetch(messageId);
          if (message) {
            const msg = message as any;
            if (typeof msg.clickButton === 'function') {
              console.log(`🔥 [AUTOJOIN] Using selfbot clickButton`);
              await msg.clickButton(buttonCustomId);
              console.log(`🔥 [AUTOJOIN] Selfbot click succeeded`);
              return;
            }
          }
        }
      } catch (selfbotErr) {
        console.log(`🔥 [AUTOJOIN] Selfbot click failed, using API`);
      }

      // Method 2: Direct API call
      console.log(`🔥 [AUTOJOIN] Using direct API`);
      
      const messageData = await this.fetchMessageData(token, channelId, messageId);
      if (!messageData) {
        throw new Error('Failed to fetch message data');
      }

      const button = this.findButtonInMessage(messageData, buttonCustomId);
      if (!button) {
        throw new Error(`Button ${buttonCustomId} not found`);
      }

      await this.sendInteraction(token, channelId, messageId, buttonCustomId, messageData);
      console.log(`🔥 [AUTOJOIN] API click succeeded`);

    } catch (err) {
      throw new Error(`Failed to click button: ${formatError(err)}`);
    }
  }

  private async clickAnyButton(
    client: Client,
    channelId: string,
    messageId: string,
  ): Promise<void> {
    console.log(`🔥 [AUTOJOIN] clickAnyButton:`, { channelId, messageId });

    try {
      const token = (client as any).token;
      if (!token) throw new Error('No token available');

      const messageData = await this.fetchMessageData(token, channelId, messageId);
      if (!messageData) {
        throw new Error('Failed to fetch message data');
      }

      const button = this.findAnyEntryButtonInMessage(messageData);
      if (!button) {
        throw new Error('No entry button found');
      }

      const customId = button.custom_id || button.customId;
      console.log(`🔥 [AUTOJOIN] Found fallback button:`, { customId, label: button.label });

      await this.sendInteraction(token, channelId, messageId, customId, messageData);
      console.log(`🔥 [AUTOJOIN] Fallback click succeeded`);

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
    
    const entryPatterns = [
      /enter/i, /join/i, /giveaway/i, /participate/i, /raffle/i,
    ];
    
    const trustedIds = [
      'giveaway_message', 'giveaway-enter', 'enter_giveaway',
      'giveaway_enter', 'join_giveaway', 'giveaway-join',
    ];

    for (const row of components) {
      for (const comp of row.components || []) {
        if (comp.type === 2 && !comp.disabled) {
          const customId = comp.custom_id || comp.customId;
          const label = (comp.label || '').toLowerCase();
          
          if (customId && trustedIds.includes(customId)) return comp;
          if (entryPatterns.some(p => p.test(label))) return comp;
          if (label.match(/^\d[\d,]*$/)) return comp; // GiveawayBoat
          if (label.includes('🎉') || label.includes('🎁')) return comp;
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

    console.log(`🔥 [AUTOJOIN] Sending interaction:`, {
      channelId,
      messageId,
      customId,
      applicationId,
      sessionId,
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
      if (response.status === 429) {
        const data = await response.json();
        const retryAfter = data.retry_after || 1;
        console.log(`🔥 [AUTOJOIN] Rate limited, waiting ${retryAfter}s...`);
        await delay(retryAfter * 1000);
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

    console.log(`🔥 [AUTOJOIN] Interaction sent successfully`);
  }

  private getSessionId(): string {
    // Try to get session ID from any client
    for (const [, session] of this.sessions) {
      try {
        const clientAny = session.client as any;
        if (clientAny._sessionId || clientAny.sessionId) {
          return clientAny._sessionId || clientAny.sessionId;
        }
      } catch {}
    }
    return Math.random().toString(36).substring(2, 15);
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

  private startSessionRefresher(): void {
    this.sessionRefreshInterval = setInterval(() => {
      this.refreshSessions();
    }, 5 * 60_000);
    this.sessionRefreshInterval.unref();
  }

  private async refreshSessions(): Promise<void> {
    console.log(`🔥 [AUTOJOIN] Refreshing sessions...`);
    // This could reload tokens or re-login if needed
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
