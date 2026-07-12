/**
 * @module database
 * MongoDB database — persistent cloud storage
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
let giveaways: Collection<StoredGiveaway>;
let counters: Collection<TotalCounter>;
let connected = false;

async function connect(): Promise<void> {
  if (connected) return;

  try {
    client = new MongoClient(MONGO_URI!);
    await client.connect();
    db = client.db('giveaway_tracker');
    giveaways = db.collection<StoredGiveaway>('giveaways');
    counters = db.collection<TotalCounter>('counters');

    await giveaways.createIndex({ messageId: 1, channelId: 1 }, { unique: true });
    await giveaways.createIndex({ status: 1, endsAt: 1 });
    await giveaways.createIndex({ detectedAt: -1 });

    const existing = await counters.findOne({ _id: 'total_detected' });
    if (!existing) {
      await counters.insertOne({ _id: 'total_detected', total: 0 });
      logger.info('Initialized total counter to 0', { component: 'Database' });
    } else {
      logger.info(`Loaded total counter: ${existing.total}`, { component: 'Database' });
    }

    const count = await giveaways.countDocuments();
    if (count > 0 && existing && existing.total < count) {
      await counters.updateOne(
        { _id: 'total_detected' },
        { $set: { total: count } }
      );
      logger.info(`Corrected total counter to ${count}`, { component: 'Database' });
    }

    connected = true;
    logger.info('Connected to MongoDB', { component: 'Database' });
  } catch (err) {
    logger.error('Failed to connect to MongoDB', { component: 'Database', error: String(err) });
    throw err;
  }
}

async function ensureConnected(): Promise<void> {
  if (!connected) await connect();
}

export async function getDb(): Promise<Db> {
  await ensureConnected();
  return db;
}

export async function getTotalDetected(): Promise<number> {
  await ensureConnected();
  const counter = await counters.findOne({ _id: 'total_detected' });
  return counter?.total || 0;
}

export async function insertGiveaway(g: Omit<GiveawayData, 'id' | 'status' | 'notifiedAt' | 'lastSeenAt'>): Promise<boolean> {
  await ensureConnected();

  try {
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

    await giveaways.insertOne(doc);
    await counters.updateOne(
      { _id: 'total_detected' },
      { $inc: { total: 1 } }
    );
    return true;
  } catch (err: any) {
    if (err.code === 11000) return false;
    logger.error('Failed to insert giveaway', { component: 'Database', error: String(err) });
    return false;
  }
}

export async function wasNotifiedRecently(messageId: string, channelId: string, cooldownSeconds: number): Promise<boolean> {
  await ensureConnected();
  const entry = await giveaways.findOne({ messageId, channelId });
  if (!entry || !entry.notifiedAt) return false;
  return Date.now() - entry.notifiedAt < cooldownSeconds * 1000;
}

export async function markNotified(messageId: string, channelId: string): Promise<void> {
  await ensureConnected();
  await giveaways.updateOne(
    { messageId, channelId },
    { $set: { notifiedAt: Date.now() } }
  );
}

export async function updateLastSeen(messageId: string, channelId: string): Promise<void> {
  await ensureConnected();
  await giveaways.updateOne(
    { messageId, channelId },
    { $set: { lastSeenAt: Date.now() } }
  );
}

export async function markEnded(messageId: string, channelId: string): Promise<void> {
  await ensureConnected();
  await giveaways.updateOne(
    { messageId, channelId },
    { $set: { status: 'ended' } }
  );
}

export async function setNotificationMessageId(giveawayMessageId: string, channelId: string, notificationMessageId: string): Promise<void> {
  await ensureConnected();
  await giveaways.updateOne(
    { messageId: giveawayMessageId, channelId },
    { $set: { notificationMessageId } }
  );
}

export async function getGiveaway(messageId: string, channelId: string): Promise<GiveawayData | null> {
  await ensureConnected();
  const entry = await giveaways.findOne({ messageId, channelId });
  if (!entry) return null;
  return rowToGiveaway(entry);
}

export async function getActiveGiveaways(limit: number = 50): Promise<GiveawayData[]> {
  await ensureConnected();
  const now = Date.now();
  const entries = await giveaways
    .find({
      status: 'active',
      $or: [
        { endsAt: null },
        { endsAt: { $gt: now } },
      ],
    })
    .sort({ detectedAt: -1 })
    .limit(limit)
    .toArray();
  return entries.map(rowToGiveaway);
}

export async function getAllGiveaways(limit: number = 100): Promise<GiveawayData[]> {
  await ensureConnected();
  const entries = await giveaways
    .find({})
    .sort({ detectedAt: -1 })
    .limit(limit)
    .toArray();
  return entries.map(rowToGiveaway);
}

export async function getStats(): Promise<GiveawayStats> {
  await ensureConnected();
  const now = Date.now();
  const counter = await counters.findOne({ _id: 'total_detected' });
  const total = counter?.total || 0;

  const active = await giveaways.countDocuments({
    status: 'active',
    $or: [
      { endsAt: null },
      { endsAt: { $gt: now } },
    ],
  });

  const servers = await giveaways.distinct('guildId');
  const lastEntry = await giveaways
    .find({})
    .sort({ detectedAt: -1 })
    .limit(1)
    .toArray();
  const last = lastEntry.length > 0 ? lastEntry[0].detectedAt : null;

  return {
    totalDetected: total,
    activeGiveaways: active,
    serversWithGiveaways: servers.length,
    lastDetected: last,
  };
}

export async function resetDatabase(): Promise<void> {
  await ensureConnected();
  await giveaways.deleteMany({});
  await counters.updateOne(
    { _id: 'total_detected' },
    { $set: { total: 0 } }
  );
  logger.warn('Database reset', { component: 'Database' });
}

export async function cleanupOldGiveaways(days: number = 30): Promise<void> {
  await ensureConnected();
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const result = await giveaways.deleteMany({
    status: { $ne: 'active' },
    detectedAt: { $lt: cutoff },
  });
  if (result.deletedCount > 0) {
    logger.debug(`Cleaned up ${result.deletedCount} old giveaways`, { component: 'Database' });
  }
}

export async function purgeEndedGiveaways(): Promise<StoredGiveaway[]> {
  await ensureConnected();
  const now = Date.now();

  const toRemove = await giveaways
    .find({
      $or: [
        { status: 'ended' },
        { status: 'active', endsAt: { $ne: null, $lte: now } },
        { status: { $nin: ['active', 'ended'] } },
      ],
    })
    .toArray();

  if (toRemove.length > 0) {
    const ids = toRemove.map(g => g.messageId);
    await giveaways.deleteMany({ messageId: { $in: ids } });
    logger.info(`Purged ${toRemove.length} expired giveaways`, { component: 'Database' });
  }

  return toRemove;
}

export async function closeDb(): Promise<void> {
  if (client) {
    await client.close();
    connected = false;
    logger.debug('Database connection closed', { component: 'Database' });
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
