import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  KubeConfig,
  CoreV1Api,
  CustomObjectsApi,
  Watch,
  PatchStrategy,
  setHeaderOptions,
  type KubernetesListObject,
  type V1Secret,
} from '@kubernetes/client-node';
import {
  GROUP,
  VERSION,
  CHANNEL_PLURAL,
  PROXYKEY_PLURAL,
  GROUP_PLURAL,
  type Channel,
  type ProxyKey,
  type Group,
} from '../common/types.js';

@Injectable()
export class K8sService implements OnModuleInit {
  private kc!: KubeConfig;
  private _core!: CoreV1Api;
  private _custom!: CustomObjectsApi;
  private _watch!: Watch;

  onModuleInit(): void {
    this.kc = new KubeConfig();
    try {
      this.kc.loadFromCluster();
    } catch {
      this.kc.loadFromDefault();
    }
    this._core = this.kc.makeApiClient(CoreV1Api);
    this._custom = this.kc.makeApiClient(CustomObjectsApi);
    this._watch = new Watch(this.kc);
  }

  get core(): CoreV1Api { return this._core; }
  get custom(): CustomObjectsApi { return this._custom; }
  get watch(): Watch { return this._watch; }
  get kubeConfig(): KubeConfig { return this.kc; }

  listChannels(ns: string): Promise<KubernetesListObject<Channel>> {
    return this._custom.listNamespacedCustomObject({
      group: GROUP, version: VERSION, namespace: ns, plural: CHANNEL_PLURAL,
    }) as Promise<KubernetesListObject<Channel>>;
  }

  listProxyKeys(): Promise<KubernetesListObject<ProxyKey>> {
    return this._custom.listClusterCustomObject({
      group: GROUP, version: VERSION, plural: PROXYKEY_PLURAL,
    }) as Promise<KubernetesListObject<ProxyKey>>;
  }

  listGroups(ns: string): Promise<KubernetesListObject<Group>> {
    return this._custom.listNamespacedCustomObject({
      group: GROUP, version: VERSION, namespace: ns, plural: GROUP_PLURAL,
    }) as Promise<KubernetesListObject<Group>>;
  }

  async patchGroupStatus(ns: string, name: string, status: NonNullable<Group['status']>): Promise<void> {
    await this._custom.patchNamespacedCustomObjectStatus(
      { group: GROUP, version: VERSION, namespace: ns, plural: GROUP_PLURAL, name, body: { status } },
      setHeaderOptions('Content-Type', PatchStrategy.MergePatch),
    ) as unknown as Promise<void>;
  }

  async patchProxyKeyStatus(ns: string, name: string, status: NonNullable<ProxyKey['status']>): Promise<void> {
    await this._custom.patchNamespacedCustomObjectStatus(
      { group: GROUP, version: VERSION, namespace: ns, plural: PROXYKEY_PLURAL, name, body: { status } },
      setHeaderOptions('Content-Type', PatchStrategy.MergePatch),
    ) as unknown as Promise<void>;
  }

  async readSecret(ns: string, name: string): Promise<V1Secret> {
    const resp = await this._core.readNamespacedSecret({ name, namespace: ns });
    return (resp as any).body as V1Secret;
  }

  async getSecretKey(ns: string, name: string, key: string): Promise<string | undefined> {
    try {
      const secret = await this.readSecret(ns, name);
      const b64 = secret.data?.[key];
      return b64 ? Buffer.from(b64, 'base64').toString('utf8') : undefined;
    } catch {
      return undefined;
    }
  }

  async createOrReplaceSecret(ns: string, name: string, body: V1Secret): Promise<void> {
    try {
      await this._core.replaceNamespacedSecret({ name, namespace: ns, body });
    } catch {
      await this._core.createNamespacedSecret({ namespace: ns, body });
    }
  }
}
