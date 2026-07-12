/**
 * @module giveawayManager
 * Hyper-optimized giveaway detector — production grade.
 *
 * - Single‑pass parse (no repeated embed/component walks)
 * - Integer constants for scores (no object lookups)
 * - Combined regexes + substring checks where possible
 * - No temporary arrays, no repeated lowercase
 * - Timestamp regex reused, not re‑compiled
 * - Processing dedup map auto‑cleaned every 30s
 * - Fingerprint cache skips already‑seen messages
 * - Lazy prize extraction (only if score passes)
 */

import { Client, Message, TextChannel } from 'discord.js-selfbot-v13';
import { EventEmitter } from 'events';
import { CONFIG } from './config.js';
import { logger, AppLogger } from './logger.js';
import { delay, formatError, truncate, sanitizeForLog } from './utils.js';
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
// Compiled constants – no allocations at runtime
// ---------------------------------------------------------------------------

const ALLOWED_BOT_IDS = new Set(['530082442967646230']);

const TRUSTED_BUTTON_IDS = new Set([
  'giveaway_message', 'giveaway-enter', 'enter_giveaway', 'giveaway_enter',
  'join_giveaway', 'giveaway-join', 'giveaway_participate', 'participate_giveaway', 'enter',
]);

// Combined blocked content regex (single pass, no loop)
const BLOCKED_RE = /already\s+entered|you(?:'ve|\s+have)\s+already|leave\s+giveaway|join(?:ed)?\s+success|entry\s+confirmed|entered\s+successfully|you're\s+entered|withdraw\s+entry|giveaway\s+(?:has\s+)?ended|giveaway\s+(?:is\s+)?over|winner\b.*\bselected|congratulations|you\s+won|you\s+did\s+not\s+win|results\s+are\s+in|this\s+giveaway\s+is\s+now\s+closed|thank\s+you\s+for\s+participating/i;

// Combined giveaway keyword regex (for title/description)
const GIVEAWAY_KW_RE = /giveaway|raffle|sweepstakes|prize|win/i;

// Button label patterns – combined
const BUTTON_LABEL_RE = /enter|join|participate|raffle|sweepstakes|submit|count\s+me\s+in|giveaway|🎉|🎁|🏆|^\d[\d,]*$/i;

// Footer end patterns
const FOOTER_END_RE = /\bends?\b|expires/i;

// Field giveaway indicators
const FIELD_GW_RE = /ends?\s+in|winners?|time\s+remaining/i;

// Giveaway embed colors
const GW_COLORS = new Set([0xF1C40F, 0x7289DA, 0x2ECC71, 0xE91E63]);

// Entry emojis (for reaction detection)
const ENTRY_EMOJIS = new Set(['🎉', '🎁', '🎊', '🎈', '🎀', '👍', '✅']);

// Timestamp regex – compiled once, reused
const TS_RE = /<t:(\d{10,13})(?::[a-zA-Z])?>/g;

// Score constants (integers, no object lookup)
const SCORE_BUTTON = 3;
const SCORE_REACTION = 2;
const SCORE_TITLE_KW = 2;
const SCORE_DESC_KW = 1;
const SCORE_FOOTER = 2;
const SCORE_TIMESTAMP = 3;
const SCORE_COLOR = 1;
const SCORE_AUTHOR = 1;
const SCORE_FIELD = 2;

const MIN_SCORE = 6;

// Processing map cleanup interval
const PROCESSING_TTL = 30_000;

// Fingerprint cache TTL
const FINGERPRINT_TTL = 10_000;

// ---------------------------------------------------------------------------
// Helper types
// ---------------------------------------------------------------------------

interface ParsedMessage {
  hasButton: boolean;
  hasReaction: boolean;
  hasTimestamp: boolean;
  timestamp: number | null;
  hasTitleKW: boolean;
  hasDescKW: boolean;
  hasFooterEnd: boolean;
  hasColor: boolean;
  hasAuthorKW: boolean;
  hasFieldGW: boolean;
  buttonCustomId: string | null;
  prize?: string;
}

// ---------------------------------------------------------------------------
// GiveawayManager
// ---------------------------------------------------------------------------
export class GiveawayManager extends EventEmitter {
  private readonly client: Client;
  private readonly log: AppLogger;
  private readonly accountLabel: string;
  private readonly botManager: BotManager | null;

  private processing = new Map<string, number>();
  private fingerprints = new Map<string, number>();

  private inviteCache = new Map<string, { url: string; expires: number }>();
  private pendingInvites = new Map<string, Promise<string>>();

  private stats = {
    detected: 0,
    notified: 0,
    skipped: 0,
    errors: 0,
    falsePositives: 0,
    startedAt: Date.now(),
  };

  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(
    client: Client,
    log: AppLogger,
    _token: string,
    accountLabel: string,
    botManager: BotManager | null,
  ) {
    super();
    this.client = client;
    this.log = log;
    this.accountLabel = accountLabel;
    this.botManager = botManager;

    this.cleanupInterval = setInterval(() => this.cleanupMaps(), 30_000);
  }

  // -------------------------------------------------------------------------
  // Public entry – extremely fast hot path
  // -------------------------------------------------------------------------
  public async handleMessage(message: Message): Promise<void> {
    const now = Date.now();

    // ========================
    // GUARDS (all sync, early exit)
    // ========================
    if (!message.guild) return;
    if (message.author?.id === this.client.user?.id) return;
    if (
      CONFIG.monitoredChannels.length > 0 &&
      !CONFIG.monitoredChannels.includes(message.channel.id)
    ) return;
    if (!message.author?.bot || !ALLOWED_BOT_IDS.has(message.author.id)) return;

    // Quick blocked content check
    const content = message.content || '';
    if (BLOCKED_RE.test(content)) return;

    // Check embed text without concatenating
    const embed = message.embeds?.[0];
    if (embed) {
      if ((embed.title && BLOCKED_RE.test(embed.title)) ||
          (embed.description && BLOCKED_RE.test(embed.description))) return;
    }

    // Deduplicate via expiring map
    const key = `${message.channel.id}:${message.id}`;
    if (this.processing.has(key)) return;
    this.processing.set(key, now + PROCESSING_TTL);

    // Fingerprint cache
    const fp = this.buildFingerprint(message);
    if (fp && this.fingerprints.has(fp)) {
      return;
    }

    // ========================
    // PARSE (single pass)
    // ========================
    const parsed = this.parseMessage(message, now);
    if (!parsed) {
      this.stats.falsePositives++;
      return;
    }

    // ========================
    // SCORE
    // ========================
    const score = this.calcScore(parsed);
    if (score < MIN_SCORE) {
      this.stats.falsePositives++;
      return;
    }

    // Store fingerprint
    if (fp) {
      this.fingerprints.set(fp, now + FINGERPRINT_TTL);
    }

    // ========================
    // DATABASE CHECK
    // ========================
    const existing = await getGiveaway(message.id, message.channel.id);
    if (existing) {
      await updateLastSeen(message.id, message.channel.id);
      if (existing.status === 'active' && parsed.timestamp && parsed.timestamp < now) {
        await markEnded(message.id, message.channel.id);
      }
      return;
    }

    // ========================
    // RETRY only if no button AND no timestamp
    // ========================
    if (!parsed.hasButton && !parsed.hasTimestamp && embed) {
      this.scheduleRetry(message, now, key);
      return;
    }

    // ========================
    // LAZY PRIZE EXTRACTION
    // ========================
    const prize = this.extractPrizeFromMessage(message, embed);
    parsed.prize = prize;

    // Insert DB + notify
    await this.finalize(message, parsed, now);
  }

  // -------------------------------------------------------------------------
  // Fingerprint
  // -------------------------------------------------------------------------
  private buildFingerprint(message: Message): string | null {
    const embed = message.embeds?.[0];
    if (!embed?.title) return null;
    const button = this.extractButtonCustomId(message);
    return `${message.author?.id}|${embed.title}|${button || ''}`;
  }

  // -------------------------------------------------------------------------
  // Single‑pass message parser
  // -------------------------------------------------------------------------
  private parseMessage(message: Message, now: number): ParsedMessage | null {
    const embed = message.embeds?.[0];
    const components = (message as any).components as any[] ?? null;

    // Button detection
    let hasButton = false;
    let buttonCustomId: string | null = null;
    if (components) {
      for (const row of components) {
        const comps = row.components as any[] | undefined;
        if (!comps) continue;
        for (const comp of comps) {
          if (comp.type !== 2 || comp.style === 5 || comp.disabled) continue;
          const cid = comp.customId || comp.custom_id;
          const label = (comp.label || '').trim();
          if (TRUSTED_BUTTON_IDS.has(cid) || BUTTON_LABEL_RE.test(label)) {
            hasButton = true;
            buttonCustomId = cid;
            break;
          }
        }
        if (hasButton) break;
      }
    }

    // Reaction detection
    let hasReaction = false;
    if (embed) {
      const desc = embed.description || '';
      const footer = embed.footer?.text || '';
      for (const emoji of ENTRY_EMOJIS) {
        if (desc.indexOf(emoji) !== -1 || footer.indexOf(emoji) !== -1) {
          hasReaction = true;
          break;
        }
      }
    }

    // Timestamp scanning
    let timestamp: number | null = null;
    const scanForTS = (text: string) => {
      if (!text) return;
      TS_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = TS_RE.exec(text)) !== null) {
        const raw = parseInt(match[1], 10);
        const ts = raw < 1e12 ? raw * 1000 : raw;
        if (ts > now && (timestamp === null || ts > timestamp)) {
          timestamp = ts;
        }
      }
    };
    scanForTS(message.content || '');
    if (embed) {
      scanForTS(embed.title || '');
      scanForTS(embed.description || '');
      scanForTS(embed.footer?.text || '');
      if (embed.fields) {
        for (const f of embed.fields) {
          scanForTS(f.name);
          scanForTS(f.value);
        }
      }
    }

    // Keyword detection
    let hasTitleKW = false;
    let hasDescKW = false;
    let hasFooterEnd = false;
    let hasColor = false;
    let hasAuthorKW = false;
    let hasFieldGW = false;

    if (embed) {
      const title = embed.title || '';
      const desc = embed.description || '';
      const footer = embed.footer?.text || '';
      const author = embed.author?.name || '';

      hasTitleKW = GIVEAWAY_KW_RE.test(title);
      hasDescKW = GIVEAWAY_KW_RE.test(desc);
      hasFooterEnd = FOOTER_END_RE.test(footer);
      hasAuthorKW = author.toLowerCase().includes('giveaway');
      hasColor = embed.color !== null && embed.color !== undefined && GW_COLORS.has(embed.color);

      if (embed.fields) {
        for (const f of embed.fields) {
          if (FIELD_GW_RE.test(f.name)) {
            hasFieldGW = true;
            break;
          }
        }
      }
    }

    return {
      hasButton,
      hasReaction,
      hasTimestamp: timestamp !== null,
      timestamp,
      hasTitleKW,
      hasDescKW,
      hasFooterEnd,
      hasColor,
      hasAuthorKW,
      hasFieldGW,
      buttonCustomId,
    };
  }

  // -------------------------------------------------------------------------
  // Score calculation
  // -------------------------------------------------------------------------
  private calcScore(p: ParsedMessage): number {
    let score = 0;
    if (p.hasButton) score += SCORE_BUTTON;
    if (p.hasReaction) score += SCORE_REACTION;
    if (p.hasTimestamp) score += SCORE_TIMESTAMP;
    if (p.hasTitleKW) score += SCORE_TITLE_KW;
    if (p.hasDescKW) score += SCORE_DESC_KW;
    if (p.hasFooterEnd) score += SCORE_FOOTER;
    if (p.hasColor) score += SCORE_COLOR;
    if (p.hasAuthorKW) score += SCORE_AUTHOR;
    if (p.hasFieldGW) score += SCORE_FIELD;
    return score;
  }

  // -------------------------------------------------------------------------
  // Prize extraction (lazy)
  // -------------------------------------------------------------------------
  private extractPrizeFromMessage(message: Message, embed: any): string {
    if (!embed) {
      return truncate(sanitizeForLog(message.content || 'Unknown Prize'), 200);
    }
    if (embed.fields) {
      for (const f of embed.fields) {
        if (/\bprize\b/i.test(f.name)) {
          return truncate(sanitizeForLog(f.value), 200);
        }
      }
    }
    if (embed.title) return truncate(sanitizeForLog(embed.title), 200);
    if (embed.description) return truncate(sanitizeForLog(embed.description), 200);
    return truncate(sanitizeForLog(message.content || 'Unknown Prize'), 200);
  }

  // -------------------------------------------------------------------------
  // Button customId extraction (for fingerprint)
  // -------------------------------------------------------------------------
  private extractButtonCustomId(message: Message): string | null {
    const components = (message as any).components as any[] | undefined;
    if (!components?.length) return null;
    for (const row of components) {
      const comps = row.components as any[] | undefined;
      if (!comps) continue;
      for (const comp of comps) {
        if (comp.type !== 2 || comp.style === 5 || comp.disabled) continue;
        const cid = comp.customId || comp.custom_id;
        if (TRUSTED_BUTTON_IDS.has(cid) || BUTTON_LABEL_RE.test(comp.label || '')) {
          return cid;
        }
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Async retry
  // -------------------------------------------------------------------------
  private async scheduleRetry(message: Message, startTime: number, key: string): Promise<void> {
    await delay(300);
    try {
      const refreshed = await message.fetch().catch(() => null);
      if (!refreshed) { this.processing.delete(key); this.stats.falsePositives++; return; }

      const parsed = this.parseMessage(refreshed, Date.now());
      if (!parsed) { this.processing.delete(key); this.stats.falsePositives++; return; }

      const score = this.calcScore(parsed);
      if (score < MIN_SCORE) { this.processing.delete(key); this.stats.falsePositives++; return; }

      const existing = await getGiveaway(refreshed.id, refreshed.channel.id);
      if (existing) { this.processing.delete(key); return; }

      const prize = this.extractPrizeFromMessage(refreshed, refreshed.embeds?.[0]);
      parsed.prize = prize;

      await this.finalize(refreshed, parsed, startTime);
    } catch {
      this.processing.delete(key);
    }
  }

  // -------------------------------------------------------------------------
  // Finalize – DB insert + notify
  // -------------------------------------------------------------------------
  private async finalize(message: Message, parsed: ParsedMessage, receivedAt: number): Promise<void> {
    const now = Date.now();
    const detectionTime = now - receivedAt;

    const data: Omit<GiveawayData, 'id' | 'status' | 'notifiedAt' | 'lastSeenAt'> = {
      messageId: message.id,
      channelId: message.channel.id,
      guildId: message.guild!.id,
      guildName: message.guild!.name,
      channelName: (message.channel as any).name || 'unknown',
      authorId: message.author?.id || '',
      prize: parsed.prize || 'Unknown Prize',
      detectedAt: receivedAt,
      endsAt: parsed.timestamp,
      detectionTimeMs: detectionTime,
    };

    const inserted = await insertGiveaway(data);
    if (!inserted) return;

    this.stats.detected++;

    if (await wasNotifiedRecently(message.id, message.channel.id, CONFIG.notificationCooldown)) {
      this.stats.skipped++;
      return;
    }

    // Send notification via botManager
    if (this.botManager) {
      const guildId = data.guildId || '0';
      const cached = this.inviteCache.get(guildId);
      const inviteUrl = (cached && cached.expires > Date.now())
        ? cached.url
        : `https://discord.com/channels/${guildId}`;

      const fullData: GiveawayData = {
        ...data,
        id: undefined,
        status: 'active',
        notifiedAt: null,
        lastSeenAt: Date.now(),
        inviteUrl,
      };

      const sent = await this.botManager.sendGiveawayNotification(fullData);
      if (sent) {
        this.stats.notified++;
        await markNotified(data.messageId, data.channelId);
      } else {
        this.stats.errors++;
      }

      // Background invite fetch
      this.fetchInviteForGuild(guildId).catch(() => {});
    }
  }

  // -------------------------------------------------------------------------
  // Invite fetching
  // -------------------------------------------------------------------------
  private async fetchInviteForGuild(guildId: string): Promise<string> {
    const cached = this.inviteCache.get(guildId);
    if (cached && cached.expires > Date.now()) return cached.url;

    const pending = this.pendingInvites.get(guildId);
    if (pending) return pending;

    const promise = this.doFetchInvite(guildId);
    this.pendingInvites.set(guildId, promise);
    try {
      const url = await promise;
      if (url && !url.includes('unavailable') && !url.includes('not reachable')) {
        this.inviteCache.set(guildId, { url, expires: Date.now() + 30 * 60_000 });
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
      const invites = await guild.invites.fetch().catch(() => null);
      const perm = invites?.find(i => i.maxAge === 0 && i.maxUses === 0);
      if (perm) return perm.url;
      const channel = guild.channels.cache.find(
        (ch): ch is TextChannel => ch.type === 'GUILD_TEXT',
      ) as TextChannel | undefined;
      if (channel) {
        const inv = await channel.createInvite({ maxAge: 0, maxUses: 0, reason: 'Giveaway tracker' });
        return inv.url;
      }
      return `https://discord.com/channels/${guildId}`;
    } catch {
      return `https://discord.com/channels/${guildId}`;
    }
  }

  // -------------------------------------------------------------------------
  // Map cleanup
  // -------------------------------------------------------------------------
  private cleanupMaps(): void {
    const now = Date.now();
    for (const [key, exp] of this.processing) {
      if (exp < now) this.processing.delete(key);
    }
    for (const [key, exp] of this.fingerprints) {
      if (exp < now) this.fingerprints.delete(key);
    }
  }

  // -------------------------------------------------------------------------
  // Stats & shutdown
  // -------------------------------------------------------------------------
  public getStats() {
    return { ...this.stats, uptime: Date.now() - this.stats.startedAt };
  }

  public logStats(): void {
    const s = this.stats;
    const uptime = (Date.now() - s.startedAt) / 1000;
    this.log.info(`── ${this.accountLabel} Stats ──────────────────────────`);
    this.log.info(`  Detected : ${s.detected}  Notified : ${s.notified}  Skipped : ${s.skipped}`);
    this.log.info(`  Errors   : ${s.errors}  FalsePos : ${s.falsePositives}`);
    this.log.info(`  Uptime   : ${Math.floor(uptime / 60)}m ${Math.floor(uptime % 60)}s`);
  }

  public resetStats(): void {
    this.stats = { detected: 0, notified: 0, skipped: 0, errors: 0, falsePositives: 0, startedAt: Date.now() };
  }

  public async shutdown(): Promise<void> {
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
    this.log.info(`Shutting down ${this.accountLabel}...`);
    this.logStats();
  }
}

export default GiveawayManager;
