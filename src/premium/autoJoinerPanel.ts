/**
 * @module autoJoinerPanel
 * Auto Joiner panel - Add token, webhook, and check status
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  TextChannel,
  ButtonInteraction,
  Message,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ModalSubmitInteraction,
} from 'discord.js';
import {
  getPremiumUser,
  setPremiumUser,
  updateUserToken,
  updateUserWebhook,
  getUserToken,
  getUserWebhook,
} from '../database.js';
import { isPremium } from './licenseMiddleware.js';
import { encryptToken, decryptToken, validateDiscordToken } from './tokenManager.js';
import { logger } from '../logger.js';

export class AutoJoinerPanel {
  private panelMessage: Message | null = null;

  constructor(private channel: TextChannel) {}

  // ============================================================================
  // PUBLIC PANEL - Auto Joiner
  // ============================================================================

  async sendPanel(): Promise<void> {
    if (this.panelMessage) {
      try { await this.panelMessage.delete(); } catch {}
    }

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('Auto Joiner')
      .setDescription('Click the buttons below to start.');

    const row = new ActionRowBuilder<ButtonBuilder>()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('autojoiner_add_token')
          .setLabel('Add Token')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('autojoiner_add_webhook')
          .setLabel('Add Webhook')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('autojoiner_status')
          .setLabel('Status')
          .setStyle(ButtonStyle.Secondary),
      );

    this.panelMessage = await this.channel.send({
      embeds: [embed],
      components: [row],
    });

    logger.debug('Auto Joiner panel sent', { channelId: this.channel.id });
  }

  // ============================================================================
  // Button Interaction Handler
  // ============================================================================

  async handleInteraction(interaction: ButtonInteraction): Promise<void> {
    const { customId } = interaction;

    if (customId === 'autojoiner_add_token') {
      await this.showAddTokenModal(interaction);
      return;
    }

    if (customId === 'autojoiner_add_webhook') {
      await this.showAddWebhookModal(interaction);
      return;
    }

    if (customId === 'autojoiner_status') {
      await this.handleStatus(interaction);
      return;
    }
  }

  // ============================================================================
  // Add Token Modal
  // ============================================================================

  private async showAddTokenModal(interaction: ButtonInteraction): Promise<void> {
    // Check if user has premium
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.reply({
        content: 'This must be used in a server.',
        ephemeral: true,
      });
      return;
    }

    const hasPremium = await isPremium(interaction.user.id, guildId);
    if (!hasPremium) {
      await interaction.reply({
        content: 'Premium access required to use Auto Joiner. Activate premium first.',
        ephemeral: true,
      });
      return;
    }

    const modal = new ModalBuilder()
      .setCustomId('autojoiner_token_modal')
      .setTitle('Add Discord Token');

    const tokenInput = new TextInputBuilder()
      .setCustomId('discord_token')
      .setLabel('Enter your Discord token')
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder('Paste your Discord token here')
      .setRequired(true)
      .setMinLength(50)
      .setMaxLength(200);

    const labelInput = new TextInputBuilder()
      .setCustomId('token_label')
      .setLabel('Label (optional)')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('e.g., main, alt')
      .setRequired(false)
      .setMaxLength(20);

    const row1 = new ActionRowBuilder<TextInputBuilder>().addComponents(tokenInput);
    const row2 = new ActionRowBuilder<TextInputBuilder>().addComponents(labelInput);

    modal.addComponents(row1, row2);

    await interaction.showModal(modal);
  }

  async handleTokenModal(interaction: ModalSubmitInteraction): Promise<void> {
    if (interaction.customId !== 'autojoiner_token_modal') {
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    const token = interaction.fields.getTextInputValue('discord_token').trim();
    const label = interaction.fields.getTextInputValue('token_label').trim() || 'main';

    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.editReply({
        content: 'This must be used in a server.',
      });
      return;
    }

    try {
      // Validate token
      const isValid = await validateDiscordToken(token);
      if (!isValid) {
        await interaction.editReply({
          content: 'Invalid Discord token. Please check and try again.',
        });
        return;
      }

      // Encrypt and store token
      const encryptedToken = encryptToken(token);
      await setPremiumUser(interaction.user.id, guildId, 'manual');
      await updateUserToken(interaction.user.id, guildId, encryptedToken, label);

      logger.info('Token added for user', {
        userId: interaction.user.id,
        guildId,
        label,
      });

      await interaction.editReply({
        content: `Token added successfully. Label: ${label}`,
      });
    } catch (error) {
      logger.error('Failed to add token', {
        userId: interaction.user.id,
        error: String(error),
      });
      await interaction.editReply({
        content: `Failed to add token: ${error instanceof Error ? error.message : 'Unknown error'}`,
      });
    }
  }

  // ============================================================================
  // Add Webhook Modal
  // ============================================================================

  private async showAddWebhookModal(interaction: ButtonInteraction): Promise<void> {
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.reply({
        content: 'This must be used in a server.',
        ephemeral: true,
      });
      return;
    }

    const hasPremium = await isPremium(interaction.user.id, guildId);
    if (!hasPremium) {
      await interaction.reply({
        content: 'Premium access required to add a webhook.',
        ephemeral: true,
      });
      return;
    }

    const modal = new ModalBuilder()
      .setCustomId('autojoiner_webhook_modal')
      .setTitle('Add Win Webhook');

    const webhookInput = new TextInputBuilder()
      .setCustomId('webhook_url')
      .setLabel('Webhook URL')
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder('https://discord.com/api/webhooks/...')
      .setRequired(true)
      .setMinLength(30)
      .setMaxLength(200);

    const row = new ActionRowBuilder<TextInputBuilder>().addComponents(webhookInput);
    modal.addComponents(row);

    await interaction.showModal(modal);
  }

  async handleWebhookModal(interaction: ModalSubmitInteraction): Promise<void> {
    if (interaction.customId !== 'autojoiner_webhook_modal') {
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    const webhookUrl = interaction.fields.getTextInputValue('webhook_url').trim();

    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.editReply({
        content: 'This must be used in a server.',
      });
      return;
    }

    try {
      // Validate webhook URL format
      if (!webhookUrl.startsWith('https://discord.com/api/webhooks/')) {
        await interaction.editReply({
          content: 'Invalid webhook URL. Must start with https://discord.com/api/webhooks/',
        });
        return;
      }

      await updateUserWebhook(interaction.user.id, guildId, webhookUrl);

      logger.info('Webhook added for user', {
        userId: interaction.user.id,
        guildId,
      });

      await interaction.editReply({
        content: 'Webhook added successfully.',
      });
    } catch (error) {
      logger.error('Failed to add webhook', {
        userId: interaction.user.id,
        error: String(error),
      });
      await interaction.editReply({
        content: `Failed to add webhook: ${error instanceof Error ? error.message : 'Unknown error'}`,
      });
    }
  }

  // ============================================================================
  // Status
  // ============================================================================

  private async handleStatus(interaction: ButtonInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.editReply({
        content: 'This must be used in a server.',
      });
      return;
    }

    const user = await getPremiumUser(interaction.user.id, guildId);

    if (!user || !user.isPremium) {
      await interaction.editReply({
        content: 'You do not have premium access. Activate premium first.',
      });
      return;
    }

    const hasToken = user.token !== null;
    const hasWebhook = user.webhookUrl !== null;

    const statusLines = [
      '**Auto Joiner Status**',
      '',
      `Premium: ✅`,
      `Token: ${hasToken ? '✅ Set' : '❌ Not set'}`,
      `Webhook: ${hasWebhook ? '✅ Set' : '❌ Not set'}`,
    ];

    if (hasToken) {
      statusLines.push(`Token Label: ${user.tokenLabel || 'main'}`);
      statusLines.push(`Token Added: ${new Date(user.tokenAddedAt || 0).toLocaleString()}`);
      if (user.tokenEntries !== undefined) {
        statusLines.push(`Entries: ${user.tokenEntries}`);
      }
      if (user.tokenWins !== undefined) {
        statusLines.push(`Wins: ${user.tokenWins}`);
      }
      statusLines.push(`Active: ${user.tokenActive ? '✅' : '❌'}`);
    }

    if (hasWebhook) {
      statusLines.push(`Webhook Added: ${new Date(user.webhookAddedAt || 0).toLocaleString()}`);
    }

    await interaction.editReply({
      content: statusLines.join('\n'),
    });
  }
}
