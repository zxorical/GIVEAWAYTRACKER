/**
 * @module giveawayManager
 *
 * Core giveaway detection, queuing, and entry logic for a single Discord
 * account session.
 */

import { Client, Message, TextChannel } from 'discord.js-selfbot-v13';
import { EventEmitter } from 'events';
import {
  AppConfig,
  GiveawayEntry,
  GiveawayStats,
  ManagerState,
  EntryMethod,
  EntryStatus,
  DetectionSource,
  GiveawayButton,
} from './types.js';
import { AppLogger } from './logger.js';
import { BotManager } from './bot.js';
import { AutoJoinService } from './autojoin/AutoJoinService.js';
import {
  hasGiveawayKeyword,
  delay,
  formatError,
  truncate,
  sanitizeForLog,
  formatTimestamp,
  formatDuration,
} from './utils.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Known giveaway bot Snowflake IDs.
 */
const KNOWN_GIVEAWAY_BOT_IDS: ReadonlySet<string> = new Set([
  '294882584201003009', // GiveawayBot
  '739448630517039104', // GiveawayBoat
  '515195524879237130',
  '235148962103951360',
  '282859044593598464',
  '270904126974590976',
  '508391840525975553',
  '530082442967646230', // Another GiveawayBot
]);

/** Maximum simultaneously executing entry workers. */
const MAX_CONCURRENT = 3;

/** How long to keep completed entries before pruning (2 hours). */
const ENTRY_TTL_MS = 2 * 60 * 60 * 1_000;

/** How long to suppress duplicate win notifications for the same channel+author (30 min). */
const WIN_DEDUP_TTL_MS = 30 * 60 * 1_000;

/**
 * Milliseconds to wait before retrying detection when components are missing.
 */
const COMPONENT_RETRY_DELAY_MS = 300;

/** How many times to retry the component fetch before giving up. */
const COMPONENT_RETRY_ATTEMPTS = 3;

/**
 * customIds that are always giveaway entry buttons regardless of their label.
 */
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
  'join',
  'giveaway',
]);

/**
 * Regex patterns for button labels that must NEVER be clicked.
 */
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

/**
 * Button labels that identify a giveaway ENTRY button.
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
  /click\s+to\s+enter/i,
  /press\s+to\s+enter/i,
  /react\s+to\s+enter/i,
  /enter\s+to\s+win/i,
];

/**
 * If ANY of these patterns match the message's plain-text content the entire
 * message is rejected for ENTRY.
 */
