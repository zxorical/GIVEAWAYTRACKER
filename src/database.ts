/**
 * @module database
 * SQLite database layer — single file, simple and fast
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { CONFIG } from './config.js';
import { logger } from './logger.js';
import { GiveawayData, GiveawayStats } from './types.js';

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    const dir = path.dirname(CONFIG.dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    db = new Database(CONFIG.dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');

    runMigrations(db);
    logger.info(`SQLite database connected: ${CONFIG.dbPath}`, { component: 'Database' });
  }
  return db;
}

function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS giveaways (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      guild_name TEXT NOT NULL,
      channel_name TEXT NOT NULL,
      author_id TEXT NOT NULL,
      prize TEXT NOT NULL,
      detected_at INTEGER NOT NULL,
      ends_at INTEGER,
      status TEXT NOT NULL DEFAULT 'active',
      notified_at INTEGER,
      last_seen_at INTEGER DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(message_id, channel_id)
    );

    CREATE INDEX IF NOT EXISTS idx_giveaways_channel ON giveaways(channel_id);
    CREATE INDEX IF NOT EXISTS idx_giveaways_guild ON giveaways(guild_id);
    CREATE INDEX IF NOT EXISTS idx_giveaways_status ON giveaways(status);
    CREATE INDEX IF NOT EXISTS idx_giveaways_detected ON giveaways(detected_at);
  `);

  // Upgrade: add columns if missing
  try {
    db.exec(`ALTER TABLE giveaways ADD COLUMN notified_at INTEGER`);
  } catch (_) {}

  try {
    db.exec(`ALTER TABLE giveaways ADD COLUMN last_seen_at INTEGER DEFAULT CURRENT_TIMESTAMP`);
  } catch (_) {}

  logger.debug('Database migrations applied', { component: 'Database' });
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
    logger.debug('Database closed', { component: 'Database' });
  }
}

// ---- CRUD operations ----

export function insertGiveaway(data: Omit<GiveawayData, 'id' | 'status' | 'notifiedAt' | 'lastSeenAt'>): boolean {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO giveaways (
      message_id, channel_id, guild_id, guild_name, channel_name,
      author_id, prize, detected_at, ends_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    data.messageId,
    data.channelId,
    data.guildId,
    data.guildName,
    data.channelName,
    data.authorId,
    data.prize,
    data.detectedAt,
    data.endsAt
  );

  return result.changes > 0;
}

export function wasNotifiedRecently(messageId: string, channelId: string, cooldownSeconds: number): boolean {
  const db = getDb();
  const cutoff = Date.now() - cooldownSeconds * 1000;
  const stmt = db.prepare(`
    SELECT notified_at FROM giveaways 
    WHERE message_id = ? AND channel_id = ? AND notified_at IS NOT NULL
  `);
  const row = stmt.get(messageId, channelId) as { notified_at: number } | undefined;
  return row !== undefined && row.notified_at > cutoff;
}

export function markNotified(messageId: string, channelId: string): void {
  const db = getDb();
  const stmt = db.prepare(`
    UPDATE giveaways SET notified_at = ? WHERE message_id = ? AND channel_id = ?
  `);
  stmt.run(Date.now(), messageId, channelId);
}

export function updateLastSeen(messageId: string, channelId: string): void {
  const db = getDb();
  const stmt = db.prepare(`
    UPDATE giveaways SET last_seen_at = ? WHERE message_id = ? AND channel_id = ?
  `);
  stmt.run(Date.now(), messageId, channelId);
}

export function markEnded(messageId: string, channelId: string): void {
  const db = getDb();
  const stmt = db.prepare(`
    UPDATE giveaways SET status = 'ended' WHERE message_id = ? AND channel_id = ?
  `);
  stmt.run(messageId, channelId);
}

export function getGiveaway(messageId: string, channelId: string): GiveawayData | null {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT * FROM giveaways WHERE message_id = ? AND channel_id = ?
  `);
  const row = stmt.get(messageId, channelId) as any;
  if (!row) return null;
  return rowToGiveaway(row);
}

export function getActiveGiveaways(limit: number = 50): GiveawayData[] {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT * FROM giveaways WHERE status = 'active' ORDER BY detected_at DESC LIMIT ?
  `);
  return stmt.all(limit).map(rowToGiveaway);
}

export function getAllGiveaways(limit: number = 100): GiveawayData[] {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT * FROM giveaways ORDER BY detected_at DESC LIMIT ?
  `);
  return stmt.all(limit).map(rowToGiveaway);
}

export function getStats(): GiveawayStats {
  const db = getDb();
  const totalStmt = db.prepare(`SELECT COUNT(*) as count FROM giveaways`);
  const activeStmt = db.prepare(`SELECT COUNT(*) as count FROM giveaways WHERE status = 'active'`);
  const serversStmt = db.prepare(`SELECT COUNT(DISTINCT guild_id) as count FROM giveaways`);
  const lastStmt = db.prepare(`SELECT MAX(detected_at) as last FROM giveaways`);

  const total = (totalStmt.get() as any).count;
  const active = (activeStmt.get() as any).count;
  const servers = (serversStmt.get() as any).count || 0;
  const last = (lastStmt.get() as any).last || null;

  return {
    totalDetected: total,
    activeGiveaways: active,
    serversWithGiveaways: servers,
    lastDetected: last,
  };
}

export function resetDatabase(): void {
  const db = getDb();
  const stmt = db.prepare(`DELETE FROM giveaways`);
  const result = stmt.run();
  logger.warn(`Database reset: ${result.changes} records deleted`, { component: 'Database' });
}

export function cleanupOldGiveaways(days: number = 30): void {
  const db = getDb();
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const stmt = db.prepare(`DELETE FROM giveaways WHERE detected_at < ? AND status != 'active'`);
  const result = stmt.run(cutoff);
  if (result.changes > 0) {
    logger.debug(`Cleaned up ${result.changes} old giveaways`, { component: 'Database' });
  }
}

function rowToGiveaway(row: any): GiveawayData {
  return {
    id: row.id,
    messageId: row.message_id,
    channelId: row.channel_id,
    guildId: row.guild_id,
    guildName: row.guild_name,
    channelName: row.channel_name,
    authorId: row.author_id,
    prize: row.prize,
    detectedAt: row.detected_at,
    endsAt: row.ends_at,
    status: row.status,
    notifiedAt: row.notified_at,
    lastSeenAt: row.last_seen_at,
  };
}
