/**
 * @module premiumPanel
 * Premium Panel - AutoJoiner configuration
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
} from '../database.js';
import { isPremium } from '../license/licenseMiddleware.js';
import {
  encryptToken,
  validateDiscordToken,
  startTokenSession,
  isSessionActive,
} from './tokenManager.js';
import { logger } from '../logger.js';

export class PremiumPanel {
  private panelMessage: Message | null = null;

  constructor(private channel: TextChannel) {}

  async sendPanel(): Promise<void> {
    if (this.panelMessage) {
      try { await this.panelMessage.delete(); } catch {}
    }

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('Premium Panel')
      .setDescription('Configure your AutoJoiner settings.');

    const row = new ActionRowBuilder<ButtonBuilder>()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('premium_autojoiner')
          .setLabel('AutoJoiner')
          .setStyle(ButtonStyle.Primary),
      );

    this.panelMessage = await this.channel.send({
      embeds: [embed],
      components: [row],
    });

    logger.debug('Premium panel sent', { channelId: this.channel.id });
  }

  async handleInteraction(interaction: ButtonInteraction): Promise<void> {
    if (interaction.customId === 'premium_autojoiner') {
      await this.showAutoJoinerModal(interaction);
    }
  }

  private async showAutoJoinerModal(interaction: ButtonInteraction): Promise<void> {
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
        content: 'Premium access required to use AutoJoiner. Activate premium first.',
        ephemeral: true,
      });
      return;
    }

    // Get existing values
    const user = await getPremiumUser(interaction.user.id, guildId);
    const existingToken = user?.token || '';
    const existingWebhook = user?.webhookUrl || '';

    const modal = new ModalBuilder()
      .setCustomId('premium_autojoiner_modal')
      .setTitle('AutoJoiner Settings');

    const tokenInput = new TextInputBuilder()
      .setCustomId('discord_token')
      .setLabel('Discord Token')
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder('Paste your Discord token here')
      .setRequired(true)
      .setMinLength(50)
      .setMaxLength(200)
      .setValue(existingToken ? '••••••••••••••••' : '');

    const webhookInput = new TextInputBuilder()
      .setCustomId('webhook_url')
      .setLabel('Webhook (optional)')
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder('https://discord.com/api/webhooks/...')
      .setRequired(false)
      .setMinLength(0)
      .setMaxLength(200)
      .setValue(existingWebhook || '');

    const row1 = new ActionRowBuilder<TextInputBuilder>().addComponents(tokenInput);
    const row2 = new ActionRowBuilder<TextInputBuilder>().addComponents(webhookInput);

    modal.addComponents(row1, row2);

    await interaction.showModal(modal);
  }

  async handleModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
    if (interaction.customId !== 'premium_autojoiner_modal') {
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    const token = interaction.fields.getTextInputValue('discord_token').trim();
    const webhookUrl = interaction.fields.getTextInputValue('webhook_url').trim();

    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.editReply({
        content: 'This must be used in a server.',
      });
      return;
    }

    try {
      // Validate token (if provided and not masked)
      if (token && token !== '••••••••••••••••') {
        const isValid = await validateDiscordToken(token);
        if (!isValid) {
          await interaction.editReply({
            content: 'Invalid Discord token. Please check and try again.',
          });
          return;
        }

        const encryptedToken = encryptToken(token);
        await updateUserToken(interaction.user.id, guildId, encryptedToken, 'main');

        // Start token session
        startTokenSession(interaction.user.id, guildId, token, 'main');
      }

      // Validate webhook format (if provided)
      if (webhookUrl) {
        if (!webhookUrl.startsWith('https://discord.com/api/webhooks/')) {
          await interaction.editReply({
            content: 'Invalid webhook URL. Must start with https://discord.com/api/webhooks/',
          });
          return;
        }
        await updateUserWebhook(interaction.user.id, guildId, webhookUrl);
      }

      // Ensure user is marked as premium
      await setPremiumUser(interaction.user.id, guildId, 'manual');

      logger.info('AutoJoiner settings updated', {
        userId: interaction.user.id,
        guildId,
        hasToken: !!token && token !== '••••••••••••••••',
        hasWebhook: !!webhookUrl,
      });

      await interaction.editReply({
        content: 'AutoJoiner settings saved successfully.',
      });
    } catch (error) {
      logger.error('Failed to save AutoJoiner settings', {
        userId: interaction.user.id,
        error: String(error),
      });
      await interaction.editReply({
        content: `Failed to save settings: ${error instanceof Error ? error.message : 'Unknown error'}`,
      });
    }
  }
}
