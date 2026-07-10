/**
 * @module bot
 * Real Discord bot for notifications and slash commands
 * Clean embed – invite is provided by the selfbot
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
  ChannelType,
  PermissionsBitField,
} from 'discord.js';
import { CONFIG } from './config.js';
import { logger } from './logger.js';
import { formatTimestamp, truncate, formatError } from './utils.js';
import { GiveawayData } from './types.js';
import { getStats, getActiveGiveaways, resetDatabase, getAllGiveaways } from './database.js';

type CommandHandler = (interaction: ChatInputCommandInteraction<CacheType>) => Promise<void>;

const commands = new Map<string, CommandHandler>();

// ---------------------------------------------------------------------------
// Helpers
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
    return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xFFA500).setTitle('🔍 No Active Giveaways').setDescription('There are currently no active giveaways being tracked.\nCheck back later or use `/recent` to see past giveaways.')] });
  }
  const embed = new EmbedBuilder().setColor(0xFFD700).setTitle('🎯 Active Giveaways').setDescription(`Currently tracking **${active.length}** active giveaway${active.length > 1 ? 's' : ''}`).setTimestamp();
  for (const g of active.slice(0, 10)) {
    const ends = g.endsAt ? `<t:${Math.floor(g.endsAt / 1000)}:R>` : '`Unknown`';
    embed.addFields({
      name: `🏆 ${truncate(g.prize, 50)}`,
      value: `**Server:** \`${g.guildName}\`\n**Channel:** \`#${g.channelName}\`\n**Ends:** ${ends}\n**Status:** 🟢 Active`,
      inline: false,
    });
  }
  if (active.length > 10) embed.setFooter({ text: `+ ${active.length - 10} more active giveaways • Use /active to refresh` });
  await interaction.editReply({ embeds: [embed] });
});

commands.set('recent', async (interaction) => {
  await deferReply(interaction, false);
  const recent = getAllGiveaways(10);
  if (recent.length === 0) {
    return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x666666).setTitle('📭 No Giveaways Tracked').setDescription('No giveaways have been detected yet.\nThey will appear here once detected!')] });
  }
  const embed = new EmbedBuilder().setColor(0x5865F2).setTitle('📋 Recent Giveaways').setDescription(`Showing the last **${recent.length}** detected giveaway${recent.length > 1 ? 's' : ''}`).setTimestamp();
  for (const g of recent) {
    const status = g.status === 'active' ? '🟢 Active' : '🔴 Ended';
    embed.addFields({
      name: `${g.status === 'active' ? '🎯' : '📦'} ${truncate(g.prize, 40)}`,
      value: `**Server:** \`${g.guildName}\`\n**Status:** ${status}\n**Detected:** ${formatTimestamp(g.detectedAt)}`,
      inline: false,
    });
  }
  await interaction.editReply({ embeds: [embed] });
});

commands.set('setchannel', async (interaction) => {
  if (!await requireAdmin(interaction)) return;
  const channel = interaction.options.getChannel('channel', true);
  if (![ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildMedia].includes(channel.type)) {
    return interaction.reply({ content: '⛔ That is not a valid text channel.', ephemeral: true });
  }
  (CONFIG as any).trackerChannelId = channel.id;
  await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x00FF00).setTitle('✅ Channel Updated').setDescription(`Notification channel has been set to ${channel}`)], ephemeral: true });
});

commands.set('reset', async (interaction) => {
  if (!await requireAdmin(interaction)) return;
  await deferReply(interaction, true);
  resetDatabase();
  await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xFF0000).setTitle('🗑️ Database Reset').setDescription('All tracked giveaways have been cleared.\nThe system will continue to detect new giveaways.')] });
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
// BotManager
// ---------------------------------------------------------------------------
export class BotManager {
  private client: Client;
  private commandsRegistered = false;

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
      this.registerCommands().catch(err => logger.error('Failed to register slash commands', { error: formatError(err) }));
    });

    this.client.on('interactionCreate', async (interaction: Interaction) => {
      if (!interaction.isChatInputCommand()) return;
      const handler = commands.get(interaction.commandName);
      if (!handler) return interaction.reply({ content: 'Unknown command.', ephemeral: true });
      try {
        await handler(interaction);
      } catch (err) {
        logger.error(`Error handling command ${interaction.commandName}`, { error: formatError(err) });
        const reply = interaction.replied || interaction.deferred ? interaction.editReply : interaction.reply;
        await reply({ content: 'An error occurred.', ephemeral: true });
      }
    });

    this.client.on('error', (err) => logger.error('Bot client error', { error: err }));
  }

  async start(): Promise<void> {
    await this.client.login(this.botToken);
  }

  async destroy(): Promise<void> {
    await this.client.destroy();
  }

  // -------------------------------------------------------------------------
  // sendGiveawayNotification – uses inviteUrl from selfbot
  // -------------------------------------------------------------------------
  public async sendGiveawayNotification(data: GiveawayData & { inviteUrl?: string }): Promise<boolean> {
    const channelId = CONFIG.trackerChannelId;
    const channel = this.client.channels.cache.get(channelId) as TextChannel | undefined;
    if (!channel) {
      logger.error(`Tracker channel ${channelId} not found`, { component: 'BotManager' });
      return false;
    }

    const guild = this.client.guilds.cache.get(data.guildId);
    const guildName = guild?.name || data.guildName || 'Unknown Server';
    const guildIcon = guild?.iconURL({ size: 512 }) || null;
    const guildBanner = guild?.bannerURL({ size: 1024 }) || null;
    const memberCount = guild?.memberCount ?? 'Unknown';

    const safeGuildId = isValidSnowflake(data.guildId) ? data.guildId : '0';
    const safeChannelId = isValidSnowflake(data.channelId) ? data.channelId : '0';
    const safeMessageId = isValidSnowflake(data.messageId) ? data.messageId : '0';

    // Use the invite fetched by the selfbot
    const inviteUrl = data.inviteUrl || 'No invite available';

    const endsAt = data.endsAt || Date.now() + 3600000;
    const detectionTime = Date.now() - data.detectedAt;
    const endTimestamp = Math.floor(endsAt / 1000);
    const winnerCount = this.extractWinnerCount(data.prize);

    const embed = new EmbedBuilder()
      .setAuthor({ name: '🎁 New Giveaway Detected!', iconURL: this.client.user?.displayAvatarURL() })
      .setTitle(data.prize || 'Unknown Giveaway')
      .setDescription([
        `### 📋 Details`,
        `**Server:** \`${guildName}\``,
        `**Channel:** \`#${data.channelName}\``,
        `**Winners:** \`${winnerCount}\``,
        ``,
        `### ⏰ Time Remaining`,
        `**Ends:** <t:${endTimestamp}:F>`,
        `**Countdown:** <t:${endTimestamp}:R>`,
        ``,
        `### 🌐 Server Access`,
        `**Invite:** ${inviteUrl}`,
        memberCount !== 'Unknown' ? `**Members:** \`${memberCount.toLocaleString()}\`` : '',
      ].filter(Boolean).join('\n'))
      .setColor(0x5865F2)
      .setThumbnail(guildIcon)
      .setFooter({ text: `Made by Gab • Detected in ${detectionTime}ms`, iconURL: this.client.user?.displayAvatarURL() })
      .setTimestamp(data.detectedAt);

    if (guildBanner) embed.setImage(guildBanner);

    // Only detection speed
    embed.addFields({ name: '⚡ Detection Speed', value: `\`${detectionTime}ms\``, inline: true });

    const messageUrl = safeUrl('https://discord.com/channels', safeGuildId, safeChannelId, safeMessageId);
    const row = new ActionRowBuilder<ButtonBuilder>();
    if (inviteUrl.startsWith('http')) {
      row.addComponents(new ButtonBuilder().setLabel('🚀 Join Server').setStyle(ButtonStyle.Link).setURL(inviteUrl));
    }
    row.addComponents(
      new ButtonBuilder().setLabel('💬 View Message').setStyle(ButtonStyle.Link).setURL(messageUrl),
      new ButtonBuilder().setLabel('🎯 Jump to Giveaway').setStyle(ButtonStyle.Link).setURL(messageUrl),
    );

    try {
      await channel.send({
        content: `🎉 **@everyone** – **${guildName}** is hosting a giveaway!`,
        embeds: [embed],
        components: [row],
      });
      logger.info(`✅ Notification sent for giveaway ${data.messageId}`, { component: 'BotManager', prize: truncate(data.prize, 50) });
      return true;
    } catch (err) {
      logger.error('Failed to send notification', { component: 'BotManager', error: formatError(err) });
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Simple winner count (kept, no type/rating)
  // -------------------------------------------------------------------------
  private extractWinnerCount(prize: string): string {
    const match = prize.match(/(\d+)\s*[xX×]/);
    if (match) return match[1];
    if (/\b(?:one|1)\s*(?:winner|win|giveaway)/i.test(prize)) return '1';
    const m = prize.match(/(\d+)\s*(?:winners?)/i);
    if (m) return m[1];
    return '1';
  }

  // -------------------------------------------------------------------------
  // Utility
  // -------------------------------------------------------------------------
  public getTrackerChannelMention(): string {
    return `<#${CONFIG.trackerChannelId}>`;
  }

  // -------------------------------------------------------------------------
  // Command registration
  // -------------------------------------------------------------------------
  private async registerCommands(): Promise<void> {
    if (this.commandsRegistered) return;
    const commandData = [
      new SlashCommandBuilder().setName('stats').setDescription('📊 Show giveaway tracker statistics'),
      new SlashCommandBuilder().setName('active').setDescription('🎯 List currently active giveaways'),
      new SlashCommandBuilder().setName('recent').setDescription('📋 Show recent giveaways'),
      new SlashCommandBuilder()
        .setName('setchannel')
        .setDescription('⚙️ Set notification channel')
        .addChannelOption(opt => opt.setName('channel').setDescription('Text channel for notifications').setRequired(true))
        .setDefaultMemberPermissions(0),
      new SlashCommandBuilder().setName('reset').setDescription('🗑️ Reset database').setDefaultMemberPermissions(0),
      new SlashCommandBuilder().setName('status').setDescription('🟢 Show system status').setDefaultMemberPermissions(0),
      new SlashCommandBuilder().setName('help').setDescription('📚 Show help menu'),
    ];

    const rest = new REST({ version: '10' }).setToken(this.botToken);
    try {
      await rest.put(Routes.applicationCommands(this.client.user!.id), { body: commandData.map(cmd => cmd.toJSON()) });
      this.commandsRegistered = true;
      logger.info('✅ Slash commands registered successfully', { component: 'BotManager' });
    } catch (err) {
      logger.error('Failed to register slash commands', { error: formatError(err) });
    }
  }
}
