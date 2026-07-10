/**
 * @module giveawayManager
 * Pure giveaway detector — ONLY detects giveaways from known giveaway bots.
 * No entry/click/reaction code – only detect, store, notify.
 */

import { Client, Message } from 'discord.js-selfbot-v13';
import { EventEmitter } from 'events';
import { CONFIG } from './config.js';
import { logger, AppLogger } from './logger.js';
import {
  delay,
  formatError,
  truncate,
  sanitizeForLog,
  formatTimestamp,
} from './utils.js';
import { GiveawayData, DetectionSource, DetectedGiveaway } from './types.js';
import {
  insertGiveaway,
  wasNotifiedRecently,
  markNotified,
  updateLastSeen,
  getGiveaway,
  markEnded,
} from './database.js';
import { BotManager } from './bot.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * ONLY these bot IDs will be detected as giveaways.
 * If a message isn't from one of these bots, it's ignored.
 */
const KNOWN_GIVEAWAY_BOT_IDS: ReadonlySet<string> = new Set([
  '294882584201003009', // GiveawayBot
  '739448630517039104', // GiveawayBoat
  '515195524879237130',
  '235148962103951360',
  '282859044593598464',
  '270904126974590976',
  '508391840525975553',
]);

/**
 * customIds that are always giveaway entry buttons regardless of their label.
 * GiveawayBoat uses customId "giveaway_message" with a bare participant count.
 */
const TRUSTED_ENTRY_CUSTOM_IDS: ReadonlySet<string> = new Set([
  'giveaway_message',   // GiveawayBoat — participant count button
  'giveaway-enter',
  'enter_giveaway',
  'giveaway_enter',
  'join_giveaway',
  'giveaway-join',
]);

/**
 * Button labels that identify a giveaway ENTRY button.
 * Also accepts bare numbers — GiveawayBoat shows the participant count.
 */
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
  /^\d[\d,]*$/,   // bare participant count — GiveawayBoat style
];

/**
 * If ANY of these patterns match the message content, it's rejected.
 * Covers "already entered", "leave giveaway", "you joined", etc.
 */
