/**
 * @module types
 * All shared TypeScript types
 */

// ─── CONFIG ──────────────────────────────────────────────────────────

export interface AppConfig {
  // Self-bot tokens
  tokens: string[];
  
  // Commercial bot
  botToken: string;
  trackerChannelId: string;
  
  // Monitoring
  monitoredChannels: string[];
  
  // Database
  dbPath: string;
  
  // Logging
  logLevel: string;
  logDir: string;
  
  // Notification
  notificationCooldown: number;
  statsIntervalMs: number;
  
  // Admin
  adminUserIds: string[];
  
  // Auto-join
  autoJoinInvites: string[];
  webhookUrl?: string;
  winWebhookUrl?: string;
  buttonDelayMs?: number;
  reactionDelayMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
}

// ─── GIVEAWAY DATA ──────────────────────────────────────────────────

export interface GiveawayData {
  id?: string;
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
  accountLabel?: string;
  
  // Optional fields for rich embeds
  inviteUrl?: string;
  notificationMessageId?: string;
  detectionTimeMs?: number;
  guildIcon?: string | null;
  guildBanner?: string | null;
  memberCount?: number | null;
  
  // Notification status
  notificationStatus?: string;
  notificationSentAt?: number;
  notificationError?: string;
}

export interface GiveawayStats {
  totalDetected: number;
  activeGiveaways: number;
  serversWithGiveaways: number;
  lastDetected: number | null;
}

export enum DetectionSource {
  CONTENT = 'content',
  EMBED = 'embed',
  COMPONENT = 'component',
}

export interface DetectedGiveaway {
  prize: string;
  source: DetectionSource;
  endsAt: number | null;
  buttonCustomId?: string;
  reactionEmoji?: string;
}

export interface GiveawayButton {
  customId: string;
  label: string;
  disabled: boolean;
}

// ─── ENTRY SYSTEM ──────────────────────────────────────────────────

export enum EntryMethod {
  BUTTON = 'button',
  REACTION = 'reaction',
}

export enum EntryStatus {
  PENDING = 'pending',
  ATTEMPTING = 'attempting',
  SUCCESS = 'success',
  FAILED = 'failed',
  SKIPPED = 'skipped',
}

export interface GiveawayEntry {
  entryId: string;
  messageId: string;
  channelId: string;
  guildId: string;
  guildName: string;
  channelName: string;
  authorId: string;
  prize: string;
  entryMethod: EntryMethod;
  buttonCustomId?: string;
  reactionEmoji?: string;
  detectionSource: DetectionSource;
  detectedAt: number;
  endsAt?: number;
  status: EntryStatus;
  attempts: number;
  lastAttemptAt?: number;
  lastError?: string;
}

export interface ManagerState {
  entries: Map<string, GiveawayEntry>;
  processing: Set<string>;
  stats: GiveawayManagerStats;
}

export interface GiveawayManagerStats {
  totalDetected: number;
  totalSucceeded: number;
  totalFailed: number;
  totalSkipped: number;
  totalDuplicates: number;
  totalWins: number;
  serversJoined: number;
  serversJoinFailed: number;
  startedAt: number;
  lastDetectedAt?: number;
  lastSuccessAt?: number;
}

// ─── AUTOJOIN SYSTEM ──────────────────────────────────────────────

export interface AutoJoinUser {
  userId: string;
  guildId: string;
  token: string; // encrypted
  tokenLabel: string;
  tokenAddedAt: number;
  tokenLastUsed: number | null;
  tokenEntries: number;
  tokenWins: number;
  tokenActive: boolean;
  webhookUrl: string | null;
  webhookAddedAt: number | null;
  webhookLastUsed: number | null;
}

export interface AutoJoinEntry {
  entryId: string;
  userId: string;
  guildId: string;
  messageId: string;
  channelId: string;
  prize: string;
  status: 'pending' | 'entered' | 'failed' | 'skipped';
  attemptedAt: number;
  error?: string;
}

export interface AutoJoinStats {
  totalEntries: number;
  totalSuccess: number;
  totalFailed: number;
  totalWins: number;
  activeSessions: number;
}

// ─── DATABASE ──────────────────────────────────────────────────────

export interface UserWatchlist {
  userId: string;
  items: string[];
  createdAt: number;
  updatedAt: number;
}

// ─── LICENSE SYSTEM ──────────────────────────────────────────────

export interface LicenseKey {
  key: string;
  used: boolean;
  usedBy: string | null;
  createdAt: number;
  createdBy: string;
}

export interface PremiumUser {
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

export interface BoosterPremium {
  userId: string;
  guildId: string;
  isBooster: boolean;
  premiumAssigned: boolean;
  assignedAt: number;
  lastChecked: number;
}

// ─── WEBHOOK ──────────────────────────────────────────────────────

export interface WebhookPayload {
  type: 'giveaway' | 'win' | 'entry';
  apiKey: string;
  data: {
    accountLabel?: string;
    userId?: string;
    messageId: string;
    channelId: string;
    guildId: string;
    guildName: string;
    channelName: string;
    authorId?: string;
    prize: string;
    detectedAt: number;
    endsAt: number | null;
    buttonCustomId?: string;
    status?: string;
    error?: string;
  };
}

export interface WebhookResponse {
  success: boolean;
  error?: string;
}

// ─── DISCORD ──────────────────────────────────────────────────────

export interface DiscordMessage {
  id: string;
  channelId: string;
  guildId?: string;
  guildName?: string;
  channelName?: string;
  content: string;
  authorId: string;
  authorName: string;
  authorBot: boolean;
  embeds: DiscordEmbed[];
  components: DiscordComponent[];
  reactions: DiscordReaction[];
  timestamp: number;
  url: string;
}

export interface DiscordEmbed {
  title?: string;
  description?: string;
  color?: number;
  footer?: { text: string };
  fields?: { name: string; value: string }[];
  author?: { name: string; iconURL?: string };
  thumbnail?: { url: string };
  image?: { url: string };
  timestamp?: string;
}

export interface DiscordComponent {
  type: number;
  customId?: string;
  label?: string;
  style?: number;
  disabled?: boolean;
  options?: { label: string; value: string }[];
}

export interface DiscordReaction {
  emoji: string;
  count: number;
  me: boolean;
}

// ─── COMMANDS ─────────────────────────────────────────────────────

export interface Command {
  name: string;
  description: string;
  options?: CommandOption[];
  defaultMemberPermissions?: string;
}

export interface CommandOption {
  name: string;
  description: string;
  type: number;
  required?: boolean;
  choices?: { name: string; value: string }[];
  minValue?: number;
  maxValue?: number;
}

// ─── UTILITY ─────────────────────────────────────────────────────

export interface InviteParseResult {
  isValid: boolean;
  code: string | null;
  url: string | null;
}

export interface RateLimitInfo {
  limit: number;
  remaining: number;
  resetAfter: number;
  resetAt: number;
}

// ─── EVENTS ──────────────────────────────────────────────────────

export interface GiveawayDetectedEvent {
  entry: GiveawayEntry;
  accountLabel: string;
}

export interface GiveawayEnteredEvent {
  entry: GiveawayEntry;
  accountLabel: string;
}

export interface GiveawayFailedEvent {
  entry: GiveawayEntry;
  accountLabel: string;
  error: string;
}

export interface GiveawayWonEvent {
  userId: string;
  guildId: string;
  prize: string;
  messageId: string;
  channelId: string;
  guildName: string;
  channelName: string;
  accountLabel: string;
}
