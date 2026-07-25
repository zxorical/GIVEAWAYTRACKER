/**
 * @module licenseMiddleware
 * Premium access checks via Discord role with caching
 */

import { Client } from 'discord.js';
import { logger } from '../logger.js';
import {
  isPremiumUser,
  setPremiumUser,
  removePremiumUser as removePremiumUserDb,
  getPremiumUser,
  getAllPremiumUsers,
  getPremiumStats as getPremiumStatsDb,
} from '../database.js';

// ============================================================================
// State
// ============================================================================

let clientRef: Client | null = null;
let roleId: string | null = null;

// Premium cache to reduce Discord API calls
interface CacheEntry {
  isPremium: boolean;
  expiresAt: number;
  guildId?: string;
  source?: string;
}

const premiumCache = new Map<string, CacheEntry>();
const CACHE_TTL = 300000; // 5 minutes

// ============================================================================
// Initialization
// ============================================================================

export function setClient(client: Client): void {
  clientRef = client;
  roleId = process.env.PREMIUM_ROLE_ID || null;

  if (!roleId) {
    logger.warn('PREMIUM_ROLE_ID not set. Premium checks will always return false.', {
      component: 'LicenseMiddleware',
    });
  }
}

export function getPremiumRoleId(): string | null {
  return roleId;
}

// ============================================================================
// Cache Management
// ============================================================================

export function clearPremiumCache(userId: string): void {
  premiumCache.delete(userId);
}

export function clearAllPremiumCache(): void {
  premiumCache.clear();
}

// ============================================================================
// Core Premium Checks
// ============================================================================

export async function isPremium(userId: string, guildId?: string): Promise<boolean> {
  if (!clientRef) {
    return false;
  }

  if (!roleId) {
    return false;
  }

  // Check cache first
  const cacheKey = guildId ? `${userId}:${guildId}` : userId;
  const cached = premiumCache.get(cacheKey);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.isPremium;
  }

  try {
    let result: { isPremium: boolean; guildId?: string };

    // If guildId is provided, check that guild only
    if (guildId) {
      const guild = clientRef.guilds.cache.get(guildId);
      if (!guild) {
        return false;
      }

      const member = await guild.members.fetch(userId).catch(() => null);
      if (!member) {
        return false;
      }

      const hasRole = member.roles.cache.has(roleId);
      result = { isPremium: hasRole, guildId };
    } else {
      // Check all guilds the bot is in
      let found = false;
      let foundGuildId: string | undefined;

      for (const guild of clientRef.guilds.cache.values()) {
        try {
          const member = await guild.members.fetch(userId).catch(() => null);
          if (member && member.roles.cache.has(roleId)) {
            found = true;
            foundGuildId = guild.id;
            break;
          }
        } catch {
          continue;
        }
      }

      result = { isPremium: found, guildId: foundGuildId };
    }

    // Cache the result
    premiumCache.set(cacheKey, {
      isPremium: result.isPremium,
      expiresAt: Date.now() + CACHE_TTL,
      guildId: result.guildId,
    });

    return result.isPremium;
  } catch {
    return false;
  }
}

export async function checkPremium(
  userId: string,
  guildId?: string
): Promise<{
  isPremium: boolean;
  guildId?: string;
  roleId?: string;
  source?: string;
  error?: string;
}> {
  if (!guildId) {
    return { isPremium: false, error: 'Guild ID required.' };
  }

  if (!clientRef) {
    return { isPremium: false, error: 'Bot client not initialized.' };
  }

  if (!roleId) {
    return { isPremium: false, error: 'Premium role not configured.' };
  }

  // Check cache first
  const cacheKey = `${userId}:${guildId}`;
  const cached = premiumCache.get(cacheKey);

  if (cached && cached.expiresAt > Date.now()) {
    return {
      isPremium: cached.isPremium,
      guildId: cached.guildId,
      roleId,
      source: cached.source,
    };
  }

  try {
    // Check database
    const dbUser = await getPremiumUser(userId, guildId);
    const dbPremium = dbUser?.isPremium || false;

    // Check Discord role
    let hasRole = false;
    const guild = clientRef.guilds.cache.get(guildId);
    if (guild) {
      const member = await guild.members.fetch(userId).catch(() => null);
      if (member) {
        hasRole = member.roles.cache.has(roleId);
      }
    }

    const isPremiumResult = dbPremium || hasRole;
    const source = dbUser?.source || (hasRole ? 'manual' : undefined);

    // Sync if needed
    if (hasRole && !dbPremium) {
      await setPremiumUser(userId, guildId, 'manual');
    }

    if (dbPremium && !hasRole && guild) {
      const member = await guild.members.fetch(userId).catch(() => null);
      if (member) {
        await member.roles.add(roleId).catch(() => {});
      }
    }

    // Cache the result
    premiumCache.set(cacheKey, {
      isPremium: isPremiumResult,
      expiresAt: Date.now() + CACHE_TTL,
      guildId,
      source,
    });

    return {
      isPremium: isPremiumResult,
      guildId,
      roleId,
      source,
    };
  } catch (error) {
    return {
      isPremium: false,
      error: String(error),
    };
  }
}

export async function isPremiumFresh(
  userId: string,
  guildId?: string
): Promise<boolean> {
  clearPremiumCache(userId);
  return isPremium(userId, guildId);
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

// ============================================================================
// Premium Management
// ============================================================================

export async function addPremiumUser(
  userId: string,
  guildId: string,
  source: 'key' | 'booster' | 'manual',
  licenseKey?: string
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
      return { success: false, error: 'Premium role not found.' };
    }

    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) {
      return { success: false, error: 'User not found in this server.' };
    }

    // Add role
    if (!member.roles.cache.has(roleId)) {
      await member.roles.add(role);
    }

    // Add to database
    await setPremiumUser(userId, guildId, source, licenseKey);
    clearPremiumCache(userId);

    logger.info('Premium user added', { userId, guildId, source });
    return { success: true };
  } catch (error) {
    logger.error('Failed to add premium user', { userId, guildId, error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function removePremiumUser(
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
      return { success: false, error: 'Premium role not found.' };
    }

    const member = await guild.members.fetch(userId).catch(() => null);
    if (member) {
      if (member.roles.cache.has(roleId)) {
        await member.roles.remove(role);
      }
    }

    // Remove from database
    await removePremiumUserDb(userId, guildId);
    clearPremiumCache(userId);

    logger.info('Premium user removed', { userId, guildId });
    return { success: true };
  } catch (error) {
    logger.error('Failed to remove premium user', { userId, guildId, error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function getPremiumUsers(guildId: string): Promise<any[]> {
  return getAllPremiumUsers(guildId);
}

export async function getPremiumStats(guildId: string): Promise<any> {
  return getPremiumStatsDb(guildId);
}

// ============================================================================
// Role Management (Legacy - use addPremiumUser instead)
// ============================================================================

export async function assignPremiumRole(
  userId: string,
  guildId: string
): Promise<{
  success: boolean;
  error?: string;
}> {
  return addPremiumUser(userId, guildId, 'key');
}
