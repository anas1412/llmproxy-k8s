import { Controller, Get, Post, Delete, Param, Body, UseGuards } from '@nestjs/common';
import { K8sService } from '../k8s/k8s.service.js';
import { ReconcilerService } from '../reconciler/reconciler.service.js';
import { RegistryService } from '../registry/registry.service.js';
import { AdminAuthGuard } from '../auth/admin-auth.guard.js';
import { GROUP, VERSION, PROXYKEY_PLURAL, type ProxyKey } from '../common/types.js';

@Controller('api/v1/proxykeys')
@UseGuards(AdminAuthGuard)
export class ProxyKeysController {
  constructor(
    private readonly k8s: K8sService,
    private readonly reconciler: ReconcilerService,
    private readonly registry: RegistryService,
  ) {}

  @Get()
  list(): Array<{ namespace: string; name: string; groupRef: string }> {
    return this.registry.getAllRoutes().map((r) => ({
      namespace: r.namespace,
      name: r.proxyKeyName,
      groupRef: r.groupName,
    }));
  }

  @Get(':ns/:name')
  async get(@Param('ns') ns: string, @Param('name') name: string): Promise<ProxyKey | null> {
    try {
      const resp = await this.k8s.custom.getNamespacedCustomObject({
        group: GROUP, version: VERSION, namespace: ns, plural: PROXYKEY_PLURAL, name,
      });
      return resp.body as ProxyKey;
    } catch {
      return null;
    }
  }

  @Post()
  async create(@Body() body: ProxyKey): Promise<ProxyKey> {
    const ns = body.metadata!.namespace!;
    const created = await this.k8s.custom.createNamespacedCustomObject({
      group: GROUP, version: VERSION, namespace: ns, plural: PROXYKEY_PLURAL, body,
    }) as ProxyKey;
    return created;
  }

  @Delete(':ns/:name')
  async delete(@Param('ns') ns: string, @Param('name') name: string): Promise<void> {
    await this.k8s.custom.deleteNamespacedCustomObject({
      group: GROUP, version: VERSION, namespace: ns, plural: PROXYKEY_PLURAL, name,
    });
  }
}
