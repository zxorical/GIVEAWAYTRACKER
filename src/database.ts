/**
 * @module database
 * JSON file-based database — no compilation needed
 * Persistent total counter tracks ALL giveaways ever detected
 */

import fs from 'fs';
import path from 'path';
import { CONFIG } from './config.js';
import { logger } from './logger.js';
import { GiveawayData, GiveawayStats } from './types.js';

interface StoredGiveaway {
  id: number;
  messageId: string;
  channelId: string;
  guildId: string;
  guildName: string;
  channelName: string;
  authorId: string;
  prize: string;
  detectedAt: number;
  endsAt: number | null;
  status: 'active' | 'ended' | 'unknown';
  notifiedAt: number | null;
  lastSeenAt: number;
  notificationMessageId?: string;
}

const DB_FILE = CONFIG.dbPath;
const DB_DIR = path.dirname(DB_FILE);
const COUNTER_FILE = path.join(DB_DIR, 'total_detected.json');

let data: StoredGiveaway[] = [];
let nextId = 1;
let loaded = false;
let totalDetectedCount = 0;

function loadDb(): void {
  if (loaded) return;
  loaded = true;

  // Load giveaway records
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        data = parsed;
        nextId = data.reduce((max, d) => Math.max(max, d.id || 0), 0) + 1;
        logger.debug(`Loaded ${data.length} records from JSON DB`, { component: 'Database' });
      }
    }
  } catch (err) {
    logger.warn('Failed to load JSON DB, starting fresh', { component: 'Database', error: String(err) });
    data = [];
    nextId = 1;
  }

  // Load total counter
  try {
    if (fs.existsSync(COUNTER_FILE)) {
      const raw = fs.readFileSync(COUNTER_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      totalDetectedCount = parsed.total || 0;
      logger.debug(`Loaded total counter: ${totalDetectedCount}`, { component: 'Database' });
    }
  } catch {
    totalDetectedCount = data.length;
    logger.debug(`Counter file missing, using data length: ${totalDetectedCount}`, { component: 'Database' });
  }
}

function saveDb(): void {
  try {
    if (!fs.existsSync(DB_DIR)) {
      fs.mkdirSync(DB_DIR, { recursive: true });
    }
    // Save giveaway records
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
    // Save total counter
    fs.writeFileSync(COUNTER_FILE, JSON.stringify({ total: totalDetectedCount }));
  } catch (err) {
    logger.error('Failed to save JSON DB', { component: 'Database', error: String(err) });
  }
}

export function getDb(): null {
  loadDb();
  return null;
}

export function getTotalDetected(): number {
  loadDb();
  return totalDetectedCount;
}

export function insertGiveaway(g: Omit<GiveawayData, 'id' | 'status' | 'notifiedAt' | 'lastSeenAt'>): boolean {
  loadDb();

  const exists = data.some(d => d.messageId === g.messageId && d.channelId === g.channelId);
  if (exists) return false;

  data.push({
    id: nextId++,
    messageId: g.messageId,
    channelId: g.channelId,
    guildId: g.guildId,
    guildName: g.guildName,
    channelName: g.channelName,
    authorId: g.authorId,
    prize: g.prize,
    detectedAt: g.detectedAt,
    endsAt: g.endsAt ?? null,
    status: 'active',
    notifiedAt: null,
    lastSeenAt: Date.now(),
  });

  // Increment the persistent total counter
  totalDetectedCount++;

  saveDb();
  logger.debug(`Inserted giveaway. Total tracked: ${totalDetectedCount}`, { component: 'Database' });
  return true;
}

export function wasNotifiedRecently(messageId: string, channelId: string, cooldownSeconds: number): boolean {
  loadDb();
  const entry = data.find(d => d.messageId === messageId && d.channelId === channelId);
  if (!entry || !entry.notifiedAt) return false;
  return Date.now() - entry.notifiedAt < cooldownSeconds * 1000;
}

export function markNotified(messageId: string, channelId: string): void {
  loadDb();
  const entry = data.find(d => d.messageId === messageId && d.channelId === channelId);
  if (entry) {
    entry.notifiedAt = Date.now();
    saveDb();
  }
}

export function updateLastSeen(messageId: string, channelId: string): void {
  loadDb();
  const entry = data.find(d => d.messageId === messageId && d.channelId === channelId);
  if (entry) {
    entry.lastSeenAt = Date.now();
    saveDb();
  }
}

