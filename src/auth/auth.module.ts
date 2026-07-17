import { Global, Module } from '@nestjs/common';
import { TokenAuthGuard } from './token-auth.guard.js';
import { AdminAuthGuard } from './admin-auth.guard.js';

@Global()
@Module({
  providers: [TokenAuthGuard, AdminAuthGuard],
  exports: [TokenAuthGuard, AdminAuthGuard],
})
export class AuthModule {}
