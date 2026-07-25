import { Client, GuildMember } from 'discord.js';
import { logger } from '../logger.js';

let clientRef: Client | null = null;
let roleId: string | null = null;

export function setClient(client: Client): void {
  clientRef = client;
  roleId = process.env.PREMIUM_ROLE_ID || null;
  
  if (!roleId) {
    logger.warn('PREMIUM_ROLE_ID not set. Premium checks will always return false.', {
      component: 'LicenseMiddleware',
    });
  }
}

export async function isPremium(userId: string, guildId?: string): Promise<boolean> {
  if (!clientRef) {
    logger.debug('isPremium called but client not set', { userId });
    return false;
  }

  if (!roleId) {
    logger.debug('isPremium called but PREMIUM_ROLE_ID not configured', { userId });
    return false;
  }

  try {
    // If guildId is provided, check that guild only
    if (guildId) {
      const guild = clientRef.guilds.cache.get(guildId);
      if (!guild) {
        logger.debug(`Guild ${guildId} not found in cache`, { userId });
        return false;
      }
      
      const member = await guild.members.fetch(userId).catch(() => null);
      if (!member) {
        logger.debug(`User ${userId} not found in guild ${guildId}`, { userId });
        return false;
      }
      
      const hasRole = member.roles.cache.has(roleId);
      logger.debug(`Premium check for ${userId} in guild ${guildId}: ${hasRole}`, {
        userId,
        guildId,
        hasRole,
      });
      return hasRole;
    }

    // Check all guilds the bot is in
    for (const guild of clientRef.guilds.cache.values()) {
      try {
        const member = await guild.members.fetch(userId).catch(() => null);
        if (member && member.roles.cache.has(roleId)) {
          logger.debug(`User ${userId} found with premium role in guild ${guild.id}`, {
            userId,
            guildId: guild.id,
          });
          return true;
        }
      } catch {
        continue;
      }
    }

    logger.debug(`User ${userId} does not have premium role in any guild`, { userId });
    return false;
  } catch (error) {
    logger.error('Error checking premium status', { userId, error: String(error) });
    return false;
  }
}

export async function requirePremium(userId: string, guildId?: string): Promise<{
  allowed: boolean;
  message?: string;
}> {
  const premium = await isPremium(userId, guildId);

  if (!premium) {
    return {
      allowed: false,
      message: 'Premium access required for this feature. Use /activate to unlock premium.',
    };
  }

  return { allowed: true };
}

export async function assignPremiumRole(
  userId: string,
  guildId: string
): Promise<{
  success: boolean;
  error?: string;
}> {
  if (!clientRef) {
    return { success: false, error: 'Bot client not initialized.' };
  }

  if (!roleId) {
    return { success: false, error: 'PREMIUM_ROLE_ID not configured.' };
  }

  try {
    const guild = clientRef.guilds.cache.get(guildId);
    if (!guild) {
      return { success: false, error: 'Guild not found.' };
    }

    const role = guild.roles.cache.get(roleId);
    if (!role) {
      return { success: false, error: 'Premium role not found. Please contact an administrator.' };
    }

    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) {
      return { success: false, error: 'User not found in this server.' };
    }

    if (member.roles.cache.has(roleId)) {
      return { success: false, error: 'You already have premium access.' };
    }

    await member.roles.add(role);
    logger.info(`Assigned premium role to user ${userId} in guild ${guildId}`, {
      userId,
      guildId,
      roleId,
    });

    return { success: true };
  } catch (error) {
    logger.error('Failed to assign premium role', { userId, guildId, error: String(error) });
    return { success: false, error: 'Failed to assign premium role. Please contact an administrator.' };
  }
}
