import { Injectable, type OnModuleInit } from '@nestjs/common';
import { makeInformer, type V1Secret } from '@kubernetes/client-node';
import { K8sService } from '../k8s/k8s.service.js';
import { AppConfig } from '../common/config.js';
import { RegistryService } from '../registry/registry.service.js';
import { ChannelInformerService } from './channel-informer.service.js';

/**
 * Watches Secrets in the operator namespace. When a Secret referenced by a
 * Channel is added or updated, re-resolves that channel's upstream key.
 */
@Injectable()
export class SecretInformerService implements OnModuleInit {
  constructor(
    private readonly k8s: K8sService,
    private readonly config: AppConfig,
    private readonly registry: RegistryService,
  ) {}

  async onModuleInit(): Promise<void> {
    const ns = this.config.operatorNamespace;
    const path = `/api/v1/namespaces/${ns}/secrets`;

    const informer = makeInformer<V1Secret>(this.k8s.kubeConfig, path, () =>
      this.k8s.core.listNamespacedSecret({ namespace: ns }),
    );

    const onSecretChange = async (s: V1Secret): Promise<void> => {
      const name = s.metadata?.name;
      if (!name) return;
      // Re-resolve any channel referencing this secret
      for (const entry of this.registry.getAllChannels()) {
        if (entry.channel.spec.keySecretRef.name === name) {
          const ref = entry.channel.spec.keySecretRef;
          try {
            const upstreamKey = await this.k8s.getSecretKey(ns, ref.name, ref.key ?? 'apiKey');
            this.registry.upsertChannel(entry.channel, upstreamKey);
          } catch (err) {
            this.registry.upsertChannel(entry.channel, undefined);
            console.error(`secret change: failed to re-resolve channel ${entry.channel.metadata!.name}:`, String(err));
          }
        }
      }
    };

    informer.on('add', (s: V1Secret) => void onSecretChange(s));
    informer.on('update', (s: V1Secret) => void onSecretChange(s));

    informer.on('error', (err: unknown) => {
      console.error(`secret informer error, restarting in 5s:`, String(err));
      setTimeout(() => informer.start().catch(console.error), 5000);
    });

    await informer.start();
    console.log('secret informer started');
  }
}
