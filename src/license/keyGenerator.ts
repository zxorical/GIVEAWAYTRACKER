import crypto from 'crypto';
import { createLicenseKey } from '../database.js';
import { logger } from '../logger.js';

export function generateKey(): string {
  const prefix = 'VRFS';
  const segments = [];
  for (let i = 0; i < 4; i++) {
    segments.push(crypto.randomBytes(4).toString('hex').toUpperCase());
  }
  return `${prefix}-${segments[0]}-${segments[1]}-${segments[2]}-${segments[3]}`;
}

export async function createKey(createdBy: string): Promise<string> {
  const key = generateKey();
  await createLicenseKey(key, createdBy);
  logger.info(`License key generated: ${key}`, { createdBy });
  return key;
}
