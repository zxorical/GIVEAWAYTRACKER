/**
 * @module bot
 * Notification bot, slash commands, and giveaway ping role panel
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
  ButtonInteraction,
  ActivityType,
} from 'discord.js';
import { CONFIG } from './config.js';
import { logger } from './logger.js';
import { formatTimestamp, truncate, formatError } from './utils.js';
import { GiveawayData } from './types.js';
import { getStats, getActiveGiveaways, resetDatabase, getAllGiveaways } from './database.js';

type CommandHandler = (interaction: ChatInputCommandInteraction<CacheType>) => Promise<void>;

const commands = new Map<string, CommandHandler>();

const PANEL_CHANNEL_ID = process.env.PANEL_CHANNEL_ID || CONFIG.trackerChannelId;
const PING_ROLE_ID = process.env.PING_ROLE_ID || '';

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
    await interaction.reply({ content: '⛔ No permission.', ephemeral: true });
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
      { name: '🎯 Total Detected', value: String(stats.totalDetected), inline: true },
      { name: '🟢 Active', value: String(stats.activeGiveaways), inline: true },
      { name: '🌐 Servers', value: String(stats.serversWithGiveaways), inline: true },
      { name: '⏱️ Last Detection', value: stats.lastDetected ? formatTimestamp(stats.lastDetected) : 'Never', inline: false },
    )
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
});

commands.set('active', async (interaction) => {
  await deferReply(interaction, false);
  const active = getActiveGiveaways(10);

  if (active.length === 0) {
    await interaction.editReply({ content: '🔍 Nothing active right now.' });
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(0xFFD700)
    .setTitle(`🎯 ${active.length} Active`)
    .setTimestamp();

  for (const g of active.slice(0, 10)) {
    const ends = g.endsAt ? `<t:${Math.floor(g.endsAt / 1000)}:R>` : 'Unknown';
    embed.addFields({
      name: `🏆 ${truncate(g.prize, 50)}`,
      value: `🏠 ${g.guildName} — 💬 #${g.channelName}\n⏳ Ends: ${ends}`,
      inline: false,
    });
  }

  await interaction.editReply({ embeds: [embed] });
});

commands.set('recent', async (interaction) => {
  await deferReply(interaction, false);
  const recent = getAllGiveaways(10);

  if (recent.length === 0) {
    await interaction.editReply({ content: '📭 Nothing yet.' });
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('📋 Recent')
    .setTimestamp();

  for (const g of recent) {
    embed.addFields({
      name: `${g.status === 'active' ? '🟢' : '🔴'} ${truncate(g.prize, 40)}`,
      value: `🏠 ${g.guildName}\n${formatTimestamp(g.detectedAt)}`,
      inline: false,
    });
  }

  await interaction.editReply({ embeds: [embed] });
});

commands.set('setchannel', async (interaction) => {
  if (!await requireAdmin(interaction)) return;
  const channel = interaction.options.getChannel('channel', true);

  if (![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) {
    await interaction.reply({ content: '❌ Pick a text channel.', ephemeral: true });
    return;
  }

  (CONFIG as any).trackerChannelId = channel.id;
  await interaction.reply({ content: `✅ Set to ${channel}`, ephemeral: true });
});

commands.set('reset', async (interaction) => {
  if (!await requireAdmin(interaction)) return;
  await deferReply(interaction, true);
  resetDatabase();
  await interaction.editReply({ content: '🗑️ Wiped.' });
});

commands.set('status', async (interaction) => {
  if (!await requireAdmin(interaction)) return;
  await deferReply(interaction, false);

  const stats = getStats();
  const embed = new EmbedBuilder()
    .setColor(0x00FF00)
    .setTitle('🟢 Running')
    .addFields(
      { name: '📊 Total', value: String(stats.totalDetected), inline: true },
      { name: '🟢 Active', value: String(stats.activeGiveaways), inline: true },
      { name: '🌐 Servers', value: String(stats.serversWithGiveaways), inline: true },
      { name: '📨 Channel', value: `<#${CONFIG.trackerChannelId}>`, inline: false },
    )
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
});

commands.set('help', async (interaction) => {
  await deferReply(interaction, false);
  const embed = new EmbedBuilder()
    .setColor(0x9B59B6)
    .setTitle('📚 Commands')
    .addFields(
      { name: '📊 /stats', value: 'Detection stats', inline: false },
      { name: '🎯 /active', value: 'Active giveaways', inline: false },
      { name: '📋 /recent', value: 'Recent giveaways', inline: false },
      { name: '🟢 /status', value: 'System status (admin)', inline: false },
      { name: '⚙️ /setchannel', value: 'Set notify channel (admin)', inline: false },
      { name: '🗑️ /reset', value: 'Clear database (admin)', inline: false },
      { name: '🔔 /panel', value: 'Resend role panel (admin)', inline: false },
    )
    .setFooter({ text: 'made by gab' })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
});

commands.set('panel', async (interaction) => {
  if (!await requireAdmin(interaction)) return;
  await deferReply(interaction, true);
  await sendRolePanel(interaction.client);
  await interaction.editReply({ content: '✅ Panel sent.' });
});

commands.set('purge', async (interaction) => {
  if (!await requireAdmin(interaction)) return;
  const amount = interaction.options.getInteger('amount') || 50;
  await deferReply(interaction, true);

  const channel = interaction.channel as TextChannel;
  if (!channel) return;

  try {
    const messages = await channel.messages.fetch({ limit: 100 });
    const botMessages = messages.filter(m => m.author.id === interaction.client.user.id);
    const toDelete = botMessages.first(amount);

    if (toDelete.length === 0) {
      await interaction.editReply({ content: '📭 Nothing to delete.' });
      return;
    }

    await channel.bulkDelete(toDelete, true);
    await interaction.editReply({ content: `🗑️ Deleted ${toDelete.length}.` });
  } catch {
    await interaction.editReply({ content: '❌ Failed.' });
  }
});

// ---------------------------------------------------------------------------
// Role Panel
// ---------------------------------------------------------------------------
async function sendRolePanel(client: Client): Promise<void> {
  if (!PANEL_CHANNEL_ID) {
    logger.warn('No panel channel set. Set PANEL_CHANNEL_ID in env.', { component: 'BotManager' });
    return;
  }

  const channel = client.channels.cache.get(PANEL_CHANNEL_ID) as TextChannel | undefined;
  if (!channel) {
    logger.error(`Panel channel ${PANEL_CHANNEL_ID} not found`, { component: 'BotManager' });
    return;
  }

  try {
    const messages = await channel.messages.fetch({ limit: 20 });
    const oldPanel = messages.find(m =>
      m.author.id === client.user?.id &&
      m.embeds.length > 0 &&
      m.embeds[0]?.title === '🔔 Giveaway Notifications'
    );
    if (oldPanel) await oldPanel.delete().catch(() => {});
  } catch {}

  const embed = new EmbedBuilder()
    .setColor(0xF1C40F)
    .setTitle('🔔 Giveaway Notifications')
    .setDescription(
      'Click the button to toggle giveaway pings.\n' +
      'You\'ll get mentioned whenever a new giveaway is detected.'
    )
    .setFooter({ text: 'Toggle anytime' });

  const row = new ActionRowBuilder<ButtonBuilder>()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('toggle_ping')
        .setLabel('Toggle Pings')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('🔔')
    );

  try {
    await channel.send({ embeds: [embed], components: [row] });
    logger.info('Panel sent', { component: 'BotManager', channelId: channel.id });
  } catch (err) {
    logger.error('Failed to send panel', { component: 'BotManager', error: formatError(err) });
  }
}

async function handlePingToggle(interaction: ButtonInteraction): Promise<void> {
  if (!PING_ROLE_ID) {
    await interaction.reply({ content: '❌ Ping role not configured.', ephemeral: true });
    return;
  }

  const role = interaction.guild?.roles.cache.get(PING_ROLE_ID);
  if (!role) {
    await interaction.reply({ content: '❌ Role not found.', ephemeral: true });
    return;
  }

  const member = interaction.member;
  if (!member || !('roles' in member)) {
    await interaction.reply({ content: '❌ Something went wrong.', ephemeral: true });
    return;
  }

  const hasRole = (member.roles as any).cache?.has(role.id) ?? false;

  try {
    if (hasRole) {
      await (member.roles as any).remove(role);
      await interaction.reply({ content: '🔕 Removed the role. You won\'t be pinged.', ephemeral: true });
    } else {
      await (member.roles as any).add(role);
      await interaction.reply({ content: '🔔 Added the role. You\'ll get pinged for giveaways!', ephemeral: true });
    }
  } catch {
    await interaction.reply({ content: '❌ Failed. Does the bot have Manage Roles permission?', ephemeral: true });
  }
}

// ---------------------------------------------------------------------------
// Rich Presence
// ---------------------------------------------------------------------------
function updatePresence(client: Client): void {
  const stats = getStats();
  const total = stats.totalDetected || 0;

  client.user?.setPresence({
    activities: [{ name: `Tracked ${total} giveaways!`, type: ActivityType.Watching }],
    status: 'online',
  });
}

// ---------------------------------------------------------------------------
// BotManager
// ---------------------------------------------------------------------------
export class BotManager {
  private client: Client;
  private commandsRegistered = false;
  private presenceInterval: NodeJS.Timeout | null = null;

  constructor(private readonly botToken: string) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
      ],
    });

    this.client.once('ready', async () => {
      logger.info(`Logged in as ${this.client.user?.tag}`, { component: 'BotManager' });
      updatePresence(this.client);

      this.presenceInterval = setInterval(() => updatePresence(this.client), 30000);

      await this.registerCommands();
      await sendRolePanel(this.client);
    });

    this.client.on('interactionCreate', async (interaction: Interaction) => {
      if (interaction.isButton()) {
        if (interaction.customId === 'toggle_ping') {
          await handlePingToggle(interaction);
        }
        return;
      }

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
    if (this.presenceInterval) clearInterval(this.presenceInterval);
    await this.client.destroy();
  }

  // -------------------------------------------------------------------------
  // Notification
  // -------------------------------------------------------------------------
  public async sendGiveawayNotification(data: GiveawayData & { inviteUrl?: string }): Promise<boolean> {
    const channel = this.client.channels.cache.get(CONFIG.trackerChannelId) as TextChannel | undefined;
    if (!channel) {
      logger.error(`Channel ${CONFIG.trackerChannelId} not found`, { component: 'BotManager' });
      return false;
    }

    const guild = this.client.guilds.cache.get(data.guildId);
    const guildName = guild?.name || data.guildName || 'Unknown';
    const guildIcon = guild?.iconURL({ size: 512 }) || null;
    const guildBanner = guild?.bannerURL({ size: 1024 }) || null;
    const memberCount = guild?.memberCount ?? null;

    const safeGuildId = isValidSnowflake(data.guildId) ? data.guildId : '0';
    const safeChannelId = isValidSnowflake(data.channelId) ? data.channelId : '0';
    const safeMessageId = isValidSnowflake(data.messageId) ? data.messageId : '0';

    const inviteUrl = data.inviteUrl || 'No invite';
    const endsAt = data.endsAt || Date.now() + 3600000;
    const detectionTime = Date.now() - data.detectedAt;
    const endTimestamp = Math.floor(endsAt / 1000);
    const winnerCount = this.extractWinnerCount(data.prize);

    const pingMention = PING_ROLE_ID ? `<@&${PING_ROLE_ID}>` : '@everyone';

    const description = [
      `### 🎁 Details`,
      `**🏠 Server:** ${guildName}`,
      `**💬 Channel:** #${data.channelName}`,
      `**👑 Winners:** ${winnerCount}`,
      ``,
      `### ⏰ Time`,
      `**📅 Ends:** <t:${endTimestamp}:F>`,
      `**⏳ Countdown:** <t:${endTimestamp}:R>`,
      ``,
      `### 🔗 Links`,
      `**📨 Invite:** ${inviteUrl}`,
      memberCount ? `**👥 Members:** ${memberCount.toLocaleString()}` : '',
    ].filter(Boolean).join('\n');

    const embed = new EmbedBuilder()
      .setAuthor({ name: '🎁 New Giveaway', iconURL: this.client.user?.displayAvatarURL() })
      .setTitle(data.prize || 'Unknown Prize')
      .setDescription(description)
      .setColor(0x5865F2)
      .setThumbnail(guildIcon)
      .setFooter({ text: `⚡ Detected in ${detectionTime}ms`, iconURL: this.client.user?.displayAvatarURL() })
      .setTimestamp(data.detectedAt);

    if (guildBanner) embed.setImage(guildBanner);

    const messageUrl = safeUrl('https://discord.com/channels', safeGuildId, safeChannelId, safeMessageId);
    const row = new ActionRowBuilder<ButtonBuilder>();

    if (inviteUrl.startsWith('http')) {
      row.addComponents(new ButtonBuilder().setLabel('Join Server').setStyle(ButtonStyle.Link).setURL(inviteUrl).setEmoji('🚀'));
    }
    row.addComponents(
      new ButtonBuilder().setLabel('Message').setStyle(ButtonStyle.Link).setURL(messageUrl).setEmoji('💬'),
      new ButtonBuilder().setLabel('Jump').setStyle(ButtonStyle.Link).setURL(messageUrl).setEmoji('🎯'),
    );

    try {
      await channel.send({
        content: pingMention,
        embeds: [embed],
        components: [row],
      });

      updatePresence(this.client);

      logger.info(`Notification sent: ${data.messageId}`, { component: 'BotManager' });
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
      new SlashCommandBuilder().setName('panel').setDescription('Resend the role panel (admin)').setDefaultMemberPermissions(0),
      new SlashCommandBuilder()
        .setName('purge')
        .setDescription('Delete bot messages (admin)')
        .addIntegerOption(opt => opt.setName('amount').setDescription('How many'))
        .setDefaultMemberPermissions(0),
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
