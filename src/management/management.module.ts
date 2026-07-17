import { Module } from '@nestjs/common';
import { ChannelsController } from './channels.controller.js';
import { ProxyKeysController } from './proxykeys.controller.js';
import { GroupsController } from './groups.controller.js';

@Module({
  controllers: [ChannelsController, ProxyKeysController, GroupsController],
})
export class ManagementModule {}
