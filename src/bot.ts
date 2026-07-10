/**
 * @module bot
 * Notification bot and slash command handler
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
} from 'discord.js';
import { CONFIG } from './config.js';
import { logger } from './logger.js';
import { formatTimestamp, truncate, formatError } from './utils.js';
import { GiveawayData } from './types.js';
import { getStats, getActiveGiveaways, resetDatabase, getAllGiveaways } from './database.js';

type CommandHandler = (interaction: ChatInputCommandInteraction<CacheType>) => Promise<void>;

const commands = new Map<string, CommandHandler>();

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
async function deferReply(interaction: ChatInputCommandInteraction<CacheType>, ephemeral = true) {
  await interaction.deferReply({ ephemeral });
}

function isAdmin(userId: string): boolean {
  return CONFIG.adminUserIds.includes(userId);
}

async function requireAdmin(interaction: ChatInputCommandInteraction<CacheType>): Promise<boolean> {
  if (!isAdmin(interaction.user.id)) {
    await interaction.reply({ content: '⛔ You don\'t have permission for that.', ephemeral: true });
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
// Commands
// ---------------------------------------------------------------------------
commands.set('stats', async (interaction) => {
  await deferReply(interaction, false);
  const stats = getStats();

  const embed = new EmbedBuilder()
    .setColor(0x00AAFF)
    .setTitle('📊 Tracker Stats')
    .addFields(
      { name: 'Total Detected', value: String(stats.totalDetected), inline: true },
      { name: 'Active Right Now', value: String(stats.activeGiveaways), inline: true },
      { name: 'Servers', value: String(stats.serversWithGiveaways), inline: true },
      { name: 'Last Detection', value: stats.lastDetected ? formatTimestamp(stats.lastDetected) : 'Never', inline: false },
    )
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
});

commands.set('active', async (interaction) => {
  await deferReply(interaction, false);
  const active = getActiveGiveaways(10);

  if (active.length === 0) {
    await interaction.editReply({ content: 'Nothing active at the moment. Check /recent for past ones.' });
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(0xFFD700)
    .setTitle(`🎯 ${active.length} Active Giveaway${active.length > 1 ? 's' : ''}`)
    .setTimestamp();

  for (const g of active.slice(0, 10)) {
    const ends = g.endsAt ? `<t:${Math.floor(g.endsAt / 1000)}:R>` : 'Unknown';
    embed.addFields({
      name: truncate(g.prize, 50),
      value: `${g.guildName} — #${g.channelName}\nEnds: ${ends}`,
      inline: false,
    });
  }

  if (active.length > 10) {
    embed.setFooter({ text: `+ ${active.length - 10} more not shown` });
  }

  await interaction.editReply({ embeds: [embed] });
});

commands.set('recent', async (interaction) => {
  await deferReply(interaction, false);
  const recent = getAllGiveaways(10);

  if (recent.length === 0) {
    await interaction.editReply({ content: 'Nothing tracked yet. Once giveaways get detected they\'ll show up here.' });
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle(`📋 Last ${recent.length} Giveaway${recent.length > 1 ? 's' : ''}`)
    .setTimestamp();

  for (const g of recent) {
    embed.addFields({
      name: truncate(g.prize, 40),
      value: `${g.guildName} — ${g.status === 'active' ? '🟢 Active' : '🔴 Ended'}\n${formatTimestamp(g.detectedAt)}`,
      inline: false,
    });
  }

  await interaction.editReply({ embeds: [embed] });
});

commands.set('setchannel', async (interaction) => {
  if (!await requireAdmin(interaction)) return;
  const channel = interaction.options.getChannel('channel', true);

  if (![ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildMedia].includes(channel.type)) {
    await interaction.reply({ content: 'That channel type won\'t work. Pick a text channel.', ephemeral: true });
    return;
  }

  (CONFIG as any).trackerChannelId = channel.id;
  await interaction.reply({ content: `✅ Notifications will now go to ${channel}`, ephemeral: true });
});

commands.set('reset', async (interaction) => {
  if (!await requireAdmin(interaction)) return;
  await deferReply(interaction, true);
  resetDatabase();
  await interaction.editReply({ content: 'Database wiped. Fresh start.' });
});

commands.set('status', async (interaction) => {
  if (!await requireAdmin(interaction)) return;
  await deferReply(interaction, false);

  const stats = getStats();
  const embed = new EmbedBuilder()
    .setColor(0x00FF00)
    .setTitle('🟢 Running')
    .addFields(
      { name: 'Total', value: String(stats.totalDetected), inline: true },
      { name: 'Active', value: String(stats.activeGiveaways), inline: true },
      { name: 'Servers', value: String(stats.serversWithGiveaways), inline: true },
      { name: 'Notifications', value: `<#${CONFIG.trackerChannelId}> — ${CONFIG.notificationCooldown}s cooldown`, inline: false },
    )
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
});

commands.set('help', async (interaction) => {
  await deferReply(interaction, false);
  const embed = new EmbedBuilder()
    .setColor(0x9B59B6)
    .setTitle('Commands')
    .addFields(
      { name: '/stats', value: 'See overall detection stats', inline: false },
      { name: '/active', value: 'Show currently running giveaways', inline: false },
      { name: '/recent', value: 'Last few detected giveaways', inline: false },
      { name: '/status', value: 'Check if everything\'s working (admin)', inline: false },
      { name: '/setchannel', value: 'Where to send notifications (admin)', inline: false },
      { name: '/reset', value: 'Clear the database (admin)', inline: false },
    )
    .setFooter({ text: 'made by gab' })
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
      logger.info(`Logged in as ${this.client.user?.tag}`, { component: 'BotManager' });
      this.registerCommands().catch(err => logger.error('Command registration failed', { error: formatError(err) }));
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
        logger.error(`Command error: ${interaction.commandName}`, { error: formatError(err) });
        const reply = interaction.replied || interaction.deferred ? interaction.editReply : interaction.reply;
        await reply({ content: 'Something went wrong.', ephemeral: true });
      }
    });

    this.client.on('error', (err) => logger.error('Client error', { error: err }));
  }

  async start(): Promise<void> {
    await this.client.login(this.botToken);
  }

  async destroy(): Promise<void> {
    await this.client.destroy();
  }

  // -------------------------------------------------------------------------
  // Send a giveaway notification
  // -------------------------------------------------------------------------
  public async sendGiveawayNotification(data: GiveawayData & { inviteUrl?: string }): Promise<boolean> {
    const channel = this.client.channels.cache.get(CONFIG.trackerChannelId) as TextChannel | undefined;
    if (!channel) {
      logger.error(`Channel ${CONFIG.trackerChannelId} not found`, { component: 'BotManager' });
      return false;
    }

    const guild = this.client.guilds.cache.get(data.guildId);
    const guildName = guild?.name || data.guildName || 'Unknown Server';
    const guildIcon = guild?.iconURL({ size: 512 }) || null;
    const guildBanner = guild?.bannerURL({ size: 1024 }) || null;
    const memberCount = guild?.memberCount ?? null;

    const safeGuildId = isValidSnowflake(data.guildId) ? data.guildId : '0';
    const safeChannelId = isValidSnowflake(data.channelId) ? data.channelId : '0';
    const safeMessageId = isValidSnowflake(data.messageId) ? data.messageId : '0';

    const inviteUrl = data.inviteUrl || 'No invite available';
    const endsAt = data.endsAt || Date.now() + 3600000;
    const detectionTime = Date.now() - data.detectedAt;
    const endTimestamp = Math.floor(endsAt / 1000);
    const winnerCount = this.extractWinnerCount(data.prize);

    const description = [
      `### 📋 Details`,
      `**Server:** ${guildName}`,
      `**Channel:** #${data.channelName}`,
      `**Winners:** ${winnerCount}`,
      ``,
      `### ⏰ Time`,
      `**Ends:** <t:${endTimestamp}:F>`,
      `**Countdown:** <t:${endTimestamp}:R>`,
      ``,
      `### 🔗 Links`,
      `**Invite:** ${inviteUrl}`,
      memberCount ? `**Members:** ${memberCount.toLocaleString()}` : '',
    ].filter(Boolean).join('\n');

    const embed = new EmbedBuilder()
      .setAuthor({ name: 'New Giveaway', iconURL: this.client.user?.displayAvatarURL() })
      .setTitle(data.prize || 'Unknown Prize')
      .setDescription(description)
      .setColor(0x5865F2)
      .setThumbnail(guildIcon)
      .setFooter({ text: `Detected in ${detectionTime}ms`, iconURL: this.client.user?.displayAvatarURL() })
      .setTimestamp(data.detectedAt);

    if (guildBanner) embed.setImage(guildBanner);

    const messageUrl = safeUrl('https://discord.com/channels', safeGuildId, safeChannelId, safeMessageId);
    const row = new ActionRowBuilder<ButtonBuilder>();

    if (inviteUrl.startsWith('http')) {
      row.addComponents(new ButtonBuilder().setLabel('Join Server').setStyle(ButtonStyle.Link).setURL(inviteUrl));
    }
    row.addComponents(
      new ButtonBuilder().setLabel('Message').setStyle(ButtonStyle.Link).setURL(messageUrl),
      new ButtonBuilder().setLabel('Jump').setStyle(ButtonStyle.Link).setURL(messageUrl),
    );

    try {
      await channel.send({
        content: `🎉 **@everyone** — **${guildName}** is hosting a giveaway`,
        embeds: [embed],
        components: [row],
      });
      logger.info(`Notification sent: ${data.messageId}`, { component: 'BotManager', prize: truncate(data.prize, 50) });
      return true;
    } catch (err) {
      logger.error('Notification failed', { component: 'BotManager', error: formatError(err) });
      return false;
    }
  }

  private extractWinnerCount(prize: string): string {
    const match = prize.match(/(\d+)\s*[xX×]/);
    if (match) return match[1];
    if (/\b(?:one|1)\s*(?:winner|win|giveaway)/i.test(prize)) return '1';
    const m = prize.match(/(\d+)\s*(?:winners?)/i);
    if (m) return m[1];
    return '1';
  }

  // -------------------------------------------------------------------------
  // Slash command registration
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
      new SlashCommandBuilder().setName('help').setDescription('List commands'),
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
