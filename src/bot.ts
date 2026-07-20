/**
 * @module bot
 * Production bot – notification queue, retries, metrics, event‑driven.
 */

import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ChatInputCommandInteraction,
  Interaction,
  CacheType,
  TextChannel,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ButtonInteraction,
  ActivityType,
  Collection,
  Invite,
  GuildBasedChannel,
  NewsChannel,
  StageChannel,
  VoiceChannel,
  ThreadChannel,
} from 'discord.js';
import { CONFIG } from './config.js';
import { logger } from './logger.js';
import { formatTimestamp, truncate, formatError } from './utils.js';
import { GiveawayData } from './types.js';
import {
  getStats,
  getTotalDetected,
  getActiveGiveaways,
  resetDatabase,
  getAllGiveaways,
  purgeEndedGiveaways,
  setNotificationMessageId,
  addItem,
  removeItem,
  getItems,
  clearItems,
} from './database.js';

declare function updateNotificationStatus(
  messageId: string,
  channelId: string,
  fields: Record<string, unknown>
): Promise<void>;

// ============================================================================
// Metrics Collector
// ============================================================================

class MetricsCollector {
  giveawaysDetected = 0;
  notificationsSent = 0;
  notificationsFailed = 0;
  retryAttempts = 0;
  detectionToNotifyLatency: number[] = [];
  mongoLatency: number[] = [];
  discordLatency: number[] = [];

  recordDetection(latencyMs: number) {
    this.giveawaysDetected++;
    this.detectionToNotifyLatency.push(latencyMs);
    if (this.detectionToNotifyLatency.length > 100) this.detectionToNotifyLatency.shift();
  }
  recordNotification(success: boolean, latencyMs: number) {
    if (success) this.notificationsSent++;
    else this.notificationsFailed++;
    this.discordLatency.push(latencyMs);
    if (this.discordLatency.length > 100) this.discordLatency.shift();
  }
  recordRetry() { this.retryAttempts++; }
  recordMongoLatency(ms: number) {
    this.mongoLatency.push(ms);
    if (this.mongoLatency.length > 100) this.mongoLatency.shift();
  }
  getSnapshot() {
    return {
      giveawaysDetected: this.giveawaysDetected,
      notificationsSent: this.notificationsSent,
      notificationsFailed: this.notificationsFailed,
      retryAttempts: this.retryAttempts,
      avgDetectionLatency: this.avg(this.detectionToNotifyLatency),
      avgMongoLatency: this.avg(this.mongoLatency),
      avgDiscordLatency: this.avg(this.discordLatency),
    };
  }
  private avg(arr: number[]): number {
    if (arr.length === 0) return 0;
    return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
  }
}

// ============================================================================
// Notification Service
// ============================================================================

interface NotificationJob {
  data: GiveawayData;
  attempt: number;
  maxRetries: number;
  messageId: string;
}

class NotificationService {
  private queue: NotificationJob[] = [];
  private processing = false;
  private dedupSet = new Set<string>();
  private bot: Client;
  private metrics: MetricsCollector;

  constructor(bot: Client, metrics: MetricsCollector) {
    this.bot = bot;
    this.metrics = metrics;
  }

  enqueue(data: GiveawayData, inviteUrl: string) {
    if (this.dedupSet.has(data.messageId)) {
      logger.debug('Notification duplicate prevented', { messageId: data.messageId });
      return;
    }
    this.dedupSet.add(data.messageId);
    (data as any).cachedInviteUrl = inviteUrl;

    this.queue.push({
      data,
      attempt: 1,
      maxRetries: 3,
      messageId: data.messageId,
    });
    this.processQueue();
  }

  private async processQueue() {
    if (this.processing) return;
    this.processing = true;
    while (this.queue.length > 0) {
      const job = this.queue.shift()!;
      try {
        await this.sendWithRetry(job);
      } catch (err) {
        logger.error('Notification failed after retries', {
          messageId: job.messageId,
          error: formatError(err),
        });
        try {
          await updateNotificationStatus?.(job.messageId, job.data.channelId, {
            notificationStatus: 'failed',
            notificationError: formatError(err),
          });
        } catch {}
      }
    }
    this.processing = false;
  }

