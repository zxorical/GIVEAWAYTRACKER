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

  /**
   * showModal() must be the FIRST response and must fire within ~3s.
   * The old version called isPremium() (live Discord API call) and
   * getPremiumUser() (Mongo read) BEFORE showModal() — either one
   * occasionally taking >3s is exactly what caused the infinite
   * loading. Now we show the modal instantly with no pre-checks,
   * and do the premium check + DB work in handleModalSubmit, where
   * deferReply() already buys 15 minutes instead of 3 seconds.
   */
  async handleInteraction(interaction: ButtonInteraction): Promise<void> {
    if (interaction.customId !== 'premium_autojoiner') return;

    if (!interaction.guildId) {
      await interaction.reply({
        content: 'This must be used in a server.',
        ephemeral: true,
      });
      return;
    }

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
      .setMaxLength(200);

    const webhookInput = new TextInputBuilder()
      .setCustomId('webhook_url')
      .setLabel('Webhook (optional)')
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder('https://discord.com/api/webhooks/...')
      .setRequired(false)
      .setMinLength(0)
      .setMaxLength(200);

    const row1 = new ActionRowBuilder<TextInputBuilder>().addComponents(tokenInput);
    const row2 = new ActionRowBuilder<TextInputBuilder>().addComponents(webhookInput);

    modal.addComponents(row1, row2);

    // Fires instantly — no async work before this line.
    await interaction.showModal(modal);
  }

  async handleModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
    if (interaction.customId !== 'premium_autojoiner_modal') {
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.editReply({
        content: 'This must be used in a server.',
      });
      return;
    }

    const hasPremium = await isPremium(interaction.user.id, guildId);
    if (!hasPremium) {
      await interaction.editReply({
        content: 'Premium access required to use AutoJoiner. Activate premium first.',
      });
      return;
    }

    const token = interaction.fields.getTextInputValue('discord_token').trim();
    const webhookUrl = interaction.fields.getTextInputValue('webhook_url').trim();

    try {
      if (token) {
        const isValid = await validateDiscordToken(token);
        if (!isValid) {
          await interaction.editReply({
            content: 'Invalid Discord token. Please check and try again.',
          });
          return;
        }

        const encryptedToken = encryptToken(token);
        await updateUserToken(interaction.user.id, guildId, encryptedToken, 'main');
        startTokenSession(interaction.user.id, guildId, token, 'main');
      }

      if (webhookUrl) {
        if (!webhookUrl.startsWith('https://discord.com/api/webhooks/')) {
          await interaction.editReply({
            content: 'Invalid webhook URL. Must start with https://discord.com/api/webhooks/',
          });
          return;
        }
        await updateUserWebhook(interaction.user.id, guildId, webhookUrl);
      }

      await setPremiumUser(interaction.user.id, guildId, 'manual');

      logger.info('AutoJoiner settings updated', {
        userId: interaction.user.id,
        guildId,
        hasToken: !!token,
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