const BLOCKED_MESSAGE_CONTENT: ReadonlyArray<RegExp> = [
  /already\s+entered\s+this\s+giveaway/i,
  /you(?:'ve|\s+have)\s+already\s+entered/i,
  /you\s+are\s+already\s+(?:in|entered|participating)/i,
  /you(?:'ve|\s+have)\s+already\s+(?:joined|joined\s+this)/i,
  /leave\s+giveaway/i,
  /giveaway\s+(?:has\s+)?ended/i,
  /giveaway\s+(?:is\s+)?over/i,
  /this\s+giveaway\s+is\s+now\s+closed/i,
];

/**
 * Win notification patterns.
 */
const WIN_PATTERNS: ReadonlyArray<RegExp> = [
  /congratulations?[^.!?\n]{0,60}(?:you|won)/i,
  /you(?:'ve|\s+have)\s+won/i,
  /you\s+won\s/i,
  /you\s+are\s+(?:a\s+)?(?:the\s+)?winner/i,
  /\bwinner[s]?\b/i,
  /has\s+won\s+(?:the\s+)?giveaway/i,
  /won\s+the\s+giveaway/i,
  /won\s+(?:a\s+)?(?:the\s+)?(?:prize|raffle|giveaway)/i,
  /🎉\s*congrat/i,
  /🏆\s*(?:congrat|winner|you)/i,
  /you\s+did\s+not\s+win/i,
  /results\s+are\s+in/i,
  /thank\s+you\s+for\s+participating/i,
];

// ---------------------------------------------------------------------------
// Token-bucket rate limiter
// ---------------------------------------------------------------------------

class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly maxTokens: number,
    private readonly refillIntervalMs: number,
  ) {
    this.tokens = maxTokens;
    this.lastRefill = Date.now();
  }

  async consume(): Promise<void> {
    this.refill();
    if (this.tokens <= 0) {
      const waitMs = this.refillIntervalMs - (Date.now() - this.lastRefill);
      await delay(Math.max(waitMs, 50));
      this.refill();
    }
    this.tokens = Math.max(0, this.tokens - 1);
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const batches = Math.floor(elapsed / this.refillIntervalMs);
    if (batches > 0) {
      this.tokens = Math.min(this.maxTokens, this.tokens + batches * this.maxTokens);
      this.lastRefill = now;
    }
  }
}

// ---------------------------------------------------------------------------
// GiveawayManager
// ---------------------------------------------------------------------------

export class GiveawayManager extends EventEmitter {
  private readonly client: Client;
  private readonly config: AppConfig;
  private readonly log: AppLogger;
  private readonly state: ManagerState;
  private readonly accountLabel: string;
  private readonly botManager: BotManager | null;
  private readonly autoJoinService?: AutoJoinService;

  // Queue
  private readonly queue: GiveawayEntry[] = [];
  private activeEntries = 0;
  private queueRunning = false;
  private shutdownResolve: (() => void) | null = null;

  /** Dedup map: `${channelId}:${authorId}` → timestamp of last win notification. */
  private readonly recentWins = new Map<string, number>();

  // Cleanup timer handle
  private cleanupHandle: ReturnType<typeof setInterval> | null = null;

  private stats = {
    totalDetected: 0,
    totalSucceeded: 0,
    totalFailed: 0,
    totalSkipped: 0,
    totalDuplicates: 0,
    totalWins: 0,
    serversJoined: 0,
    serversJoinFailed: 0,
    startedAt: Date.now(),
    lastDetectedAt: undefined as number | undefined,
    lastSuccessAt: undefined as number | undefined,
  };

  // ---------------------------------------------------------------------------

  constructor(
    client: Client,
    config: AppConfig,
    log: AppLogger,
    token: string,
    accountLabel = 'main',
    botManager: BotManager | null = null,
    autoJoinService?: AutoJoinService,
  ) {
    super();
    this.client = client;
    this.config = config;
    this.log = log;
    this.accountLabel = accountLabel;
    this.botManager = botManager;
    this.autoJoinService = autoJoinService;

    this.state = {
      entries: new Map<string, GiveawayEntry>(),
      processing: new Set<string>(),
      stats: this.getStats(),
    };

    this.cleanupHandle = setInterval(() => {
      this.pruneEntries();
      this.pruneWinDedup();
    }, 60_000);
    this.cleanupHandle.unref();

    console.log(`🔥 [GiveawayManager] Initialized with AutoJoinService: ${!!this.autoJoinService}`);
  }

  // ---------------------------------------------------------------------------
  // Public API — entry detection
  // ---------------------------------------------------------------------------

  public async handleMessage(message: Message): Promise<void> {
    if (!message.guild) return;
    if (message.author?.id === this.client.user?.id) return;
    if (
      this.config.monitoredChannels.length > 0 &&
      !this.config.monitoredChannels.includes(message.channel.id)
    ) return;

    const entryId = this.makeId(message);

    if (this.state.entries.has(entryId)) {
      this.stats.totalDuplicates++;
      return;
    }
    if (this.state.processing.has(entryId)) return;

    this.state.processing.add(entryId);

    try {
      const detected = await this.detectGiveaway(message);
      if (!detected) return;

      const entry: GiveawayEntry = {
        entryId,
        messageId: message.id,
        channelId: message.channel.id,
        guildId: message.guild.id,
        authorId: message.author?.id ?? '',
        guildName: message.guild.name,
        channelName: (message.channel as { name?: string }).name ?? 'unknown',
        prize: detected.prize,
        entryMethod: detected.method,
        buttonCustomId: detected.button?.customId,
        detectionSource: DetectionSource.COMPONENT,
        detectedAt: Date.now(),
        endsAt: this.extractEndTimestamp(message),
        status: EntryStatus.PENDING,
        attempts: 0,
      };

      this.state.entries.set(entryId, entry);
      this.stats.totalDetected++;
      this.stats.lastDetectedAt = Date.now();

      this.log.info('🎯 Giveaway detected', {
        component: 'GiveawayManager',
        account: this.accountLabel,
        prize: truncate(entry.prize, 80),
        guild: entry.guildName,
        channel: `#${entry.channelName}`,
        method: EntryMethod[entry.entryMethod],
        button: detected.button?.label ?? 'n/a',
        customId: detected.button?.customId ?? 'n/a',
        endsAt: entry.endsAt ? formatTimestamp(entry.endsAt) : 'unknown',
      });

      // EMIT EVENT FOR AUTOJOIN
      this.emit('giveawayDetected', entry);

      // DIRECTLY CALL AUTOJOIN SERVICE
      if (this.autoJoinService && detected.button?.customId) {
        console.log(`🔥 [AUTOJOIN] 🎯 AutoJoin triggered for: ${entry.prize}`);
        this.autoJoinService.handleGiveawayDetected({
          messageId: entry.messageId,
          channelId: entry.channelId,
          guildId: entry.guildId,
          guildName: entry.guildName,
          channelName: entry.channelName,
          prize: entry.prize,
          buttonCustomId: detected.button.customId,
          detectedAt: entry.detectedAt,
        }).catch((err: unknown) => {
          console.error('🔥 [AUTOJOIN] Error:', formatError(err));
        });
      }

      this.enqueueEntry(entry);
    } catch (err: unknown) {
      this.log.error('handleMessage: unexpected error', {
        component: 'GiveawayManager',
        account: this.accountLabel,
        entryId,
        error: formatError(err),
      });
    } finally {
      this.state.processing.delete(entryId);
    }
  }

  // ---------------------------------------------------------------------------
  // Public API — win detection
  // ---------------------------------------------------------------------------

  public async handleWin(message: Message): Promise<boolean> {
    if (!message.guild || !message.author?.bot) return false;

    const myId = this.client.user?.id;
    if (!myId) return false;

    const mentionedInUsers = message.mentions?.users?.has(myId) ?? false;
    const mentionedInContent = (message.content ?? '').includes(myId);
    if (!mentionedInUsers && !mentionedInContent) return false;

    const allText = this.extractAllText(message);
    if (!WIN_PATTERNS.some(re => re.test(allText))) return false;

    return this.processWin(message, 'guild');
  }

  public async handleDmWin(message: Message): Promise<boolean> {
    if (message.guild) return false;

    const allText = this.extractAllText(message);
    if (!WIN_PATTERNS.some(re => re.test(allText))) return false;

    return this.processWin(message, 'dm');
  }

  private async processWin(message: Message, source: 'guild' | 'dm'): Promise<boolean> {
    const dedupKey = `${message.channel.id}:${message.author?.id ?? 'unknown'}`;
    const lastWin = this.recentWins.get(dedupKey);
    if (lastWin && Date.now() - lastWin < WIN_DEDUP_TTL_MS) {
      this.log.debug('Win dedup — suppressing duplicate notification', {
        component: 'GiveawayManager',
        account: this.accountLabel,
        dedupKey,
      });
      return false;
    }
    this.recentWins.set(dedupKey, Date.now());

    const prize = this.extractPrize(message);
    const sourceName = source === 'dm'
      ? 'Direct Message'
      : `#${(message.channel as { name?: string }).name ?? message.channel.id} in ${message.guild?.name ?? 'unknown server'}`;

    this.stats.totalWins++;

    this.log.info('🏆 WIN DETECTED', {
      component: 'GiveawayManager',
      account: this.accountLabel,
      source,
      sourceName,
      prize,
      authorId: message.author?.id,
      authorName: message.author?.username ?? 'unknown',
      guildName: message.guild?.name ?? 'DM',
    });

    await this.sendWinWebhook(message, prize, sourceName).catch((err: unknown) => {
      this.log.error('Win webhook failed', {
        component: 'GiveawayManager',
        account: this.accountLabel,
        error: formatError(err),
      });
    });

    this.emit('giveawayWon', { message, prize, source: sourceName });
    return true;
  }

  // ---------------------------------------------------------------------------
  // Public utilities
  // ---------------------------------------------------------------------------

  public getStats() {
    const active = this.state.entries.size;
    return {
      totalDetected: this.stats.totalDetected,
      activeGiveaways: active,
      serversWithGiveaways: new Set(Array.from(this.state.entries.values()).map(e => e.guildId)).size,
      lastDetected: this.stats.lastDetectedAt ?? null,
    };
  }

  public getEntryCount(): number { return this.state.entries.size; }
  public getQueueLength(): number { return this.queue.length; }

  public recordServerJoin(success: boolean): void {
    if (success) this.stats.serversJoined++;
    else this.stats.serversJoinFailed++;
  }

  public logStats(): void {
    const s = this.stats;
    const rows: [string, string | number][] = [
      ['Account', this.accountLabel],
      ['Uptime', formatDuration(Date.now() - s.startedAt)],
      ['Detected', s.totalDetected],
      ['Succeeded', s.totalSucceeded],
      ['Failed', s.totalFailed],
      ['Skipped', s.totalSkipped],
      ['Duplicates', s.totalDuplicates],
      ['Wins', s.totalWins],
      ['Servers Joined', s.serversJoined],
      ['Queue Length', this.queue.length],
      ['Active Workers', this.activeEntries],
      ['Tracked Entries', this.state.entries.size],
      ['Last Success', s.lastSuccessAt ? formatTimestamp(s.lastSuccessAt) : 'never'],
    ];
    this.log.info('── Statistics ───────────────────────────────────────', { component: 'GiveawayManager' });
    for (const [label, val] of rows) {
      this.log.info(`  ${label.padEnd(16)}: ${val}`, { component: 'GiveawayManager' });
    }
    this.log.info('─────────────────────────────────────────────────────', { component: 'GiveawayManager' });
  }

  public resetState(): void {
    this.state.entries.clear();
    this.state.processing.clear();
    this.recentWins.clear();
    this.queue.length = 0;
    this.activeEntries = 0;
    this.stats = {
      totalDetected: 0,
      totalSucceeded: 0,
      totalFailed: 0,
      totalSkipped: 0,
      totalDuplicates: 0,
      totalWins: 0,
      serversJoined: 0,
      serversJoinFailed: 0,
      startedAt: Date.now(),
      lastDetectedAt: undefined,
      lastSuccessAt: undefined,
    };
    this.log.warn('GiveawayManager state reset — all entries cleared', {
      component: 'GiveawayManager',
      account: this.accountLabel,
    });
  }

  public async shutdown(): Promise<void> {
    this.log.info('Shutting down GiveawayManager…', {
      component: 'GiveawayManager',
      account: this.accountLabel,
    });
    if (this.cleanupHandle) {
      clearInterval(this.cleanupHandle);
      this.cleanupHandle = null;
    }

    if (this.queue.length > 0 || this.activeEntries > 0) {
      this.log.info(
        `Draining: ${this.queue.length} queued, ${this.activeEntries} active`,
        { component: 'GiveawayManager', account: this.accountLabel },
      );
      await Promise.race([
        new Promise<void>(resolve => { this.shutdownResolve = resolve; }),
        delay(10_000),
      ]);
    }

    this.logStats();
  }

  // ---------------------------------------------------------------------------
  // Queue
  // ---------------------------------------------------------------------------

  private enqueueEntry(entry: GiveawayEntry): void {
    this.queue.push(entry);
    this.drainQueue();
  }

  private drainQueue(): void {
    if (this.queueRunning) return;
    this.queueRunning = true;

    while (this.queue.length > 0 && this.activeEntries < MAX_CONCURRENT) {
      const entry = this.queue.shift()!;
      this.activeEntries++;

      this.enterGiveaway(entry)
        .catch(() => { /* errors are handled inside enterGiveaway */ })
        .finally(() => {
          this.activeEntries--;
          this.queueRunning = false;
          this.drainQueue();

          if (
            this.shutdownResolve !== null &&
            this.queue.length === 0 &&
            this.activeEntries === 0
          ) {
            this.shutdownResolve();
            this.shutdownResolve = null;
          }
        });
    }

    this.queueRunning = false;
  }

  // ---------------------------------------------------------------------------
  // Entry execution
  // ---------------------------------------------------------------------------

  private async enterGiveaway(entry: GiveawayEntry): Promise<void> {
    const { entryId } = entry;
    entry.status = EntryStatus.ATTEMPTING;
    let lastError = '';
    const maxAttempts = this.config.maxRetries + 1;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      entry.attempts = attempt + 1;
      entry.lastAttemptAt = Date.now();

      if (attempt > 0) {
        const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 30000);
        this.log.info(`Retry ${attempt + 1}/${maxAttempts}`, {
          component: 'GiveawayManager',
          account: this.accountLabel,
          entryId,
          backoffMs,
        });
        await delay(backoffMs);
      }

      try {
        const skipped = await this.executeEntry(entry);
        if (skipped) return;

        entry.status = EntryStatus.SUCCESS;
        this.stats.totalSucceeded++;
        this.stats.lastSuccessAt = Date.now();

        this.log.info('✅ Entered giveaway', {
          component: 'GiveawayManager',
          account: this.accountLabel,
          entryId,
          prize: truncate(entry.prize, 60),
          attempts: entry.attempts,
          guild: entry.guildName,
        });

        this.emit('giveawayEntered', entry);
        this.sendWebhook(entry).catch(() => undefined);
        return;
      } catch (err: unknown) {
        lastError = formatError(err);
        entry.lastError = lastError;
        this.log.warn(`Attempt ${attempt + 1}/${maxAttempts} failed`, {
          component: 'GiveawayManager',
          account: this.accountLabel,
          entryId,
          error: lastError,
          remaining: maxAttempts - attempt - 1,
        });
      }
    }

    entry.status = EntryStatus.FAILED;
    this.stats.totalFailed++;

    this.log.error('❌ All retries exhausted', {
      component: 'GiveawayManager',
      account: this.accountLabel,
      entryId,
      prize: truncate(entry.prize, 60),
      attempts: entry.attempts,
      lastError,
    });

    this.emit('giveawayFailed', entry);
  }

  private async executeEntry(entry: GiveawayEntry): Promise<boolean> {
    if (entry.entryMethod === EntryMethod.BUTTON) return this.enterViaButton(entry);
    if (entry.entryMethod === EntryMethod.REACTION) return this.enterViaReaction(entry);
    throw new Error(`Unsupported entry method: ${String(entry.entryMethod)}`);
  }

  // ---------------------------------------------------------------------------
  // Button entry
  // ---------------------------------------------------------------------------

  private async enterViaButton(entry: GiveawayEntry): Promise<boolean> {
    if (!entry.buttonCustomId) throw new Error('No buttonCustomId set on entry');

    if (this.config.buttonDelayMs && this.config.buttonDelayMs > 0) {
      await delay(this.config.buttonDelayMs);
    }

    const message = await this.fetchMessage(entry.channelId, entry.messageId);
    if (!message) throw new Error(`Message ${entry.messageId} not found on re-fetch`);

    const button = this.findButtonById(message, entry.buttonCustomId);

    if (!button) {
      this.log.info('Button gone — assuming already entered or giveaway ended', {
        component: 'GiveawayManager',
        account: this.accountLabel,
        entryId: entry.entryId,
        customId: entry.buttonCustomId,
      });
      entry.status = EntryStatus.SKIPPED;
      this.stats.totalSkipped++;
      return true;
    }

    if (button.disabled) {
      this.log.info('Button disabled — giveaway ended or already entered', {
        component: 'GiveawayManager',
        account: this.accountLabel,
        entryId: entry.entryId,
        customId: entry.buttonCustomId,
      });
      entry.status = EntryStatus.SKIPPED;
      this.stats.totalSkipped++;
      return true;
    }

    await this.clickComponent(message, button);
    return false;
  }

  // ---------------------------------------------------------------------------
  // Reaction entry
  // ---------------------------------------------------------------------------

  private async enterViaReaction(entry: GiveawayEntry): Promise<boolean> {
    const emoji = entry.reactionEmoji ?? '🎉';

    if (this.config.reactionDelayMs && this.config.reactionDelayMs > 0) {
      await delay(this.config.reactionDelayMs);
    }

    const message = await this.fetchMessage(entry.channelId, entry.messageId);
    if (!message) throw new Error(`Message ${entry.messageId} not found on re-fetch`);

    const existing = message.reactions?.cache?.get(emoji) as { me?: boolean } | undefined;
    if (existing?.me) {
      this.log.info('Already reacted — skipping', {
        component: 'GiveawayManager',
        account: this.accountLabel,
        entryId: entry.entryId,
        emoji,
      });
      entry.status = EntryStatus.SKIPPED;
      this.stats.totalSkipped++;
      return true;
    }

    await message.react(emoji);
    return false;
  }

  // ---------------------------------------------------------------------------
  // Component interaction
  // ---------------------------------------------------------------------------

  private async clickComponent(message: Message, button: GiveawayButton): Promise<void> {
    const selfbotMsg = message as Message & { clickButton?: (id: string) => Promise<unknown> };
    if (typeof selfbotMsg.clickButton === 'function') {
      await selfbotMsg.clickButton(button.customId);
      return;
    }
    // If clickButton not available, try direct API
    await this.postInteractionDirect(message, button);
  }

  private async postInteractionDirect(message: Message, button: GiveawayButton): Promise<void> {
    const token = (this.client as any).token;
    if (!token) throw new Error('No token available');

    const nonce = `${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
    const appId = (message as any).applicationId ?? (message as any).application_id ?? message.author?.id;

    const payload = {
      type: 3,
      nonce,
      guild_id: message.guild?.id ?? null,
      channel_id: message.channel.id,
      message_id: message.id,
      application_id: appId,
      session_id: `giveaway-${Date.now()}`,
      data: { component_type: 2, custom_id: button.customId },
    };

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
      throw new Error(`Interaction failed: ${response.status} - ${text.slice(0, 100)}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Giveaway detection
  // ---------------------------------------------------------------------------

  private async detectGiveaway(
    message: Message,
  ): Promise<{ prize: string; method: EntryMethod; button?: GiveawayButton } | null> {
    const rawContent = message.content ?? '';
    if (BLOCKED_MESSAGE_CONTENT.some(re => re.test(rawContent))) {
      this.log.debug('Rejected — blocked message content pattern matched', {
        component: 'GiveawayManager',
        account: this.accountLabel,
        preview: truncate(rawContent, 80),
      });
      return null;
    }

    const isKnownBot = this.isKnownGiveawayBot(message);
    const hasKeyword = this.messageHasKeyword(message);
    const hasEmbedSignal = this.messageHasEmbedSignal(message);
    const hasSignal = isKnownBot || hasKeyword || hasEmbedSignal;

    if (!hasSignal) {
      this.log.debug('No giveaway signal detected', {
        component: 'GiveawayManager',
        account: this.accountLabel,
        messageId: message.id,
        authorId: message.author?.id,
        isKnownBot,
        hasKeyword,
        hasEmbedSignal,
      });
      return null;
    }

    const immediate = this.tryExtractEntry(message, isKnownBot);
    if (immediate) return immediate;

    for (let i = 0; i < COMPONENT_RETRY_ATTEMPTS; i++) {
      await delay(COMPONENT_RETRY_DELAY_MS);
      try {
        const refreshed = await message.fetch();
        const result = this.tryExtractEntry(refreshed, isKnownBot);
        if (result) return result;
      } catch {
        break;
      }
    }

    if (hasSignal) {
      this.log.debug('Giveaway signal present but no usable entry button found', {
        component: 'GiveawayManager',
        account: this.accountLabel,
        messageId: message.id,
        isKnownBot,
        hasKeyword,
        hasEmbedSignal,
      });
    }

    return null;
  }

  private tryExtractEntry(
    message: Message,
    isKnownBot: boolean,
  ): { prize: string; method: EntryMethod; button: GiveawayButton } | null {
    const button = this.extractEntryButton(message, isKnownBot);
    if (!button) return null;
    return { prize: this.extractPrize(message), method: EntryMethod.BUTTON, button };
  }

  private extractEntryButton(message: Message, _isKnownBot: boolean): GiveawayButton | null {
    const msgAny = message as unknown as Record<string, unknown>;
    const components = msgAny['components'] as unknown[] | undefined;
    if (!components?.length) return null;

    for (const row of components) {
      const rowAny = row as Record<string, unknown>;
      const rowComps = rowAny['components'] as unknown[] | undefined;
      if (!rowComps) continue;

      for (const comp of rowComps) {
        const c = comp as Record<string, unknown>;

        const type = c['type'];
        if (type !== 2 && type !== 'BUTTON') continue;
        if (c['style'] === 5) continue;
        if (c['disabled'] === true) continue;

        const customId = (c['customId'] ?? c['custom_id']) as string | undefined;
        if (!customId) continue;

        const label = ((c['label'] as string | undefined) ?? '').trim();

        if (BLOCKED_BUTTON_LABELS.some(re => re.test(label))) {
          continue;
        }

        if (TRUSTED_ENTRY_CUSTOM_IDS.has(customId)) {
          return { customId, label: label || customId, disabled: false };
        }

        if (ENTRY_BUTTON_PATTERNS.some(re => re.test(label))) {
          return { customId, label: label || 'Enter', disabled: false };
        }
      }
    }

    return null;
  }

  private findButtonById(message: Message, customId: string): GiveawayButton | null {
    const msgAny = message as unknown as Record<string, unknown>;
    const components = msgAny['components'] as unknown[] | undefined;
    if (!components) return null;

    for (const row of components) {
      const rowAny = row as Record<string, unknown>;
      const rowComps = rowAny['components'] as unknown[] | undefined;
      if (!rowComps) continue;

      for (const comp of rowComps) {
        const c = comp as Record<string, unknown>;
        const id = (c['customId'] ?? c['custom_id']) as string | undefined;
        if (id !== customId) continue;
        return {
          customId: id,
          label: ((c['label'] as string | undefined) ?? ''),
          disabled: (c['disabled'] as boolean | undefined) ?? false,
        };
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Signal helpers
  // ---------------------------------------------------------------------------

  private isKnownGiveawayBot(message: Message): boolean {
    return !!(
      message.author?.bot &&
      message.author.id &&
      KNOWN_GIVEAWAY_BOT_IDS.has(message.author.id)
    );
  }

  private messageHasKeyword(message: Message): boolean {
    const texts = [
      message.content ?? '',
      ...message.embeds.flatMap(e => [
        e.title ?? '',
        e.description ?? '',
        e.footer?.text ?? '',
        ...(e.fields ?? []).flatMap(f => [f.name, f.value]),
      ]),
    ];
    return texts.some(t => hasGiveawayKeyword(t));
  }

  private messageHasEmbedSignal(message: Message): boolean {
    if (!message.embeds?.length) return false;
    
    for (const embed of message.embeds) {
      const text = [
        embed.title ?? '',
        embed.description ?? '',
        embed.footer?.text ?? '',
        ...(embed.fields ?? []).flatMap(f => [f.name, f.value]),
      ].join(' ');
      
      if (hasGiveawayKeyword(text)) return true;
      if (/\bends?\s+in\b/i.test(text)) return true;
      if (/\bwinners?\b/i.test(text)) return true;
      if (/\bprize\b/i.test(text)) return true;
      if (/\bgiveaway\b/i.test(text)) return true;
      if (/\braffle\b/i.test(text)) return true;
      if (/🎉/.test(text)) return true;
      if (/🎁/.test(text)) return true;
      if (/🏆/.test(text)) return true;
    }
    
    return false;
  }

  // ---------------------------------------------------------------------------
  // Text / prize extraction
  // ---------------------------------------------------------------------------

  private extractPrize(message: Message): string {
    const embed = message.embeds?.[0];
    if (embed?.title) return this.cleanText(embed.title);
    if (embed?.description) return this.cleanText(embed.description);
    if (message.content) return this.cleanText(message.content);
    return 'Unknown Prize';
  }

  private extractAllText(message: Message): string {
    return [
      message.content ?? '',
      ...message.embeds.flatMap(e => [
        e.title ?? '',
        e.description ?? '',
        e.footer?.text ?? '',
        ...(e.fields ?? []).flatMap(f => [f.name, f.value]),
      ]),
    ].join(' ');
  }

  private extractEndTimestamp(message: Message): number | undefined {
    const re = /<t:(\d{10,13})(?::[a-zA-Z])?>/;
    const allText = this.extractAllText(message);
    const match = allText.match(re);
    if (!match?.[1]) return undefined;
    const raw = parseInt(match[1], 10);
    const tsMs = raw < 1e12 ? raw * 1_000 : raw;
    return Number.isFinite(tsMs) && tsMs > Date.now() ? tsMs : undefined;
  }

  private cleanText(text: string): string {
    return truncate(sanitizeForLog(text), 200);
  }

  // ---------------------------------------------------------------------------
  // Channel / message fetching
  // ---------------------------------------------------------------------------

  private async fetchMessage(channelId: string, messageId: string): Promise<Message | null> {
    const channel = await this.fetchChannel(channelId);
    if (!channel) return null;
    try { return await channel.messages.fetch(messageId); }
    catch { return null; }
  }

  private async fetchChannel(id: string): Promise<TextChannel | null> {
    try {
      const ch = await this.client.channels.fetch(id);
      return ch && 'messages' in ch ? (ch as TextChannel) : null;
    } catch { return null; }
  }

  // ---------------------------------------------------------------------------
  // Webhooks
  // ---------------------------------------------------------------------------

  private async sendWebhook(entry: GiveawayEntry): Promise<void> {
    const url = this.config.webhookUrl;
    if (!url) return;

    const jumpUrl = `https://discord.com/channels/${entry.guildId}/${entry.channelId}/${entry.messageId}`;

    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'Giveaway Bot',
          embeds: [{
            title: '🎉 Giveaway Entered',
            color: 0x57F287,
            fields: [
              { name: '🏆 Prize', value: entry.prize, inline: false },
              { name: '🏠 Server', value: entry.guildName, inline: true },
              { name: '📢 Channel', value: `#${entry.channelName}`, inline: true },
              { name: '🔁 Attempts', value: String(entry.attempts), inline: true },
              { name: '🔗 Jump', value: `[View](${jumpUrl})`, inline: false },
              { name: '⏰ Time', value: formatTimestamp(Date.now()), inline: false },
            ],
            footer: { text: `Entry: ${entry.entryId} • ${this.accountLabel}` },
            timestamp: new Date().toISOString(),
          }],
        }),
      });
    } catch (err) {
      this.log.debug('Webhook send failed', { error: formatError(err) });
    }
  }

  private async sendWinWebhook(message: Message, prize: string, sourceName: string): Promise<void> {
    const url = this.config.winWebhookUrl ?? this.config.webhookUrl;
    if (!url) {
      this.log.warn(
        'Win detected but no WEBHOOK_URL or WIN_WEBHOOK_URL configured',
        { component: 'GiveawayManager', account: this.accountLabel },
      );
      return;
    }

    const guildName = message.guild?.name ?? 'Direct Message';
    const jumpUrl = message.guild
      ? `https://discord.com/channels/${message.guild.id}/${message.channel.id}/${message.id}`
      : null;
    const authorName = message.author?.username ?? message.author?.id ?? 'unknown';

    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: '@everyone',
          username: 'WIN Notifier',
          embeds: [{
            title: '🏆 GIVEAWAY WIN!',
            description: jumpUrl ? `[Jump to message](${jumpUrl})` : 'Won via Direct Message',
            color: 0xFFD700,
            fields: [
              { name: '🎁 Prize', value: prize, inline: false },
              { name: '🏠 Server', value: guildName, inline: true },
              { name: '📢 Source', value: sourceName, inline: true },
              { name: '🤖 Bot', value: authorName, inline: true },
              { name: '👤 Account', value: this.accountLabel, inline: true },
              { name: '⏰ Won At', value: formatTimestamp(Date.now()), inline: false },
            ],
            footer: { text: `Message ID: ${message.id}` },
            timestamp: new Date().toISOString(),
          }],
        }),
      });
    } catch (err) {
      this.log.debug('Win webhook send failed', { error: formatError(err) });
    }
  }

  // ---------------------------------------------------------------------------
  // Housekeeping
  // ---------------------------------------------------------------------------

  private pruneEntries(): void {
    const cutoff = Date.now() - ENTRY_TTL_MS;
    let pruned = 0;
    for (const [id, entry] of this.state.entries) {
      if (
        entry.detectedAt < cutoff &&
        (entry.status === EntryStatus.SUCCESS ||
          entry.status === EntryStatus.FAILED ||
          entry.status === EntryStatus.SKIPPED)
      ) {
        this.state.entries.delete(id);
        pruned++;
      }
    }
    if (pruned > 0) {
      this.log.debug(`Pruned ${pruned} old entries`, {
        component: 'GiveawayManager',
        account: this.accountLabel,
      });
    }
  }

  private pruneWinDedup(): void {
    const cutoff = Date.now() - WIN_DEDUP_TTL_MS;
    for (const [key, ts] of this.recentWins) {
      if (ts < cutoff) this.recentWins.delete(key);
    }
  }

  private makeId(message: Message): string {
    return `${message.channel.id}:${message.id}`;
  }
}

export default GiveawayManager;
