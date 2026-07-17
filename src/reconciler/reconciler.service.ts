import { Injectable } from '@nestjs/common';
import type { V1Secret } from '@kubernetes/client-node';
import { K8sService } from '../k8s/k8s.service.js';
import { AppConfig } from '../common/config.js';
import { RegistryService } from '../registry/registry.service.js';
import { MetricsService } from '../metrics/metrics.service.js';
import { generateVirtualKey, hashKey } from '../common/key-utils.js';
import { GROUP, VERSION, type ProxyKey } from '../common/types.js';

const MANAGED_BY = 'llmproxy-operator';

@Injectable()
export class ReconcilerService {
  private queue = new Map<string, ProxyKey>();
  private running = false;

  constructor(
    private readonly k8s: K8sService,
    private readonly config: AppConfig,
    private readonly registry: RegistryService,
    private readonly metrics: MetricsService,
  ) {}

  enqueue(pk: ProxyKey): void {
    this.queue.set(`${pk.metadata!.namespace}/${pk.metadata!.name}`, pk);
    void this.drain();
  }

  handleDelete(pk: ProxyKey): void {
    this.registry.evictRouteByUid(pk.metadata!.uid!);
    this.queue.delete(`${pk.metadata!.namespace}/${pk.metadata!.name}`);
    this.refreshProxyKeyGauge();
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.size > 0) {
        const [key, pk] = this.queue.entries().next().value as [string, ProxyKey];
        this.queue.delete(key);
        try {
          await this.reconcile(pk);
        } catch (err) {
          console.error(`reconcile ${key} failed:`, err);
          await this.setStatus(pk, { ready: false, message: String(err) }).catch(() => {});
          setTimeout(() => this.enqueue(pk), 5000);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async reconcile(pk: ProxyKey): Promise<void> {
    const ns = pk.metadata!.namespace!;
    const name = pk.metadata!.name!;
    const uid = pk.metadata!.uid!;
    const secretName = `${name}-llmproxy`;
    // Group is always the ProxyKey's namespace — tenant can't override
    const groupRef = ns;
    const groupEntry = this.registry.getGroup(groupRef);
    if (!groupEntry) {
      await this.setStatus(pk, { ready: false, message: `group "${groupRef}" not found` });
      this.registry.evictRouteByUid(uid);
      return;
    }
    if ((groupEntry.group.spec.status ?? 'Enabled') !== 'Enabled') {
      await this.setStatus(pk, { ready: false, message: `group "${groupRef}" is disabled` });
      this.registry.evictRouteByUid(uid);
      return;
    }
    const groupChannels = this.registry.getGroupChannels(groupRef);
    if (groupChannels.length === 0) {
      await this.setStatus(pk, { ready: false, message: `group "${groupRef}" has no enabled channels` });
      this.registry.evictRouteByUid(uid);
      return;
    }
    const primaryChannel = groupChannels[0].channel.metadata!.name!;

    // Mint virtual key
    let keyHash = pk.status?.keyHash;
    let secret: V1Secret | undefined;
    try {
      secret = await this.k8s.readSecret(ns, secretName);
    } catch {}

    const secretKeyB64 = secret?.data?.LLMPROXY_KEY;
    const secretHash = secretKeyB64
      ? hashKey(Buffer.from(secretKeyB64, 'base64').toString('utf8'))
      : undefined;

    if (!secret || !secretHash || (keyHash && secretHash !== keyHash)) {
      const virtualKey = generateVirtualKey();
      keyHash = hashKey(virtualKey);
      const body = this.buildSecret(pk, secretName, virtualKey, primaryChannel, groupRef);
      await this.k8s.createOrReplaceSecret(ns, secretName, body);
      console.log(`minted key for ${ns}/${name} -> secret ${secretName} (group: ${groupRef})`);
      this.metrics.keysMintedTotal.inc({ channel: primaryChannel });
    } else if (!keyHash) {
      keyHash = secretHash;
    }

    this.registry.upsertRoute(uid, {
      keyHash,
      groupName: groupRef,
      namespace: ns,
      proxyKeyName: name,
      models: pk.spec.models?.length ? pk.spec.models : undefined,
    });

    if (pk.status?.keyHash !== keyHash || pk.status?.ready !== true || pk.status?.secretName !== secretName) {
      await this.setStatus(pk, { ready: true, message: 'Active', keyHash, secretName });
    }

    this.refreshProxyKeyGauge();
  }

  private refreshProxyKeyGauge(): void {
    const byChannel: Record<string, number> = {};
    for (const r of this.registry.getAllRoutes()) {
      const ch = r.groupName;
      byChannel[ch] = (byChannel[ch] ?? 0) + 1;
    }
    // Reset all, then set current
    for (const [channel, count] of Object.entries(byChannel)) {
      this.metrics.proxykeysActive.set({ channel }, count);
    }
  }

  private buildSecret(pk: ProxyKey, secretName: string, virtualKey: string, channel: string, groupRef: string): V1Secret {
    return {
      metadata: {
        name: secretName,
        namespace: pk.metadata!.namespace!,
        labels: { 'app.kubernetes.io/managed-by': MANAGED_BY },
        ownerReferences: [{
          apiVersion: `${GROUP}/${VERSION}`,
          kind: 'ProxyKey',
          name: pk.metadata!.name!,
          uid: pk.metadata!.uid!,
          controller: true,
          blockOwnerDeletion: false,
        }],
      },
      type: 'Opaque',
      stringData: {
        LLMPROXY_KEY: virtualKey,
        LLMPROXY_ENDPOINT: this.config.proxyURL,
        LLMPROXY_CHANNEL: channel,
        LLMPROXY_GROUP: groupRef,
      },
    };
  }

  private async setStatus(pk: ProxyKey, status: NonNullable<ProxyKey['status']>): Promise<void> {
    await this.k8s.patchProxyKeyStatus(pk.metadata!.namespace!, pk.metadata!.name!, status);
  }
}
