/**
 * @module keyPanel
 * Public Discord panel for premium activation
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
  ChatInputCommandInteraction,
  CacheType,
} from 'discord.js';
import { useLicenseKey, getLicenseStats, listLicenseKeys } from '../database.js';
import { assignPremiumRole, isPremium } from './licenseMiddleware.js';
import { createKey, validateKeyFormat } from './keyGenerator.js';
import { logger } from '../logger.js';
import { formatTimestamp } from '../utils.js';

export class KeyPanel {
  private panelMessage: Message | null = null;

  constructor(private channel: TextChannel) {}

  // ============================================================================
  // PUBLIC PANEL - Clean, minimal, no stats
  // ============================================================================

  async sendPublicPanel(): Promise<void> {
    if (this.panelMessage) {
      try { await this.panelMessage.delete(); } catch {}
    }

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('Premium Access')
      .setDescription('Click the button below to activate premium with your license key.');

    const row = new ActionRowBuilder<ButtonBuilder>()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('activate_premium')
          .setLabel('Activate Premium')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('check_premium')
          .setLabel('Check Status')
          .setStyle(ButtonStyle.Secondary),
      );

    this.panelMessage = await this.channel.send({
      embeds: [embed],
      components: [row],
    });

    logger.debug('Public premium panel sent', { channelId: this.channel.id });
  }

  // ============================================================================
  // ADMIN PANEL - Only admin sees stats
  // ============================================================================

  async sendAdminPanel(interaction: ChatInputCommandInteraction<CacheType>): Promise<void> {
    const stats = await getLicenseStats();

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('License Admin')
      .setDescription([
        `Total: ${stats.total} | Available: ${stats.unused} | Used: ${stats.used}`,
      ].join('\n'));

    const row = new ActionRowBuilder<ButtonBuilder>()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('admin_generate_key')
          .setLabel('Generate Key')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('admin_list_keys')
          .setLabel('List Keys')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('admin_refresh')
          .setLabel('Refresh')
          .setStyle(ButtonStyle.Secondary),
      );

    await interaction.editReply({
      embeds: [embed],
      components: [row],
    });
  }

  // ============================================================================
  // Button Interaction Handler
  // ============================================================================

  async handleInteraction(interaction: ButtonInteraction): Promise<void> {
    const { customId } = interaction;

    // Public panel buttons
    if (customId === 'activate_premium') {
      await this.showActivateModal(interaction);
      return;
    }

    if (customId === 'check_premium') {
      await this.handleCheckStatus(interaction);
      return;
    }

    // Admin panel buttons
    if (customId === 'admin_generate_key') {
      await this.handleAdminGenerate(interaction);
      return;
    }

    if (customId === 'admin_list_keys') {
      await this.handleAdminList(interaction);
      return;
    }

    if (customId === 'admin_refresh') {
      await this.handleAdminRefresh(interaction);
      return;
    }
  }

  // ============================================================================
  // Activate Premium - Opens Modal for Key Entry
  // ============================================================================

  private async showActivateModal(interaction: ButtonInteraction): Promise<void> {
    const modal = new ModalBuilder()
      .setCustomId('activate_premium_modal')
      .setTitle('Activate Premium');

    const keyInput = new TextInputBuilder()
      .setCustomId('license_key')
      .setLabel('Enter your license key')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('UNTITLED-XXXXXXXXXXXX-XXXXXXXXXXXX-XXXXXXXXXXXX-XXXXXXXXXXXX-XXXXXXXXXXXX-XXXXXXXXXXXX-XXXXXXXXXXXX')
      .setRequired(true)
      .setMinLength(20)
      .setMaxLength(120);  // ← FIXED: Increased to 120

    const row = new ActionRowBuilder<TextInputBuilder>().addComponents(keyInput);
    modal.addComponents(row);

    await interaction.showModal(modal);
  }

  async handleModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
    if (interaction.customId !== 'activate_premium_modal') {
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    const key = interaction.fields
      .getTextInputValue('license_key')
      .trim()
      .toUpperCase();

    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.editReply({
        content: 'This must be used in a server.',
      });
      return;
    }

    // Validate key format
    const formatValidation = validateKeyFormat(key);
    if (!formatValidation.valid) {
      await interaction.editReply({
        content: formatValidation.error,
      });
      return;
    }

    // Check if user already has premium
    const alreadyPremium = await isPremium(interaction.user.id, guildId);
    if (alreadyPremium) {
      await interaction.editReply({
        content: 'You already have premium access.',
      });
      return;
    }

    // Use the license key
    const result = await useLicenseKey(key, interaction.user.id);

    if (!result.success) {
      await interaction.editReply({
        content: `Activation failed: ${result.error || 'Unknown error'}`,
      });
      return;
    }

    // Assign premium role
    const roleResult = await assignPremiumRole(interaction.user.id, guildId);

    if (!roleResult.success) {
      await interaction.editReply({
        content: `Activation failed: ${roleResult.error || 'Could not assign premium role.'}`,
      });
      return;
    }

    await interaction.editReply({
      content: 'Premium activated successfully.',
    });
  }

  // ============================================================================
  // Check Status
  // ============================================================================

  private async handleCheckStatus(interaction: ButtonInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.editReply({
        content: 'This must be used in a server.',
      });
      return;
    }

    const premium = await isPremium(interaction.user.id, guildId);

    if (!premium) {
      await interaction.editReply({
        content: 'You do not have premium access. Click "Activate Premium" to enter your key.',
      });
      return;
    }

    await interaction.editReply({
      content: 'You have premium access.',
    });
  }

  // ============================================================================
  // Admin Handlers
  // ============================================================================

  private async handleAdminGenerate(interaction: ButtonInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    const key = await createKey(interaction.user.id);

    const embed = new EmbedBuilder()
      .setColor(0x00AAFF)
      .setTitle('Key Generated')
      .addFields(
        { name: 'Key', value: `\`${key}\``, inline: false },
        { name: 'Type', value: 'Single-use', inline: true },
        { name: 'Expires', value: 'Never', inline: true },
      );

    await interaction.editReply({ embeds: [embed] });

    logger.info('License key generated by admin', { 
      adminId: interaction.user.id,
      key 
    });
  }

  private async handleAdminList(interaction: ButtonInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    const keys = await listLicenseKeys(50);

    if (keys.length === 0) {
      await interaction.editReply({ content: 'No keys generated.' });
      return;
    }

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle(`Keys (${keys.length})`);

    for (const k of keys.slice(0, 20)) {
      const status = k.used 
        ? `Used by <@${k.usedBy}>` 
        : 'Available';
      
      embed.addFields({
        name: `\`${k.key}\``,
        value: `${status} | ${formatTimestamp(k.createdAt)}`,
        inline: false,
      });
    }

    if (keys.length > 20) {
      embed.setFooter({ text: `Showing 20 of ${keys.length}` });
    }

    await interaction.editReply({ embeds: [embed] });
  }

  private async handleAdminRefresh(interaction: ButtonInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });
    await this.sendAdminPanel(interaction as any);
  }
}
