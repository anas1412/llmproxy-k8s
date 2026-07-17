import { Injectable, type OnModuleInit } from '@nestjs/common';
import { makeInformer, type KubernetesListObject } from '@kubernetes/client-node';
import { K8sService } from '../k8s/k8s.service.js';
import { ReconcilerService } from '../reconciler/reconciler.service.js';
import { GROUP, VERSION, PROXYKEY_PLURAL, type ProxyKey } from '../common/types.js';

@Injectable()
export class ProxyKeyInformerService implements OnModuleInit {
  constructor(
    private readonly k8s: K8sService,
    private readonly reconciler: ReconcilerService,
  ) {}

  async onModuleInit(): Promise<void> {
    const path = `/apis/${GROUP}/${VERSION}/${PROXYKEY_PLURAL}`;

    const informer = makeInformer<ProxyKey>(this.k8s.kubeConfig, path, () =>
      this.k8s.listProxyKeys() as Promise<KubernetesListObject<ProxyKey>>,
    );

    informer.on('add', (pk: ProxyKey) => this.reconciler.enqueue(pk));
    informer.on('update', (pk: ProxyKey) => this.reconciler.enqueue(pk));
    informer.on('delete', (pk: ProxyKey) => this.reconciler.handleDelete(pk));

    informer.on('error', (err: unknown) => {
      console.error(`proxykey informer error, restarting in 5s:`, String(err));
      setTimeout(() => informer.start().catch(console.error), 5000);
    });

    await informer.start();
    console.log('proxykey informer started');
  }
}
