/**
 * @module database
 * MongoDB database with in-memory cache for speed
 * All reads are instant, writes sync to MongoDB in background
 */

import { MongoClient, Db, Collection } from 'mongodb';
import { logger } from './logger.js';
import { GiveawayData, GiveawayStats } from './types.js';

interface StoredGiveaway {
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

interface TotalCounter {
  _id: string;
  total: number;
}

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  throw new Error('MONGO_URI environment variable is required');
}

let client: MongoClient;
let db: Db;
let giveawaysCol: Collection<StoredGiveaway>;
let countersCol: Collection<TotalCounter>;
let connected = false;

// In-memory cache — instant reads/writes
let cache: StoredGiveaway[] = [];
let totalDetectedCount = 0;

// Sync queue
let syncTimeout: NodeJS.Timeout | null = null;
let dirtyTotal = false;

async function connect(): Promise<void> {
  if (connected) return;

  try {
    client = new MongoClient(MONGO_URI!);
    await client.connect();
    db = client.db('giveaway_tracker');
    giveawaysCol = db.collection<StoredGiveaway>('giveaways');
    countersCol = db.collection<TotalCounter>('counters');

    // Load existing data into cache
    cache = await giveawaysCol.find({}).toArray();
    
    const counter = await countersCol.findOne({ _id: 'total_detected' });
    if (!counter) {
      await countersCol.insertOne({ _id: 'total_detected', total: cache.length });
      totalDetectedCount = cache.length;
    } else {
      totalDetectedCount = Math.max(counter.total, cache.length);
    }

    connected = true;
    logger.info(`Connected to MongoDB. Cache loaded: ${cache.length} giveaways, ${totalDetectedCount} total`, { component: 'Database' });
  } catch (err) {
    logger.error('Failed to connect to MongoDB', { component: 'Database', error: String(err) });
    throw err;
  }
}

async function ensureConnected(): Promise<void> {
  if (!connected) await connect();
}

function scheduleSync(): void {
  if (syncTimeout) return;
  syncTimeout = setTimeout(() => flushSync(), 2000);
}

async function flushSync(): Promise<void> {
  syncTimeout = null;
  if (!connected) return;

  try {
    if (dirtyTotal) {
      await countersCol.updateOne(
        { _id: 'total_detected' },
        { $set: { total: totalDetectedCount } },
        { upsert: true }
      );
      dirtyTotal = false;
    }
  } catch (err) {
    logger.error('Failed to sync counter', { component: 'Database', error: String(err) });
  }
}

async function syncGiveaway(doc: StoredGiveaway): Promise<void> {
  if (!connected) return;
  try {
    await giveawaysCol.updateOne(
      { messageId: doc.messageId, channelId: doc.channelId },
      { $set: doc },
      { upsert: true }
    );
  } catch (err) {
    logger.error('Failed to sync giveaway', { component: 'Database', error: String(err) });
  }
}

async function deleteFromMongo(messageId: string): Promise<void> {
  if (!connected) return;
  try {
    await giveawaysCol.deleteOne({ messageId });
  } catch (err) {
    logger.error('Failed to delete from MongoDB', { component: 'Database', error: String(err) });
  }
}

// ---------------------------------------------------------------------------
// Public API — all instant from cache
// ---------------------------------------------------------------------------

export async function getDb(): Promise<Db> {
  await ensureConnected();
  return db;
}

export async function getTotalDetected(): Promise<number> {
  // Sync, no MongoDB call
  return totalDetectedCount;
}

export async function insertGiveaway(g: Omit<GiveawayData, 'id' | 'status' | 'notifiedAt' | 'lastSeenAt'>): Promise<boolean> {
  const exists = cache.some(d => d.messageId === g.messageId && d.channelId === g.channelId);
  if (exists) return false;

  const doc: StoredGiveaway = {
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
  };

  cache.push(doc);
  totalDetectedCount++;
  dirtyTotal = true;
  scheduleSync();

  // Sync to MongoDB in background
  syncGiveaway(doc);

  return true;
}

export async function wasNotifiedRecently(messageId: string, channelId: string, cooldownSeconds: number): Promise<boolean> {
  const entry = cache.find(d => d.messageId === messageId && d.channelId === channelId);
  if (!entry || !entry.notifiedAt) return false;
  return Date.now() - entry.notifiedAt < cooldownSeconds * 1000;
}