  private async sendWithRetry(job: NotificationJob): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= job.maxRetries; attempt++) {
      try {
        job.attempt = attempt;
        await this.sendOne(job);
        return;
      } catch (err) {
        lastError = err;
        this.metrics.recordRetry();
        logger.warn(`Notification attempt ${attempt}/${job.maxRetries} failed`, {
          messageId: job.messageId,
          error: formatError(err),
        });
        if (attempt < job.maxRetries) {
          const wait = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
          await new Promise(r => setTimeout(r, wait));
        }
      }
    }
    throw lastError;
  }

  private async sendOne(job: NotificationJob): Promise<void> {
    const channel = this.bot.channels.cache.get(CONFIG.trackerChannelId) as TextChannel | undefined;
    if (!channel) throw new Error('Tracker channel not found');

    const data = job.data;
    const guild = this.bot.guilds.cache.get(data.guildId);
    const guildName = guild?.name || data.guildName || 'Unknown';
    const guildIcon = guild?.iconURL({ size: 512 }) || null;
    const guildBanner = guild?.bannerURL({ size: 1024 }) || null;
    const memberCount = guild?.memberCount ?? null;
    
    // Get invite - try cached, then passed, then generate
    let inviteUrl = (data as any).cachedInviteUrl || data.inviteUrl || 'No invite available';
    
    // If no invite, try to generate one
    if (inviteUrl === 'No invite available' && data.guildId) {
      try {
        const guild = this.bot.guilds.cache.get(data.guildId);
        if (guild) {
          // Try existing invites first
          const invites = await guild.invites.fetch().catch(() => new Collection<string, Invite>());
          const existingInvite = invites.find((inv: Invite) => inv.channelId === data.channelId && inv.maxUses === 0);
          if (existingInvite) {
            inviteUrl = existingInvite.url;
          } else {
            // Create new invite
            const channel = guild.channels.cache.get(data.channelId);
            if (channel && channel.isTextBased() && 'createInvite' in channel) {
              const perms = channel.permissionsFor(this.bot.user?.id || '');
              if (perms?.has('CreateInstantInvite')) {
                const newInvite = await channel.createInvite({
                  maxAge: 86400,
                  maxUses: 0,
                  reason: 'Giveaway notification'
                });
                inviteUrl = newInvite.url;
              }
            }
          }
        }
      } catch (err) {
        logger.debug(`Could not generate invite for notification: ${formatError(err)}`);
      }
    }

    const endsAt = data.endsAt || Date.now() + 3600000;
    const endTimestamp = Math.floor(endsAt / 1000);
    const winnerCount = extractWinnerCount(data.prize);
    const detectionTime = data.detectionTimeMs ?? (Date.now() - data.detectedAt);

    const pingMention = process.env.PING_ROLE_ID
      ? `<@&${process.env.PING_ROLE_ID}>`
      : '@everyone';

    const description = [
      `### Details`,
      `**Server:** ${guildName}`,
      `**Channel:** #${data.channelName}`,
      `**Winners:** ${winnerCount}`,
      ``,
      `### Time`,
      `**Ends:** <t:${endTimestamp}:F>`,
      `**Countdown:** <t:${endTimestamp}:R>`,
      ``,
      `### Links`,
      `**Invite:** ${inviteUrl}`,
      memberCount ? `**Members:** ${memberCount.toLocaleString()}` : '',
    ].filter(Boolean).join('\n');

    // Build the embed for the MAIN SERVER MESSAGE with thumbnail and banner
    const embed = new EmbedBuilder()
      .setAuthor({ 
        name: 'New Giveaway', 
        iconURL: this.bot.user?.displayAvatarURL() 
      })
      .setTitle(data.prize || 'Unknown Prize')
      .setDescription(description)
      .setColor(0x5865F2)
      .setTimestamp(data.detectedAt);

    // ✅ MAIN SERVER MESSAGE - Set thumbnail (server icon) if available
    if (guildIcon) {
      embed.setThumbnail(guildIcon);
    }

    // ✅ MAIN SERVER MESSAGE - Set banner (server banner) if available
    // This will display as a large image at the bottom of the embed
    if (guildBanner) {
      embed.setImage(guildBanner);
    }

    // Set footer with detection time
    embed.setFooter({ 
      text: `Detected in ${detectionTime}ms`, 
      iconURL: this.bot.user?.displayAvatarURL() 
    });

    const messageUrl = `https://discord.com/channels/${data.guildId}/${data.channelId}/${data.messageId}`;
    const row = new ActionRowBuilder<ButtonBuilder>();
    if (inviteUrl.startsWith('http')) {
      row.addComponents(new ButtonBuilder().setLabel('Join Server').setStyle(ButtonStyle.Link).setURL(inviteUrl));
    }
    row.addComponents(
      new ButtonBuilder().setLabel('Message').setStyle(ButtonStyle.Link).setURL(messageUrl),
    );

    const start = Date.now();
    const sentMessage = await channel.send({
      content: pingMention,
      embeds: [embed],
      components: [row],
    });
    this.metrics.recordNotification(true, Date.now() - start);

    await setNotificationMessageId(data.messageId, data.channelId, sentMessage.id);
    try {
      await updateNotificationStatus?.(data.messageId, data.channelId, {
        notificationStatus: 'sent',
        notificationSentAt: Date.now(),
        notificationMessageId: sentMessage.id,
      });
    } catch {}
  }
}

