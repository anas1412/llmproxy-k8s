import { Injectable } from '@nestjs/common';

interface Window {
  count: number;
  resetAt: number; // epoch ms
}

/**
 * In-memory sliding window rate limiter. No Redis needed.
 *
 * Two tiers:
 *   - per ProxyKey (RPM/TPM)
 *   - per Channel (RPM/TPM)
 *
 * Rate limits are derived from channel config or global defaults.
 * Defaults: unlimited (0 = no limit).
 */
@Injectable()
export class RateLimiterService {
  private rpm = new Map<string, Window>(); // key|channel → window
  private tpm = new Map<string, Window>();

  /** Check RPM for a given key. Returns true if allowed. */
  checkRPM(key: string, limit: number): boolean {
    if (limit <= 0) return true;
    return this.check(key, limit, this.rpm);
  }

  /** Check TPM for a given key. Returns true if allowed. */
  checkTPM(key: string, tokenCount: number, limit: number): boolean {
    if (limit <= 0) return true;
    return this.check(key, limit, this.tpm, tokenCount);
  }

  /** Record a request for RPM tracking */
  recordRPM(key: string): void {
    this.record(key, this.rpm);
  }

  /** Record tokens for TPM tracking */
  recordTPM(key: string, tokens: number): void {
    this.record(key, this.tpm, tokens);
  }

  private check(key: string, limit: number, store: Map<string, Window>, delta = 1): boolean {
    const now = Date.now();
    const w = store.get(key);
    if (!w || now > w.resetAt) return true; // window expired → allow
    return w.count + delta <= limit;
  }

  private record(key: string, store: Map<string, Window>, delta = 1): void {
    const now = Date.now();
    const w = store.get(key);
    if (!w || now > w.resetAt) {
      store.set(key, { count: delta, resetAt: now + 60_000 }); // 1-minute window
    } else {
      w.count += delta;
    }
  }
}
