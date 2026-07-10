/**
 * @module giveawayManager
 * Production‑grade giveaway detector.
 * Detects giveaways ONLY from trusted bots, using a scoring system
 * to eliminate false positives from non‑giveaway messages.
 * No entry/click/reaction code — only detect, store, notify.
 */

import { Client, Message, MessageEmbed, MessageComponent } from 'discord.js-selfbot-v13';
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
import {
  GiveawayData,
  DetectionSource,
  DetectedGiveaway,
  GiveawayStatus,
} from './types.js';
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
// Constants – tighten detection with multiple layers
// ---------------------------------------------------------------------------

/**
 * Allowed giveaway bot IDs.
 * Expand this Set if you ever trust other bots.
 */
const ALLOWED_GIVEAWAY_BOT_IDS: ReadonlySet<string> = new Set([
  '530082442967646230', // GiveawayBot (or whatever this ID is)
]);

/**
 * customIds that are always giveaway entry buttons.
 * GiveawayBot often uses 'giveaway_message' with a participant count.
 */
const TRUSTED_ENTRY_CUSTOM_IDS: ReadonlySet<string> = new Set([
  'giveaway_message',    // participant count button
  'giveaway-enter',
  'enter_giveaway',
  'giveaway_enter',
  'join_giveaway',
  'giveaway-join',
  'giveaway_participate',
  'participate_giveaway',
  'enter',
]);

/**
 * Button labels that strongly indicate a giveaway entry button.
 * Also accepts bare numbers (participant count).
 */
const ENTRY_BUTTON_LABEL_PATTERNS: ReadonlyArray<RegExp> = [
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
  /^\d[\d,]*$/,          // bare participant count
];

/**
 * Reaction emojis commonly used to enter giveaways.
 */
const ENTRY_EMOJI_PATTERNS: ReadonlyArray<string> = [
  '🎉',
  '🎁',
  '🎊',
  '🎈',
  '🎀',
  '👍',
  '✅',
];

/**
 * Content patterns that BLOCK a message from being detected.
 * These are typical "already entered", "results", "ended" messages.
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
  /giveaway\s+(?:has\s+)?ended/i,
  /giveaway\s+(?:is\s+)?over/i,
  /winner(?:s)?\b.*\bselected/i,
  /congratulations\b/i,
  /you\s+won/i,
  /you\s+did\s+not\s+win/i,
  /results\s+are\s+in/i,
  /this\s+giveaway\s+is\s+now\s+closed/i,
  /thank\s+you\s+for\s+participating/i,
];

// ---------------------------------------------------------------------------
// Giveaway Scoring System – prevents false positives
// ---------------------------------------------------------------------------
enum GiveawaySignal {
  /** Message has an entry button (component) */
  ENTRY_BUTTON = 3,
  /** Message has a reaction emoji commonly used for giveaways */
  ENTRY_REACTION = 2,
  /** Embed title contains giveaway keywords */
  TITLE_KEYWORD = 2,
  /** Embed description contains giveaway keywords */
  DESCRIPTION_KEYWORD = 1,
  /** Embed footer contains "ends" or similar */
  FOOTER_ENDS = 2,
  /** Presence of a valid future timestamp */
  FUTURE_TIMESTAMP = 3,
  /** Embed color is typical giveaway colour (e.g. gold, blurple) */
  EMBED_COLOR = 1,
  /** Author of embed is a known giveaway bot name */
  AUTHOR_KNOWN = 1,
  /** Message has a "Message" embed field with "Ends in" or "Winners" */
  FIELD_GIVEAWAY = 2,
}

const GIVEAWAY_KEYWORDS: ReadonlyArray<RegExp> = [
  /\bgiveaway\b/i,
  /\braffle\b/i,
  /\bsweepstakes\b/i,
  /\bwin\b/i,
  /\bprize\b/i,
];

const MINIMUM_SCORE_THRESHOLD = 6;   // Must meet or exceed this to be considered a giveaway

// ---------------------------------------------------------------------------
// Helper types & functions
// ---------------------------------------------------------------------------
interface ButtonInfo {
  customId: string;
  label: string;
}

