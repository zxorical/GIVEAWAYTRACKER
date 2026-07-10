/**
 * @module giveawayManager
 * Production‑grade giveaway detector.
 * Detects giveaways ONLY from trusted bots, using a scoring system
 * to eliminate false positives from non‑giveaway messages.
 * No entry/click/reaction code — only detect, store, notify.
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
// Constants – tighten detection with multiple layers
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
  /this\s+giveaway\s+is\s+now\s+closed/i,
  /thank\s+you\s+for\s+participating/i,
];

// ---------------------------------------------------------------------------
// Giveaway Scoring System – prevents false positives
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
    if (!message.guild) return;
    if (message.author?.id === this.client.user?.id) return;

    if (
      CONFIG.monitoredChannels.length > 0 &&
      !CONFIG.monitoredChannels.includes(message.channel.id)
    ) {
      return;
    }

    if (!this.isAllowedBot(message)) return;

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

    const existing = getGiveaway(message.id, message.channel.id);
    if (existing) {
      updateLastSeen(message.id, message.channel.id);
      if (existing.status === 'active' && this.isEnded(message)) {
        markEnded(message.id, message.channel.id);
      }
      return;
    }

    const detected = await this.detectGiveaway(message);
    if (!detected) {
      this.stats.falsePositivesBlocked++;
      return;
    }

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

  // -------------------------------------------------------------------------
  // Core Detection with scoring
  // -------------------------------------------------------------------------
  private async detectGiveaway(message: Message): Promise<DetectedGiveaway | null> {
    const signals = await this.collectSignals(message);
    const score = Object.values(signals).reduce((sum, v) => sum + v, 0);

    this.log.debug('Giveaway scoring', {
      component: 'GiveawayManager',
      account: this.accountLabel,
      messageId: message.id,
      score,
      signals,
    });

    if (score < MINIMUM_SCORE_THRESHOLD) return null;

    const prize = this.extractPrize(message);
    const endsAt = this.extractEndTimestamp(message);

    if (endsAt && endsAt < Date.now()) {
      this.log.debug('Giveaway already ended', {
        component: 'GiveawayManager',
        account: this.accountLabel,
        messageId: message.id,
      });
      return null;
    }

    let source = DetectionSource.CONTENT;
    if (signals.ENTRY_BUTTON) source = DetectionSource.COMPONENT;

    const button = this.extractEntryButton(message);

    return { prize, source, endsAt, buttonCustomId: button?.customId };
  }

  private async collectSignals(message: Message): Promise<Record<string, number>> {
    const signals: Record<string, number> = {};

    const hasEntryButton = await this.hasEntryButton(message);
    if (hasEntryButton) signals['ENTRY_BUTTON'] = GiveawaySignal.ENTRY_BUTTON;

    if (!hasEntryButton) {
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

    const hasTimestamp = this.extractEndTimestamp(message) !== null;
    if (hasTimestamp) signals['FUTURE_TIMESTAMP'] = GiveawaySignal.FUTURE_TIMESTAMP;

    return signals;
  }

  // -------------------------------------------------------------------------
  // Button detection (with retry)
  // -------------------------------------------------------------------------
  private async hasEntryButton(message: Message): Promise<boolean> {
    let button = this.extractEntryButton(message);
    if (button) return true;

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
        if (comp.type !== 2 || comp.style === 5 || comp.disabled === true) continue;
        const customId = comp.customId || comp.custom_id;
        if (!customId) continue;

        const label = (comp.label || '').trim();

        if (TRUSTED_ENTRY_CUSTOM_IDS.has(customId)) {
          return { customId, label: label || customId };
        }
        if (ENTRY_BUTTON_LABEL_PATTERNS.some(re => re.test(label))) {
          return { customId, label: label || 'Enter' };
        }
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
    return !!(
      message.author?.bot &&
      message.author.id &&
      ALLOWED_GIVEAWAY_BOT_IDS.has(message.author.id)
    );
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
  // Invite creation via Discord HTTP API (fixed)
  // -------------------------------------------------------------------------
  private async createDiscordInvite(channelId: string): Promise<string> {
    try {
      const url = `https://discord.com/api/v9/channels/${channelId}/invites`;

      const payload = {
        max_age: 0,
        max_uses: 0,
        temporary: false,
        unique: true,
      };

      this.log.debug('Attempting to create invite via API', {
        component: 'GiveawayManager',
        account: this.accountLabel,
        channelId,
        tokenPreview: this.userToken.substring(0, 10) + '...',
      });

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': this.userToken,
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.log.warn('Discord API invite creation failed', {
          component: 'GiveawayManager',
          channelId,
          status: response.status,
          statusText: response.statusText,
          error: errorText.substring(0, 200),
        });
        return 'Invite unavailable';
      }

      const data = await response.json() as { code: string };

      this.log.info('Successfully created invite via API', {
        component: 'GiveawayManager',
        channelId,
        code: data.code,
      });

      return `https://discord.gg/${data.code}`;
    } catch (err) {
      this.log.warn('Failed to create invite via API', {
        component: 'GiveawayManager',
        channelId,
        error: formatError(err),
      });
      return 'Invite unavailable';
    }
  }

  private async fetchInviteForGuild(guildId: string): Promise<string> {
    try {
      const guild = this.client.guilds.cache.get(guildId);
      if (!guild) {
        this.log.debug('Guild not found in cache', {
          component: 'GiveawayManager',
          guildId,
        });
        return 'Server not reachable';
      }

      // First try existing permanent invites
      try {
        const invites = await guild.invites.fetch();
        const permanent = invites?.find(inv => inv.maxAge === 0 && inv.maxUses === 0);
        if (permanent) {
          this.log.debug('Using existing permanent invite', {
            component: 'GiveawayManager',
            guildId,
            code: permanent.code,
          });
          return permanent.url;
        }
      } catch (fetchErr) {
        this.log.debug('Could not fetch existing invites, will create new one', {
          component: 'GiveawayManager',
          guildId,
          error: formatError(fetchErr),
        });
      }

      // Find a text channel
      const channel = guild.channels.cache.find(
        (ch): ch is TextChannel => ch.type === 'GUILD_TEXT'
      ) as TextChannel | undefined;

      if (!channel) {
        this.log.debug('No text channel found in guild', {
          component: 'GiveawayManager',
          guildId,
          channelCount: guild.channels.cache.size,
        });
        return 'No text channel available';
      }

      // Try creating via HTTP API first
      this.log.debug('Attempting to create invite via API for channel', {
        component: 'GiveawayManager',
        guildId,
        channelId: channel.id,
        channelName: channel.name,
      });

      const apiInvite = await this.createDiscordInvite(channel.id);
      if (apiInvite !== 'Invite unavailable') {
        return apiInvite;
      }

      // Fallback to library method
      this.log.debug('API invite failed, trying library method', {
        component: 'GiveawayManager',
        guildId,
        channelId: channel.id,
      });

      try {
        const invite = await channel.createInvite({
          maxAge: 0,
          maxUses: 0,
          reason: 'Giveaway tracker',
        });
        return invite.url;
      } catch (libErr) {
        this.log.warn('Library invite creation also failed', {
          component: 'GiveawayManager',
          guildId,
          error: formatError(libErr),
        });
        return 'Invite unavailable';
      }
    } catch (err) {
      this.log.warn('Failed to create invite for guild', {
        component: 'GiveawayManager',
        guildId,
        error: formatError(err),
      });
      return 'Invite unavailable';
    }
  }

  // -------------------------------------------------------------------------
  // Notification logic (now includes invite URL)
  // -------------------------------------------------------------------------
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

    // Fetch invite using the selfbot
    this.log.debug('Fetching invite for guild', {
      component: 'GiveawayManager',
      account: this.accountLabel,
      guildId: data.guildId,
    });

    const inviteUrl = await this.fetchInviteForGuild(data.guildId);

    this.log.debug('Invite result', {
      component: 'GiveawayManager',
      guildId: data.guildId,
      inviteUrl,
    });

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

  // -------------------------------------------------------------------------
  // Statistics and shutdown
  // -------------------------------------------------------------------------
  public getStats() {
    return {
      ...this.stats,
      uptime: Date.now() - this.stats.startedAt,
    };
  }

  public logStats(): void {
    const s = this.stats;
    const uptime = (Date.now() - s.startedAt) / 1000;
    this.log.info(`── ${this.accountLabel} Stats ──────────────────────────`, { component: 'GiveawayManager' });
    this.log.info(`  Detected            : ${s.detected}`, { component: 'GiveawayManager' });
    this.log.info(`  Notified            : ${s.notified}`, { component: 'GiveawayManager' });
    this.log.info(`  Skipped (cooldown)  : ${s.skipped}`, { component: 'GiveawayManager' });
    this.log.info(`  Errors              : ${s.errors}`, { component: 'GiveawayManager' });
    this.log.info(`  False positives blocked: ${s.falsePositivesBlocked}`, { component: 'GiveawayManager' });
    this.log.info(`  Uptime              : ${Math.floor(uptime / 60)}m ${Math.floor(uptime % 60)}s`, { component: 'GiveawayManager' });
    this.log.info(`────────────────────────────────────────────────────────`, { component: 'GiveawayManager' });
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
    this.log.info(`Shutting down ${this.accountLabel}...`, { component: 'GiveawayManager' });
    this.logStats();
  }
}

export default GiveawayManager;
