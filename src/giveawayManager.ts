/**
 * @module giveawayManager
 * Reliable giveaway detector — scans everything, misses nothing.
 * Original scoring system with performance caching.
 */

import {
  Client,
  Message,
  TextChannel,
  Permissions,
} from 'discord.js-selfbot-v13';
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
// Constants
// ---------------------------------------------------------------------------

const ALLOWED_GIVEAWAY_BOT_IDS: ReadonlySet<string> = new Set([
  '530082442967646230',
]);

const TRUSTED_ENTRY_CUSTOM_IDS: ReadonlySet<string> = new Set([
  'giveaway_message',
  'giveaway-enter',
  'enter_giveaway',
  'giveaway_enter',
  'join_giveaway',
  'giveaway-join',
  'giveaway_participate',
  'participate_giveaway',
  'enter',
]);

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
  /^\d[\d,]*$/,
];

const ENTRY_EMOJI_PATTERNS: ReadonlyArray<string> = [
  '🎉', '🎁', '🎊', '🎈', '🎀', '👍', '✅',
];

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
  /this\s+giveaway\s+is\+now\s+closed/i,
  /thank\s+you\s+for\s+participating/i,
];

// ---------------------------------------------------------------------------
// Scoring System
// ---------------------------------------------------------------------------
enum GiveawaySignal {
  ENTRY_BUTTON = 3,
  ENTRY_REACTION = 2,
  TITLE_KEYWORD = 2,
  DESCRIPTION_KEYWORD = 1,
  FOOTER_ENDS = 2,
  FUTURE_TIMESTAMP = 3,
  EMBED_COLOR = 1,
  AUTHOR_KNOWN = 1,
  FIELD_GIVEAWAY = 2,
}

const GIVEAWAY_KEYWORDS: ReadonlyArray<RegExp> = [
  /\bgiveaway\b/i,
  /\braffle\b/i,
  /\bsweepstakes\b/i,
  /\bwin\b/i,
  /\bprize\b/i,
];

const MINIMUM_SCORE_THRESHOLD = 6;