const BLOCKED_MESSAGE_CONTENT: ReadonlyArray<RegExp> = [
  /already\s+entered\s+this\s+giveaway/i,
  /you(?:'ve|\s+have)\s+already\s+entered/i,
  /you\s+are\s+already\s+(?:in|entered|participating)/i,
  /you(?:'ve|\s+have)\s+already\s+(?:joined|joined\s+this)/i,
  /leave\s+giveaway/i,
  /join(?:ed)?\s+success(?:fully)?/i,
  /entry\s+confirmed/i,
  /entered\s+successfully/i,
  /you're\s+entered/i,
  /withdraw\s+entry/i,
];

const COMPONENT_RETRY_DELAY_MS = 300;
const COMPONENT_RETRY_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// GiveawayManager
// ---------------------------------------------------------------------------

export class GiveawayManager extends EventEmitter {
  private readonly client: Client;
  private readonly log: AppLogger;
  private readonly accountLabel: string;
  private readonly botManager: BotManager | null;

  private stats = {
    detected: 0,
    notified: 0,
    skipped: 0,
    errors: 0,
    startedAt: Date.now(),
  };

  constructor(
    client: Client,
    log: AppLogger,
    token: string,
    accountLabel: string,
    botManager: BotManager | null,
  ) {
    super();
    this.client = client;
    this.log = log;
    this.accountLabel = accountLabel;
    this.botManager = botManager;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  public async handleMessage(message: Message): Promise<void> {
    // Basic guards
    if (!message.guild) return;
    if (message.author?.id === this.client.user?.id) return;

    // Channel filter
    if (
      CONFIG.monitoredChannels.length > 0 &&
      !CONFIG.monitoredChannels.includes(message.channel.id)
    ) {
      return;
    }

    // --- ONLY APPROVE FROM KNOWN GIVEAWAY BOTS ---
    if (!this.isKnownGiveawayBot(message)) {
      return;
    }

    // --- BLOCK CONFIRMATION / DUPLICATE MESSAGES ---
    const content = message.content || '';
    if (BLOCKED_MESSAGE_CONTENT.some(re => re.test(content))) {
      this.log.debug('Blocked message from known bot', {
        component: 'GiveawayManager',
        account: this.accountLabel,
        botId: message.author?.id,
        preview: truncate(content, 60),
      });
      return;
    }

    // Check if already tracked
    const existing = getGiveaway(message.id, message.channel.id);
    if (existing) {
      updateLastSeen(message.id, message.channel.id);
      if (existing.status === 'active' && this.isEnded(message)) {
        markEnded(message.id, message.channel.id);
      }
      return;
    }

    // Detect the giveaway
    const detected = await this.detectGiveaway(message);
    if (!detected) return;

    // Store in database
    const data: Omit<GiveawayData, 'id' | 'status' | 'notifiedAt' | 'lastSeenAt'> = {
      messageId: message.id,
      channelId: message.channel.id,
      guildId: message.guild.id,
      guildName: message.guild.name,
      channelName: (message.channel as any).name || 'unknown',
      authorId: message.author?.id || '',
      prize: detected.prize,
      detectedAt: Date.now(),
      endsAt: detected.endsAt,
    };

    const inserted = insertGiveaway(data);
    if (!inserted) {
      this.log.debug('Giveaway already in DB', {
        component: 'GiveawayManager',
        account: this.accountLabel,
        messageId: message.id,
      });
      return;
    }

    this.stats.detected++;

    // Check cooldown before notifying
    if (wasNotifiedRecently(message.id, message.channel.id, CONFIG.notificationCooldown)) {
      this.stats.skipped++;
      this.log.debug('Notification cooldown active', {
        component: 'GiveawayManager',
        account: this.accountLabel,
        messageId: message.id,
      });
      return;
    }

    // Send notification via bot
    await this.sendNotification(data);
  }

  // ---------------------------------------------------------------------------
  // Detection
  // ---------------------------------------------------------------------------

  private async detectGiveaway(message: Message): Promise<DetectedGiveaway | null> {
    // Try to find entry button
    let button = this.extractEntryButton(message);

    // If no button, retry with fetch
    if (!button) {
      for (let i = 0; i < COMPONENT_RETRY_ATTEMPTS; i++) {
        await delay(COMPONENT_RETRY_DELAY_MS);
        try {
          const refreshed = await message.fetch();
          button = this.extractEntryButton(refreshed);
          if (button) break;
        } catch {
          break;
        }
      }
    }

    const prize = this.extractPrize(message);
    const endsAt = this.extractEndTimestamp(message);

    this.log.debug('Giveaway detected from known bot', {
      component: 'GiveawayManager',
      account: this.accountLabel,
      botId: message.author?.id,
      hasButton: !!button,
      prize: truncate(prize, 60),
    });

    return {
      prize,
      source: button ? DetectionSource.COMPONENT : DetectionSource.CONTENT,
      endsAt,
      buttonCustomId: button?.customId,
    };
  }

  private extractEntryButton(message: Message): { customId: string; label: string } | null {
    const components = (message as any).components as any[] | undefined;
    if (!components?.length) return null;

    for (const row of components) {
      const comps = row.components as any[] | undefined;
      if (!comps) continue;

      for (const comp of comps) {
        // Must be a button (type 2) and not a link button (style 5)
        if (comp.type !== 2 || comp.style === 5 || comp.disabled === true) continue;

        const customId = comp.customId || comp.custom_id;
        if (!customId) continue;

        const label = (comp.label || '').trim();

        // Trusted custom IDs (GiveawayBoat participant count, etc.)
        if (TRUSTED_ENTRY_CUSTOM_IDS.has(customId)) {
          return { customId, label: label || customId };
        }

        // Entry button label patterns
        if (ENTRY_BUTTON_PATTERNS.some(re => re.test(label))) {
          return { customId, label: label || 'Enter' };
        }
      }
    }

    return null;
  }

  private isKnownGiveawayBot(message: Message): boolean {
    return !!(
      message.author?.bot &&
      message.author.id &&
      KNOWN_GIVEAWAY_BOT_IDS.has(message.author.id)
    );
  }

  // ---------------------------------------------------------------------------
  // Text extraction
  // ---------------------------------------------------------------------------

  private extractPrize(message: Message): string {
    const embed = message.embeds?.[0];
    if (embed?.title) return this.cleanText(embed.title);
    if (embed?.description) return this.cleanText(embed.description);
    if (message.content) return this.cleanText(message.content);
    return 'Unknown Prize';
  }

  private extractEndTimestamp(message: Message): number | null {
    const re = /<t:(\d{10,13})(?::[a-zA-Z])?>/;
    const allText = [
      message.content || '',
      ...message.embeds.flatMap(e => [
        e.title || '',
        e.description || '',
        e.footer?.text || '',
        ...(e.fields || []).flatMap(f => [f.name, f.value]),
      ]),
    ].join(' ');

    const match = allText.match(re);
    if (!match?.[1]) return null;

    const raw = parseInt(match[1], 10);
    const tsMs = raw < 1e12 ? raw * 1000 : raw;
    return Number.isFinite(tsMs) && tsMs > Date.now() ? tsMs : null;
  }

  private isEnded(message: Message): boolean {
    const endsAt = this.extractEndTimestamp(message);
    if (endsAt === null) return false;
    return endsAt < Date.now();
  }

  private cleanText(text: string): string {
    return truncate(sanitizeForLog(text), 200);
  }

  // ---------------------------------------------------------------------------
  // Notification
  // ---------------------------------------------------------------------------

  private async sendNotification(data: Omit<GiveawayData, 'id' | 'status' | 'notifiedAt' | 'lastSeenAt'>): Promise<void> {
    if (!this.botManager) {
      this.log.warn('No bot manager – notification not sent', {
        component: 'GiveawayManager',
        account: this.accountLabel,
      });
      return;
    }

    const fullData: GiveawayData = {
      ...data,
      id: undefined,
      status: 'active',
      notifiedAt: null,
      lastSeenAt: Date.now(),
    };

    const sent = await this.botManager.sendGiveawayNotification(fullData);
    if (sent) {
      this.stats.notified++;
      markNotified(data.messageId, data.channelId);

      this.log.info('✅ Giveaway notification sent', {
        component: 'GiveawayManager',
        account: this.accountLabel,
        prize: truncate(data.prize, 60),
        guild: data.guildName,
        channel: data.channelName,
      });
    } else {
      this.stats.errors++;
    }
  }

  // ---------------------------------------------------------------------------
  // Stats
  // ---------------------------------------------------------------------------

  public getStats() {
    return {
      ...this.stats,
      uptime: Date.now() - this.stats.startedAt,
    };
  }

  public logStats(): void {
    const s = this.stats;
    const uptime = (Date.now() - s.startedAt) / 1000;
    this.log.info(`── ${this.accountLabel} Stats ──────────────────────────`, {
      component: 'GiveawayManager',
    });
    this.log.info(`  Detected  : ${s.detected}`, { component: 'GiveawayManager' });
    this.log.info(`  Notified  : ${s.notified}`, { component: 'GiveawayManager' });
    this.log.info(`  Skipped   : ${s.skipped}`, { component: 'GiveawayManager' });
    this.log.info(`  Errors    : ${s.errors}`, { component: 'GiveawayManager' });
    this.log.info(`  Uptime    : ${Math.floor(uptime / 60)}m ${Math.floor(uptime % 60)}s`, {
      component: 'GiveawayManager',
    });
    this.log.info(`────────────────────────────────────────────────────────`, {
      component: 'GiveawayManager',
    });
  }

  public resetStats(): void {
    this.stats = {
      detected: 0,
      notified: 0,
      skipped: 0,
      errors: 0,
      startedAt: Date.now(),
    };
    this.log.warn('Stats reset', { component: 'GiveawayManager', account: this.accountLabel });
  }

  public async shutdown(): Promise<void> {
    this.log.info(`Shutting down ${this.accountLabel}...`, {
      component: 'GiveawayManager',
    });
    this.logStats();
  }
}

export default GiveawayManager;
