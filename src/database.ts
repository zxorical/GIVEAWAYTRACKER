/**
 * @module database
 * MongoDB-backed store with an in-memory cache for instant reads.
 */

import { MongoClient, Db, Collection, AnyBulkWriteOperation } from 'mongodb';
import { logger } from './logger.js';
import { GiveawayData, GiveawayStats, UserWatchlist } from './types.js';

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
  status: 'active' | 'ended';
  notifiedAt: number | null;
  lastSeenAt: number;
  notificationMessageId?: string;
  notificationStatus?: string;
  notificationSentAt?: number;
  notificationError?: string;
}

interface TotalCounter {
  _id: string;
  total: number;
}

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  throw new Error('MONGO_URI environment variable is required');
}

const SYNC_INTERVAL_MS = 2000;

let client: MongoClient;
let db: Db;
let giveawaysCol: Collection<StoredGiveaway>;
let countersCol: Collection<TotalCounter>;
let watchlistCol: Collection<UserWatchlist>;

let connected = false;
let connectingPromise: Promise<void> | null = null;

const cache = new Map<string, StoredGiveaway>();
let totalDetectedCount = 0;

let syncTimeout: NodeJS.Timeout | null = null;
let dirtyTotal = false;
const dirtyKeys = new Set<string>();
const pendingDeletes = new Set<string>();

function cacheKey(messageId: string, channelId: string): string {
  return `${channelId}:${messageId}`;
}

async function connect(): Promise<void> {
  if (connected) return;
  if (connectingPromise) return connectingPromise;

  connectingPromise = (async () => {
    try {
      client = new MongoClient(MONGO_URI!);
      await client.connect();
      db = client.db('giveaway_tracker');
      giveawaysCol = db.collection<StoredGiveaway>('giveaways');
      countersCol = db.collection<TotalCounter>('counters');
      watchlistCol = db.collection<UserWatchlist>('watchlists');

      await giveawaysCol.createIndex({ messageId: 1, channelId: 1 }, { unique: true });
      await giveawaysCol.createIndex({ status: 1 });
      await giveawaysCol.createIndex({ detectedAt: -1 });
      await giveawaysCol.createIndex({ notificationStatus: 1 });
      await watchlistCol.createIndex({ userId: 1 }, { unique: true });
      await watchlistCol.createIndex({ items: 1 });

      const docs = await giveawaysCol.find({}).toArray();
      cache.clear();
      for (const doc of docs) {
        cache.set(cacheKey(doc.messageId, doc.channelId), doc);
      }

      const counter = await countersCol.findOne({ _id: 'total_detected' });
      if (!counter) {
        await countersCol.insertOne({ _id: 'total_detected', total: cache.size });
        totalDetectedCount = cache.size;
      } else {
        totalDetectedCount = Math.max(counter.total, cache.size);
      }

      connected = true;
      logger.info(`Connected to MongoDB. Cache loaded: ${cache.size} giveaways, ${totalDetectedCount} total`, {
        component: 'Database',
      });
    } catch (err) {
      logger.error('Failed to connect to MongoDB', { component: 'Database', error: String(err) });
      throw err;
    } finally {
      connectingPromise = null;
    }
  })();

  return connectingPromise;
}

async function ensureConnected(): Promise<void> {
  if (!connected) await connect();
}

function markDirty(key: string): void {
  dirtyKeys.add(key);
  scheduleSync();
}

function scheduleSync(): void {
  if (syncTimeout) return;
  syncTimeout = setTimeout(() => {
    flushSync().catch((err) =>
      logger.error('Unhandled error during scheduled sync', { component: 'Database', error: String(err) })
    );
  }, SYNC_INTERVAL_MS);
}

