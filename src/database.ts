/**
 * @module database
 * MongoDB-backed store with an in-memory cache for instant reads.
 *
 * Design:
 *  - All reads/writes hit an in-memory Map first (O(1), no scans).
 *  - Mutations mark documents "dirty"; a debounced flush batches them
 *    into a single bulkWrite so we don't hammer Mongo on every change
 *    and don't lose writes if the process exits mid-flight (flush is
 *    also run on close()).
 *  - Connection is guarded against concurrent callers via a shared
 *    in-flight promise.
 *  - Notification status fields added for tracking delivery state.
 */

import { MongoClient, Db, Collection, AnyBulkWriteOperation } from 'mongodb';
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
  // Notification tracking fields
  notificationStatus?: string;       // 'pending' | 'sent' | 'failed'
  notificationSentAt?: number;       // timestamp when sent
  notificationError?: string;        // error message if failed
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

let connected = false;
let connectingPromise: Promise<void> | null = null;

// In-memory cache — instant reads/writes. Key: `${channelId}:${messageId}`
const cache = new Map<string, StoredGiveaway>();
let totalDetectedCount = 0;

// Sync bookkeeping
let syncTimeout: NodeJS.Timeout | null = null;
let dirtyTotal = false;
const dirtyKeys = new Set<string>();
const pendingDeletes = new Set<string>(); // messageIds removed since last flush

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

      await giveawaysCol.createIndex({ messageId: 1, channelId: 1 }, { unique: true });
      await giveawaysCol.createIndex({ status: 1 });
      await giveawaysCol.createIndex({ detectedAt: -1 });
      await giveawaysCol.createIndex({ notificationStatus: 1 });

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

/**
 * Flush all pending writes/deletes/counter updates to MongoDB in one batch.
 * On failure, dirty markers are left in place so the next flush retries them
 * instead of silently dropping the write.
 */
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
      scheduleSync(); // retry later
    }
  }

  if (dirtyKeys.size > 0) {
    const keys = Array.from(dirtyKeys);
    const ops: AnyBulkWriteOperation<StoredGiveaway>[] = [];
    const docsForKeys: string[] = [];

    for (const key of keys) {
      const doc = cache.get(key);
      if (!doc) continue; // deleted locally before flush; handled below
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
        // leave dirtyKeys intact so we retry on next flush
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
// Public API — all instant from cache
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
    notificationStatus: 'pending',  // mark as pending until notification is sent
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

/**
 * Update notification status fields on a giveaway document.
 * Used by the bot's notification service to track delivery state.
 */
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
      dirtyKeys.delete(key); // no point syncing a doc we're about to delete
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
  // Make sure anything still pending gets written before we disconnect.
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
  };
}
