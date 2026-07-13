/**
 * @module index
 * Application entry point – multi-account giveaway tracker
 * With health server and robust error handling.
 */

import http from 'http';
import { Client } from 'discord.js-selfbot-v13';
import type { Message } from 'discord.js-selfbot-v13';
import 'dotenv/config';

import { CONFIG } from './config.js';
import { logger, reconfigureLogger } from './logger.js';
import GiveawayManager from './giveawayManager.js';
import { BotManager } from './bot.js';
import { delay, formatError, formatDuration } from './utils.js';
import { getDb, closeDb, cleanupOldGiveaways } from './database.js';

// ----------------------------------------------------------------------------
// HEALTH SERVER
// ----------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT || '3000', 10) || 3000;
const healthServer = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

healthServer.listen(PORT, '0.0.0.0', () => {
  console.log(`[Bootstrap] Health check server on port ${PORT}`);
});
healthServer.on('error', (err) => console.error('[Bootstrap] Health server error:', err));

// ----------------------------------------------------------------------------
// GLOBAL ERROR HANDLERS
// ----------------------------------------------------------------------------
process.on('uncaughtException', (err) => {
  try { logger.error('Uncaught exception', { component: 'Process', error: err }); } catch {}
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  try { logger.warn('Unhandled rejection', { component: 'Process', reason: formatError(reason) }); } catch {}
});

// ----------------------------------------------------------------------------
// STATE
// ----------------------------------------------------------------------------
let activeManagers: GiveawayManager[] = [];
let botManager: BotManager | null = null;
let statsInterval: ReturnType<typeof setInterval> | null = null;
let shuttingDown = false;

const CLIENT_READY_TIMEOUT_MS = 60000;
const MAX_BOOT_RETRIES = 10;
const BOOT_RETRY_DELAY_MS = 15000;

// ----------------------------------------------------------------------------
// MAIN
// ----------------------------------------------------------------------------
async function main(): Promise<void> {
  reconfigureLogger(CONFIG.logLevel, CONFIG.logDir);

  logger.info('╔═══════════════════════════════════════╗', { component: 'Bootstrap' });
  logger.info('║    Discord Giveaway Tracker v2        ║', { component: 'Bootstrap' });
  logger.info('╚═══════════════════════════════════════╝', { component: 'Bootstrap' });

  logger.info('Configuration', {
    component: 'Bootstrap',
    accounts: CONFIG.tokens.length,
    monitoredChannels: CONFIG.monitoredChannels.length || 'all',
    trackerChannel: CONFIG.trackerChannelId,
    cooldown: CONFIG.notificationCooldown,
    dbPath: CONFIG.dbPath,
  });

  // Connect DB
  getDb();
  cleanupOldGiveaways(30);

  // Init BotManager (notification sender)
  botManager = new BotManager(CONFIG.botToken);
  await botManager.start();
  logger.info('BotManager started.', { component: 'Bootstrap' });

  activeManagers = [];
  let authFailures = 0;

  for (let i = 0; i < CONFIG.tokens.length; i++) {
    const token = CONFIG.tokens[i]!.trim();
    const label = `acc${i + 1}`;

    if (!token) {
      logger.warn(`Token ${i + 1} is empty – skipping`, { component: 'Bootstrap' });
      continue;
    }

    try {
      logger.info(`Starting account ${i + 1}/${CONFIG.tokens.length} (${label})...`, {
        component: 'Bootstrap',
      });

      const client = new Client();
      const manager = new GiveawayManager(client, logger, token, label, botManager);

      registerDiscordEvents(client, manager);

      // Login with timeout
      await Promise.race([
        waitForReady(client, token),
        timeout(CLIENT_READY_TIMEOUT_MS, `Client ${label} did not become ready`),
      ]);

      activeManagers.push(manager);

      logger.info(`Account ${label} connected`, {
        component: 'Bootstrap',
        userId: client.user?.id,
        username: client.user?.username,
        guilds: client.guilds.cache.size,
      });
    } catch (err) {
      const message = formatError(err);
      const isAuth = /token|auth|login|invalid|unauthorized|401|403/i.test(message);

      if (isAuth) {
        authFailures++;
        logger.warn(`Account ${label} skipped (auth error)`, {
          component: 'Bootstrap',
          error: message,
        });
        continue;
      }

      logger.error(`Account ${label} failed`, {
        component: 'Bootstrap',
        error: message,
      });
    }
  }

  if (activeManagers.length === 0 && authFailures > 0) {
    throw Object.assign(
      new Error('All tokens failed authentication'),
      { code: 'AUTH_ALL_FAILED' }
    );
  }

  if (activeManagers.length === 0) {
    throw new Error('No accounts could be started');
  }

  logger.info(`✅ ${activeManagers.length} account(s) running`, {
    component: 'Bootstrap',
    active: activeManagers.length,
    failures: authFailures,
  });

  statsInterval = setInterval(() => {
    for (const m of activeManagers) {
      m.logStats();
    }
  }, CONFIG.statsIntervalMs);
  statsInterval.unref();

  registerShutdown();

  logger.info('🟢 Tracker is live', {
    component: 'Bootstrap',
    accounts: activeManagers.length,
    statsEvery: `${CONFIG.statsIntervalMs / 1000}s`,
  });
}

