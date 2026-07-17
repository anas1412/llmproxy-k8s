import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const config = {
  operatorNamespace: process.env.OPERATOR_NAMESPACE ?? 'llmproxy-system',
  /** URL tenants use to reach the proxy — injected into tenant secrets */
  proxyURL: process.env.PROXY_URL ?? 'http://llmproxy.llmproxy-system.svc.cluster.local:8000',
  proxyPort: Number(process.env.PROXY_PORT ?? 8000),
  healthPort: Number(process.env.HEALTH_PORT ?? 8081),
};

const KEY_PREFIX = 'sk-proxy-';

export function generateVirtualKey(): string {
  return KEY_PREFIX + randomBytes(24).toString('base64url'); // 32 chars of entropy
}

export function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/** Constant-time comparison of two hex hashes. */
export function hashesEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
