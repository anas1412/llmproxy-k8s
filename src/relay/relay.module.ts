import { Module } from '@nestjs/common';
import { RelayController } from './relay.controller.js';
import { RelayService } from './relay.service.js';
import { ChannelPickerService } from './channel-picker.service.js';
import { RateLimiterService } from './rate-limiter.service.js';

@Module({
  controllers: [RelayController],
  providers: [RelayService, ChannelPickerService, RateLimiterService],
})
export class RelayModule {}
