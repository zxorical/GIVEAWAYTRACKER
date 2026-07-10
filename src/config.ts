/**
 * @module config
 * Environment configuration loader with validation
 * Now uses JSON file instead of SQLite
 */

import 'dotenv/config';
import { AppConfig } from './types.js';

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val || val.trim() === '') {
    throw new Error(`Missing required env var: ${key}`);
  }
  return val.trim();
}

function optionalEnv(key: string, fallback: string): string {
  const val = process.env[key];
  return val && val.trim() !== '' ? val.trim() : fallback;
}

function csvEnv(key: string): string[] {
  const val = process.env[key];
  if (!val || val.trim() === '') return [];
  return val.split(',').map(s => s.trim()).filter(Boolean);
}

function assertSnowflake(id: string, label: string): void {
  if (!/^\d{17,19}$/.test(id)) {
    throw new Error(`${label} "${id}" is not a valid Discord Snowflake`);
  }
}

function assertInt(raw: string, label: string, min: number, max: number): number {
  const n = parseInt(raw, 10);
  if (isNaN(n) || n < min || n > max) {
    throw new Error(`${label} must be between ${min} and ${max}, got "${raw}"`);
  }
  return n;
}

function tokensEnv(): string[] {
  const multi = process.env.DISCORD_TOKENS;
  if (multi && multi.trim() !== '') {
    const tokens = multi.split(',').map(s => s.trim()).filter(Boolean);
    if (tokens.length === 0) throw new Error('DISCORD_TOKENS is empty');
    return tokens;
  }
  const single = process.env.DISCORD_TOKEN;
  if (single && single.trim() !== '') {
    return [single.trim()];
  }
  throw new Error('Missing DISCORD_TOKENS or DISCORD_TOKEN');
}

export const CONFIG: AppConfig = {
  // Required
  tokens: tokensEnv(),
  botToken: requireEnv('DISCORD_BOT_TOKEN'),
  trackerChannelId: requireEnv('TRACKER_CHANNEL_ID'),

  // Optional with defaults
  monitoredChannels: csvEnv('MONITORED_CHANNELS'),
  dbPath: optionalEnv('DB_PATH', './data/giveaways.json'),
  logLevel: optionalEnv('LOG_LEVEL', 'info'),
  logDir: optionalEnv('LOG_DIR', './logs'),
  notificationCooldown: assertInt(
    optionalEnv('NOTIFICATION_COOLDOWN', '300'),
    'NOTIFICATION_COOLDOWN', 10, 3600
  ),
  statsIntervalMs: assertInt(
    optionalEnv('STATS_INTERVAL_MS', '60000'),
    'STATS_INTERVAL_MS', 10000, 3600000
  ),
  adminUserIds: csvEnv('ADMIN_USER_IDS'),
};

// Validate snowflakes
CONFIG.monitoredChannels.forEach((id, i) => assertSnowflake(id, `MONITORED_CHANNELS[${i}]`));
assertSnowflake(CONFIG.trackerChannelId, 'TRACKER_CHANNEL_ID');
CONFIG.adminUserIds.forEach((id, i) => assertSnowflake(id, `ADMIN_USER_IDS[${i}]`));

// Validate tokens
if (CONFIG.tokens.length === 0) {
  throw new Error('At least one token is required in DISCORD_TOKENS');
}

// Log config summary (without exposing tokens)
console.log('[Config] Loaded successfully');
console.log(`  - Accounts: ${CONFIG.tokens.length}`);
console.log(`  - Bot Token: ${CONFIG.botToken ? '✅ Set' : '❌ Missing'}`);
console.log(`  - Tracker Channel: ${CONFIG.trackerChannelId ? '✅ Set' : '❌ Missing'}`);
console.log(`  - Monitored Channels: ${CONFIG.monitoredChannels.length || 'All'}`);
console.log(`  - DB Path: ${CONFIG.dbPath}`);
console.log(`  - Log Level: ${CONFIG.logLevel}`);
console.log(`  - Notification Cooldown: ${CONFIG.notificationCooldown}s`);
console.log(`  - Admins: ${CONFIG.adminUserIds.length || 'None'}`);
