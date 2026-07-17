import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

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

/** Check if an IP address matches any CIDR in the list. Empty list = allow all. */
export function ipInSubnets(ip: string, subnets: string[]): boolean {
  if (!subnets.length) return true;
  // Normalize IPv6-mapped IPv4 addresses like ::ffff:10.0.0.1
  const normalized = ip.replace(/^::ffff:/, '');
  const ipInt = ipToInt(normalized);
  if (ipInt === null) return false;

  for (const cidr of subnets) {
    const parts = cidr.split('/');
    const netInt = ipToInt(parts[0]);
    const prefix = parseInt(parts[1], 10);
    if (netInt === null || isNaN(prefix)) continue;

    const mask = prefix === 0 ? 0 : ~0 << (32 - prefix);
    if ((ipInt & mask) === (netInt & mask)) return true;
  }
  return false;
}

function ipToInt(ip: string): number | null {
  if (isIP(ip) !== 4) return null;
  const parts = ip.split('.');
  return ((+parts[0] << 24) | (+parts[1] << 16) | (+parts[2] << 8) | +parts[3]) >>> 0;
}
