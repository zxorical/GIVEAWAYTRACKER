/**
 * @module giveawayManager
 * Hybrid giveaway detector — combines bot ID bypass, scoring, and button detection.
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
import {
  GiveawayData,
  DetectionSource,
  DetectedGiveaway,
  GiveawayMessage,
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

// ─── Detection Constants (merged from both systems) ──────────────────

// Known giveaway bot IDs – these bypass scoring (but still check blocked)
const KNOWN_GIVEAWAY_BOT_IDS: ReadonlySet<string> = new Set([
  '294882584201003009', // GiveawayBot
  '739448630517039104', // GiveawayBoat
  '515195524879237130',
  '235148962103951360',
  '282859044593598464',
  '270904126974590976',
  '508391840525975553',
]);

// Blocked patterns (confirmation messages, already entered, etc.)
const BLOCKED_PATTERNS: RegExp[] = [
  /join(?:ed)?\s+success(?:fully)?/i,
  /success(?:fully)?\s+join(?:ed)?/i,
  /entry\s+confirmed/i,
  /entered\s+successfully/i,
  /already\s+entered/i,
  /already\s+joined/i,
  /already\s+participating/i,
  /you(?:'ve|\s+have)\s+entered/i,
  /you(?:'ve|\s+have)\s+joined/i,
  /you\s+are\s+entered/i,
  /you\s+are\s+already/i,
  /you're\s+entered/i,
  /leave\s+giveaway/i,
  /withdraw\s+entry/i,
  /you(?:'ve|\s+have)\s+already\s+(?:joined|entered|participating)/i,
];

// Announcement patterns (keywords that indicate a new giveaway)
const ANNOUNCEMENT_PATTERNS: RegExp[] = [
  /\bnew\s+giveaway\b/i,
  /\bgiveaway\b/i,
  /\bhosted\s+by\b/i,
  /\bends?\s+in\b/i,
  /\bends?\s+at\b/i,
  /\bwinner(?:s)?\s+(?:will|chosen|announced)/i,
  /\bprize\b/i,
  /\bentries?\b/i,
  /\bparticipants?\b/i,
  /\breact\s+to\s+enter\b/i,
  /\bclick\s+.*enter\b/i,
  /<t:\d{10,13}/,                     // Discord timestamp
  /🎉/,
  /🎁/,
  /🏆/,
  /\benter\s+to\s+win\b/i,
  /\braffle\b/i,
  /\bsweepstakes\b/i,
];

// Entry button detection
const TRUSTED_BUTTONS: Set<string> = new Set([
  'giveaway_message',    // GiveawayBoat participant count
  'giveaway-enter',
  'enter_giveaway',
  'giveaway_enter',
  'join_giveaway',
  'giveaway-join',
]);

const BUTTON_PATTERNS: RegExp[] = [
  /\benter\b/i,
  /\bjoin\b/i,
  /\bparticipate\b/i,
  /\benter\s+giveaway\b/i,
  /\bjoin\s+giveaway\b/i,
  /🎉/,
  /🎁/,
];

// Component retry settings
const COMPONENT_RETRY_DELAY_MS = 300;
const COMPONENT_RETRY_ATTEMPTS = 3;

// ─── Helper Functions ──────────────────────────────────────────────

function collectText(msg: GiveawayMessage): string {
  const parts: string[] = [];

  if (msg.content) parts.push(msg.content);

  for (const embed of msg.embeds ?? []) {
    if (embed.title) parts.push(embed.title);
    if (embed.description) parts.push(embed.description);
    if (embed.footer?.text) parts.push(embed.footer.text);

    for (const field of embed.fields ?? []) {
      parts.push(field.name);
      parts.push(field.value);
    }
  }

  return parts.join('\n');
}

function hasEntryButton(msg: GiveawayMessage): boolean {
  for (const btn of msg.buttons ?? []) {
    if (btn.disabled) continue;

    if (btn.customId && TRUSTED_BUTTONS.has(btn.customId)) {
      return true;
    }

    if (btn.label && BUTTON_PATTERNS.some(r => r.test(btn.label))) {
      return true;
    }
  }

  return false;
}

function isBlockedMessage(msg: GiveawayMessage): boolean {
  const text = collectText(msg);
  return BLOCKED_PATTERNS.some(r => r.test(text));
}

/**
 * Hybrid detection:
 * - If message author is a known giveaway bot → bypass scoring (but still check blocked)
 * - Otherwise → use scoring: require 2+ announcement patterns OR presence of entry button
 * - Also require minimum text length (to filter short confirmations)
 */
function isGiveawayAnnouncement(msg: GiveawayMessage, isKnownBot: boolean): boolean {
  const text = collectText(msg);

  // Always block confirmation/duplicate messages
  if (isBlockedMessage(msg)) {
    return false;
  }

  // Very short messages are usually not announcements
  if (text.trim().length < 20) {
    return false;
  }

  // Known bot: trust it, but only if it has an entry button or strong signals
  if (isKnownBot) {
    // If it's a known bot, we still require either a button or at least one announcement signal
    const hasButton = hasEntryButton(msg);
    const hasSignal = ANNOUNCEMENT_PATTERNS.some(r => r.test(text));
    return hasButton || hasSignal;
  }

  // For non-bot messages: use scoring
  const announcementScore = ANNOUNCEMENT_PATTERNS.filter(r => r.test(text)).length;
  const hasButton = hasEntryButton(msg);

  // Accept if: trusted entry button exists OR score >= 2
  if (hasButton) return true;
  return announcementScore >= 2;
}