async function flushSync(): Promise<void> {
  syncTimeout = null;
  if (!connected) return;

  if (dirtyTotal) {
    try {
      await countersCol.updateOne(
        { _id: 'total_detected' },
        { $set: { total: totalDetectedCount } },
        { upsert: true }
      );
      dirtyTotal = false;
    } catch (err) {
      logger.error('Failed to sync counter', { component: 'Database', error: String(err) });
      scheduleSync();
    }
  }

  if (dirtyKeys.size > 0) {
    const keys = Array.from(dirtyKeys);
    const ops: AnyBulkWriteOperation<StoredGiveaway>[] = [];
    const docsForKeys: string[] = [];

    for (const key of keys) {
      const doc = cache.get(key);
      if (!doc) continue;
      ops.push({
        updateOne: {
          filter: { messageId: doc.messageId, channelId: doc.channelId },
          update: { $set: doc },
          upsert: true,
        },
      });
      docsForKeys.push(key);
    }

    if (ops.length > 0) {
      try {
        await giveawaysCol.bulkWrite(ops, { ordered: false });
        for (const key of docsForKeys) dirtyKeys.delete(key);
      } catch (err) {
        logger.error('Failed to sync giveaways batch', { component: 'Database', error: String(err) });
        scheduleSync();
      }
    }
  }

  if (pendingDeletes.size > 0) {
    const ids = Array.from(pendingDeletes);
    try {
      await giveawaysCol.deleteMany({ messageId: { $in: ids } });
      pendingDeletes.clear();
    } catch (err) {
      logger.error('Failed to delete from MongoDB', { component: 'Database', error: String(err) });
      scheduleSync();
    }
  }
}

// ---------------------------------------------------------------------------
// Existing Public API
// ---------------------------------------------------------------------------

export async function getDb(): Promise<Db> {
  await ensureConnected();
  return db;
}

export async function getTotalDetected(): Promise<number> {
  return totalDetectedCount;
}

export async function insertGiveaway(
  g: Omit<GiveawayData, 'id' | 'status' | 'notifiedAt' | 'lastSeenAt'>
): Promise<boolean> {
  const key = cacheKey(g.messageId, g.channelId);
  if (cache.has(key)) return false;

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
    notificationStatus: 'pending',
  };

  cache.set(key, doc);
  totalDetectedCount++;
  dirtyTotal = true;
  markDirty(key);

  return true;
}

export async function wasNotifiedRecently(
  messageId: string,
  channelId: string,
  cooldownSeconds: number
): Promise<boolean> {
  const entry = cache.get(cacheKey(messageId, channelId));
  if (!entry || !entry.notifiedAt) return false;
  return Date.now() - entry.notifiedAt < cooldownSeconds * 1000;
}

export async function markNotified(messageId: string, channelId: string): Promise<void> {
  const key = cacheKey(messageId, channelId);
  const entry = cache.get(key);
  if (entry) {
    entry.notifiedAt = Date.now();
    entry.notificationStatus = 'sent';
    entry.notificationSentAt = Date.now();
    markDirty(key);
  }
}

export async function updateLastSeen(messageId: string, channelId: string): Promise<void> {
  const key = cacheKey(messageId, channelId);
  const entry = cache.get(key);
  if (entry) {
    entry.lastSeenAt = Date.now();
    markDirty(key);
  }
}

export async function markEnded(messageId: string, channelId: string): Promise<void> {
  const key = cacheKey(messageId, channelId);
  const entry = cache.get(key);
  if (entry) {
    entry.status = 'ended';
    markDirty(key);
  }
}

export async function setNotificationMessageId(
  giveawayMessageId: string,
  channelId: string,
  notificationMessageId: string
): Promise<void> {
  const key = cacheKey(giveawayMessageId, channelId);
  const entry = cache.get(key);
  if (entry) {
    entry.notificationMessageId = notificationMessageId;
    markDirty(key);
  }
}

export async function updateNotificationStatus(
  messageId: string,
  channelId: string,
  fields: {
    notificationStatus?: string;
    notificationSentAt?: number;
    notificationMessageId?: string;
    notificationError?: string;
  }
): Promise<void> {
  const key = cacheKey(messageId, channelId);
  const entry = cache.get(key);
  if (entry) {
    if (fields.notificationStatus !== undefined) entry.notificationStatus = fields.notificationStatus;
    if (fields.notificationSentAt !== undefined) entry.notificationSentAt = fields.notificationSentAt;
    if (fields.notificationMessageId !== undefined) entry.notificationMessageId = fields.notificationMessageId;
    if (fields.notificationError !== undefined) entry.notificationError = fields.notificationError;
    markDirty(key);
  }
}

export async function getGiveaway(messageId: string, channelId: string): Promise<GiveawayData | null> {
  const entry = cache.get(cacheKey(messageId, channelId));
  return entry ? rowToGiveaway(entry) : null;
}

export async function getActiveGiveaways(limit: number = 50): Promise<GiveawayData[]> {
  const now = Date.now();
  const active: StoredGiveaway[] = [];
  for (const d of cache.values()) {
    if (d.status === 'active' && (d.endsAt === null || d.endsAt > now)) active.push(d);
  }
  return active
    .sort((a, b) => b.detectedAt - a.detectedAt)
    .slice(0, limit)
    .map(rowToGiveaway);
}

