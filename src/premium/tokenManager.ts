/**
 * @module tokenManager
 * Token encryption, validation, and session management
 */

import crypto from 'crypto';
import { Client } from 'discord.js-selfbot-v13';
import { logger } from '../logger.js';

// ============================================================================
// Encryption
// ============================================================================

const ENCRYPTION_KEY = process.env.TOKEN_ENCRYPTION_KEY;
if (!ENCRYPTION_KEY || ENCRYPTION_KEY.length !== 64) {
  throw new Error('TOKEN_ENCRYPTION_KEY must be 64 hex characters (32 bytes)');
}

const KEY = Buffer.from(ENCRYPTION_KEY, 'hex');
const IV_LENGTH = 16;

export function encryptToken(text: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-cbc', KEY, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

export function decryptToken(encrypted: string): string {
  const parts = encrypted.split(':');
  if (parts.length !== 2) {
    throw new Error('Invalid encrypted token format');
  }
  const iv = Buffer.from(parts[0], 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', KEY, iv);
  let decrypted = decipher.update(parts[1], 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// ============================================================================
// Token Validation
// ============================================================================

export async function validateDiscordToken(token: string): Promise<boolean> {
  try {
    const client = new Client();
    await client.login(token);
    await client.destroy();
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Session Management
// ============================================================================

interface TokenSession {
  client: Client;
  userId: string;
  guildId: string;
  token: string;
  label: string;
  startedAt: number;
}

const sessions = new Map<string, TokenSession>();

export function startTokenSession(
  userId: string,
  guildId: string,
  token: string,
  label: string
): void {
  const sessionKey = `${userId}:${guildId}`;

  if (sessions.has(sessionKey)) {
    stopTokenSession(userId, guildId);
  }

  const client = new Client();
  client.login(token).catch((error) => {
    logger.error('Failed to start token session', {
      userId,
      guildId,
      error: String(error),
    });
  });

  sessions.set(sessionKey, {
    client,
    userId,
    guildId,
    token,
    label,
    startedAt: Date.now(),
  });

  logger.info('Token session started', { userId, guildId, label });
}

export function stopTokenSession(userId: string, guildId: string): void {
  const sessionKey = `${userId}:${guildId}`;
  const session = sessions.get(sessionKey);

  if (session) {
    try {
      session.client.destroy();
    } catch {
      // Ignore
    }
    sessions.delete(sessionKey);
    logger.info('Token session stopped', { userId, guildId });
  }
}

export function getTokenSession(userId: string, guildId: string): TokenSession | null {
  const sessionKey = `${userId}:${guildId}`;
  return sessions.get(sessionKey) || null;
}

export function isSessionActive(userId: string, guildId: string): boolean {
  return sessions.has(`${userId}:${guildId}`);
}

export function getAllSessions(): TokenSession[] {
  return Array.from(sessions.values());
}
