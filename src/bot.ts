/**
 * @module bot
 * Real Discord bot for notifications and slash commands
 * Premium giveaway tracker with beautiful embeds and full server branding
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

// ---------------------------------------------------------------------------
// Command Helpers
// ---------------------------------------------------------------------------
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

function isValidSnowflake(id: string): boolean {
  return /^\d{17,20}$/.test(id);
}

function safeUrl(base: string, ...parts: string[]): string {
  if (parts.every(p => isValidSnowflake(p))) {
    return `${base}/${parts.join('/')}`;
  }
  return base;
}

// ---------------------------------------------------------------------------
// Slash Commands
// ---------------------------------------------------------------------------
commands.set('stats', async (interaction) => {
  await deferReply(interaction, false);
  const stats = getStats();

  const embed = new EmbedBuilder()
    .setColor(0x00AAFF)
    .setTitle('📊 Giveaway Tracker Statistics')
    .setDescription('Real-time overview of the giveaway detection system')
    .addFields(
      { name: '🎯 Total Detected', value: `\`${stats.totalDetected}\``, inline: true },
      { name: '🟢 Active Now', value: `\`${stats.activeGiveaways}\``, inline: true },
      { name: '🌐 Servers Tracked', value: `\`${stats.serversWithGiveaways}\``, inline: true },
      { name: '⏱️ Last Detection', value: stats.lastDetected ? formatTimestamp(stats.lastDetected) : '`Never`', inline: false },
    )
    .setFooter({ text: 'Giveaway Tracker System • Premium Edition' })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
});

commands.set('active', async (interaction) => {
  await deferReply(interaction, false);
  const active = getActiveGiveaways(10);

  if (active.length === 0) {
    const embed = new EmbedBuilder()
      .setColor(0xFFA500)
      .setTitle('🔍 No Active Giveaways')
      .setDescription('There are currently no active giveaways being tracked.\nCheck back later or use `/recent` to see past giveaways.')
      .setTimestamp();
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(0xFFD700)
    .setTitle('🎯 Active Giveaways')
    .setDescription(`Currently tracking **${active.length}** active giveaway${active.length > 1 ? 's' : ''}`)
    .setTimestamp();

  for (const g of active.slice(0, 10)) {
    const ends = g.endsAt 
      ? `<t:${Math.floor(g.endsAt / 1000)}:R>`
      : '`Unknown`';
    embed.addFields({
      name: `🏆 ${truncate(g.prize, 50)}`,
      value: [
        `**Server:** \`${g.guildName}\``,
        `**Channel:** \`#${g.channelName}\``,
        `**Ends:** ${ends}`,
        `**Status:** 🟢 Active`,
      ].join('\n'),
      inline: false,
    });
  }

  if (active.length > 10) {
    embed.setFooter({ text: `+ ${active.length - 10} more active giveaways • Use /active to refresh` });
  }

  await interaction.editReply({ embeds: [embed] });
});

commands.set('recent', async (interaction) => {
  await deferReply(interaction, false);
  const recent = getAllGiveaways(10);

  if (recent.length === 0) {
    const embed = new EmbedBuilder()
      .setColor(0x666666)
      .setTitle('📭 No Giveaways Tracked')
      .setDescription('No giveaways have been detected yet.\nThey will appear here once detected!')
      .setTimestamp();
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('📋 Recent Giveaways')
    .setDescription(`Showing the last **${recent.length}** detected giveaway${recent.length > 1 ? 's' : ''}`)
    .setTimestamp();

  for (const g of recent) {
    const status = g.status === 'active' ? '🟢 Active' : '🔴 Ended';
    embed.addFields({
      name: `${g.status === 'active' ? '🎯' : '📦'} ${truncate(g.prize, 40)}`,
      value: [
        `**Server:** \`${g.guildName}\``,
        `**Status:** ${status}`,
        `**Detected:** ${formatTimestamp(g.detectedAt)}`,
      ].join('\n'),
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
    await interaction.reply({ content: '⛔ That is not a valid text channel.', ephemeral: true });
    return;
  }

  (CONFIG as any).trackerChannelId = channel.id;

  const embed = new EmbedBuilder()
    .setColor(0x00FF00)
    .setTitle('✅ Channel Updated')
    .setDescription(`Notification channel has been set to ${channel}`)
    .addFields({ name: 'Channel ID', value: `\`${channel.id}\``, inline: true })
    .setTimestamp();

  await interaction.reply({ embeds: [embed], ephemeral: true });
});

commands.set('reset', async (interaction) => {
  if (!await requireAdmin(interaction)) return;
  await deferReply(interaction, true);
  resetDatabase();

  const embed = new EmbedBuilder()
    .setColor(0xFF0000)
    .setTitle('🗑️ Database Reset')
    .setDescription('All tracked giveaways have been cleared.\nThe system will continue to detect new giveaways.')
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
});

commands.set('status', async (interaction) => {
  if (!await requireAdmin(interaction)) return;
  await deferReply(interaction, false);

  const stats = getStats();
  const embed = new EmbedBuilder()
    .setColor(0x00FF00)
    .setTitle('🟢 System Status')
    .setDescription('Giveaway tracker is operational')
    .addFields(
      { name: '📊 Total Giveaways', value: `\`${stats.totalDetected}\``, inline: true },
      { name: '🟢 Active', value: `\`${stats.activeGiveaways}\``, inline: true },
      { name: '🌐 Servers', value: `\`${stats.serversWithGiveaways}\``, inline: true },
      { name: '⚙️ Configuration', value: `**Channel:** <#${CONFIG.trackerChannelId}>\n**Cooldown:** \`${CONFIG.notificationCooldown}s\``, inline: false },
    )
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
});

commands.set('help', async (interaction) => {
  await deferReply(interaction, false);
  const embed = new EmbedBuilder()
    .setColor(0x9B59B6)
    .setTitle('📚 Command Help')
    .setDescription('Here are all available commands:')
    .addFields(
      { name: '📊 `/stats`', value: 'Show giveaway tracker statistics', inline: false },
      { name: '🎯 `/active`', value: 'List currently active giveaways', inline: false },
      { name: '📋 `/recent`', value: 'Show recent giveaways', inline: false },
      { name: '🔍 `/status`', value: 'Show system status (Admin)', inline: false },
      { name: '⚙️ `/setchannel`', value: 'Set notification channel (Admin)', inline: false },
      { name: '🗑️ `/reset`', value: 'Reset database (Admin)', inline: false },
    )
    .setFooter({ text: 'Made by Gab • Premium Edition' })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
});

// ---------------------------------------------------------------------------
// Bot Manager Class
// ---------------------------------------------------------------------------
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
      logger.info(`🤖 Bot logged in as ${this.client.user?.tag}`, { component: 'BotManager' });
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
          await interaction.editReply({ content: 'An error occurred while processing the command.' });
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

  // ---------------------------------------------------------------------------
  // Main Notification Method - Beautiful Embeds with Server Branding
  // ---------------------------------------------------------------------------
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

    // Fetch guild data for branding
    const guild = this.client.guilds.cache.get(data.guildId);
    const guildName = guild?.name || data.guildName || 'Unknown Server';
    const guildIcon = guild?.iconURL({ size: 512 }) || null;
    const guildBanner = guild?.bannerURL({ size: 1024 }) || null;
    const memberCount = guild?.memberCount || 'Unknown';
    const guildDescription = guild?.description || null;
    
    // Validate IDs for URL construction
    const safeGuildId = isValidSnowflake(data.guildId) ? data.guildId : '0';
    const safeChannelId = isValidSnowflake(data.channelId) ? data.channelId : '0';
    const safeMessageId = isValidSnowflake(data.messageId) ? data.messageId : '0';
    
    const inviteUrl = await this.fetchServerInvite(guild);

    // Extract giveaway metadata
    const winnerCount = this.extractWinnerCount(data.prize);
    const giveawayType = this.extractGiveawayType(data.prize);
    const worthRating = this.calculateWorthRating(data);
    const endsAt = data.endsAt || Date.now() + 3600000;
    const detectionTime = Date.now() - data.detectedAt;
    const prizeEmoji = this.getPrizeEmoji(giveawayType);
    const endTimestamp = Math.floor(endsAt / 1000);

    // Build premium embed
    const embed = new EmbedBuilder()
      .setAuthor({
        name: `🎁 New Giveaway Detected!`,
        iconURL: this.client.user?.displayAvatarURL(),
      })
      .setTitle(`${prizeEmoji} ${data.prize || 'Unknown Giveaway'}`)
      .setDescription([
        `### 📋 Giveaway Details`,
        `**Server:** \`${guildName}\``,
        `**Channel:** \`#${data.channelName}\``,
        guildDescription ? `**About:** ${truncate(guildDescription, 100)}` : '',
        ``,
        `### 🎯 Entry Information`,
        `**Winners:** \`${winnerCount}\`  **Type:** \`${giveawayType}\``,
        `**Worth Joining:** ${worthRating}`,
        ``,
        `### ⏰ Time Remaining`,
        `**Ends:** <t:${endTimestamp}:F>`,
        `**Countdown:** <t:${endTimestamp}:R>`,
        ``,
        `### 🌐 Server Access`,
        `**Invite:** ${inviteUrl}`,
        memberCount !== 'Unknown' ? `**Members:** \`${memberCount.toLocaleString()}\`` : '',
      ].filter(Boolean).join('\n'))
      .setColor(this.getEmbedColor(giveawayType))
      .setThumbnail(guildIcon)
      .setFooter({
        text: `Made by Gab • Detected in ${detectionTime}ms`,
        iconURL: this.client.user?.displayAvatarURL(),
      })
      .setTimestamp(data.detectedAt);

    // Add guild banner if available
    if (guildBanner) {
      embed.setImage(guildBanner);
    }

    // Add detection info field
    embed.addFields(
      { 
        name: '📊 Detection Info', 
        value: [
          `**Speed:** \`${detectionTime}ms\``,
          `**Method:** \`Embed Detection\``,
          `**Detected At:** ${formatTimestamp(data.detectedAt)}`,
        ].join('\n'),
        inline: false 
      },
      {
        name: '🔗 Quick Actions',
        value: 'Use the buttons below to join the server or view the giveaway!',
        inline: false,
      }
    );

    // Build action buttons with validated URLs
    const row = new ActionRowBuilder<ButtonBuilder>();

    // Join Server button
    if (inviteUrl && inviteUrl.startsWith('http')) {
      row.addComponents(
        new ButtonBuilder()
          .setLabel('🚀 Join Server')
          .setStyle(ButtonStyle.Link)
          .setURL(inviteUrl)
      );
    }

    // Message Link button
    const messageUrl = safeUrl(
      'https://discord.com/channels',
      safeGuildId,
      safeChannelId,
      safeMessageId
    );
    
    row.addComponents(
      new ButtonBuilder()
        .setLabel('💬 View Message')
        .setStyle(ButtonStyle.Link)
        .setURL(messageUrl)
    );

    // Jump to Giveaway button
    row.addComponents(
      new ButtonBuilder()
        .setLabel('🎯 Jump to Giveaway')
        .setStyle(ButtonStyle.Link)
        .setURL(messageUrl)
    );

    // Send the notification
    try {
      await channel.send({
        content: [
          `🎉 **@everyone** - New Giveaway Alert!`,
          `**${guildName}** is hosting a giveaway!`,
        ].join('\n'),
        embeds: [embed],
        components: [row],
      });

      logger.info(`✅ Notification sent for giveaway ${data.messageId}`, {
        component: 'BotManager',
        channel: channelId,
        prize: truncate(data.prize, 50),
        guild: guildName,
        detectionTime,
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

  // ---------------------------------------------------------------------------
  // Server Invite Management
  // ---------------------------------------------------------------------------
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
      logger.debug('Failed creating invite', {
        error: formatError(err)
      });
      return 'Invite unavailable';
    }
  }

  // ---------------------------------------------------------------------------
  // Prize Analysis Methods
  // ---------------------------------------------------------------------------
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
    if (/game|steam|epic|playstation|xbox/i.test(prize)) return 'Game';
    if (/crypto|btc|eth|bitcoin/i.test(prize)) return 'Crypto';
    if (/gift\s*card|voucher|amazon/i.test(prize)) return 'Gift Card';
    if (/boost|booster/i.test(prize)) return 'Boost';
    if (/role|rank|permission/i.test(prize)) return 'Role';
    if (/hat|skin|item|weapon|cosmetic/i.test(prize)) return 'Item';
    if (/money|cash|paypal/i.test(prize)) return 'Cash';
    return 'Custom';
  }

  private getPrizeEmoji(type: string): string {
    const emojiMap: Record<string, string> = {
      'Nitro': '💎',
      'Game': '🎮',
      'Crypto': '💰',
      'Gift Card': '🎫',
      'Boost': '⚡',
      'Role': '👑',
      'Item': '🎁',
      'Cash': '💵',
      'Custom': '🎉',
    };
    return emojiMap[type] || '🎊';
  }

  private getEmbedColor(type: string): number {
    const colorMap: Record<string, number> = {
      'Nitro': 0x9146FF,
      'Game': 0x2ECC71,
      'Crypto': 0xF39C12,
      'Gift Card': 0xE74C3C,
      'Boost': 0xF1C40F,
      'Role': 0x9B59B6,
      'Item': 0x3498DB,
      'Cash': 0x27AE60,
      'Custom': 0x5865F2,
    };
    return colorMap[type] || 0x7289DA;
  }

  private calculateWorthRating(data: GiveawayData): string {
    const prize = data.prize || '';
    if (/nitro.*year|year.*nitro|12.*month/i.test(prize)) return '⭐⭐⭐⭐⭐';
    if (/nitro|premium|plus/i.test(prize)) return '⭐⭐⭐⭐';
    if (/game.*aaa|aaa.*game|cyberpunk|gta|call\s*of\s*duty/i.test(prize)) return '⭐⭐⭐⭐⭐';
    if (/game|steam|playstation|xbox|switch|code/i.test(prize)) return '⭐⭐⭐⭐';
    if (/gift.*card.*\$[5-9]\d|gift.*card.*\$[1-9]\d\d/i.test(prize)) return '⭐⭐⭐⭐';
    if (/gift|card|voucher|discount/i.test(prize)) return '⭐⭐⭐';
    if (/hat|skin|item|weapon|role|rank/i.test(prize)) return '⭐⭐';
    const valueMatch = prize.match(/\$(\d+)/);
    if (valueMatch) {
      const value = parseInt(valueMatch[1]);
      if (value > 50) return '⭐⭐⭐⭐⭐';
      if (value > 20) return '⭐⭐⭐⭐';
      if (value > 10) return '⭐⭐⭐';
      return '⭐⭐';
    }
    return '⭐⭐⭐';
  }

  // ---------------------------------------------------------------------------
  // Utility Methods
  // ---------------------------------------------------------------------------
  public getTrackerChannelMention(): string {
    return `<#${CONFIG.trackerChannelId}>`;
  }

  // ---------------------------------------------------------------------------
  // Command Registration
  // ---------------------------------------------------------------------------
  private async registerCommands(): Promise<void> {
    if (this.commandsRegistered) return;

    const commandData = [
      new SlashCommandBuilder()
        .setName('stats')
        .setDescription('📊 Show giveaway tracker statistics'),
      new SlashCommandBuilder()
        .setName('active')
        .setDescription('🎯 List currently active giveaways'),
      new SlashCommandBuilder()
        .setName('recent')
        .setDescription('📋 Show recent giveaways'),
      new SlashCommandBuilder()
        .setName('setchannel')
        .setDescription('⚙️ Set notification channel')
        .addChannelOption(opt => 
          opt.setName('channel')
            .setDescription('Text channel for notifications')
            .setRequired(true)
        )
        .setDefaultMemberPermissions(0),
      new SlashCommandBuilder()
        .setName('reset')
        .setDescription('🗑️ Reset database')
        .setDefaultMemberPermissions(0),
      new SlashCommandBuilder()
        .setName('status')
        .setDescription('🟢 Show system status')
        .setDefaultMemberPermissions(0),
      new SlashCommandBuilder()
        .setName('help')
        .setDescription('📚 Show help menu'),
    ];

    const rest = new REST({ version: '10' }).setToken(this.botToken);
    try {
      await rest.put(Routes.applicationCommands(this.client.user!.id), {
        body: commandData.map(cmd => cmd.toJSON()),
      });
      this.commandsRegistered = true;
      logger.info('✅ Slash commands registered successfully', { component: 'BotManager' });
    } catch (err) {
      logger.error('Failed to register slash commands', { error: formatError(err) });
    }
  }
}