export function markEnded(messageId: string, channelId: string): void {
  loadDb();
  const entry = data.find(d => d.messageId === messageId && d.channelId === channelId);
  if (entry) {
    entry.status = 'ended';
    saveDb();
    logger.debug(`Marked giveaway as ended: ${messageId}`, { component: 'Database' });
  }
}

export function setNotificationMessageId(giveawayMessageId: string, channelId: string, notificationMessageId: string): void {
  loadDb();
  const entry = data.find(d => d.messageId === giveawayMessageId && d.channelId === channelId);
  if (entry) {
    entry.notificationMessageId = notificationMessageId;
    saveDb();
    logger.debug(`Saved notification message ID: ${notificationMessageId} for giveaway: ${giveawayMessageId}`, { component: 'Database' });
  }
}

export function getGiveaway(messageId: string, channelId: string): GiveawayData | null {
  loadDb();
  const entry = data.find(d => d.messageId === messageId && d.channelId === channelId);
  if (!entry) return null;
  return rowToGiveaway(entry);
}

export function getActiveGiveaways(limit: number = 50): GiveawayData[] {
  loadDb();
  const now = Date.now();
  return data
    .filter(d => d.status === 'active' && (d.endsAt === null || d.endsAt > now))
    .slice(0, limit)
    .map(rowToGiveaway);
}

export function getAllGiveaways(limit: number = 100): GiveawayData[] {
  loadDb();
  return data
    .slice(0, limit)
    .map(rowToGiveaway);
}

export function getStats(): GiveawayStats {
  loadDb();
  const now = Date.now();
  const total = totalDetectedCount;
  const active = data.filter(d => d.status === 'active' && (d.endsAt === null || d.endsAt > now)).length;
  const servers = new Set(data.map(d => d.guildId)).size;
  const last = data.length > 0 ? data.reduce((max, d) => Math.max(max, d.detectedAt), 0) : null;

  return {
    totalDetected: total,
    activeGiveaways: active,
    serversWithGiveaways: servers,
    lastDetected: last,
  };
}

export function resetDatabase(): void {
  loadDb();
  data = [];
  nextId = 1;
  totalDetectedCount = 0;
  saveDb();
  logger.warn('Database reset', { component: 'Database' });
}

export function cleanupOldGiveaways(days: number = 30): void {
  loadDb();
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const before = data.length;
  data = data.filter(d => d.status === 'active' || d.detectedAt >= cutoff);
  const removed = before - data.length;
  if (removed > 0) {
    saveDb();
    logger.debug(`Cleaned up ${removed} old giveaways`, { component: 'Database' });
  }
  // Note: totalDetectedCount is NOT reduced — it stays as the all-time total
}

// ---------------------------------------------------------------------------
// Purge ended giveaways — returns removed entries for bot.ts to edit messages
// ---------------------------------------------------------------------------
export function purgeEndedGiveaways(): StoredGiveaway[] {
  loadDb();
  const now = Date.now();
  const removed: StoredGiveaway[] = [];

  data = data.filter(d => {
    const isActive = d.status === 'active';
    const hasNoEndTime = d.endsAt === null;
    const isStillRunning = d.endsAt !== null && d.endsAt > now;
    const keep = isActive && (hasNoEndTime || isStillRunning);

    if (!keep) {
      removed.push({ ...d });
      logger.debug(`Purging giveaway: ${d.messageId} (prize: ${d.prize?.substring(0, 30)})`, { component: 'Database' });
    }

    return keep;
  });

  if (removed.length > 0) {
    // Note: totalDetectedCount is NOT reduced — it stays as the all-time total
    saveDb();
    logger.info(`Purged ${removed.length} expired giveaways. Total tracked: ${totalDetectedCount}`, { component: 'Database' });
  }

  return removed;
}

export function closeDb(): void {
  if (data.length > 0) saveDb();
  logger.debug('Database closed', { component: 'Database' });
}

function rowToGiveaway(row: StoredGiveaway): GiveawayData {
  return {
    id: row.id,
    messageId: row.messageId,
    channelId: row.channelId,
    guildId: row.guildId,
    guildName: row.guildName,
    channelName: row.channelName,
    authorId: row.authorId,
    prize: row.prize,
    detectedAt: row.detectedAt,
    endsAt: row.endsAt,
    status: row.status,
    notifiedAt: row.notifiedAt,
    lastSeenAt: row.lastSeenAt,
    notificationMessageId: row.notificationMessageId,
  };
}
