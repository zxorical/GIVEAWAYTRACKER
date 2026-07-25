/**
 * @module keyPanel
 * Public Discord panel for premium activation (like the role ping panel)
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
  // PUBLIC PANEL - Like the role ping panel, everyone can see and use it
  // ============================================================================

  async sendPublicPanel(): Promise<void> {
    // Delete old panel if exists
    if (this.panelMessage) {
      try { await this.panelMessage.delete(); } catch {}
    }

    const stats = await getLicenseStats();

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('Premium Access')
      .setDescription([
        'Click the button below to activate premium access with your license key.',
        '',
        `**Keys Available:** ${stats.unused}`,
      ].join('\n'))
      .setFooter({ text: 'Click the button to enter your key' });

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

    logger.debug('Public premium panel sent to channel', { channelId: this.channel.id });
  }

  // ============================================================================
  // ADMIN PANEL - Ephemeral (only visible to admin)
  // ============================================================================

  async sendAdminPanel(interaction: ChatInputCommandInteraction<CacheType>): Promise<void> {
    const stats = await getLicenseStats();
    const keys = await listLicenseKeys(10);

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('Admin - License Management')
      .setDescription([
        'Generate and manage license keys.',
        '',
        '**Statistics**',
        `Total Keys: ${stats.total}`,
        `Used: ${stats.used}`,
        `Available: ${stats.unused}`,
        '',
        '**Recent Keys**',
        keys.length > 0 ? keys.slice(0, 5).map(k => {
          const status = k.used ? `Used by <@${k.usedBy}>` : 'Available';
          return `\`${k.key}\` - ${status}`;
        }).join('\n') : 'No keys generated yet.',
      ].join('\n'))
      .setTimestamp();

    const row = new ActionRowBuilder<ButtonBuilder>()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('admin_generate_key')
          .setLabel('Generate Key')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('admin_list_keys')
          .setLabel('List All Keys')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('admin_refresh')
          .setLabel('Refresh')
          .setStyle(ButtonStyle.Secondary),
      );

    await interaction.editReply({
      embeds: [embed],
      components: [row],
      ephemeral: true,
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
      .setPlaceholder('UNTITLED-A83F91C2-9B21F4AA-7C81D992-F02A11BC')
      .setRequired(true)
      .setMinLength(20)
      .setMaxLength(60);

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
      content: 'Premium activated successfully. You now have access to premium features.',
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
        content: [
          'You do not have premium access.',
          '',
          'Click the "Activate Premium" button to enter your license key.',
          'Contact an administrator to obtain a license key.',
        ].join('\n'),
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
      .setTitle('License Key Generated')
      .addFields(
        { name: 'Key', value: `\`${key}\``, inline: false },
        { name: 'Type', value: 'Single-use', inline: true },
        { name: 'Expiration', value: 'Never', inline: true },
      )
      .setTimestamp();

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
      await interaction.editReply({ content: 'No license keys have been generated.' });
      return;
    }

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle(`All License Keys (${keys.length})`)
      .setTimestamp();

    for (const k of keys.slice(0, 20)) {
      const status = k.used 
        ? `Used by <@${k.usedBy}>` 
        : 'Available';
      
      embed.addFields({
        name: `\`${k.key}\``,
        value: `${status} | Created ${formatTimestamp(k.createdAt)}`,
        inline: false,
      });
    }

    if (keys.length > 20) {
      embed.setFooter({ text: `Showing 20 of ${keys.length} keys` });
    }

    await interaction.editReply({ embeds: [embed] });
  }

  private async handleAdminRefresh(interaction: ButtonInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });
    
    // Re-send the admin panel
    const stats = await getLicenseStats();
    const keys = await listLicenseKeys(10);

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('Admin - License Management')
      .setDescription([
        'Generate and manage license keys.',
        '',
        '**Statistics**',
        `Total Keys: ${stats.total}`,
        `Used: ${stats.used}`,
        `Available: ${stats.unused}`,
        '',
        '**Recent Keys**',
        keys.length > 0 ? keys.slice(0, 5).map(k => {
          const status = k.used ? `Used by <@${k.usedBy}>` : 'Available';
          return `\`${k.key}\` - ${status}`;
        }).join('\n') : 'No keys generated yet.',
      ].join('\n'))
      .setTimestamp();

    const row = new ActionRowBuilder<ButtonBuilder>()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('admin_generate_key')
          .setLabel('Generate Key')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('admin_list_keys')
          .setLabel('List All Keys')
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
}
