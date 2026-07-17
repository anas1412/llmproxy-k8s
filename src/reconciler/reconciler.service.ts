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
    const secretName = `${name}-llmproxy`;

    const entry = this.registry.getChannel(pk.spec.channelRef);
    if (!entry) {
      await this.setStatus(pk, {
        ready: false,
        message: `channel "${pk.spec.channelRef}" not found`,
      });
      this.registry.evictRouteByUid(pk.metadata!.uid!);
      return;
    }

    const channelModels = entry.channel.spec.models;
    let models = pk.spec.models;
    if (models && channelModels?.length) {
      models = models.filter((m) => channelModels.includes(m));
    } else if (!models) {
      models = channelModels;
    }

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
      const body = this.buildSecret(pk, secretName, virtualKey);
      await this.k8s.createOrReplaceSecret(ns, secretName, body);
      console.log(`minted key for ${ns}/${name} -> secret ${secretName}`);
      this.metrics.keysMintedTotal.inc({ channel: pk.spec.channelRef });
    } else if (!keyHash) {
      keyHash = secretHash;
    }

    this.registry.upsertRoute(pk.metadata!.uid!, {
      keyHash,
      channelName: pk.spec.channelRef,
      namespace: ns,
      proxyKeyName: name,
      models: models?.length ? models : undefined,
    });

    if (pk.status?.keyHash !== keyHash || pk.status?.ready !== true || pk.status?.secretName !== secretName) {
      await this.setStatus(pk, { ready: true, message: 'Active', keyHash, secretName });
    }
  }

  private buildSecret(pk: ProxyKey, secretName: string, virtualKey: string): V1Secret {
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
        LLMPROXY_CHANNEL: pk.spec.channelRef,
      },
    };
  }

  private async setStatus(pk: ProxyKey, status: NonNullable<ProxyKey['status']>): Promise<void> {
    await this.k8s.patchProxyKeyStatus(pk.metadata!.namespace!, pk.metadata!.name!, status);
  }
}
