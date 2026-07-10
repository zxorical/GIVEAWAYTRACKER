/**
 * @module bot
 * Real Discord bot for notifications and slash commands
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
  ChannelType,
  PermissionsBitField,
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

commands.set('setchannel', async (interaction) => {
  if (!await requireAdmin(interaction)) return;
  const channel = interaction.options.getChannel('channel', true);

  if (channel.type !== ChannelType.GuildText && 
      channel.type !== ChannelType.GuildAnnouncement &&
      channel.type !== ChannelType.GuildForum &&
      channel.type !== ChannelType.GuildMedia) {
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

    const guild = this.client.guilds.cache.get(data.guildId);
    const guildName = guild?.name || data.guildName || 'Unknown Server';
    const serverIcon = guild?.iconURL({ size: 256 }) || null;
    // Change 3: Updated call – only passing guild
    const inviteUrl = await this.fetchServerInvite(guild);

    const winnerCount = this.extractWinnerCount(data.prize);
    const giveawayType = this.extractGiveawayType(data.prize);
    const worthRating = this.calculateWorthRating(data);
    const endsAt = data.endsAt || Date.now() + 3600000;
    // Change 4: Discord's live countdown timestamps
    const countdownStr = `<t:${Math.floor(endsAt / 1000)}:F> (<t:${Math.floor(endsAt / 1000)}:R>)`;
    const detectionTime = Date.now() - data.detectedAt;

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
      // Change 1: Footer from "Jimbo" to "Gab"
      .setFooter({
        text: `Made by Gab • Detected in ${detectionTime}ms • ${formatTimestamp(Date.now())}`,
      })
      .setTimestamp();

    const row = new ActionRowBuilder<ButtonBuilder>()
      .addComponents(
        new ButtonBuilder()
          .setLabel('Join')
          .setStyle(ButtonStyle.Link)
          .setURL(inviteUrl || `https://discord.gg/${data.guildId}`),
        new ButtonBuilder()
          .setLabel('Message')
          .setStyle(ButtonStyle.Link)
          // Change 5: Fixed Message button URL
          .setURL(`https://discord.com/channels/${data.guildId}/${data.channelId}/${data.messageId}`),
        new ButtonBuilder()
          .setLabel('Jump To Giveaway')
          .setStyle(ButtonStyle.Link)
          .setURL(`https://discord.com/channels/${data.guildId}/${data.channelId}/${data.messageId}`),
      );

    try {
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

  // Change 2: New fetchServerInvite method
  private async fetchServerInvite(guild: Guild | undefined): Promise<string> {
    if (!guild) {
      return 'No invite available';
    }

    try {
      const existingInvites = await guild.invites.fetch().catch(() => null);

      const existing = existingInvites?.find(
        invite => invite.maxAge === 0 && invite.maxUses === 0
      );

      if (existing) {
        return existing.url;
      }

      const channel = guild.channels.cache.find(
        (ch): ch is TextChannel =>
          ch.type === ChannelType.GuildText &&
          ch.permissionsFor(guild.members.me!)?.has(
            PermissionsBitField.Flags.CreateInstantInvite
          ) === true
      );

      if (!channel) {
        return 'No invite permission';
      }

      const invite = await channel.createInvite({
        maxAge: 0,
        maxUses: 0,
        reason: 'Giveaway tracker invite'
      });

      return invite.url;

    } catch (err) {
      logger.debug(
        'Failed creating invite',
        {
          error: formatError(err)
        }
      );
      return 'Invite unavailable';
    }
  }

  // The following methods are kept for internal use / fallback
  private extractWinnerCount(prize: string): string {
    const match = prize.match(/(\d+)\s*[xX×]/);
    if (match) return match[1];
    if (/\b(?:one|1)\s*(?:winner|win|giveaway)/i.test(prize)) return '1';
    const m = prize.match(/(\d+)\s*(?:winners?)/i);
    if (m) return m[1];
    return '1';
  }

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

  private calculateWorthRating(data: GiveawayData): string {
    const prize = data.prize || '';
    if (/nitro|month|year|premium|plus/i.test(prize)) return '★★★★★';
    if (/game|steam|playstation|xbox|switch|code/i.test(prize)) return '★★★★☆';
    if (/gift|card|voucher|discount/i.test(prize)) return '★★★☆☆';
    if (/hat|skin|item|weapon|role|rank/i.test(prize)) return '★★☆☆☆';
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

  // This method is no longer used for notifications but kept for backward compatibility / other potential usage
  private formatCountdown(endsAt: number): string {
    const now = Date.now();
    const diff = Math.max(0, endsAt - now);
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
    const remaining = formatDuration(diff);
    return `${formattedDate} (in ${remaining})`;
  }

  public getTrackerChannelMention(): string {
    return `<#${CONFIG.trackerChannelId}>`;
  }

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
