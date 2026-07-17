import {
  CoreV1Api,
  CustomObjectsApi,
  KubeConfig,
  PatchStrategy,
  setHeaderOptions,
  V1Secret,
} from '@kubernetes/client-node';
import { config, generateVirtualKey, hashKey } from './config.js';
import { registry } from './registry.js';
import { GROUP, PROXYKEY_PLURAL, VERSION, type ProxyKey } from './types.js';

const MANAGED_BY = 'llmproxy-operator';

export class ProxyKeyReconciler {
  private core: CoreV1Api;
  private custom: CustomObjectsApi;
  /** naive workqueue: serialize reconciles per object, dedupe bursts */
  private queue = new Map<string, ProxyKey>();
  private running = false;

  constructor(kc: KubeConfig) {
    this.core = kc.makeApiClient(CoreV1Api);
    this.custom = kc.makeApiClient(CustomObjectsApi);
  }

  enqueue(pk: ProxyKey): void {
    this.queue.set(`${pk.metadata!.namespace}/${pk.metadata!.name}`, pk);
    void this.drain();
  }

  handleDelete(pk: ProxyKey): void {
    // Secret is garbage-collected via ownerReference; just evict the route.
    registry.evictRouteByUid(pk.metadata!.uid!);
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
          // requeue with backoff
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

    // 1. Validate the referenced channel
    const entry = registry.getChannel(pk.spec.channelRef);
    if (!entry) {
      await this.setStatus(pk, {
        ready: false,
        message: `channel "${pk.spec.channelRef}" not found in ${config.operatorNamespace}`,
      });
      registry.evictRouteByUid(pk.metadata!.uid!);
      return;
    }

    // Effective model allowlist = spec.models ∩ channel.models (if both set)
    const channelModels = entry.channel.spec.models;
    let models = pk.spec.models;
    if (models && channelModels?.length) {
      models = models.filter((m) => channelModels.includes(m));
    } else if (!models) {
      models = channelModels;
    }

    // 2. Ensure the tenant Secret exists and matches status.keyHash
    let keyHash = pk.status?.keyHash;
    let secret: V1Secret | undefined;
    try {
      secret = await this.core.readNamespacedSecret({ name: secretName, namespace: ns });
    } catch {
      secret = undefined;
    }

    const secretKeyB64 = secret?.data?.LLMPROXY_KEY;
    const secretHash = secretKeyB64
      ? hashKey(Buffer.from(secretKeyB64, 'base64').toString('utf8'))
      : undefined;

    if (!secret || !secretHash || (keyHash && secretHash !== keyHash)) {
      // Secret missing or tampered → mint a fresh key (old one is unrecoverable by design)
      const virtualKey = generateVirtualKey();
      keyHash = hashKey(virtualKey);
      const body = this.buildSecret(pk, secretName, virtualKey);
      if (secret) {
        await this.core.replaceNamespacedSecret({ name: secretName, namespace: ns, body });
      } else {
        await this.core.createNamespacedSecret({ namespace: ns, body });
      }
      console.log(`minted key for ${ns}/${name} -> secret ${secretName}`);
    } else if (!keyHash) {
      // Secret exists (e.g. operator restarted mid-flight) but status was never written
      keyHash = secretHash;
    }

    // 3. Publish route + status
    registry.upsertRoute(pk.metadata!.uid!, {
      keyHash,
      channelName: pk.spec.channelRef,
      namespace: ns,
      proxyKeyName: name,
      models: models?.length ? models : undefined,
    });

    if (
      pk.status?.keyHash !== keyHash ||
      pk.status?.ready !== true ||
      pk.status?.secretName !== secretName
    ) {
      await this.setStatus(pk, { ready: true, message: 'Active', keyHash, secretName });
    }
  }

  private buildSecret(pk: ProxyKey, secretName: string, virtualKey: string): V1Secret {
    return {
      metadata: {
        name: secretName,
        namespace: pk.metadata!.namespace!,
        labels: { 'app.kubernetes.io/managed-by': MANAGED_BY },
        ownerReferences: [
          {
            apiVersion: `${GROUP}/${VERSION}`,
            kind: 'ProxyKey',
            name: pk.metadata!.name!,
            uid: pk.metadata!.uid!,
            controller: true,
            blockOwnerDeletion: false,
          },
        ],
      },
      type: 'Opaque',
      stringData: {
        LLMPROXY_KEY: virtualKey,
        LLMPROXY_ENDPOINT: config.proxyURL,
        LLMPROXY_CHANNEL: pk.spec.channelRef,
      },
    };
  }

  private async setStatus(pk: ProxyKey, status: NonNullable<ProxyKey['status']>): Promise<void> {
    await this.custom.patchNamespacedCustomObjectStatus(
      {
        group: GROUP,
        version: VERSION,
        namespace: pk.metadata!.namespace!,
        plural: PROXYKEY_PLURAL,
        name: pk.metadata!.name!,
        body: { status },
      },
      setHeaderOptions('Content-Type', PatchStrategy.MergePatch),
    );
  }
}