export async function getAllGiveaways(limit: number = 100): Promise<GiveawayData[]> {
  return Array.from(cache.values())
    .sort((a, b) => b.detectedAt - a.detectedAt)
    .slice(0, limit)
    .map(rowToGiveaway);
}

export async function getStats(): Promise<GiveawayStats> {
  const now = Date.now();
  let active = 0;
  let last: number | null = null;
  const guildIds = new Set<string>();

  for (const d of cache.values()) {
    if (d.status === 'active' && (d.endsAt === null || d.endsAt > now)) active++;
    guildIds.add(d.guildId);
    if (last === null || d.detectedAt > last) last = d.detectedAt;
  }

  return {
    totalDetected: totalDetectedCount,
    activeGiveaways: active,
    serversWithGiveaways: guildIds.size,
    lastDetected: last,
  };
}

export async function resetDatabase(): Promise<void> {
  cache.clear();
  totalDetectedCount = 0;
  dirtyTotal = false;
  dirtyKeys.clear();
  pendingDeletes.clear();

  if (connected) {
    await giveawaysCol.deleteMany({});
    await countersCol.updateOne({ _id: 'total_detected' }, { $set: { total: 0 } }, { upsert: true });
  }

  logger.warn('Database reset', { component: 'Database' });
}

export async function cleanupOldGiveaways(days: number = 30): Promise<void> {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  for (const [key, d] of cache) {
    if (d.status !== 'active' && d.detectedAt < cutoff) {
      cache.delete(key);
      dirtyKeys.delete(key);
    }
  }
}

export async function purgeEndedGiveaways(): Promise<GiveawayData[]> {
  const now = Date.now();
  const removed: GiveawayData[] = [];

  for (const [key, d] of cache) {
    const isRunning = d.status === 'active' && (d.endsAt === null || d.endsAt > now);
    if (!isRunning) {
      removed.push(rowToGiveaway(d));
      cache.delete(key);
      dirtyKeys.delete(key);
      pendingDeletes.add(d.messageId);
    }
  }

  if (removed.length > 0) {
    scheduleSync();
    logger.info(`Purged ${removed.length} expired giveaways`, { component: 'Database' });
  }

  return removed;
}

export async function closeDb(): Promise<void> {
  if (syncTimeout) {
    clearTimeout(syncTimeout);
    syncTimeout = null;
  }
  await flushSync();

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
    ...(row.notificationStatus && { notificationStatus: row.notificationStatus }),
    ...(row.notificationSentAt && { notificationSentAt: row.notificationSentAt }),
    ...(row.notificationError && { notificationError: row.notificationError }),
  };
}

// ---------------------------------------------------------------------------
// Watchlist API
// ---------------------------------------------------------------------------

export async function addItem(userId: string, item: string): Promise<boolean> {
  await ensureConnected();
  
  const result = await watchlistCol.updateOne(
    { userId },
    { 
      $addToSet: { items: item.toLowerCase().trim() },
      $set: { updatedAt: Date.now() },
      $setOnInsert: { createdAt: Date.now() }
    },
    { upsert: true }
  );
  
  return result.modifiedCount > 0 || result.upsertedCount > 0;
}

export async function removeItem(userId: string, item: string): Promise<boolean> {
  await ensureConnected();
  
  const result = await watchlistCol.updateOne(
    { userId },
    { $pull: { items: item.toLowerCase().trim() } }
  );
  
  return result.modifiedCount > 0;
}

export async function getItems(userId: string): Promise<string[]> {
  await ensureConnected();
  
  const doc = await watchlistCol.findOne({ userId });
  return doc?.items || [];
}

export async function getAllWatchlists(): Promise<UserWatchlist[]> {
  await ensureConnected();
  
  return await watchlistCol.find({}).toArray();
}

export async function getUsersForItem(item: string): Promise<string[]> {
  await ensureConnected();
  
  const docs = await watchlistCol.find({
    items: item.toLowerCase().trim()
  }).toArray();
  
  return docs.map(doc => doc.userId);
}

export async function clearItems(userId: string): Promise<void> {
  await ensureConnected();
  
  await watchlistCol.updateOne(
    { userId },
    { $set: { items: [], updatedAt: Date.now() } }
  );
}
