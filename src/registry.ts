import type { Channel } from './types.js';

export interface Route {
  /** hex sha256 of the virtual key */
  keyHash: string;
  channelName: string;
  namespace: string; // tenant namespace, for logging/metrics
  proxyKeyName: string;
  models?: string[]; // effective allowlist
}

/**
 * The routing table is rebuilt purely from informer events — no persistence.
 * keyHash -> Route, channelName -> Channel (with resolved upstream key).
 */
class Registry {
  private routes = new Map<string, Route>();
  /** ProxyKey uid -> keyHash, so delete events can evict without recomputing */
  private byUid = new Map<string, string>();
  private channels = new Map<string, { channel: Channel; upstreamKey?: string }>();

  upsertRoute(uid: string, route: Route): void {
    const old = this.byUid.get(uid);
    if (old && old !== route.keyHash) this.routes.delete(old);
    this.byUid.set(uid, route.keyHash);
    this.routes.set(route.keyHash, route);
  }

  evictRouteByUid(uid: string): void {
    const hash = this.byUid.get(uid);
    if (hash) {
      this.routes.delete(hash);
      this.byUid.delete(uid);
    }
  }

  lookup(keyHash: string): Route | undefined {
    return this.routes.get(keyHash);
  }

  upsertChannel(channel: Channel, upstreamKey?: string): void {
    this.channels.set(channel.metadata!.name!, { channel, upstreamKey });
  }

  evictChannel(name: string): void {
    this.channels.delete(name);
  }

  getChannel(name: string): { channel: Channel; upstreamKey?: string } | undefined {
    return this.channels.get(name);
  }

  stats(): { routes: number; channels: number } {
    return { routes: this.routes.size, channels: this.channels.size };
  }
}

export const registry = new Registry();
