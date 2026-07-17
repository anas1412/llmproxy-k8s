import { Injectable } from '@nestjs/common';
import type { Channel } from '../common/types.js';
import type { Route, ChannelEntry } from '../common/types.js';

/**
 * In-memory routing table built entirely from informer events.
 * No persistence — rebuilt on restart via informer initial lists.
 *
 * Two maps:
 *   keyHash → Route        (for auth lookups on every request)
 *   channelName → ChannelEntry  (for channel metadata + resolved upstream key)
 */
@Injectable()
export class RegistryService {
  private routes = new Map<string, Route>();
  private byUid = new Map<string, string>(); // ProxyKey uid → keyHash
  private channels = new Map<string, ChannelEntry>();

  // -- Route management (ProxyKey lifecycle) ---------------------------------

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

  /** Look up a route by hashed virtual key — called on every request */
  lookup(keyHash: string): Route | undefined {
    return this.routes.get(keyHash);
  }

  // -- Channel management ----------------------------------------------------

  upsertChannel(channel: Channel, upstreamKey?: string): void {
    this.channels.set(channel.metadata!.name!, { channel, upstreamKey });
  }

  evictChannel(name: string): void {
    this.channels.delete(name);
  }

  getChannel(name: string): ChannelEntry | undefined {
    return this.channels.get(name);
  }

  /** All channels with resolved keys — for channel picker */
  getAllChannels(): ChannelEntry[] {
    return [...this.channels.values()];
  }

  /** All enabled channels with resolved keys */
  getEnabledChannels(): ChannelEntry[] {
    return this.getAllChannels().filter(
      (e) => (e.channel.spec.status ?? 'Enabled') === 'Enabled' && e.upstreamKey,
    );
  }

  // -- Stats for health/metrics -----------------------------------------------

  stats(): { routes: number; channels: number } {
    return { routes: this.routes.size, channels: this.channels.size };
  }
}