// ============================================================================
// Helpers
// ============================================================================

function extractWinnerCount(prize: string): string {
  const match = prize.match(/(\d+)\s*[xX×]/);
  if (match) return match[1];
  if (/\b(?:one|1)\s*(?:winner|win|giveaway)/i.test(prize)) return '1';
  const m = prize.match(/(\d+)\s*(?:winners?)/i);
  if (m) return m[1];
  return '1';
}

async function deferReply(interaction: ChatInputCommandInteraction<CacheType>, ephemeral = true) {
  await interaction.deferReply({ ephemeral });
}

function isAdmin(userId: string): boolean {
  return CONFIG.adminUserIds.includes(userId);
}

async function requireAdmin(interaction: ChatInputCommandInteraction<CacheType>): Promise<boolean> {
  if (!isAdmin(interaction.user.id)) {
    await interaction.reply({ content: 'No permission.', ephemeral: true });
    return false;
  }
  return true;
}

// ============================================================================
// BotManager
// ============================================================================

export class BotManager {
  private client: Client;
  private commandsRegistered = false;
  private presenceInterval: NodeJS.Timeout | null = null;
  private cleanupInterval: NodeJS.Timeout | null = null;

  public metrics = new MetricsCollector();
  public notifications: NotificationService;

  private commands = new Map<string, (interaction: ChatInputCommandInteraction<CacheType>) => Promise<void>>();

