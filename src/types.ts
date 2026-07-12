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

  status: 'active' | 'ended';

  notifiedAt: number | null;
  lastSeenAt: number;

  inviteUrl?: string;
  notificationMessageId?: string;

  detectionTimeMs?: number;
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
}

export interface GiveawayMessage {
  content?: string;

  embeds?: {
    title?: string;
    description?: string;
    footer?: {
      text?: string;
    };
    fields?: {
      name: string;
      value: string;
    }[];
  }[];

  buttons?: {
    customId?: string;
    label?: string;
    disabled?: boolean;
    style?: number;
  }[];
}
