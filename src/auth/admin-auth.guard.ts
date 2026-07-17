import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { AppConfig } from '../common/config.js';

@Injectable()
export class AdminAuthGuard implements CanActivate {
  constructor(private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const auth = req.headers.authorization;
    if (!auth) return false;
    const token = auth.replace(/^(Bearer |sk-)/, '');
    return token === this.config.adminKey;
  }
}
