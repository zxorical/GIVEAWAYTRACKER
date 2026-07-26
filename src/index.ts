// src/index.ts
/**
 * @module index
 * Application entry point – with BotManager timeout and fallback.
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
import { AutoJoinService } from './autojoin/AutoJoinService.js';

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
  console.error('🔥 UNCAUGHT EXCEPTION:', err);
  try { logger.error('Uncaught exception', { component: 'Process', error: err }); } catch {}
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('🔥 UNHANDLED REJECTION:', reason);
  try { logger.warn('Unhandled rejection', { component: 'Process', reason: formatError(reason) }); } catch {}
});

// ----------------------------------------------------------------------------
// STATE
// ----------------------------------------------------------------------------
let activeManagers: GiveawayManager[] = [];
let botManager: BotManager | null = null;
let statsInterval: ReturnType<typeof setInterval> | null = null;
let shuttingDown = false;
let autoJoinService: AutoJoinService | null = null;

const CLIENT_READY_TIMEOUT_MS = 60000;
const MAX_BOOT_RETRIES = 10;
const BOOT_RETRY_DELAY_MS = 15000;
const BOT_MANAGER_START_TIMEOUT_MS = 10000;

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
    autoJoinInvites: CONFIG.autoJoinInvites.length || 0,
    webhookEnabled: !!CONFIG.webhookUrl,
    winWebhookEnabled: !!CONFIG.winWebhookUrl,
  });

  // Connect DB (await)
  await getDb();
  logger.info('Database connection established', { component: 'Bootstrap' });

  // Cleanup old giveaways (fire and forget)
  cleanupOldGiveaways(30).catch(err => logger.warn('cleanupOldGiveaways error', { error: err }));

  // --------------------------------------------------------------------------
  // ✅ INITIALIZE AUTOJOIN SERVICE
  // --------------------------------------------------------------------------
  autoJoinService = new AutoJoinService();
  logger.info('AutoJoinService initialized', { component: 'Bootstrap' });

  // --------------------------------------------------------------------------
  // START BOTMANAGER WITH TIMEOUT
  // --------------------------------------------------------------------------
  logger.info('Initializing BotManager...', { component: 'Bootstrap' });
  try {
    const startPromise = (async () => {
      botManager = new BotManager(CONFIG.botToken);
      await botManager.start();
    })();
    await Promise.race([
      startPromise,
      timeout(BOT_MANAGER_START_TIMEOUT_MS, 'BotManager.start() timed out'),
    ]);
    logger.info('BotManager started successfully.', { component: 'Bootstrap' });
  } catch (err) {
    logger.warn('BotManager failed to start (will continue without it):', {
      component: 'Bootstrap',
      error: formatError(err),
    });
    botManager = null;
  }

  // --------------------------------------------------------------------------
  // START ACCOUNT CLIENTS
  // --------------------------------------------------------------------------
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

      // Debug / error events
      client.on('debug', (info) => {
        logger.debug(`[${label}] Debug: ${info}`, { component: 'Client' });
      });

      client.on('ready', () => {
        logger.info(`[${label}] Client ready event fired`, { component: 'Client' });
      });

      client.on('error', (err) => {
        logger.error(`[${label}] Client error event: ${formatError(err)}`, { component: 'Client' });
      });

      // ✅ CREATE GIVEAWAY MANAGER WITH AUTOJOIN SERVICE
      const manager = new GiveawayManager(
        client,
        CONFIG,      // Pass config
        logger,      // Pass logger
        token,       // Pass token
        label,       // Account label
        botManager,  // Bot manager
        autoJoinService // ✅ Pass AutoJoinService
      );
      
      // ✅ REGISTER EVENTS
      registerDiscordEvents(client, manager);
      
      // ✅ CONNECT AUTOJOIN TO GIVEAWAY EVENTS
      manager.on('giveawayDetected', (entry) => {
        if (autoJoinService && entry.buttonCustomId) {
          console.log(`🔥 [AUTOJOIN] 🎯 AutoJoin triggered for: ${entry.prize}`);
          autoJoinService.handleGiveawayDetected({
            messageId: entry.messageId,
            channelId: entry.channelId,
            guildId: entry.guildId,
            guildName: entry.guildName,
            channelName: entry.channelName,
            prize: entry.prize,
            buttonCustomId: entry.buttonCustomId,
            detectedAt: entry.detectedAt,
          }).catch(err => {
            console.error('🔥 [AUTOJOIN] Error:', err);
          });
        }
      });

      logger.info(`[${label}] Calling waitForReady...`, { component: 'Bootstrap' });

      await Promise.race([
        waitForReady(client, token, label),
        timeout(CLIENT_READY_TIMEOUT_MS, `Client ${label} did not become ready`),
      ]);

      logger.info(`[${label}] waitForReady resolved successfully`, { component: 'Bootstrap' });

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

  // ── Auto‑join invites for every active account ─────────────────────────
  if (CONFIG.autoJoinInvites && CONFIG.autoJoinInvites.length > 0) {
    logger.info(`Auto‑joining ${CONFIG.autoJoinInvites.length} server(s) for each active account`, {
      component: 'AutoJoin',
    });

    for (let i = 0; i < activeManagers.length; i++) {
      const manager = activeManagers[i]!;
      if (i > 0) {
        await delay(5000);
      }
      await autoJoinForManager(manager);
    }

    logger.info('Auto‑join complete for all accounts', { component: 'AutoJoin' });
  }

  statsInterval = setInterval(() => {
    for (const m of activeManagers) {
      m.logStats();
    }
    // Log AutoJoinService stats
    if (autoJoinService) {
      const stats = autoJoinService.getStats();
      logger.info('AutoJoinService Stats', {
        component: 'Bootstrap',
        sessions: autoJoinService.getActiveSessions(),
        detected: stats.totalDetected,
        success: stats.totalSuccess,
        failed: stats.totalFailed,
        wins: stats.totalWins,
      });
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
    if (!msg.guild) {
      // Handle DM wins
      manager.handleDmWin(msg).catch((err) => {
        logger.error('handleDmWin error', {
          component: 'Events',
          messageId: msg.id,
          error: formatError(err),
        });
      });
      return;
    }

    // Check for wins from bots
    if (msg.author?.bot) {
      manager.handleWin(msg).catch((err) => {
        logger.error('handleWin error', {
          component: 'Events',
          messageId: msg.id,
          error: formatError(err),
        });
      });
    }

    // Handle giveaway detection
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
// AUTO-JOIN FOR MANAGER
// ----------------------------------------------------------------------------
async function autoJoinForManager(manager: GiveawayManager): Promise<void> {
  const invites = CONFIG.autoJoinInvites || [];
  
  for (let i = 0; i < invites.length; i++) {
    const raw = invites[i]!;
    const parsed = parseInvite(raw);

    if (!parsed.isValid || !parsed.code) {
      logger.warn(`Could not parse invite #${i + 1} – skipping`, { 
        component: 'AutoJoin', 
        raw 
      });
      manager.recordServerJoin(false);
      continue;
    }

    const { code, url } = parsed;
    logger.info(`Joining [${i + 1}/${invites.length}]: ${url ?? code}`, { 
      component: 'AutoJoin' 
    });

    try {
      const client = (manager as any).client as Client;
      await joinByInvite(client, code);
      logger.info(`Joined via ${code}`, { component: 'AutoJoin' });
      manager.recordServerJoin(true);
    } catch (err: unknown) {
      logger.error(`Failed to join via ${code}`, { 
        component: 'AutoJoin', 
        error: formatError(err) 
      });
      manager.recordServerJoin(false);
    }

    if (i < invites.length - 1) {
      await delay(3500);
    }
  }
}

async function joinByInvite(client: Client, code: string): Promise<void> {
  const selfbot = client as Client & { acceptInvite?: (code: string) => Promise<any> };
  if (typeof selfbot.acceptInvite === 'function') {
    await selfbot.acceptInvite(code);
    return;
  }

  const invite = await client.fetchInvite(code);
  if (invite.guild && client.guilds.cache.has(invite.guild.id)) {
    logger.info(`Already in "${invite.guild.name}" – skipping`, { component: 'AutoJoin' });
    return;
  }

  throw new Error(`Cannot join "${code}" – acceptInvite not available`);
}

function parseInvite(input: string): { isValid: boolean; code: string | null; url: string | null } {
  const trimmed = input.trim();
  
  // Try to extract code from URL
  const urlMatch = trimmed.match(/(?:https?:\/\/)?(?:discord\.gg|discord\.com\/invite)\/([a-zA-Z0-9-]{2,20})/i);
  if (urlMatch) {
    return { isValid: true, code: urlMatch[1], url: trimmed };
  }
  
  // Assume it's just a code
  if (/^[a-zA-Z0-9-]{2,20}$/.test(trimmed)) {
    return { isValid: true, code: trimmed, url: `https://discord.gg/${trimmed}` };
  }
  
  return { isValid: false, code: null, url: null };
}

// ----------------------------------------------------------------------------
// HELPERS
// ----------------------------------------------------------------------------
function waitForReady(client: Client, token: string, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log(`[${label}] waitForReady: setting up listeners and calling login...`);
    client.once('ready', () => {
      console.log(`[${label}] waitForReady: ready event received`);
      resolve();
    });
    client.once('error', (err) => {
      console.error(`[${label}] waitForReady: error event received`, err);
      reject(err);
    });
    client.login(token)
      .then(() => {
        console.log(`[${label}] waitForReady: client.login() resolved`);
      })
      .catch((err) => {
        console.error(`[${label}] waitForReady: client.login() rejected`, err);
        reject(new Error(`Login failed: ${formatError(err)}`));
      });
  });
}

function timeout(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => {
      console.error(`Timeout triggered: ${message}`);
      reject(new Error(message));
    }, ms);
  });
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

    // Shut down AutoJoinService first
    if (autoJoinService) {
      logger.info('Shutting down AutoJoinService...', { component: 'Shutdown' });
      await autoJoinService.shutdown();
    }

    // Shut down all giveaway managers
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
