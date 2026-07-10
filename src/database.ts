/**
 * @module database
 * JSON file-based database — no compilation needed, works everywhere
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
}

// File path
const DB_FILE = CONFIG.dbPath.replace('.db', '.json');
const DB_DIR = path.dirname(DB_FILE);

// In-memory store
let data: StoredGiveaway[] = [];
let nextId = 1;
let loaded = false;

// ---- Load/Save ----

function loadDb(): void {
  if (loaded) return;
  loaded = true;

  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        data = parsed;
        nextId = data.reduce((max, d) => Math.max(max, d.id || 0), 0) + 1;
        logger.debug(`Loaded ${data.length} records from JSON DB`, { component: 'Database' });
        return;
      }
    }
  } catch (err) {
    logger.warn('Failed to load JSON DB, starting fresh', { component: 'Database', error: String(err) });
  }

  data = [];
  nextId = 1;
  saveDb();
}

function saveDb(): void {
  try {
    if (!fs.existsSync(DB_DIR)) {
      fs.mkdirSync(DB_DIR, { recursive: true });
    }
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    logger.error('Failed to save JSON DB', { component: 'Database', error: String(err) });
  }
}

// ---- Public API ----

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

  saveDb();
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
  return data
    .filter(d => d.status === 'active')
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
  const total = data.length;
  const active = data.filter(d => d.status === 'active').length;
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
}

export function closeDb(): void {
  if (data.length > 0) saveDb();
  logger.debug('Database closed', { component: 'Database' });
}

// ---- Helpers ----

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
  };
}
