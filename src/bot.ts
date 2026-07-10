/**
 * @module bot
 * Real Discord bot for notifications and slash commands
 * UI matches the Jimbo-style giveaway embed with live countdown
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
  Guild,
  GuildChannel,
} from 'discord.js';
import { CONFIG } from './config.js';
import { logger } from './logger.js';
import { formatTimestamp, formatDuration, truncate, formatError } from './utils.js';
import { GiveawayData, GiveawayStats } from './types.js';
import { getStats, getActiveGiveaways, resetDatabase, getAllGiveaways } from './database.js';

type CommandHandler = (interaction: ChatInputCommandInteraction<CacheType>) => Promise<void>;

const commands = new Map<string, CommandHandler>();

async function deferReply(interaction: ChatInputCommandInteraction<CacheType>, ephemeral = true) {
  await interaction.deferReply({ ephemeral });
}

function isAdmin(userId: string): boolean {
  return CONFIG.adminUserIds.includes(userId);
}

async function requireAdmin(interaction: ChatInputCommandInteraction<CacheType>): Promise<boolean> {
  if (!isAdmin(interaction.user.id)) {
    await interaction.reply({ content: '⛔ You do not have permission.', ephemeral: true });
    return false;
  }
  return true;
}

// ---- Public commands ----

commands.set('stats', async (interaction) => {
  await deferReply(interaction, false);
  const stats = getStats();

  const embed = new EmbedBuilder()
    .setColor(0x00AAFF)
    .setTitle('📊 Giveaway Tracker Stats')
    .addFields(
      { name: 'Total Detected', value: String(stats.totalDetected), inline: true },
      { name: 'Active Giveaways', value: String(stats.activeGiveaways), inline: true },
      { name: 'Servers Tracked', value: String(stats.serversWithGiveaways), inline: true },
      { name: 'Last Detection', value: stats.lastDetected ? formatTimestamp(stats.lastDetected) : 'Never', inline: false },
    )
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
});

commands.set('active', async (interaction) => {
  await deferReply(interaction, false);
  const active = getActiveGiveaways(10);

  if (active.length === 0) {
    await interaction.editReply('No active giveaways tracked.');
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(0xFFD700)
    .setTitle('🎯 Active Giveaways')
    .setTimestamp();

  for (const g of active.slice(0, 10)) {
    const ends = g.endsAt ? formatTimestamp(g.endsAt) : 'Unknown';
    embed.addFields({
      name: truncate(g.prize, 50),
      value: `**Server:** ${g.guildName}\n**Channel:** #${g.channelName}\n**Ends:** ${ends}`,
      inline: false,
    });
  }

  if (active.length > 10) {
    embed.setFooter({ text: `+ ${active.length - 10} more active giveaways` });
  }

  await interaction.editReply({ embeds: [embed] });
});

commands.set('recent', async (interaction) => {
  await deferReply(interaction, false);
  const recent = getAllGiveaways(10);

  if (recent.length === 0) {
    await interaction.editReply('No giveaways tracked yet.');
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('📋 Recent Giveaways')
    .setTimestamp();

  for (const g of recent) {
    const status = g.status === 'active' ? '🟢 Active' : '🔴 Ended';
    embed.addFields({
      name: truncate(g.prize, 40),
      value: `**Server:** ${g.guildName}\n**Status:** ${status}\n**Detected:** ${formatTimestamp(g.detectedAt)}`,
      inline: false,
    });
  }

  await interaction.editReply({ embeds: [embed] });
});

// ---- Admin commands ----

commands.set('setchannel', async (interaction) => {
  if (!await requireAdmin(interaction)) return;
  const channel = interaction.options.getChannel('channel', true);

  if (!channel.isTextBased()) {
    await interaction.reply({ content: 'That is not a text channel.', ephemeral: true });
    return;
  }

  (CONFIG as any).trackerChannelId = channel.id;

  await interaction.reply({
    content: `✅ Notification channel set to <#${channel.id}>`,
    ephemeral: true,
  });
});

commands.set('reset', async (interaction) => {
  if (!await requireAdmin(interaction)) return;
  await deferReply(interaction, true);

  resetDatabase();
  await interaction.editReply('✅ Database reset. All tracked giveaways cleared.');
});

commands.set('status', async (interaction) => {
  if (!await requireAdmin(interaction)) return;
  await deferReply(interaction, false);

  const stats = getStats();
  const embed = new EmbedBuilder()
    .setColor(0x00FF00)
    .setTitle('🟢 Tracker Status')
    .addFields(
      { name: 'Total Giveaways', value: String(stats.totalDetected), inline: true },
      { name: 'Active', value: String(stats.activeGiveaways), inline: true },
      { name: 'Servers', value: String(stats.serversWithGiveaways), inline: true },
      { name: 'Config', value: `Channel: <#${CONFIG.trackerChannelId}>\nCooldown: ${CONFIG.notificationCooldown}s`, inline: false },
    )
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
});

// ---- BotManager ----

export class BotManager {
  private client: Client;
  private commandsRegistered = false;
  private inviteCache = new Map<string, string>();

  constructor(private readonly botToken: string) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
      ],
    });

    this.client.once('ready', () => {
      logger.info(`Bot logged in as ${this.client.user?.tag}`, { component: 'BotManager' });
      this.registerCommands().catch(err => {
        logger.error('Failed to register slash commands', { error: formatError(err) });
      });
    });

    this.client.on('interactionCreate', async (interaction: Interaction) => {
      if (!interaction.isChatInputCommand()) return;
      const handler = commands.get(interaction.commandName);
      if (!handler) {
        await interaction.reply({ content: 'Unknown command.', ephemeral: true });
        return;
      }
      try {
        await handler(interaction);
      } catch (err) {
        logger.error(`Error handling command ${interaction.commandName}`, { error: formatError(err) });
        if (interaction.replied || interaction.deferred) {
          await interaction.editReply({ content: 'An error occurred.' });
        } else {
          await interaction.reply({ content: 'An error occurred.', ephemeral: true });
        }
      }
    });

    this.client.on('error', (err) => {
      logger.error('Bot client error', { error: err });
    });
  }

  async start(): Promise<void> {
    await this.client.login(this.botToken);
  }

  async destroy(): Promise<void> {
    await this.client.destroy();
  }

  /**
   * Send a giveaway notification with Jimbo-style UI
   * Includes: server logo, server name, live countdown, invite, message, jump
   */
  public async sendGiveawayNotification(data: GiveawayData): Promise<boolean> {
    const channelId = CONFIG.trackerChannelId;
    const channel = this.client.channels.cache.get(channelId) as TextChannel | undefined;

    if (!channel) {
      logger.error(`Tracker channel ${channelId} not found`, {
        component: 'BotManager',
        availableChannels: this.client.channels.cache.size,
      });
      return false;
    }

    // Get guild info
    const guild = this.client.guilds.cache.get(data.guildId);
    const guildName = guild?.name || data.guildName || 'Unknown Server';
    const serverIcon = guild?.iconURL({ size: 256 }) || null;

    // Get channel name with mention
    const channelObj = guild?.channels.cache.get(data.channelId) as GuildChannel | undefined;
    const channelMention = channelObj ? `<#${data.channelId}>` : `#${data.channelName}`;

    // Get invite
    const inviteUrl = await this.fetchServerInvite(guild, data.guildId);

    // Extract winner count from prize (if any)
    const winnerCount = this.extractWinnerCount(data.prize);
    const giveawayType = this.extractGiveawayType(data.prize);

    // Calculate worth rating based on prize value or estimated worth
    const worthRating = this.calculateWorthRating(data);

    // Calculate live countdown
    const endsAt = data.endsAt || Date.now() + 3600000;
    const countdownStr = this.formatCountdown(endsAt);

    // Get time since detection
    const detectionTime = Date.now() - data.detectedAt;

    // Build the embed
    const embed = new EmbedBuilder()
      .setAuthor({
        name: 'Giveaway Tracker',
        iconURL: this.client.user?.displayAvatarURL(),
      })
      .setTitle(data.prize || 'Unknown Giveaway')
      .setDescription(
        `**${guildName}**\n\n` +
        `**Winners:** \`${winnerCount}\`  **Type:** \`${giveawayType}\`\n` +
        `**Worth Joining:** ${worthRating}\n\n` +
        `**Ends:** ${countdownStr}\n\n` +
        `**Server Invite:** ${inviteUrl}`
      )
      .setColor(0x5865F2)
      .setThumbnail(serverIcon)
      .setFooter({
        text: `Made by Jimbo • Detected in ${detectionTime}ms • ${formatTimestamp(Date.now())}`,
      })
      .setTimestamp();

    // Build button row: Join | Message | Jump To Giveaway
    const row = new ActionRowBuilder<ButtonBuilder>()
      .addComponents(
        new ButtonBuilder()
          .setLabel('Join')
          .setStyle(ButtonStyle.Link)
          .setURL(inviteUrl || `https://discord.gg/${data.guildId}`),
        new ButtonBuilder()
          .setLabel('Message')
          .setStyle(ButtonStyle.Link)
          .setURL(`https://discord.com/channels/@me/${data.authorId}`),
        new ButtonBuilder()
          .setLabel('Jump To Giveaway')
          .setStyle(ButtonStyle.Link)
          .setURL(`https://discord.com/channels/${data.guildId}/${data.channelId}/${data.messageId}`),
      );

    try {
      // Send with @everyone ping
      await channel.send({
        content: '@everyone',
        embeds: [embed],
        components: [row],
      });

      logger.info(`Notification sent for giveaway ${data.messageId}`, {
        component: 'BotManager',
        channel: channelId,
        prize: truncate(data.prize, 50),
        guild: guildName,
      });

      return true;
    } catch (err) {
      logger.error('Failed to send notification', {
        component: 'BotManager',
        error: formatError(err),
      });
      return false;
    }
  }

  /**
   * Fetch or generate a server invite
   */
  private async fetchServerInvite(guild: Guild | undefined, guildId: string): Promise<string> {
    // Check cache
    if (this.inviteCache.has(guildId)) {
      return this.inviteCache.get(guildId)!;
    }

    if (!guild) {
      return `https://discord.gg/${guildId}`;
    }

    try {
      // Try to find an existing invite
      const invites = await guild.invites.fetch();
      const invite = invites.find(i => i.maxUses === 0 || i.maxUses === null);

      if (invite) {
        const url = `https://discord.gg/${invite.code}`;
        this.inviteCache.set(guildId, url);
        return url;
      }

      // Try to create a new invite
      const channel = guild.channels.cache.find(
        (ch): ch is TextChannel => ch.isTextBased() && ch.permissionsFor(guild.members.me!)?.has('CreateInvite')
      );

      if (channel) {
        const newInvite = await channel.createInvite({
          maxAge: 86400,
          maxUses: 1,
        });
        const url = `https://discord.gg/${newInvite.code}`;
        this.inviteCache.set(guildId, url);
        return url;
      }

      return `https://discord.gg/${guildId}`;
    } catch (err) {
      logger.debug('Failed to fetch/create invite', {
        component: 'BotManager',
        guildId,
        error: formatError(err),
      });
      return `https://discord.gg/${guildId}`;
    }
  }

  /**
   * Extract winner count from prize string
   * Example: "UVSA Hat" → "1"
   * Example: "5x Nitro" → "5"
   */
  private extractWinnerCount(prize: string): string {
    const match = prize.match(/(\d+)\s*[xX×]/);
    if (match) return match[1];

    // Check for common patterns
    if (/\b(?:one|1)\s*(?:winner|win|giveaway)/i.test(prize)) return '1';
    if (/(\d+)\s*(?:winners?)/i.test(prize)) {
      const m = prize.match(/(\d+)\s*(?:winners?)/i);
      return m ? m[1] : '1';
    }

    return '1';
  }

  /**
   * Extract giveaway type from prize
   */
  private extractGiveawayType(prize: string): string {
    if (/nitro/i.test(prize)) return 'Nitro';
    if (/game|steam|epic/i.test(prize)) return 'Game';
    if (/crypto|btc|eth/i.test(prize)) return 'Crypto';
    if (/gift|card|voucher/i.test(prize)) return 'Gift Card';
    if (/boost/i.test(prize)) return 'Boost';
    if (/role|rank/i.test(prize)) return 'Role';
    if (/hat|skin|item|weapon/i.test(prize)) return 'Item';
    return 'Custom';
  }

  /**
   * Calculate worth rating (stars)
   */
  private calculateWorthRating(data: GiveawayData): string {
    const prize = data.prize || '';

    // Check for known high-value keywords
    if (/nitro|month|year|premium|plus/i.test(prize)) {
      return '★★★★★';
    }
    if (/game|steam|playstation|xbox|switch|code/i.test(prize)) {
      return '★★★★☆';
    }
    if (/gift|card|voucher|discount/i.test(prize)) {
      return '★★★☆☆';
    }
    if (/hat|skin|item|weapon|role|rank/i.test(prize)) {
      return '★★☆☆☆';
    }

    // Check for numbers that might indicate value
    const valueMatch = prize.match(/\$(\d+)/);
    if (valueMatch) {
      const value = parseInt(valueMatch[1]);
      if (value > 50) return '★★★★★';
      if (value > 20) return '★★★★☆';
      if (value > 10) return '★★★☆☆';
      return '★★☆☆☆';
    }

    return '★★★★☆';
  }

  /**
   * Format countdown with live timer
   * Returns: "Friday, 10 July 2026 at 06:22 pm (in 29 seconds)"
   */
  private formatCountdown(endsAt: number): string {
    const now = Date.now();
    const diff = Math.max(0, endsAt - now);

    // Format the date
    const date = new Date(endsAt);
    const options: Intl.DateTimeFormatOptions = {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    };
    const formattedDate = date.toLocaleString('en-US', options);

    // Format time remaining
    const remaining = formatDuration(diff);

    return `${formattedDate} (in ${remaining})`;
  }

  /**
   * Get channel mention for the tracker channel
   */
  public getTrackerChannelMention(): string {
    return `<#${CONFIG.trackerChannelId}>`;
  }

  // ---- Slash command registration ----

  private async registerCommands(): Promise<void> {
    if (this.commandsRegistered) return;

    const commandData = [
      new SlashCommandBuilder().setName('stats').setDescription('Show giveaway tracker statistics'),
      new SlashCommandBuilder().setName('active').setDescription('List active giveaways'),
      new SlashCommandBuilder().setName('recent').setDescription('List recent giveaways'),
      new SlashCommandBuilder()
        .setName('setchannel')
        .setDescription('[Admin] Set notification channel')
        .addChannelOption(opt => opt.setName('channel').setDescription('Text channel').setRequired(true))
        .setDefaultMemberPermissions(0),
      new SlashCommandBuilder().setName('reset').setDescription('[Admin] Reset database').setDefaultMemberPermissions(0),
      new SlashCommandBuilder().setName('status').setDescription('[Admin] Show tracker status').setDefaultMemberPermissions(0),
    ];

    const rest = new REST({ version: '10' }).setToken(this.botToken);
    try {
      await rest.put(Routes.applicationCommands(this.client.user!.id), {
        body: commandData.map(cmd => cmd.toJSON()),
      });
      this.commandsRegistered = true;
      logger.info('Slash commands registered.', { component: 'BotManager' });
    } catch (err) {
      logger.error('Failed to register slash commands', { error: formatError(err) });
    }
  }
}