// ---------------------------------------------------------------------------
// Helper types
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
  private readonly userToken: string;

  private processingMessages = new Set<string>();

  private inviteCache = new Map<string, { url: string; expiresAt: number }>();
  private pendingInvites = new Map<string, Promise<string>>();

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
    this.userToken = token;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------
  public async handleMessage(message: Message): Promise<void> {
    const receivedAt = Date.now();

    // Fast‑path guards
    if (!message.guild) return;
    if (message.author?.id === this.client.user?.id) return;

    if (
      CONFIG.monitoredChannels.length > 0 &&
      !CONFIG.monitoredChannels.includes(message.channel.id)
    ) {
      return;
    }

    if (!this.isAllowedBot(message)) return;

    // Blocked content check
    const content = message.content || '';
    if (BLOCKED_MESSAGE_CONTENT.some(re => re.test(content))) {
      return;
    }

    for (const embed of message.embeds ?? []) {
      const text = [embed.title, embed.description].join(' ').toLowerCase();
      if (BLOCKED_MESSAGE_CONTENT.some(re => re.test(text))) {
        return;
      }
    }

    // Block duplicate processing
    const key = `${message.id}-${message.channel.id}`;
    if (this.processingMessages.has(key)) {
      return;
    }
    this.processingMessages.add(key);

    try {
      // Deduplication
      const existing = await getGiveaway(message.id, message.channel.id);
      if (existing) {
        await updateLastSeen(message.id, message.channel.id);
        if (existing.status === 'active' && this.isEnded(message)) {
          await markEnded(message.id, message.channel.id);
        }
        return;
      }

      // Detection — full scan with retry
      const detected = await this.detectGiveaway(message);
      if (!detected) {
        this.stats.falsePositivesBlocked++;
        return;
      }

      const detectionTime = Date.now() - receivedAt;

      // Store
      const data: Omit<GiveawayData, 'id' | 'status' | 'notifiedAt' | 'lastSeenAt'> = {
        messageId: message.id,
        channelId: message.channel.id,
        guildId: message.guild.id,
        guildName: message.guild.name,
        channelName: (message.channel as any).name || 'unknown',
        authorId: message.author?.id || '',
        prize: detected.prize,
        detectedAt: receivedAt,
        endsAt: detected.endsAt,
        detectionTimeMs: detectionTime,
      };

      const inserted = await insertGiveaway(data);
      if (!inserted) return;

      this.stats.detected++;

      if (await wasNotifiedRecently(message.id, message.channel.id, CONFIG.notificationCooldown)) {
        this.stats.skipped++;
        return;
      }

      // Fire notification
      this.sendNotification(data);
    } finally {
      this.processingMessages.delete(key);
    }
  }

  // -------------------------------------------------------------------------
  // Detection — full scan with button retry
  // -------------------------------------------------------------------------
  private async detectGiveaway(message: Message): Promise<DetectedGiveaway | null> {
    // Try sync first
    let signals = this.collectSignalsSync(message);
    let score = Object.values(signals).reduce((sum, v) => sum + v, 0);
    let button = this.extractEntryButton(message);

    // If no button found, retry with fetch
    if (!button) {
      await delay(200);
      try {
        const refreshed = await message.fetch();
        signals = this.collectSignalsSync(refreshed);
        score = Object.values(signals).reduce((sum, v) => sum + v, 0);
        button = this.extractEntryButton(refreshed);
      } catch {
        // Keep original signals
      }
    }

    if (score < MINIMUM_SCORE_THRESHOLD) return null;

    const prize = this.extractPrize(message);
    const endsAt = this.extractEndTimestamp(message);

    if (endsAt && endsAt < Date.now()) return null;

    let source = DetectionSource.CONTENT;
    if (button) source = DetectionSource.COMPONENT;

    return { prize, source, endsAt, buttonCustomId: button?.customId };
  }

  // -------------------------------------------------------------------------
  // Signal collection (sync version — walks everything once)
  // -------------------------------------------------------------------------
  private collectSignalsSync(message: Message): Record<string, number> {
    const signals: Record<string, number> = {};

    const button = this.extractEntryButton(message);
    if (button) signals['ENTRY_BUTTON'] = GiveawaySignal.ENTRY_BUTTON;

    if (!button) {
      const entryReaction = this.extractEntryReaction(message);
      if (entryReaction) signals['ENTRY_REACTION'] = GiveawaySignal.ENTRY_REACTION;
    }

    const embed = message.embeds?.[0];
    if (embed) {
      if (embed.title && GIVEAWAY_KEYWORDS.some(re => re.test(embed.title)))
        signals['TITLE_KEYWORD'] = GiveawaySignal.TITLE_KEYWORD;

      if (embed.description && GIVEAWAY_KEYWORDS.some(re => re.test(embed.description)))
        signals['DESCRIPTION_KEYWORD'] = GiveawaySignal.DESCRIPTION_KEYWORD;

      if (embed.footer?.text && /\bends\b|ends\s+in|expires\b/i.test(embed.footer.text))
        signals['FOOTER_ENDS'] = GiveawaySignal.FOOTER_ENDS;

      if (embed.author?.name && /\bgiveaway\b/i.test(embed.author.name))
        signals['AUTHOR_KNOWN'] = GiveawaySignal.AUTHOR_KNOWN;

      if (embed.color && [0xF1C40F, 0x7289DA, 0x2ECC71, 0xE91E63].includes(embed.color))
        signals['EMBED_COLOR'] = GiveawaySignal.EMBED_COLOR;

      if (embed.fields) {
        for (const field of embed.fields) {
          if (/\b(?:ends?\s+in|winners?|time\s+remaining)\b/i.test(field.name)) {
            signals['FIELD_GIVEAWAY'] = GiveawaySignal.FIELD_GIVEAWAY;
            break;
          }
        }
      }
    }

    if (this.extractEndTimestamp(message) !== null) {
      signals['FUTURE_TIMESTAMP'] = GiveawaySignal.FUTURE_TIMESTAMP;
    }

    return signals;
  }

  // -------------------------------------------------------------------------
  // Button detection
  // -------------------------------------------------------------------------
  private extractEntryButton(message: Message): ButtonInfo | null {
    const components = (message as any).components as any[] | undefined;
    if (!components?.length) return null;

    for (const row of components) {
      const comps = row.components as any[] | undefined;
      if (!comps?.length) continue;

      for (const comp of comps) {
        // Must be a button (type 2) and not a link button (style 5)
        if (comp.type !== 2 || comp.style === 5 || comp.disabled === true) continue;
        const customId = comp.customId || comp.custom_id;
        if (!customId) continue;

        const label = (comp.label || '').trim();
        if (TRUSTED_ENTRY_CUSTOM_IDS.has(customId)) return { customId, label: label || customId };
        if (ENTRY_BUTTON_LABEL_PATTERNS.some(re => re.test(label))) return { customId, label: label || 'Enter' };
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Reaction emoji extraction
  // -------------------------------------------------------------------------
  private extractEntryReaction(message: Message): ReactionInfo | null {
    const embed = message.embeds?.[0];
    if (!embed) return null;
    const text = [embed.description, embed.footer?.text].filter(Boolean).join(' ');
    for (const emoji of ENTRY_EMOJI_PATTERNS) {
      if (text.includes(emoji)) return { emoji };
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Allowed bot check
  // -------------------------------------------------------------------------
  private isAllowedBot(message: Message): boolean {
    return !!(message.author?.bot && message.author.id && ALLOWED_GIVEAWAY_BOT_IDS.has(message.author.id));
  }

  // -------------------------------------------------------------------------
  // Prize extraction
  // -------------------------------------------------------------------------
  private extractPrize(message: Message): string {
    const embed = message.embeds?.[0];
    if (embed) {
      if (embed.fields) {
        const prizeField = embed.fields.find(f => /\bprize\b/i.test(f.name));
        if (prizeField) return this.cleanText(prizeField.value);
      }
      if (embed.title) return this.cleanText(embed.title);
      if (embed.description) return this.cleanText(embed.description);
    }
    return this.cleanText(message.content || 'Unknown Prize');
  }

  // -------------------------------------------------------------------------
  // Timestamp extraction
  // -------------------------------------------------------------------------
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

  // -------------------------------------------------------------------------
  // Utilities
  // -------------------------------------------------------------------------
  private cleanText(text: string): string {
    return truncate(sanitizeForLog(text), 200);
  }

  // -------------------------------------------------------------------------
  // Cached invite
  // -------------------------------------------------------------------------
  private getCachedInvite(guildId: string): string | null {
    const cached = this.inviteCache.get(guildId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.url;
    }
    this.inviteCache.delete(guildId);
    return null;
  }

  private setCachedInvite(guildId: string, url: string): void {
    this.inviteCache.set(guildId, { url, expiresAt: Date.now() + 30 * 60 * 1000 });
  }

  private async fetchInviteForGuild(guildId: string): Promise<string> {
    const cached = this.getCachedInvite(guildId);
    if (cached) return cached;

    const pending = this.pendingInvites.get(guildId);
    if (pending) return pending;

    const promise = this.doFetchInvite(guildId);
    this.pendingInvites.set(guildId, promise);

    try {
      const url = await promise;
      if (url && !url.includes('unavailable') && !url.includes('not reachable')) {
        this.setCachedInvite(guildId, url);
      }
      return url;
    } finally {
      this.pendingInvites.delete(guildId);
    }
  }

  private async doFetchInvite(guildId: string): Promise<string> {
    try {
      const guild = this.client.guilds.cache.get(guildId);
      if (!guild) return 'Server not reachable';

      try {
        const invites = await guild.invites.fetch();
        if (invites?.size > 0) {
          const permanent = invites.find(inv => inv.maxAge === 0 && inv.maxUses === 0);
          return permanent ? permanent.url : invites.first()!.url;
        }
      } catch {}

      try {
        const vanity = (guild as any).vanityURLCode;
        if (vanity) return `https://discord.gg/${vanity}`;
      } catch {}

      const channels = guild.channels.cache.filter(
        (ch): ch is TextChannel => ch.type === 'GUILD_TEXT'
      ) as unknown as TextChannel[];

      for (const channel of channels.values()) {
        try {
          const invite = await channel.createInvite({ maxAge: 0, maxUses: 0, reason: 'Giveaway tracker' });
          return invite.url;
        } catch {
          continue;
        }
      }

      return `https://discord.com/channels/${guildId}`;
    } catch {
      return `https://discord.com/channels/${guildId}`;
    }
  }

  // -------------------------------------------------------------------------
  // Notification
  // -------------------------------------------------------------------------
  private async sendNotification(
    data: Omit<GiveawayData, 'id' | 'status' | 'notifiedAt' | 'lastSeenAt'>
  ): Promise<void> {
    if (!this.botManager) return;

    const guildId: string = data.guildId || '0';
    const cachedInvite: string = this.getCachedInvite(guildId) ?? `https://discord.com/channels/${guildId}`;

    // Generate a temporary ID for the notification; the database will have its own.
    const tempId = `temp-${data.messageId}`;

    const fullData: GiveawayData = {
      ...data,
      id: tempId,
      status: 'active',
      notifiedAt: null,
      lastSeenAt: Date.now(),
      inviteUrl: cachedInvite,
    };

    const sent = await this.botManager.sendGiveawayNotification(fullData);
    if (sent) {
      this.stats.notified++;
      await markNotified(data.messageId, data.channelId);
    } else {
      this.stats.errors++;
    }

    this.fetchInviteForGuild(guildId).catch(() => {});
  }

  // -------------------------------------------------------------------------
  // Statistics and shutdown
  // -------------------------------------------------------------------------
  public getStats() {
    return { ...this.stats, uptime: Date.now() - this.stats.startedAt };
  }

  public logStats(): void {
    const s = this.stats;
    const uptime = (Date.now() - s.startedAt) / 1000;
    this.log.info(`── ${this.accountLabel} Stats ──────────────────────────`);
    this.log.info(`  Detected            : ${s.detected}`);
    this.log.info(`  Notified            : ${s.notified}`);
    this.log.info(`  Skipped (cooldown)  : ${s.skipped}`);
    this.log.info(`  Errors              : ${s.errors}`);
    this.log.info(`  False positives blocked: ${s.falsePositivesBlocked}`);
    this.log.info(`  Uptime              : ${Math.floor(uptime / 60)}m ${Math.floor(uptime % 60)}s`);
    this.log.info(`────────────────────────────────────────────────────────`);
  }

  public resetStats(): void {
    this.stats = { detected: 0, notified: 0, skipped: 0, errors: 0, falsePositivesBlocked: 0, startedAt: Date.now() };
  }

  public async shutdown(): Promise<void> {
    this.log.info(`Shutting down ${this.accountLabel}...`);
    this.logStats();
  }
}

export default GiveawayManager;