export async function markNotified(messageId: string, channelId: string): Promise<void> {
  const entry = cache.find(d => d.messageId === messageId && d.channelId === channelId);
  if (entry) {
    entry.notifiedAt = Date.now();
    scheduleSync();
    syncGiveaway(entry);
  }
}

export async function updateLastSeen(messageId: string, channelId: string): Promise<void> {
  const entry = cache.find(d => d.messageId === messageId && d.channelId === channelId);
  if (entry) {
    entry.lastSeenAt = Date.now();
    scheduleSync();
    syncGiveaway(entry);
  }
}

export async function markEnded(messageId: string, channelId: string): Promise<void> {
  const entry = cache.find(d => d.messageId === messageId && d.channelId === channelId);
  if (entry) {
    entry.status = 'ended';
    scheduleSync();
    syncGiveaway(entry);
  }
}

export async function setNotificationMessageId(giveawayMessageId: string, channelId: string, notificationMessageId: string): Promise<void> {
  const entry = cache.find(d => d.messageId === giveawayMessageId && d.channelId === channelId);
  if (entry) {
    entry.notificationMessageId = notificationMessageId;
    scheduleSync();
    syncGiveaway(entry);
  }
}

export async function getGiveaway(messageId: string, channelId: string): Promise<GiveawayData | null> {
  const entry = cache.find(d => d.messageId === messageId && d.channelId === channelId);
  if (!entry) return null;
  return rowToGiveaway(entry);
}

export async function getActiveGiveaways(limit: number = 50): Promise<GiveawayData[]> {
  const now = Date.now();
  return cache
    .filter(d => d.status === 'active' && (d.endsAt === null || d.endsAt > now))
    .sort((a, b) => b.detectedAt - a.detectedAt)
    .slice(0, limit)
    .map(rowToGiveaway);
}

export async function getAllGiveaways(limit: number = 100): Promise<GiveawayData[]> {
  return cache
    .sort((a, b) => b.detectedAt - a.detectedAt)
    .slice(0, limit)
    .map(rowToGiveaway);
}

export async function getStats(): Promise<GiveawayStats> {
  const now = Date.now();
  const active = cache.filter(d => d.status === 'active' && (d.endsAt === null || d.endsAt > now)).length;
  const servers = new Set(cache.map(d => d.guildId)).size;
  const last = cache.length > 0 ? cache.reduce((max, d) => Math.max(max, d.detectedAt), 0) : null;

  return {
    totalDetected: totalDetectedCount,
    activeGiveaways: active,
    serversWithGiveaways: servers,
    lastDetected: last,
  };
}

export async function resetDatabase(): Promise<void> {
  cache = [];
  totalDetectedCount = 0;
  dirtyTotal = true;
  scheduleSync();
  
  if (connected) {
    await giveawaysCol.deleteMany({});
    await countersCol.updateOne({ _id: 'total_detected' }, { $set: { total: 0 } });
  }
  
  logger.warn('Database reset', { component: 'Database' });
}

export async function cleanupOldGiveaways(days: number = 30): Promise<void> {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  cache = cache.filter(d => d.status === 'active' || d.detectedAt >= cutoff);
}

export async function purgeEndedGiveaways(): Promise<StoredGiveaway[]> {
  const now = Date.now();
  const removed: StoredGiveaway[] = [];

  cache = cache.filter(d => {
    const isActive = d.status === 'active';
    const hasNoEndTime = d.endsAt === null;
    const isStillRunning = d.endsAt !== null && d.endsAt > now;
    const keep = isActive && (hasNoEndTime || isStillRunning);

    if (!keep) {
      removed.push({ ...d });
      deleteFromMongo(d.messageId);
    }

    return keep;
  });

  if (removed.length > 0) {
    logger.info(`Purged ${removed.length} expired giveaways`, { component: 'Database' });
  }

  return removed;
}

export async function closeDb(): Promise<void> {
  if (syncTimeout) {
    clearTimeout(syncTimeout);
    await flushSync();
  }
  if (client) {
    await client.close();
    connected = false;
  }
}

function rowToGiveaway(row: StoredGiveaway): GiveawayData {
  return {
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
