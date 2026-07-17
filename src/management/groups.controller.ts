import { Controller, Get, Post, Put, Delete, Param, Body, UseGuards } from '@nestjs/common';
import { K8sService } from '../k8s/k8s.service.js';
import { AppConfig } from '../common/config.js';
import { RegistryService } from '../registry/registry.service.js';
import { AdminAuthGuard } from '../auth/admin-auth.guard.js';
import { GROUP, VERSION, GROUP_PLURAL, type Group } from '../common/types.js';

@Controller('api/v1/groups')
@UseGuards(AdminAuthGuard)
export class GroupsController {
  constructor(
    private readonly k8s: K8sService,
    private readonly config: AppConfig,
    private readonly registry: RegistryService,
  ) {}

  @Get()
  list(): Group[] {
    return this.registry.getAllGroups().map((e) => e.group);
  }

  @Get(':name')
  get(@Param('name') name: string): Group | undefined {
    return this.registry.getGroup(name)?.group;
  }

  @Post()
  async create(@Body() body: Group): Promise<Group> {
    const ns = this.config.operatorNamespace;
    const created = await this.k8s.custom.createNamespacedCustomObject({
      group: GROUP, version: VERSION, namespace: ns, plural: GROUP_PLURAL, body,
    }) as Group;
    return created;
  }

  @Put(':name')
  async update(@Param('name') name: string, @Body() body: Group): Promise<Group> {
    const ns = this.config.operatorNamespace;
    const updated = await this.k8s.custom.replaceNamespacedCustomObject({
      group: GROUP, version: VERSION, namespace: ns, plural: GROUP_PLURAL, name, body,
    }) as Group;
    return updated;
  }

  @Delete(':name')
  async delete(@Param('name') name: string): Promise<void> {
    const ns = this.config.operatorNamespace;
    await this.k8s.custom.deleteNamespacedCustomObject({
      group: GROUP, version: VERSION, namespace: ns, plural: GROUP_PLURAL, name,
    });
  }
}
