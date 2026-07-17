import { Module } from '@nestjs/common';
import { ChannelsController } from './channels.controller.js';
import { ProxyKeysController } from './proxykeys.controller.js';

@Module({
  controllers: [ChannelsController, ProxyKeysController],
})
export class ManagementModule {}
