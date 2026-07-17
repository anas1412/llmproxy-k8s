import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { RegistryService } from '../registry/registry.service.js';
import { hashKey, hashesEqual } from '../common/key-utils.js';
import type { Route } from '../common/types.js';

/** Attached to the request by TokenAuthGuard on successful auth */
export interface AuthenticatedRequest extends Request {
  route: Route;
}

@Injectable()
export class TokenAuthGuard implements CanActivate {
  constructor(private readonly registry: RegistryService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const key = this.extractKey(req);
    if (!key) return false;

    const h = hashKey(key);
    const route = this.registry.lookup(h);
    if (!route) return false;

    // Attach route for downstream handlers
    (req as AuthenticatedRequest).route = route;
    return true;
  }

  private extractKey(req: Request): string | undefined {
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) return auth.slice(7);
    const xApiKey = req.headers['x-api-key'];
    return typeof xApiKey === 'string' ? xApiKey : undefined;
  }
}
