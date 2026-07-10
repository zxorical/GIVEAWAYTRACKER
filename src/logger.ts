/**
 * @module logger
 * Winston-based logger
 */

import { createLogger, format, transports, Logger } from 'winston';
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';

const LEVEL_COLORS: Record<string, (text: string) => string> = {
  error: chalk.bold.red,
  warn: chalk.bold.yellow,
  info: chalk.bold.cyan,
  debug: chalk.bold.gray,
};

const LEVEL_BADGE: Record<string, string> = {
  error: '✖ ERROR',
  warn: '⚠ WARN ',
  info: '● INFO ',
  debug: '◌ DEBUG',
};

const consoleFormat = format.printf((info) => {
  const { timestamp, level, message, stack, component, ...meta } = info as any;
  const colorFn = LEVEL_COLORS[level] ?? chalk.white;
  const badge = LEVEL_BADGE[level] ?? level.toUpperCase().padEnd(7);
  const ts = chalk.dim(timestamp ?? '');
  const lvl = colorFn(`[${badge}]`);
  const comp = component ? chalk.magenta(`[${component}] `) : '';

  const known = new Set(['timestamp', 'level', 'message', 'stack', 'component', 'splat']);
  const extras = Object.entries(meta)
    .filter(([k]) => !known.has(k))
    .map(([k, v]) => `${chalk.dim(k)}=${chalk.yellow(JSON.stringify(v))}`)
    .join(' ');

  const extraStr = extras ? `  ${extras}` : '';
  const stackStr = stack ? `\n${chalk.dim.red(String(stack))}` : '';

  return `${ts} ${lvl} ${comp}${String(message)}${extraStr}${stackStr}`;
});

function buildLogger(logLevel: string, logDir: string): Logger {
  const resolved = path.resolve(logDir);
  if (!fs.existsSync(resolved)) fs.mkdirSync(resolved, { recursive: true });

  return createLogger({
    level: logLevel,
    format: format.combine(
      format.errors({ stack: true }),
      format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      format.splat()
    ),
    transports: [
      new transports.Console({
        format: format.combine(format.colorize({ level: false }), consoleFormat),
      }),
      new transports.File({
        filename: path.join(resolved, 'combined.log'),
        format: format.combine(format.json()),
        maxsize: 10 * 1024 * 1024,
        maxFiles: 5,
        tailable: true,
      }),
      new transports.File({
        filename: path.join(resolved, 'error.log'),
        level: 'error',
        format: format.combine(format.json()),
        maxsize: 5 * 1024 * 1024,
        maxFiles: 5,
        tailable: true,
      }),
    ],
    exitOnError: false,
  });
}

let winstonLogger = buildLogger('info', './logs');

export function reconfigureLogger(level: string, dir: string): void {
  winstonLogger = buildLogger(level, dir);
}

export const logger = {
  info(msg: string, meta?: Record<string, unknown>) {
    winstonLogger.info(msg, meta ?? {});
  },
  warn(msg: string, meta?: Record<string, unknown>) {
    winstonLogger.warn(msg, meta ?? {});
  },
  error(msg: string, meta?: Record<string, unknown>) {
    const safe = { ...meta };
    if (safe.error instanceof Error) {
      const err = safe.error as Error;
      safe.errorMessage = err.message;
      safe.stack = err.stack;
      delete safe.error;
    }
    winstonLogger.error(msg, safe);
  },
  debug(msg: string, meta?: Record<string, unknown>) {
    winstonLogger.debug(msg, meta ?? {});
  },
};

export type AppLogger = typeof logger;
