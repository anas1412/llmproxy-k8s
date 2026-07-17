import { Injectable } from '@nestjs/common';

@Injectable()
export class AppConfig {
  /** Namespace where Channel CRDs and provider Secrets live */
  readonly operatorNamespace: string;

  /** URL tenants use to reach this proxy (injected into tenant Secrets) */
  readonly proxyURL: string;

  /** Port the LLM proxy listens on */
  readonly proxyPort: number;

  /** Port for health checks and metrics */
  readonly healthPort: number;

  /** Admin API key for management endpoints. Reads from ADMIN_KEY env var. */
  readonly adminKey: string;

  constructor() {
    this.operatorNamespace = process.env.OPERATOR_NAMESPACE ?? 'llmproxy-system';
    this.proxyURL = process.env.PROXY_URL ?? 'http://llmproxy.llmproxy-system.svc.cluster.local:8000';
    this.proxyPort = Number(process.env.PROXY_PORT ?? 8000);
    this.healthPort = Number(process.env.HEALTH_PORT ?? 8081);
    this.adminKey = process.env.ADMIN_KEY ?? 'admin-change-me';
  }
}
