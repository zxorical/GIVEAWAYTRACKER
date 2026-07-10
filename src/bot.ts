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

  // Update config in memory (persists until restart)
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

  constructor(private readonly botToken: string) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
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
   * Send a giveaway notification to the configured tracker channel
   */
  public async sendGiveawayNotification(data: GiveawayData): Promise<boolean> {
    const channelId = CONFIG.trackerChannelId;
    const channel = this.client.channels.cache.get(channelId) as TextChannel | undefined;

    if (!channel) {
      logger.error(`Tracker channel ${channelId} not found or not a text channel`, {
        component: 'BotManager',
        availableChannels: this.client.channels.cache.size,
      });
      return false;
    }

    const endsAt = data.endsAt ? formatTimestamp(data.endsAt) : 'Unknown';
    const jumpUrl = `https://discord.com/channels/${data.guildId}/${data.channelId}/${data.messageId}`;

    const embed = new EmbedBuilder()
      .setTitle('🎁 New Giveaway Detected')
      .setDescription(truncate(data.prize, 200))
      .addFields(
        { name: '🏠 Server', value: data.guildName, inline: true },
        { name: '📢 Channel', value: `#${data.channelName}`, inline: true },
        { name: '⏰ Ends At', value: endsAt, inline: true },
        { name: '🔗 Jump', value: `[Click here](${jumpUrl})`, inline: false },
      )
      .setColor(0x5865F2)
      .setTimestamp()
      .setFooter({ text: `Detected by ${data.authorId || 'unknown'}` });

    try {
      await channel.send({ embeds: [embed] });
      logger.info(`Notification sent for giveaway ${data.messageId}`, {
        component: 'BotManager',
        channel: channelId,
        prize: truncate(data.prize, 50),
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
