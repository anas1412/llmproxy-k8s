import { Injectable, type OnModuleInit } from '@nestjs/common';
import { makeInformer, type KubernetesListObject } from '@kubernetes/client-node';
import { K8sService } from '../k8s/k8s.service.js';
import { AppConfig } from '../common/config.js';
import { RegistryService } from '../registry/registry.service.js';
import { GROUP, VERSION, CHANNEL_PLURAL, type Channel } from '../common/types.js';

@Injectable()
export class ChannelInformerService implements OnModuleInit {
  constructor(
    private readonly k8s: K8sService,
    private readonly config: AppConfig,
    private readonly registry: RegistryService,
  ) {}

  async onModuleInit(): Promise<void> {
    const ns = this.config.operatorNamespace;
    const path = `/apis/${GROUP}/${VERSION}/namespaces/${ns}/${CHANNEL_PLURAL}`;

    const informer = makeInformer<Channel>(this.k8s.kubeConfig, path, () =>
      this.k8s.listChannels(ns) as Promise<KubernetesListObject<Channel>>,
    );

    informer.on('add', (ch: Channel) => void this.resolve(ch));
    informer.on('update', (ch: Channel) => void this.resolve(ch));
    informer.on('delete', (ch: Channel) => this.registry.evictChannel(ch.metadata!.name!));

    informer.on('error', (err: unknown) => {
      console.error(`channel informer error, restarting in 5s:`, String(err));
      setTimeout(() => informer.start().catch(console.error), 5000);
    });

    await informer.start();
    console.log('channel informer started');
  }

  private async resolve(ch: Channel): Promise<void> {
    try {
      const ref = ch.spec.keySecretRef;
      const upstreamKey = await this.k8s.getSecretKey(
        this.config.operatorNamespace,
        ref.name,
        ref.key ?? 'apiKey',
      );
      this.registry.upsertChannel(ch, upstreamKey);
      if (!upstreamKey) {
        console.warn(`channel ${ch.metadata!.name}: key "${ref.key ?? 'apiKey'}" missing in secret ${ref.name}`);
      }
    } catch (err) {
      this.registry.upsertChannel(ch, undefined);
      console.error(`channel ${ch.metadata!.name}: cannot read upstream secret:`, String(err));
    }
  }
}