  constructor(private readonly botToken: string) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.DirectMessages,
      ],
    });

    this.notifications = new NotificationService(this.client, this.metrics);

    this.commands.set('stats', this.statsCommand.bind(this));
    this.commands.set('active', this.activeCommand.bind(this));
    this.commands.set('recent', this.recentCommand.bind(this));
    this.commands.set('setchannel', this.setchannelCommand.bind(this));
    this.commands.set('reset', this.resetCommand.bind(this));
    this.commands.set('status', this.statusCommand.bind(this));
    this.commands.set('metrics', this.metricsCommand.bind(this));
    this.commands.set('help', this.helpCommand.bind(this));
    this.commands.set('panel', this.panelCommand.bind(this));
    this.commands.set('purge', this.purgeCommand.bind(this));
    this.commands.set('watch', this.watchlistCommand.bind(this));

    this.client.once('ready', async () => {
      logger.info(`Logged in as ${this.client.user?.tag}`, { component: 'BotManager' });
      await this.updatePresence();
      this.presenceInterval = setInterval(() => this.updatePresence(), 30_000);
      await this.purgeAndUpdatePresence();
      this.cleanupInterval = setInterval(() => this.purgeAndUpdatePresence(), 60_000);
      await this.registerCommands();
      await this.sendRolePanel();
    });

    this.client.on('interactionCreate', async (interaction: Interaction) => {
      if (interaction.isButton()) {
        if (interaction.customId === 'toggle_ping') {
          await this.handlePingToggle(interaction);
        }
        return;
      }
      if (!interaction.isChatInputCommand()) return;
      const handler = this.commands.get(interaction.commandName);
      if (!handler) {
        await interaction.reply({ content: 'Unknown command.', ephemeral: true });
        return;
      }
      try {
        await handler(interaction);
      } catch (err) {
        logger.error(`Command error: ${interaction.commandName}`, { error: formatError(err) });
        const reply = interaction.replied || interaction.deferred ? interaction.editReply : interaction.reply;
        await reply({ content: 'Something went wrong.', ephemeral: true });
      }
    });

    this.client.on('error', (err) => logger.error('Client error', { error: err }));
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  public async start(): Promise<void> {
    const LOGIN_TIMEOUT_MS = 10000;

    logger.info('BotManager: attempting login...', { component: 'BotManager' });

    try {
      await Promise.race([
        this.client.login(this.botToken),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Login timed out after 10s')), LOGIN_TIMEOUT_MS)
        ),
      ]);

      await Promise.race([
        new Promise<void>((resolve) => {
          if (this.client.isReady()) {
            resolve();
          } else {
            this.client.once('ready', () => resolve());
          }
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Ready event timed out after 10s')), LOGIN_TIMEOUT_MS)
        ),
      ]);

      logger.info('BotManager started successfully', { component: 'BotManager' });
    } catch (err) {
      logger.error(`BotManager start failed: ${formatError(err)}`, { component: 'BotManager' });
      throw err;
    }
  }

  public async destroy(): Promise<void> {
    if (this.presenceInterval) clearInterval(this.presenceInterval);
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
    await this.client.destroy();
  }

  public async sendGiveawayNotification(data: GiveawayData & { inviteUrl?: string }): Promise<boolean> {
    this.notifications.enqueue(data, data.inviteUrl || '');
    this.metrics.recordDetection(Date.now() - data.detectedAt);
    await this.updatePresence();
    return true;
  }

  // -------------------------------------------------------------------------
  // Helper: Resolve Invite URL (same logic as sendOne, used by DMs too)
  // -------------------------------------------------------------------------
  
  private async resolveInviteUrl(guildId: string, channelId: string, fallbackInvite?: string | null): Promise<string> {
    // If we already have a valid invite, use it
    if (fallbackInvite && fallbackInvite.startsWith('http')) {
      return fallbackInvite;
    }

    let inviteUrl = 'No invite available';
    try {
      const guild = this.client.guilds.cache.get(guildId);
      if (guild) {
        // Try existing invites first
        const invites = await guild.invites.fetch().catch(() => new Collection<string, Invite>());
        const existingInvite = invites.find((inv: Invite) => inv.channelId === channelId && inv.maxUses === 0);
        if (existingInvite) {
          inviteUrl = existingInvite.url;
        } else {
          // Create new invite
          const channel = guild.channels.cache.get(channelId);
          if (channel && channel.isTextBased() && 'createInvite' in channel) {
            const perms = channel.permissionsFor(this.client.user?.id || '');
            if (perms?.has('CreateInstantInvite')) {
              const newInvite = await channel.createInvite({
                maxAge: 86400,
                maxUses: 0,
                reason: 'Giveaway notification'
              });
              inviteUrl = newInvite.url;
            }
          }
        }
      }
    } catch (err) {
      logger.debug(`Failed to resolve invite: ${formatError(err)}`);
    }

    return inviteUrl;
  }

  // -------------------------------------------------------------------------
  // Watchlist DM - Same format as main notifications with invite generation
  // -------------------------------------------------------------------------
  
  public async sendWatchlistDM(
    userId: string,
    prize: string,
    guildName: string,
    channelName: string,
    endsAt: number | null,
    messageUrl: string,
    guildId?: string,
    guildIcon?: string | null,
    detectedAt?: number,
    inviteUrl?: string | null,
    guildBanner?: string | null,
    memberCount?: number | null
  ): Promise<boolean> {
    try {
      let user;
      try {
        user = await this.client.users.fetch(userId);
      } catch {
        user = this.client.users.cache.get(userId);
        if (!user) {
          logger.debug(`User ${userId} not found`);
          return false;
        }
      }

      let dmChannel;
      try {
        dmChannel = await user.createDM();
      } catch {
        return false;
      }

      if (!dmChannel) return false;

      // Extract channel ID from message URL
      // Format: https://discord.com/channels/{guildId}/{channelId}/{messageId}
      const urlParts = messageUrl.split('/');
      const channelId = urlParts[5] || '';

      // Resolve the invite URL
      let resolvedInvite = 'No invite available';
      if (guildId && channelId) {
        resolvedInvite = await this.resolveInviteUrl(guildId, channelId, inviteUrl);
      }

      const endTimestamp = endsAt
        ? Math.floor(endsAt / 1000)
        : Math.floor((Date.now() + 3600000) / 1000);
      const winnerCount = extractWinnerCount(prize);
      const detectionTime = detectedAt ? Date.now() - detectedAt : 0;

      // Same description shape/order as sendOne
      const description = [
        `### Details`,
        `**Server:** ${guildName}`,
        `**Channel:** #${channelName}`,
        `**Winners:** ${winnerCount}`,
        ``,
        `### Time`,
        `**Ends:** <t:${endTimestamp}:F>`,
        `**Countdown:** <t:${endTimestamp}:R>`,
        ``,
        `### Links`,
        `**Invite:** ${resolvedInvite}`,
        memberCount ? `**Members:** ${memberCount.toLocaleString()}` : '',
      ].filter(Boolean).join('\n');

      const embed = new EmbedBuilder()
        .setAuthor({ 
          name: 'New Giveaway', 
          iconURL: this.client.user?.displayAvatarURL() 
        })
        .setTitle(prize || 'Unknown Prize')
        .setDescription(description)
        .setColor(0x5865F2)
        .setTimestamp(detectedAt);

      // Set thumbnail if available
      if (guildIcon) {
        embed.setThumbnail(guildIcon);
      }

      // Set banner if available
      if (guildBanner) {
        embed.setImage(guildBanner);
      }

      // Set footer
      embed.setFooter({ 
        text: `Detected in ${detectionTime}ms`, 
        iconURL: this.client.user?.displayAvatarURL() 
      });

      const row = new ActionRowBuilder<ButtonBuilder>();
      if (resolvedInvite.startsWith('http')) {
        row.addComponents(new ButtonBuilder().setLabel('Join Server').setStyle(ButtonStyle.Link).setURL(resolvedInvite));
      }
      row.addComponents(
        new ButtonBuilder().setLabel('Message').setStyle(ButtonStyle.Link).setURL(messageUrl),
      );

      await dmChannel.send({
        embeds: [embed],
        components: [row]
      });

      logger.debug(`Sent watchlist DM to ${userId} with invite: ${resolvedInvite}`);
      return true;
    } catch (err) {
      const errorMsg = formatError(err);
      if (errorMsg.includes('Cannot send messages to this user')) {
        logger.debug(`User ${userId} has DMs disabled`);
      } else if (errorMsg.includes('rate limit')) {
        logger.warn(`Rate limit hit for user ${userId}`);
      } else {
        logger.debug(`Failed to send DM to ${userId}`, { error: errorMsg });
      }
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Giveaway Ended Notification (DM)
  // -------------------------------------------------------------------------
  
  public async sendGiveawayEndedDM(
    userId: string,
    prize: string,
    guildName: string,
    channelName: string,
    messageUrl: string,
    guildIcon?: string | null
  ): Promise<boolean> {
    try {
      let user;
      try {
        user = await this.client.users.fetch(userId);
      } catch {
        user = this.client.users.cache.get(userId);
        if (!user) return false;
      }

      let dmChannel;
      try {
        dmChannel = await user.createDM();
      } catch {
        return false;
      }

      if (!dmChannel) return false;

      const embed = new EmbedBuilder()
        .setAuthor({ 
          name: 'Giveaway Ended', 
          iconURL: this.client.user?.displayAvatarURL() 
        })
        .setTitle(`${prize || 'Giveaway Ended'}`)
        .setDescription([
          `**Server:** ${guildName}`,
          `**Channel:** #${channelName}`,
          '',
          `This giveaway has ended. Better luck next time.`,
          '',
          `[View giveaway](${messageUrl})`
        ].join('\n'))
        .setColor(0xFF0000)
        .setFooter({ 
          text: 'Giveaway tracker', 
          iconURL: this.client.user?.displayAvatarURL() 
        })
        .setTimestamp();

      if (guildIcon) {
        embed.setThumbnail(guildIcon);
      }

      const row = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
          new ButtonBuilder()
            .setLabel('View Giveaway')
            .setStyle(ButtonStyle.Link)
            .setURL(messageUrl)
        );

      await dmChannel.send({ embeds: [embed], components: [row] });
      return true;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Watchlist Commands
  // -------------------------------------------------------------------------

  private async watchlistCommand(interaction: ChatInputCommandInteraction<CacheType>) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'add') await this.watchAdd(interaction);
    else if (sub === 'remove') await this.watchRemove(interaction);
    else if (sub === 'list') await this.watchList(interaction);
    else if (sub === 'clear') await this.watchClear(interaction);
  }

  private async watchAdd(interaction: ChatInputCommandInteraction<CacheType>) {
    const item = interaction.options.getString('item', true).trim().toLowerCase();

    if (item.length < 2 || item.length > 50) {
      await interaction.reply({ content: 'Item must be 2-50 characters.', ephemeral: true });
      return;
    }

    await addItem(interaction.user.id, item);
    const items = await getItems(interaction.user.id);

    await interaction.reply({
      content: `Watching **${item}**\n\nYour items:\n${items.map(i => `- ${i}`).join('\n')}`,
      ephemeral: true
    });
  }

  private async watchRemove(interaction: ChatInputCommandInteraction<CacheType>) {
    const item = interaction.options.getString('item', true).trim().toLowerCase();
    const removed = await removeItem(interaction.user.id, item);

    if (!removed) {
      await interaction.reply({ content: `"${item}" not in your watchlist.`, ephemeral: true });
      return;
    }

    const items = await getItems(interaction.user.id);
    await interaction.reply({
      content: `Removed **${item}**\n\nYour items:\n${items.map(i => `- ${i}`).join('\n')}`,
      ephemeral: true
    });
  }

  private async watchList(interaction: ChatInputCommandInteraction<CacheType>) {
    const items = await getItems(interaction.user.id);

    if (items.length === 0) {
      await interaction.reply({
        content: 'No items. Use `/watch add <item>` to start tracking giveaways.',
        ephemeral: true
      });
      return;
    }

    await interaction.reply({
      content: `**Your items (${items.length})**\n${items.map(i => `- ${i}`).join('\n')}`,
      ephemeral: true
    });
  }

  private async watchClear(interaction: ChatInputCommandInteraction<CacheType>) {
    const items = await getItems(interaction.user.id);

    if (items.length === 0) {
      await interaction.reply({ content: 'Watchlist is empty.', ephemeral: true });
      return;
    }

    await clearItems(interaction.user.id);
    await interaction.reply({
      content: `Cleared ${items.length} items.`,
      ephemeral: true
    });
  }

  // -------------------------------------------------------------------------
  // Existing Commands
  // -------------------------------------------------------------------------
  
  private async statsCommand(interaction: ChatInputCommandInteraction<CacheType>) {
    await deferReply(interaction, false);
    const stats = await getStats();
    const totalEver = await getTotalDetected();
    const embed = new EmbedBuilder()
      .setColor(0x00AAFF)
      .setTitle('Tracker Stats')
      .addFields(
        { name: 'Total Ever Tracked', value: String(totalEver), inline: true },
        { name: 'Active Now', value: String(stats.activeGiveaways), inline: true },
        { name: 'Servers', value: String(stats.serversWithGiveaways), inline: true },
        { name: 'Last Detection', value: stats.lastDetected ? formatTimestamp(stats.lastDetected) : 'Never', inline: false },
      )
      .setTimestamp();
    await interaction.editReply({ embeds: [embed] });
  }

  private async activeCommand(interaction: ChatInputCommandInteraction<CacheType>) {
    await deferReply(interaction, false);
    const active = await getActiveGiveaways(10);
    if (active.length === 0) {
      await interaction.editReply({ content: 'Nothing active right now.' });
      return;
    }
    const embed = new EmbedBuilder()
      .setColor(0xFFD700)
      .setTitle(`${active.length} Active`)
      .setTimestamp();
    for (const g of active.slice(0, 10)) {
      const ends = g.endsAt ? `<t:${Math.floor(g.endsAt / 1000)}:R>` : 'Unknown';
      embed.addFields({
        name: `${truncate(g.prize, 50)}`,
        value: `${g.guildName} - #${g.channelName}\nEnds: ${ends}`,
        inline: false,
      });
    }
    await interaction.editReply({ embeds: [embed] });
  }

  private async recentCommand(interaction: ChatInputCommandInteraction<CacheType>) {
    await deferReply(interaction, false);
    const recent = await getAllGiveaways(10);
    if (recent.length === 0) {
      await interaction.editReply({ content: 'Nothing yet.' });
      return;
    }
    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('Recent')
      .setTimestamp();
    for (const g of recent) {
      embed.addFields({
        name: `${g.status === 'active' ? '[Active]' : '[Ended]'} ${truncate(g.prize, 40)}`,
        value: `${g.guildName}\n${formatTimestamp(g.detectedAt)}`,
        inline: false,
      });
    }
    await interaction.editReply({ embeds: [embed] });
  }

  private async setchannelCommand(interaction: ChatInputCommandInteraction<CacheType>) {
    if (!await requireAdmin(interaction)) return;
    const channel = interaction.options.getChannel('channel', true);
    if (![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) {
      await interaction.reply({ content: 'Pick a text channel.', ephemeral: true });
      return;
    }
    (CONFIG as any).trackerChannelId = channel.id;
    await interaction.reply({ content: `Set to ${channel}`, ephemeral: true });
  }

  private async resetCommand(interaction: ChatInputCommandInteraction<CacheType>) {
    if (!await requireAdmin(interaction)) return;
    await deferReply(interaction, true);
    await resetDatabase();
    await interaction.editReply({ content: 'Wiped.' });
  }

  private async statusCommand(interaction: ChatInputCommandInteraction<CacheType>) {
    if (!await requireAdmin(interaction)) return;
    await deferReply(interaction, false);
    const stats = await getStats();
    const totalEver = await getTotalDetected();
    const embed = new EmbedBuilder()
      .setColor(0x00FF00)
      .setTitle('Running')
      .addFields(
        { name: 'Total Ever', value: String(totalEver), inline: true },
        { name: 'Active', value: String(stats.activeGiveaways), inline: true },
        { name: 'Servers', value: String(stats.serversWithGiveaways), inline: true },
        { name: 'Channel', value: `<#${CONFIG.trackerChannelId}>`, inline: false },
      )
      .setTimestamp();
    await interaction.editReply({ embeds: [embed] });
  }

  private async metricsCommand(interaction: ChatInputCommandInteraction<CacheType>) {
    if (!await requireAdmin(interaction)) return;
    await deferReply(interaction, false);
    const m = this.metrics.getSnapshot();
    const embed = new EmbedBuilder()
      .setColor(0x3498DB)
      .setTitle('Performance Metrics')
      .addFields(
        { name: 'Giveaways Detected', value: String(m.giveawaysDetected), inline: true },
        { name: 'Notifications Sent', value: String(m.notificationsSent), inline: true },
        { name: 'Failed Notifications', value: String(m.notificationsFailed), inline: true },
        { name: 'Retry Attempts', value: String(m.retryAttempts), inline: true },
        { name: 'Avg Detection to Notify', value: `${m.avgDetectionLatency}ms`, inline: true },
        { name: 'Avg Discord Latency', value: `${m.avgDiscordLatency}ms`, inline: true },
      )
      .setTimestamp();
    await interaction.editReply({ embeds: [embed] });
  }

  private async helpCommand(interaction: ChatInputCommandInteraction<CacheType>) {
    await deferReply(interaction, false);
    const embed = new EmbedBuilder()
      .setColor(0x9B59B6)
      .setTitle('Commands')
      .addFields(
        { name: '/stats', value: 'Detection stats', inline: false },
        { name: '/active', value: 'Active giveaways', inline: false },
        { name: '/recent', value: 'Recent giveaways', inline: false },
        { name: '/status', value: 'System status (admin)', inline: false },
        { name: '/metrics', value: 'Performance metrics (admin)', inline: false },
        { name: '/setchannel', value: 'Set notify channel (admin)', inline: false },
        { name: '/reset', value: 'Clear database (admin)', inline: false },
        { name: '/panel', value: 'Resend role panel (admin)', inline: false },
        { name: '/watch add <item>', value: 'Track giveaway items', inline: false },
        { name: '/watch remove <item>', value: 'Stop tracking item', inline: false },
        { name: '/watch list', value: 'Show tracked items', inline: false },
        { name: '/watch clear', value: 'Clear all items', inline: false },
      )
      .setFooter({ text: 'made by gab' })
      .setTimestamp();
    await interaction.editReply({ embeds: [embed] });
  }

  private async panelCommand(interaction: ChatInputCommandInteraction<CacheType>) {
    if (!await requireAdmin(interaction)) return;
    await deferReply(interaction, true);
    await this.sendRolePanel();
    await interaction.editReply({ content: 'Panel sent.' });
  }

  private async purgeCommand(interaction: ChatInputCommandInteraction<CacheType>) {
    if (!await requireAdmin(interaction)) return;
    const amount = interaction.options.getInteger('amount') || 50;
    await deferReply(interaction, true);
    const channel = interaction.channel as TextChannel;
    if (!channel) return;
    try {
      const messages = await channel.messages.fetch({ limit: 100 });
      const botMessages = messages.filter(m => m.author.id === this.client.user?.id);
      const toDelete = botMessages.first(amount);
      if (toDelete.length === 0) {
        await interaction.editReply({ content: 'Nothing to delete.' });
        return;
      }
      await channel.bulkDelete(toDelete, true);
      await interaction.editReply({ content: `Deleted ${toDelete.length}.` });
    } catch {
      await interaction.editReply({ content: 'Failed.' });
    }
  }

  // -------------------------------------------------------------------------
  // Role Panel
  // -------------------------------------------------------------------------
  
  private async sendRolePanel(): Promise<void> {
    const panelChannelId = process.env.PANEL_CHANNEL_ID || CONFIG.trackerChannelId;
    const channel = this.client.channels.cache.get(panelChannelId) as TextChannel | undefined;
    if (!channel) return;
    try {
      const messages = await channel.messages.fetch({ limit: 20 });
      const oldPanel = messages.find(m =>
        m.author.id === this.client.user?.id &&
        m.embeds.length > 0 &&
        m.embeds[0]?.title === 'Giveaway Notifications'
      );
      if (oldPanel) await oldPanel.delete().catch(() => {});
    } catch {}
    const embed = new EmbedBuilder()
      .setColor(0xF1C40F)
      .setTitle('Giveaway Notifications')
      .setDescription('Click the button to toggle giveaway pings.\nYou\'ll get mentioned whenever a new giveaway is detected.')
      .setFooter({ text: 'Toggle anytime' });
    const row = new ActionRowBuilder<ButtonBuilder>()
      .addComponents(new ButtonBuilder().setCustomId('toggle_ping').setLabel('Toggle Pings').setStyle(ButtonStyle.Primary));
    await channel.send({ embeds: [embed], components: [row] });
  }

  private async handlePingToggle(interaction: ButtonInteraction): Promise<void> {
    const pingRoleId = process.env.PING_ROLE_ID;
    if (!pingRoleId) {
      await interaction.reply({ content: 'Ping role not configured.', ephemeral: true });
      return;
    }
    const role = interaction.guild?.roles.cache.get(pingRoleId);
    if (!role) {
      await interaction.reply({ content: 'Role not found.', ephemeral: true });
      return;
    }
    const member = interaction.member;
    if (!member || !('roles' in member)) {
      await interaction.reply({ content: 'Something went wrong.', ephemeral: true });
      return;
    }
    const hasRole = (member.roles as any).cache?.has(role.id) ?? false;
    try {
      if (hasRole) {
        await (member.roles as any).remove(role);
        await interaction.reply({ content: 'Removed the role.', ephemeral: true });
      } else {
        await (member.roles as any).add(role);
        await interaction.reply({ content: 'Added the role.', ephemeral: true });
      }
    } catch {
      await interaction.reply({ content: 'Failed.', ephemeral: true });
    }
  }

  // -------------------------------------------------------------------------
  // Presence
  // -------------------------------------------------------------------------
  
  private async updatePresence() {
    const totalEver = await getTotalDetected();
    this.client.user?.setPresence({
      activities: [{ name: `${totalEver} giveaways tracked`, type: ActivityType.Watching }],
      status: 'online',
    });
  }

  // -------------------------------------------------------------------------
  // Cleanup - Also sends ended notifications to watchlist users
  // -------------------------------------------------------------------------
  
  private async purgeAndUpdatePresence() {
    const removed = await purgeEndedGiveaways();
    if (removed.length > 0) {
      const trackerChannel = this.client.channels.cache.get(CONFIG.trackerChannelId) as TextChannel | undefined;

      for (const giveaway of removed) {
        // Update the main notification embed
        const notifMsgId = giveaway.notificationMessageId;
        if (notifMsgId && trackerChannel) {
          const msg = await trackerChannel.messages.fetch(notifMsgId).catch(() => null);
          if (msg && msg.embeds.length > 0) {
            const updatedEmbed = EmbedBuilder.from(msg.embeds[0])
              .setColor(0xFF0000)
              .setAuthor({ 
                name: 'Giveaway Ended', 
                iconURL: msg.embeds[0].author?.iconURL || undefined 
              });
            await msg.edit({ embeds: [updatedEmbed] }).catch(() => {});
          }
        }

        // TODO: Send ended notifications to watchlist users who were tracking this giveaway
        // This requires storing which users got notified for each giveaway
        // For now, the database tracks the giveaway status and will show as ended
      }
      await this.updatePresence();
    }
  }

  // -------------------------------------------------------------------------
  // Command registration
  // -------------------------------------------------------------------------
  
  private async registerCommands(): Promise<void> {
    if (this.commandsRegistered) return;
    const commandData = [
      new SlashCommandBuilder().setName('stats').setDescription('Tracker statistics'),
      new SlashCommandBuilder().setName('active').setDescription('Active giveaways'),
      new SlashCommandBuilder().setName('recent').setDescription('Recently detected'),
      new SlashCommandBuilder()
        .setName('setchannel')
        .setDescription('Set notification channel (admin)')
        .addChannelOption(opt => opt.setName('channel').setDescription('Target channel').setRequired(true))
        .setDefaultMemberPermissions(0),
      new SlashCommandBuilder().setName('reset').setDescription('Wipe database (admin)').setDefaultMemberPermissions(0),
      new SlashCommandBuilder().setName('status').setDescription('Check if running (admin)').setDefaultMemberPermissions(0),
      new SlashCommandBuilder().setName('metrics').setDescription('Performance metrics (admin)').setDefaultMemberPermissions(0),
      new SlashCommandBuilder()
        .setName('purge')
        .setDescription('Delete bot messages (admin)')
        .addIntegerOption(opt => opt.setName('amount').setDescription('How many'))
        .setDefaultMemberPermissions(0),
      new SlashCommandBuilder().setName('help').setDescription('List commands'),
      new SlashCommandBuilder()
        .setName('watch')
        .setDescription('Manage giveaway watchlist')
        .addSubcommand(sub =>
          sub.setName('add')
            .setDescription('Add an item to watch')
            .addStringOption(opt =>
              opt.setName('item')
                .setDescription('Item to track (e.g., "VFA", "VSL")')
                .setRequired(true)
                .setMinLength(2)
                .setMaxLength(50)
            )
        )
        .addSubcommand(sub =>
          sub.setName('remove')
            .setDescription('Remove an item from watchlist')
            .addStringOption(opt =>
              opt.setName('item')
                .setDescription('Item to remove')
                .setRequired(true)
            )
        )
        .addSubcommand(sub =>
          sub.setName('list')
            .setDescription('Show your tracked items')
        )
        .addSubcommand(sub =>
          sub.setName('clear')
            .setDescription('Clear all tracked items')
        ),
    ];
    const rest = new REST({ version: '10' }).setToken(this.botToken);
    try {
      await rest.put(Routes.applicationCommands(this.client.user!.id), { body: commandData.map(cmd => cmd.toJSON()) });
      this.commandsRegistered = true;
      logger.info('Commands registered', { component: 'BotManager' });
    } catch (err) {
      logger.error('Command registration failed', { error: formatError(err) });
    }
  }
}