interface ReactionInfo {
  emoji: string;
}

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
    falsePositivesBlocked: 0,
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

    // --- ONLY ALLOWED BOT IDs ---
    if (!this.isAllowedBot(message)) return;

    // --- BLOCK CONFIRMATION / RESULTS MESSAGES (early return) ---
    const content = message.content || '';
    if (BLOCKED_MESSAGE_CONTENT.some(re => re.test(content))) {
      this.log.debug('Blocked message (results/confirmation)', {
        component: 'GiveawayManager',
        account: this.accountLabel,
        botId: message.author?.id,
        preview: truncate(content, 60),
      });
      return;
    }
    // Also check embed description/title for blocked phrases
    for (const embed of message.embeds ?? []) {
      const text = [embed.title, embed.description].join(' ').toLowerCase();
      if (BLOCKED_MESSAGE_CONTENT.some(re => re.test(text))) {
        this.log.debug('Blocked embed (results/confirmation)', {
          component: 'GiveawayManager',
          account: this.accountLabel,
          botId: message.author?.id,
          embedTitle: embed.title,
        });
        return;
      }
    }

    // Check if already tracked (deduplication)
    const existing = getGiveaway(message.id, message.channel.id);
    if (existing) {
      updateLastSeen(message.id, message.channel.id);
      if (existing.status === 'active' && this.isEnded(message)) {
        markEnded(message.id, message.channel.id);
      }
      return;
    }

    // ---- Advanced detection ----
    const detected = await this.detectGiveaway(message);
    if (!detected) {
      this.stats.falsePositivesBlocked++;
      return;
    }

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

    // Notification cooldown
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
  // Core Detection with scoring
  // ---------------------------------------------------------------------------
  private async detectGiveaway(message: Message): Promise<DetectedGiveaway | null> {
    // 1. Collect signals
    const signals = await this.collectSignals(message);

    // 2. Calculate score
    const score = Object.values(signals).reduce((sum, v) => sum + v, 0);

    // 3. Log scoring for debugging
    this.log.debug('Giveaway scoring', {
      component: 'GiveawayManager',
      account: this.accountLabel,
      messageId: message.id,
      score,
      signals,
    });

    // 4. Must meet threshold
    if (score < MINIMUM_SCORE_THRESHOLD) {
      return null;
    }

    // 5. Extract prize and timestamp (even if button missing, we still want them)
    const prize = this.extractPrize(message);
    const endsAt = this.extractEndTimestamp(message);

    // 6. Additional safety: if timestamp exists and is already past, ignore
    if (endsAt && endsAt < Date.now()) {
      this.log.debug('Giveaway already ended', {
        component: 'GiveawayManager',
        account: this.accountLabel,
        messageId: message.id,
      });
      return null;
    }

    // Determine source: prefer button over reaction
    let source = DetectionSource.CONTENT;
    if (signals.ENTRY_BUTTON) source = DetectionSource.COMPONENT;
    else if (signals.ENTRY_REACTION) source = DetectionSource.REACTION;

    // Extract button customId if present
    const button = this.extractEntryButton(message);

    return {
      prize,
      source,
      endsAt,
      buttonCustomId: button?.customId,
      score,
    };
  }

  /**
   * Gathers numeric signals for a message. Each signal contributes a weight.
   */
  private async collectSignals(message: Message): Promise<Record<string, number>> {
    const signals: Record<string, number> = {};

    // --- Button detection (retry once) ---
    const hasEntryButton = await this.hasEntryButton(message);
    if (hasEntryButton) signals['ENTRY_BUTTON'] = GiveawaySignal.ENTRY_BUTTON;

    // --- Reaction detection (check first embed reaction suggestion) ---
    // Many giveaway bots put a reaction emoji in the embed footer or description.
    // We check for common emojis that are not part of a button.
    if (!hasEntryButton) {
      // Only score if no button found, to avoid double points.
      const entryReaction = this.extractEntryReaction(message);
      if (entryReaction) {
        signals['ENTRY_REACTION'] = GiveawaySignal.ENTRY_REACTION;
      }
    }

    // --- Embed analysis ---
    const embed = message.embeds?.[0];
    if (embed) {
      // Title keywords
      if (embed.title && GIVEAWAY_KEYWORDS.some(re => re.test(embed.title))) {
        signals['TITLE_KEYWORD'] = GiveawaySignal.TITLE_KEYWORD;
      }
      // Description keywords
      if (embed.description && GIVEAWAY_KEYWORDS.some(re => re.test(embed.description))) {
        signals['DESCRIPTION_KEYWORD'] = GiveawaySignal.DESCRIPTION_KEYWORD;
      }
      // Footer "ends" detection
      if (embed.footer?.text && /\bends\b|ends\s+in|expires\b/i.test(embed.footer.text)) {
        signals['FOOTER_ENDS'] = GiveawaySignal.FOOTER_ENDS;
      }
      // Author name known?
      if (embed.author?.name && /\bgiveaway\b/i.test(embed.author.name)) {
        signals['AUTHOR_KNOWN'] = GiveawaySignal.AUTHOR_KNOWN;
      }
      // Embed color (common giveaway colors: gold, blurple, green)
      if (embed.color && [0xF1C40F, 0x7289DA, 0x2ECC71, 0xE91E63].includes(embed.color)) {
        signals['EMBED_COLOR'] = GiveawaySignal.EMBED_COLOR;
      }
      // Fields that contain "Ends in", "Winners"
      if (embed.fields) {
        for (const field of embed.fields) {
          if (/\b(?:ends?\s+in|winners?|time\s+remaining)\b/i.test(field.name)) {
            signals['FIELD_GIVEAWAY'] = GiveawaySignal.FIELD_GIVEAWAY;
            break;
          }
        }
      }
    }

    // --- Timestamp detection ---
    const hasTimestamp = this.extractEndTimestamp(message) !== null;
    if (hasTimestamp) {
      signals['FUTURE_TIMESTAMP'] = GiveawaySignal.FUTURE_TIMESTAMP;
    }

    return signals;
  }

  // ---------------------------------------------------------------------------
  // Button detection (with retry)
  // ---------------------------------------------------------------------------
  private async hasEntryButton(message: Message): Promise<boolean> {
    let button = this.extractEntryButton(message);
    if (button) return true;

    // Retry with fetch (components might be delayed)
    for (let i = 0; i < 2; i++) {
      await delay(300);
      try {
        const refreshed = await message.fetch();
        button = this.extractEntryButton(refreshed);
        if (button) return true;
      } catch (err) {
        this.log.warn('Failed to fetch message for button retry', {
          component: 'GiveawayManager',
          account: this.accountLabel,
          messageId: message.id,
          error: formatError(err),
        });
        break;
      }
    }
    return false;
  }

  private extractEntryButton(message: Message): ButtonInfo | null {
    const components = (message as any).components as any[] | undefined;
    if (!components?.length) return null;

    for (const row of components) {
      const comps = row.components as any[] | undefined;
      if (!comps) continue;

      for (const comp of comps) {
        // Button type 2, not link (5), not disabled
        if (comp.type !== 2 || comp.style === 5 || comp.disabled === true) continue;

        const customId = comp.customId || comp.custom_id;
        if (!customId) continue;

        const label = (comp.label || '').trim();

        // Trusted custom IDs always qualify
        if (TRUSTED_ENTRY_CUSTOM_IDS.has(customId)) {
          return { customId, label: label || customId };
        }
        // Label patterns
        if (ENTRY_BUTTON_LABEL_PATTERNS.some(re => re.test(label))) {
          return { customId, label: label || 'Enter' };
        }
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Reaction emoji extraction
  // ---------------------------------------------------------------------------
  private extractEntryReaction(message: Message): ReactionInfo | null {
    // Check if any embed footer or description contains a single emoji
    // Often: "React with 🎉 to enter"
    const embed = message.embeds?.[0];
    if (!embed) return null;

    const text = [embed.description, embed.footer?.text]
      .filter(Boolean)
      .join(' ');

    // Find first occurrence of a known entry emoji in the text
    for (const emoji of ENTRY_EMOJI_PATTERNS) {
      if (text.includes(emoji)) {
        return { emoji };
      }
    }

    // Also check if message has actual reactions already? Not needed.
    return null;
  }

  // ---------------------------------------------------------------------------
  // Allowed bot check
  // ---------------------------------------------------------------------------
  private isAllowedBot(message: Message): boolean {
    return !!(
      message.author?.bot &&
      message.author.id &&
      ALLOWED_GIVEAWAY_BOT_IDS.has(message.author.id)
    );
  }

  // ---------------------------------------------------------------------------
  // Prize extraction – improved heuristics
  // ---------------------------------------------------------------------------
  private extractPrize(message: Message): string {
    const embed = message.embeds?.[0];

    if (embed) {
      // 1. Check for a field named "Prize"
      if (embed.fields) {
        const prizeField = embed.fields.find(f =>
          /\bprize\b/i.test(f.name)
        );
        if (prizeField) return this.cleanText(prizeField.value);
      }
      // 2. Use embed title (most common)
      if (embed.title) return this.cleanText(embed.title);
      // 3. Fallback to description
      if (embed.description) return this.cleanText(embed.description);
    }

    // 4. If no embed, use plain message content
    return this.cleanText(message.content || 'Unknown Prize');
  }

  // ---------------------------------------------------------------------------
  // Timestamp extraction – robust <t:> parsing
  // ---------------------------------------------------------------------------
  private extractEndTimestamp(message: Message): number | null {
    const re = /<t:(\d{10,13})(?::[a-zA-Z])?>/;
    const texts: string[] = [
      message.content || '',
      ...message.embeds.flatMap(e => [
        e.title || '',
        e.description || '',
        e.footer?.text || '',
        ...(e.fields || []).flatMap(f => [f.name, f.value]),
      ]),
    ];
    const joined = texts.join(' ');

    // Find all timestamps, pick the farthest in future (sometimes multiple)
    const matches = joined.matchAll(new RegExp(re.source, 'g'));
    let best: number | null = null;
    for (const match of matches) {
      const raw = parseInt(match[1], 10);
      const tsMs = raw < 1e12 ? raw * 1000 : raw;
      if (Number.isFinite(tsMs) && tsMs > Date.now()) {
        if (best === null || tsMs > best) best = tsMs;
      }
    }
    return best;
  }

  private isEnded(message: Message): boolean {
    const endsAt = this.extractEndTimestamp(message);
    if (endsAt === null) return false;
    return endsAt < Date.now();
  }

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------
  private cleanText(text: string): string {
    return truncate(sanitizeForLog(text), 200);
  }

  // ---------------------------------------------------------------------------
  // Notification logic
  // ---------------------------------------------------------------------------
  private async sendNotification(
    data: Omit<GiveawayData, 'id' | 'status' | 'notifiedAt' | 'lastSeenAt'>
  ): Promise<void> {
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
      status: 'active' as GiveawayStatus,
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
      this.log.error('Failed to send giveaway notification', {
        component: 'GiveawayManager',
        account: this.accountLabel,
        prize: truncate(data.prize, 60),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Statistics and shutdown
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
    this.log.info(`  Detected            : ${s.detected}`, { component: 'GiveawayManager' });
    this.log.info(`  Notified            : ${s.notified}`, { component: 'GiveawayManager' });
    this.log.info(`  Skipped (cooldown)  : ${s.skipped}`, { component: 'GiveawayManager' });
    this.log.info(`  Errors              : ${s.errors}`, { component: 'GiveawayManager' });
    this.log.info(`  False positives blocked: ${s.falsePositivesBlocked}`, { component: 'GiveawayManager' });
    this.log.info(`  Uptime              : ${Math.floor(uptime / 60)}m ${Math.floor(uptime % 60)}s`, {
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
      falsePositivesBlocked: 0,
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
