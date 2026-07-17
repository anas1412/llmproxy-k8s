import { Injectable } from '@nestjs/common';
import { RegistryService } from '../registry/registry.service.js';
import type { ChannelEntry } from '../common/types.js';

/**
 * Priority-weighted random channel selection.
 *
 * Higher priority = more traffic. A channel with priority 20 gets 2× the
 * traffic of a channel with priority 10 (all else being equal).
 *
 * Only returns channels with status=Enabled and a resolved upstream key.
 */
@Injectable()
export class ChannelPickerService {
  constructor(private readonly registry: RegistryService) {}

  /** Pick a single channel, weighted by priority. Sorted for reproducibility. */
  pick(entries: ChannelEntry[]): ChannelEntry | undefined {
    const eligible = entries.filter(
      (e) => (e.channel.spec.status ?? 'Enabled') === 'Enabled' && e.upstreamKey,
    );
    if (eligible.length === 0) return undefined;
    if (eligible.length === 1) return eligible[0];

    // Sort by name for deterministic ordering
    eligible.sort((a, b) => a.channel.metadata!.name!.localeCompare(b.channel.metadata!.name!));

    const totalWeight = eligible.reduce((sum, e) => sum + (e.channel.spec.priority ?? 10), 0);
    let r = Math.random() * totalWeight;

    for (const entry of eligible) {
      r -= entry.channel.spec.priority ?? 10;
      if (r <= 0) return entry;
    }

    return eligible[eligible.length - 1];
  }

  /** Pick a channel scoped to a group's channelRefs, weighted by priority */
  pickFromGroup(groupName: string, model?: string): ChannelEntry | undefined {
    const groupChannels = this.registry.getGroupChannels(groupName);
    if (groupChannels.length === 0) return undefined;

    let entries = groupChannels;
    if (model) {
      entries = entries.filter((e) => {
        const models = e.channel.spec.models;
        if (!models || models.length === 0) return true;
        return models.includes(model);
      });
    }
    return this.pick(entries);
  }

  /** Pick a primary channel and return fallbacks (for retry) */
  pickWithFallbacks(model?: string): { primary: ChannelEntry | undefined; fallbacks: ChannelEntry[] } {
    let entries = this.registry.getEnabledChannels();

    // If model is specified, filter channels that can serve it
    if (model) {
      entries = entries.filter((e) => {
        const models = e.channel.spec.models;
        if (!models || models.length === 0) return true; // no restriction
        return models.includes(model);
      });
    }

    const primary = this.pick(entries);
    const fallbacks = primary ? entries.filter((e) => e !== primary) : [];

    return { primary, fallbacks };
  }
}
