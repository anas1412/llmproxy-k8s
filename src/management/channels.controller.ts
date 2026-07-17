import { Controller, Get, Post, Put, Delete, Param, Body, UseGuards } from '@nestjs/common';
import { K8sService } from '../k8s/k8s.service.js';
import { AppConfig } from '../common/config.js';
import { RegistryService } from '../registry/registry.service.js';
import { AdminAuthGuard } from '../auth/admin-auth.guard.js';
import { GROUP, VERSION, CHANNEL_PLURAL, type Channel } from '../common/types.js';

@Controller('api/v1/channels')
@UseGuards(AdminAuthGuard)
export class ChannelsController {
  constructor(
    private readonly k8s: K8sService,
    private readonly config: AppConfig,
    private readonly registry: RegistryService,
  ) {}

  @Get()
  list(): Channel[] {
    return this.registry.getAllChannels().map((e) => e.channel);
  }

  @Get(':name')
  get(@Param('name') name: string): Channel | undefined {
    return this.registry.getChannel(name)?.channel;
  }

  @Post()
  async create(@Body() body: Channel): Promise<Channel> {
    const ns = this.config.operatorNamespace;
    const created = await this.k8s.custom.createNamespacedCustomObject({
      group: GROUP, version: VERSION, namespace: ns, plural: CHANNEL_PLURAL, body,
    }) as Channel;
    return created;
  }

  @Put(':name')
  async update(@Param('name') name: string, @Body() body: Channel): Promise<Channel> {
    const ns = this.config.operatorNamespace;
    const updated = await this.k8s.custom.replaceNamespacedCustomObject({
      group: GROUP, version: VERSION, namespace: ns, plural: CHANNEL_PLURAL, name, body,
    }) as Channel;
    return updated;
  }

  @Delete(':name')
  async delete(@Param('name') name: string): Promise<void> {
    const ns = this.config.operatorNamespace;
    await this.k8s.custom.deleteNamespacedCustomObject({
      group: GROUP, version: VERSION, namespace: ns, plural: CHANNEL_PLURAL, name,
    });
  }

  @Post(':name/test')
  async test(@Param('name') name: string): Promise<{ success: boolean; message: string }> {
    const entry = this.registry.getChannel(name);
    if (!entry) return { success: false, message: `channel "${name}" not found` };
    if (!entry.upstreamKey) return { success: false, message: `channel "${name}" has no resolved upstream key` };
    return { success: true, message: `channel "${name}" is available (${entry.channel.spec.type})` };
  }
}
