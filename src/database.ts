/**
 * @module database
 * MongoDB-backed store with an in-memory cache for instant reads.
 */

import { MongoClient, Db, Collection, AnyBulkWriteOperation } from 'mongodb';
import { logger } from './logger.js';
import { GiveawayData, GiveawayStats, UserWatchlist, LicenseKey } from './types.js';

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

// Premium User Tracking
interface PremiumUser {
  userId: string;
  guildId: string;
  isPremium: boolean;
  source: 'key' | 'booster' | 'manual';
  licenseKey?: string;
  activatedAt: number;
  expiresAt: number | null;
  lastChecked: number;
  // Auto Joiner fields
  token?: string | null;
  tokenLabel?: string | null;
  tokenAddedAt?: number | null;
  tokenLastUsed?: number | null;
  tokenEntries?: number;
  tokenWins?: number;
  tokenActive?: boolean;
  webhookUrl?: string | null;
  webhookAddedAt?: number | null;
  webhookLastUsed?: number | null;
}

interface BoosterPremium {
  userId: string;
  guildId: string;
  isBooster: boolean;
  premiumAssigned: boolean;
  assignedAt: number;
  lastChecked: number;
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
let licenseKeysCol: Collection<LicenseKey>;
let premiumUsersCol: Collection<PremiumUser>;
let boosterPremiumCol: Collection<BoosterPremium>;

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
      licenseKeysCol = db.collection<LicenseKey>('license_keys');
      premiumUsersCol = db.collection<PremiumUser>('premium_users');
      boosterPremiumCol = db.collection<BoosterPremium>('booster_premium');

      await giveawaysCol.createIndex({ messageId: 1, channelId: 1 }, { unique: true });
      await giveawaysCol.createIndex({ status: 1 });
      await giveawaysCol.createIndex({ detectedAt: -1 });
      await giveawaysCol.createIndex({ notificationStatus: 1 });
      await watchlistCol.createIndex({ userId: 1 }, { unique: true });
      await watchlistCol.createIndex({ items: 1 });
      await licenseKeysCol.createIndex({ key: 1 }, { unique: true });
      await licenseKeysCol.createIndex({ used: 1 });
      await premiumUsersCol.createIndex({ userId: 1, guildId: 1 }, { unique: true });
      await premiumUsersCol.createIndex({ isPremium: 1 });
      await premiumUsersCol.createIndex({ source: 1 });
      await boosterPremiumCol.createIndex({ userId: 1, guildId: 1 }, { unique: true });
      await boosterPremiumCol.createIndex({ isBooster: 1 });
      await boosterPremiumCol.createIndex({ premiumAssigned: 1 });

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
  
  const trimmedItem = item.toLowerCase().trim();
  if (!trimmedItem) return false;
  
  const result = await watchlistCol.updateOne(
    { userId },
    { 
      $addToSet: { items: trimmedItem },
      $set: { updatedAt: Date.now() },
      $setOnInsert: { createdAt: Date.now() }
    },
    { upsert: true }
  );
  
  return result.modifiedCount > 0 || result.upsertedCount > 0;
}

