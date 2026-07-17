import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const KEY_PREFIX = 'sk-proxy-';

/** Generate a new virtual API key: sk-proxy- + 32 chars of base64url entropy */
export function generateVirtualKey(): string {
  return KEY_PREFIX + randomBytes(24).toString('base64url');
}

/** SHA-256 hex digest of a key — stored in ProxyKey status, never the raw key */
export function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/** Constant-time comparison of two hex-encoded SHA-256 hashes */
export function hashesEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
