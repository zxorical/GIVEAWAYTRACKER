/**
 * @module keyGenerator
 * License key generation utilities
 */

import crypto from 'crypto';
import { createLicenseKey, getLicenseKey } from '../database.js';
import { logger } from '../logger.js';

const CONFIG = {
  PREFIX: 'UNTITLED',
  SEGMENTS: 7,
  BYTES_PER_SEGMENT: 6,
  MAX_ATTEMPTS: 10
};

/**
 * Generates a secure random key segment
 */
function generateSegment(): string {
  return crypto
    .randomBytes(CONFIG.BYTES_PER_SEGMENT)
    .toString('hex')
    .toUpperCase();
}

/**
 * Generates a new license key
 *
 * Format: UNTITLED-XXXXXXXXXXXX-XXXXXXXXXXXX-XXXXXXXXXXXX-XXXXXXXXXXXX-XXXXXXXXXXXX-XXXXXXXXXXXX-XXXXXXXXXXXX
 */
export function generateKey(): string {
  const segments: string[] = [];
  for (let i = 0; i < CONFIG.SEGMENTS; i++) {
    segments.push(generateSegment());
  }
  return `${CONFIG.PREFIX}-${segments.join('-')}`;
}

/**
 * Creates a unique license key
 */
export async function createKey(createdBy: string): Promise<string> {
  let attempts = 0;

  while (attempts < CONFIG.MAX_ATTEMPTS) {
    const key = generateKey();
    attempts++;

    const existing = await getLicenseKey(key);

    if (!existing) {
      await createLicenseKey(key, createdBy);
      logger.info('License key generated', { createdBy });
      return key;
    }
  }

  throw new Error('Failed to generate a unique license key.');
}

/**
 * Validates license key format
 *
 * Example: UNTITLED-A83F91C2-9B21F4AA-7C81D992-F02A11BC-91AF83D9-21BCA81F-92CC31DA
 */
export function isValidKeyFormat(key: string): boolean {
  // 7 segments of 12 hex characters each (6 bytes)
  const regex = /^UNTITLED-[A-F0-9]{12}(?:-[A-F0-9]{12}){6}$/;
  return regex.test(key);
}

/**
 * Validates license key format with error message
 */
export function validateKeyFormat(key: string): {
  valid: boolean;
  error?: string;
} {
  if (!key || key.length === 0) {
    return { valid: false, error: 'License key cannot be empty.' };
  }

  const regex = /^UNTITLED-[A-F0-9]{12}(?:-[A-F0-9]{12}){6}$/;
  
  if (!regex.test(key)) {
    return { 
      valid: false, 
      error: 'Invalid license key format. Expected: UNTITLED-XXXXXXXXXXXX-XXXXXXXXXXXX-XXXXXXXXXXXX-XXXXXXXXXXXX-XXXXXXXXXXXX-XXXXXXXXXXXX-XXXXXXXXXXXX' 
    };
  }

  return { valid: true };
}