// ----------------------------------------------------------------------------
// DISCORD EVENT HANDLERS
// ----------------------------------------------------------------------------
function registerDiscordEvents(client: Client, manager: GiveawayManager): void {
  client.on('messageCreate', (msg: Message) => {
    if (!msg.guild) return;
    manager.handleMessage(msg).catch((err) => {
      logger.error('messageCreate handler error', {
        component: 'Events',
        error: formatError(err),
        messageId: msg.id,
      });
    });
  });

  client.on('messageUpdate', (_old: any, updated: any) => {
    if (!updated.id || !updated.channel) return;
    manager.handleMessage(updated as Message).catch((err) => {
      logger.error('messageUpdate handler error', {
        component: 'Events',
        error: formatError(err),
        messageId: updated.id,
      });
    });
  });

  client.on('guildCreate', (guild) => {
    logger.info('Joined server', {
      component: 'Events',
      guildId: guild.id,
      guildName: guild.name,
      memberCount: guild.memberCount,
    });
  });

  client.on('guildDelete', (guild) => {
    logger.info('Left server', {
      component: 'Events',
      guildId: guild.id,
      guildName: guild.name,
    });
  });

  client.on('disconnect', () => logger.warn('Disconnected', { component: 'Events' }));
  client.on('reconnecting', () => logger.info('Reconnecting...', { component: 'Events' }));
  client.on('error', (err) => logger.error('Client error', { component: 'Events', error: err }));
}

// ----------------------------------------------------------------------------
// HELPERS
// ----------------------------------------------------------------------------
function waitForReady(client: Client, token: string): Promise<void> {
  return new Promise((resolve, reject) => {
    client.once('ready', () => resolve());
    client.once('error', (err) => reject(err));
    client.login(token).catch((err) => reject(new Error(`Login failed: ${formatError(err)}`)));
  });
}

function timeout(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms));
}

// ----------------------------------------------------------------------------
// SHUTDOWN
// ----------------------------------------------------------------------------
function registerShutdown(): void {
  const handle = async (signal: string): Promise<void> => {
    if (shuttingDown) { process.exit(1); }
    shuttingDown = true;

    logger.info(`${signal} received – shutting down`, { component: 'Shutdown' });

    if (statsInterval) { clearInterval(statsInterval); statsInterval = null; }

    for (const m of activeManagers) {
      await m.shutdown();
    }

    if (botManager) {
      logger.info('Shutting down BotManager...', { component: 'Shutdown' });
      await botManager.destroy();
    }

    closeDb();
    healthServer.close(() => {});
    logger.info('Goodbye.', { component: 'Shutdown' });
    setTimeout(() => process.exit(0), 500);
  };

  process.on('SIGINT', () => handle('SIGINT').catch(() => process.exit(1)));
  process.on('SIGTERM', () => handle('SIGTERM').catch(() => process.exit(1)));
}

// ----------------------------------------------------------------------------
// BOOT LOOP
// ----------------------------------------------------------------------------
async function boot(): Promise<void> {
  let attempt = 0;

  while (attempt < MAX_BOOT_RETRIES) {
    try {
      attempt++;
      if (attempt > 1) {
        logger.info(`Boot attempt ${attempt}/${MAX_BOOT_RETRIES}`, { component: 'Bootstrap' });
      }
      await main();
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = (err as any)?.code;

      logger.error('Startup error', {
        component: 'Bootstrap',
        error: message,
        attempt,
        maxRetries: MAX_BOOT_RETRIES,
      });

      if (code === 'AUTH_ALL_FAILED') {
        logger.error('All tokens invalid – exiting', { component: 'Bootstrap' });
        process.exit(1);
      }

      if (/token|auth|login|invalid|unauthorized|401|403/i.test(message)) {
        logger.error('Fatal auth error – exiting', { component: 'Bootstrap' });
        process.exit(1);
      }

      if (attempt >= MAX_BOOT_RETRIES) {
        logger.error('Max retries exceeded', { component: 'Bootstrap' });
        process.exit(1);
      }

      for (const m of activeManagers) {
        try { (m as any).client?.destroy(); } catch {}
      }
      activeManagers = [];
      shuttingDown = false;

      logger.info(`Retrying in ${BOOT_RETRY_DELAY_MS / 1000}s...`, { component: 'Bootstrap' });
      await delay(BOOT_RETRY_DELAY_MS);
    }
  }
}

boot();
