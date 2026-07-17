import { Injectable, type OnModuleInit } from '@nestjs/common';
import { makeInformer, type KubernetesListObject } from '@kubernetes/client-node';
import { K8sService } from '../k8s/k8s.service.js';
import { AppConfig } from '../common/config.js';
import { RegistryService } from '../registry/registry.service.js';
import { GROUP, VERSION, GROUP_PLURAL, type Group } from '../common/types.js';

@Injectable()
export class GroupInformerService implements OnModuleInit {
  constructor(
    private readonly k8s: K8sService,
    private readonly config: AppConfig,
    private readonly registry: RegistryService,
  ) {}

  async onModuleInit(): Promise<void> {
    const ns = this.config.operatorNamespace;
    const path = `/apis/${GROUP}/${VERSION}/namespaces/${ns}/${GROUP_PLURAL}`;

    const informer = makeInformer<Group>(this.k8s.kubeConfig, path, () =>
      this.k8s.listGroups(ns) as Promise<KubernetesListObject<Group>>,
    );

    informer.on('add', (g: Group) => this.registry.upsertGroup(g));
    informer.on('update', (g: Group) => this.registry.upsertGroup(g));
    informer.on('delete', (g: Group) => this.registry.evictGroup(g.metadata!.name!));

    informer.on('error', (err: unknown) => {
      console.error(`group informer error, restarting in 5s:`, String(err));
      setTimeout(() => informer.start().catch(console.error), 5000);
    });

    await informer.start();
    console.log('group informer started');
  }
}