function extractPrizeFromMessage(msg: GiveawayMessage): string {
  // Try embeds first
  for (const embed of msg.embeds ?? []) {
    if (embed.title) return embed.title;
    if (embed.description) return embed.description;
    for (const field of embed.fields ?? []) {
      if (field.name && /prize|giveaway|win|you could win/i.test(field.name)) {
        return field.value;
      }
    }
  }

  // Fall back to content
  if (msg.content) return msg.content;

  return 'Unknown Prize';
}

function extractEndTimestampFromMessage(msg: GiveawayMessage): number | null {
  const text = collectText(msg);
  const re = /<t:(\d{10,13})(?::[a-zA-Z])?>/;
  const match = text.match(re);

  if (!match?.[1]) return null;

  const raw = parseInt(match[1], 10);
  const tsMs = raw < 1e12 ? raw * 1000 : raw;

  return Number.isFinite(tsMs) && tsMs > Date.now() ? tsMs : null;
}

function messageToGiveawayMessage(message: Message): GiveawayMessage {
  const buttons: { customId?: string; label?: string; disabled?: boolean; style?: number }[] = [];

  const components = (message as any).components as any[] | undefined;
  if (components) {
    for (const row of components) {
      for (const comp of row.components || []) {
        if (comp.type === 2) {
          buttons.push({
            customId: comp.customId || comp.custom_id,
            label: comp.label,
            disabled: comp.disabled === true,
            style: comp.style,
          });
        }
      }
    }
  }

  return {
    content: message.content || undefined,
    embeds: message.embeds.map(e => ({
      title: e.title || undefined,
      description: e.description || undefined,
      footer: e.footer ? { text: e.footer.text || undefined } : undefined,
      fields: e.fields?.map(f => ({ name: f.name, value: f.value })),
    })),
    buttons: buttons.length > 0 ? buttons : undefined,
  };
}

// ─── GiveawayManager ──────────────────────────────────────────────────

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

  // ─── Public API ──────────────────────────────────────────────────────

  public async handleMessage(message: Message): Promise<void> {
    if (!message.guild) return;
    if (message.author?.id === this.client.user?.id) return;

    if (
      CONFIG.monitoredChannels.length > 0 &&
      !CONFIG.monitoredChannels.includes(message.channel.id)
    ) {
      return;
    }

    const existing = getGiveaway(message.id, message.channel.id);
    if (existing) {
      updateLastSeen(message.id, message.channel.id);
      if (existing.status === 'active' && this.isEnded(message)) {
        markEnded(message.id, message.channel.id);
      }
      return;
    }

    const detected = await this.detectGiveaway(message);
    if (!detected) return;

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

    if (wasNotifiedRecently(message.id, message.channel.id, CONFIG.notificationCooldown)) {
      this.stats.skipped++;
      this.log.debug('Notification cooldown active', {
        component: 'GiveawayManager',
        account: this.accountLabel,
        messageId: message.id,
      });
      return;
    }

    await this.sendNotification(data);
  }

  // ─── Detection ──────────────────────────────────────────────────────

  private async detectGiveaway(message: Message): Promise<DetectedGiveaway | null> {
    const msg = messageToGiveawayMessage(message);

    // Check blocked patterns first
    if (isBlockedMessage(msg)) {
      this.log.debug('Blocked message', {
        component: 'GiveawayManager',
        account: this.accountLabel,
        messageId: message.id,
      });
      return null;
    }

    const isKnownBot = this.isKnownGiveawayBot(message);
    const isAnnouncement = isGiveawayAnnouncement(msg, isKnownBot);

    // If not known bot and not announcement → reject
    if (!isKnownBot && !isAnnouncement) {
      return null;
    }

    // Try to find entry button (with retry)
    let button = this.extractEntryButtonFromMessage(msg);
    if (!button) {
      for (let i = 0; i < COMPONENT_RETRY_ATTEMPTS; i++) {
        await delay(COMPONENT_RETRY_DELAY_MS);
        try {
          const refreshed = await message.fetch();
          const refreshedMsg = messageToGiveawayMessage(refreshed);
          button = this.extractEntryButtonFromMessage(refreshedMsg);
          if (button) break;
        } catch {
          break;
        }
      }
    }

    const prize = extractPrizeFromMessage(msg);
    const endsAt = extractEndTimestampFromMessage(msg);

    // Log detection signal
    this.log.debug('Giveaway detection', {
      component: 'GiveawayManager',
      account: this.accountLabel,
      isKnownBot,
      isAnnouncement,
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

  private extractEntryButtonFromMessage(msg: GiveawayMessage): { customId: string; label: string } | null {
    for (const btn of msg.buttons ?? []) {
      if (btn.disabled) continue;

      const customId = btn.customId;
      const label = btn.label || '';

      if (customId && TRUSTED_BUTTONS.has(customId)) {
        return { customId, label: label || customId };
      }

      if (label && BUTTON_PATTERNS.some(r => r.test(label))) {
        return { customId: customId || 'unknown', label };
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

  private isEnded(message: Message): boolean {
    const msg = messageToGiveawayMessage(message);
    const endsAt = extractEndTimestampFromMessage(msg);
    if (endsAt === null) return false;
    return endsAt < Date.now();
  }

  // ─── Notification ─────────────────────────────────────────────────

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

  // ─── Stats ─────────────────────────────────────────────────────────

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
