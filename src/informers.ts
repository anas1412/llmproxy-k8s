import {
  CoreV1Api,
  CustomObjectsApi,
  KubeConfig,
  makeInformer,
  type KubernetesListObject,
  type V1Secret,
} from '@kubernetes/client-node';
import { config } from './config.js';
import { registry } from './registry.js';
import type { ProxyKeyReconciler } from './reconcile.js';
import { CHANNEL_PLURAL, GROUP, PROXYKEY_PLURAL, VERSION, type Channel, type ProxyKey } from './types.js';

function withRestart(name: string, informer: { start: () => Promise<void>; on: Function }): void {
  informer.on('error', (err: unknown) => {
    console.error(`${name} informer error, restarting in 5s:`, String(err));
    setTimeout(() => informer.start().catch(console.error), 5000);
  });
}

export async function startInformers(kc: KubeConfig, reconciler: ProxyKeyReconciler): Promise<void> {
  const core = kc.makeApiClient(CoreV1Api);
  const custom = kc.makeApiClient(CustomObjectsApi);
  const opNs = config.operatorNamespace;

  // --- Channels (operator namespace only) -----------------------------------
  const channelInformer = makeInformer<Channel>(
    kc,
    `/apis/${GROUP}/${VERSION}/namespaces/${opNs}/${CHANNEL_PLURAL}`,
    () =>
      custom.listNamespacedCustomObject({
        group: GROUP,
        version: VERSION,
        namespace: opNs,
        plural: CHANNEL_PLURAL,
      }) as Promise<KubernetesListObject<Channel>>,
  );

  const resolveChannel = async (ch: Channel) => {
    try {
      const ref = ch.spec.keySecretRef;
      const secret = await core.readNamespacedSecret({ name: ref.name, namespace: opNs });
      const b64 = secret.data?.[ref.key ?? 'apiKey'];
      const upstreamKey = b64 ? Buffer.from(b64, 'base64').toString('utf8') : undefined;
      registry.upsertChannel(ch, upstreamKey);
      if (!upstreamKey) console.warn(`channel ${ch.metadata!.name}: key "${ref.key ?? 'apiKey'}" missing in secret ${ref.name}`);
    } catch (err) {
      registry.upsertChannel(ch, undefined);
      console.error(`channel ${ch.metadata!.name}: cannot read upstream secret:`, String(err));
    }
  };

  channelInformer.on('add', (ch) => void resolveChannel(ch));
  channelInformer.on('update', (ch) => void resolveChannel(ch));
  channelInformer.on('delete', (ch) => registry.evictChannel(ch.metadata!.name!));
  withRestart('channel', channelInformer);

  // --- Provider secrets in operator ns: re-resolve channels on rotation -----
  const secretInformer = makeInformer<V1Secret>(
    kc,
    `/api/v1/namespaces/${opNs}/secrets`,
    () => core.listNamespacedSecret({ namespace: opNs }),
  );
  const onSecretChange = (s: V1Secret) => {
    for (const ch of channelInformer.list()) {
      if (ch.spec.keySecretRef.name === s.metadata?.name) void resolveChannel(ch);
    }
  };
  secretInformer.on('update', onSecretChange);
  secretInformer.on('add', onSecretChange);
  withRestart('secret', secretInformer);

  // --- ProxyKeys (all namespaces) --------------------------------------------
  const proxyKeyInformer = makeInformer<ProxyKey>(
    kc,
    `/apis/${GROUP}/${VERSION}/${PROXYKEY_PLURAL}`,
    () =>
      custom.listClusterCustomObject({
        group: GROUP,
        version: VERSION,
        plural: PROXYKEY_PLURAL,
      }) as Promise<KubernetesListObject<ProxyKey>>,
  );
  proxyKeyInformer.on('add', (pk) => reconciler.enqueue(pk));
  proxyKeyInformer.on('update', (pk) => reconciler.enqueue(pk));
  proxyKeyInformer.on('delete', (pk) => reconciler.handleDelete(pk));
  withRestart('proxykey', proxyKeyInformer);

  // Order matters: channels must be in the registry before proxykeys reconcile,
  // otherwise the first pass marks everything "channel not found".
  await channelInformer.start();
  await secretInformer.start();
  await proxyKeyInformer.start();
  console.log('informers started', registry.stats());
}
