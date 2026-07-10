/**
 * @module types
 * All shared TypeScript types
 */

export interface AppConfig {
  tokens: string[];
  botToken: string;
  trackerChannelId: string;
  monitoredChannels: string[];
  dbPath: string;
  logLevel: string;
  logDir: string;
  notificationCooldown: number;
  statsIntervalMs: number;
  adminUserIds: string[];
}

export interface GiveawayData {
  id?: number;
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

export interface AppConfig {
  tokens: string[];
  botToken: string;
  trackerChannelId: string;
  monitoredChannels: string[];
  dbPath: string;
  logLevel: string;
  logDir: string;
  notificationCooldown: number;
  statsIntervalMs: number;
  adminUserIds: string[];
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
}