export async function removeItem(userId: string, item: string): Promise<boolean> {
  await ensureConnected();
  
  const trimmedItem = item.toLowerCase().trim();
  if (!trimmedItem) return false;
  
  const result = await watchlistCol.updateOne(
    { userId },
    { $pull: { items: trimmedItem } }
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
  
  try {
    return await watchlistCol.find({}).toArray();
  } catch (err) {
    logger.error('Failed to get watchlists', { error: String(err) });
    return [];
  }
}

export async function clearItems(userId: string): Promise<void> {
  await ensureConnected();
  
  await watchlistCol.updateOne(
    { userId },
    { $set: { items: [], updatedAt: Date.now() } }
  );
}

// ---------------------------------------------------------------------------
// License System API
// ---------------------------------------------------------------------------

export async function createLicenseKey(key: string, createdBy: string): Promise<void> {
  await ensureConnected();
  await licenseKeysCol.insertOne({
    key,
    used: false,
    usedBy: null,
    createdAt: Date.now(),
    createdBy,
  });
}

export async function getLicenseKey(key: string): Promise<LicenseKey | null> {
  await ensureConnected();
  return licenseKeysCol.findOne({ key });
}

export async function validateLicenseKey(key: string): Promise<{
  valid: boolean;
  error?: string;
}> {
  await ensureConnected();

  const license = await licenseKeysCol.findOne({ key });
  if (!license) {
    return { valid: false, error: 'Invalid license key.' };
  }

  if (license.used) {
    return { valid: false, error: 'This license key has already been used.' };
  }

  return { valid: true };
}

export async function useLicenseKey(key: string, userId: string): Promise<{
  success: boolean;
  error?: string;
}> {
  await ensureConnected();

  const validation = await validateLicenseKey(key);
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  await licenseKeysCol.updateOne(
    { key },
    { $set: { used: true, usedBy: userId } }
  );

  return { success: true };
}

export async function listLicenseKeys(limit: number = 50): Promise<LicenseKey[]> {
  await ensureConnected();
  return licenseKeysCol.find({}).sort({ createdAt: -1 }).limit(limit).toArray();
}

export async function getLicenseStats(): Promise<{
  total: number;
  used: number;
  unused: number;
}> {
  await ensureConnected();
  const total = await licenseKeysCol.countDocuments();
  const used = await licenseKeysCol.countDocuments({ used: true });
  return { total, used, unused: total - used };
}

// ---------------------------------------------------------------------------
// Premium User Tracking
// ---------------------------------------------------------------------------

export async function setPremiumUser(
  userId: string,
  guildId: string,
  source: 'key' | 'booster' | 'manual',
  licenseKey?: string
): Promise<void> {
  await ensureConnected();

  const updateData: any = {
    userId,
    guildId,
    isPremium: true,
    source,
    activatedAt: Date.now(),
    expiresAt: null,
    lastChecked: Date.now(),
  };

  if (licenseKey) {
    updateData.licenseKey = licenseKey;
  }

  await premiumUsersCol.updateOne(
    { userId, guildId },
    { $set: updateData },
    { upsert: true }
  );

  logger.debug('Premium user set', { userId, guildId, source });
}

export async function removePremiumUser(
  userId: string,
  guildId: string
): Promise<void> {
  await ensureConnected();

  await premiumUsersCol.updateOne(
    { userId, guildId },
    {
      $set: {
        isPremium: false,
        lastChecked: Date.now(),
      }
    }
  );

  logger.debug('Premium user removed', { userId, guildId });
}

export async function getPremiumUser(
  userId: string,
  guildId: string
): Promise<PremiumUser | null> {
  await ensureConnected();
  return premiumUsersCol.findOne({ userId, guildId });
}

export async function isPremiumUser(
  userId: string,
  guildId: string
): Promise<boolean> {
  await ensureConnected();
  const user = await premiumUsersCol.findOne({ userId, guildId, isPremium: true });
  return !!user;
}

export async function getAllPremiumUsers(guildId: string): Promise<PremiumUser[]> {
  await ensureConnected();
  return premiumUsersCol.find({
    guildId,
    isPremium: true,
  }).toArray();
}

export async function getPremiumUsersBySource(
  guildId: string,
  source: 'key' | 'booster' | 'manual'
): Promise<PremiumUser[]> {
  await ensureConnected();
  return premiumUsersCol.find({
    guildId,
    isPremium: true,
    source,
  }).toArray();
}

export async function getPremiumStats(guildId: string): Promise<{
  total: number;
  byKey: number;
  byBooster: number;
  byManual: number;
}> {
  await ensureConnected();

  const total = await premiumUsersCol.countDocuments({ guildId, isPremium: true });
  const byKey = await premiumUsersCol.countDocuments({ guildId, isPremium: true, source: 'key' });
  const byBooster = await premiumUsersCol.countDocuments({ guildId, isPremium: true, source: 'booster' });
  const byManual = await premiumUsersCol.countDocuments({ guildId, isPremium: true, source: 'manual' });

  return { total, byKey, byBooster, byManual };
}

// ---------------------------------------------------------------------------
// Auto Joiner - Token & Webhook Management
// ---------------------------------------------------------------------------

export async function updateUserToken(
  userId: string,
  guildId: string,
  encryptedToken: string,
  label: string
): Promise<void> {
  await ensureConnected();

  await premiumUsersCol.updateOne(
    { userId, guildId },
    {
      $set: {
        token: encryptedToken,
        tokenLabel: label,
        tokenAddedAt: Date.now(),
        tokenLastUsed: null,
        tokenEntries: 0,
        tokenWins: 0,
        tokenActive: true,
        lastChecked: Date.now(),
      }
    },
    { upsert: true }
  );

  logger.debug('User token updated', { userId, guildId, label });
}

export async function updateUserWebhook(
  userId: string,
  guildId: string,
  webhookUrl: string
): Promise<void> {
  await ensureConnected();

  await premiumUsersCol.updateOne(
    { userId, guildId },
    {
      $set: {
        webhookUrl: webhookUrl,
        webhookAddedAt: Date.now(),
        webhookLastUsed: null,
        lastChecked: Date.now(),
      }
    },
    { upsert: true }
  );

  logger.debug('User webhook updated', { userId, guildId });
}

export async function getUserToken(
  userId: string,
  guildId: string
): Promise<{ token: string | null; label: string | null }> {
  await ensureConnected();
  const user = await premiumUsersCol.findOne({ userId, guildId });
  return {
    token: user?.token || null,
    label: user?.tokenLabel || null,
  };
}

export async function getUserWebhook(
  userId: string,
  guildId: string
): Promise<string | null> {
  await ensureConnected();
  const user = await premiumUsersCol.findOne({ userId, guildId });
  return user?.webhookUrl || null;
}

export async function incrementTokenEntries(
  userId: string,
  guildId: string
): Promise<void> {
  await ensureConnected();
  await premiumUsersCol.updateOne(
    { userId, guildId },
    { $inc: { tokenEntries: 1 } }
  );
}

export async function incrementTokenWins(
  userId: string,
  guildId: string
): Promise<void> {
  await ensureConnected();
  await premiumUsersCol.updateOne(
    { userId, guildId },
    { $inc: { tokenWins: 1 } }
  );
}

export async function updateTokenLastUsed(
  userId: string,
  guildId: string
): Promise<void> {
  await ensureConnected();
  await premiumUsersCol.updateOne(
    { userId, guildId },
    { $set: { tokenLastUsed: Date.now() } }
  );
}

export async function setTokenActive(
  userId: string,
  guildId: string,
  active: boolean
): Promise<void> {
  await ensureConnected();
  await premiumUsersCol.updateOne(
    { userId, guildId },
    { $set: { tokenActive: active } }
  );
}

// ---------------------------------------------------------------------------
// Booster Premium Tracking
// ---------------------------------------------------------------------------

export async function setBoosterPremium(
  userId: string,
  guildId: string,
  isBooster: boolean
): Promise<void> {
  await ensureConnected();

  await boosterPremiumCol.updateOne(
    { userId, guildId },
    {
      $set: {
        userId,
        guildId,
        isBooster,
        premiumAssigned: isBooster,
        assignedAt: isBooster ? Date.now() : 0,
        lastChecked: Date.now(),
      }
    },
    { upsert: true }
  );
}

export async function getBoosterPremium(
  userId: string,
  guildId: string
): Promise<BoosterPremium | null> {
  await ensureConnected();
  return boosterPremiumCol.findOne({ userId, guildId });
}

export async function getActiveBoosters(guildId: string): Promise<BoosterPremium[]> {
  await ensureConnected();
  return boosterPremiumCol.find({
    guildId,
    isBooster: true,
    premiumAssigned: true,
  }).toArray();
}

export async function removeBoosterPremium(
  userId: string,
  guildId: string
): Promise<void> {
  await ensureConnected();
  await boosterPremiumCol.updateOne(
    { userId, guildId },
    {
      $set: {
        isBooster: false,
        premiumAssigned: false,
        lastChecked: Date.now(),
      }
    }
  );
}

export async function updateBoosterPremiumStatus(
  userId: string,
  guildId: string,
  isBooster: boolean
): Promise<{
  shouldHavePremium: boolean;
  currentStatus: boolean;
}> {
  await ensureConnected();

  const record = await getBoosterPremium(userId, guildId);

  if (!record) {
    await setBoosterPremium(userId, guildId, isBooster);
    return {
      shouldHavePremium: isBooster,
      currentStatus: false,
    };
  }

  const shouldHavePremium = isBooster;

  if (record.isBooster !== isBooster) {
    await setBoosterPremium(userId, guildId, isBooster);
  }

  return {
    shouldHavePremium,
    currentStatus: record.premiumAssigned,
  };
}

export async function getBoosterPremiumStats(guildId: string): Promise<{
  total: number;
  withPremium: number;
  withoutPremium: number;
}> {
  await ensureConnected();

  const total = await boosterPremiumCol.countDocuments({ guildId, isBooster: true });
  const withPremium = await boosterPremiumCol.countDocuments({
    guildId,
    isBooster: true,
    premiumAssigned: true,
  });

  return {
    total,
    withPremium,
    withoutPremium: total - withPremium,
  };
}
