/**
 * @module utils
 * Helper functions
 */

export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
}

export function formatTimestamp(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;
}

export function formatDuration(ms: number): string {
  if (ms < 0) return '0s';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (sec > 0 || parts.length === 0) parts.push(`${sec}s`);
  return parts.join(' ');
}

export function truncate(text: string, len: number): string {
  if (!text) return '';
  return text.length > len ? text.slice(0, len - 1) + '…' : text;
}

export function formatError(err: unknown): string {
  if (err instanceof Error) return err.message || err.name || 'Unknown error';
  if (typeof err === 'string' && err.trim()) return err.trim();
  if (err && typeof err === 'object' && 'message' in err && typeof (err as any).message === 'string') {
    return (err as any).message;
  }
  try { return JSON.stringify(err); } catch { return String(err); }
}

export function extractInviteCode(text: string): string | null {
  const match = text.match(/(?:https?:\/\/)?(?:discord\.gg|discord\.com\/invite)\/([a-zA-Z0-9-]{2,20})/i);
  return match ? match[1] : null;
}

export function isValidSnowflake(id: string): boolean {
  return /^\d{17,19}$/.test(id);
}

export function hasGiveawayKeyword(text: string): boolean {
  if (!text || text.length === 0) return false;
  const patterns = [
    /\bgiveaway\b/i,
    /\bgive\s*away\b/i,
    /\bgiveway\b/i,
    /react\s+to\s+enter/i,
    /enter\s+to\s+win/i,
    /click\s+to\s+enter/i,
    /press\s+to\s+enter/i,
    /enter\s+the\s+giveaway/i,
    /\braffle\b/i,
    /\bsweepstakes\b/i,
    /ends?\s+in\b/i,
    /time\s+remaining/i,
    /\bwinner\s+will\b/i,
    /\bwinners?\s+chosen\b/i,
  ];
  return patterns.some(re => re.test(text));
}

export function sanitizeForLog(text: string): string {
  if (!text) return '';
  return text
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\p{Cc}/gu, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
