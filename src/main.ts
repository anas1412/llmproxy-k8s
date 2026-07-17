import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { type INestApplication } from '@nestjs/common';
import express, { type Request, type Response } from 'express';

import { AppModule } from './app.module.js';
import { AppConfig } from './common/config.js';
import { RegistryService } from './registry/registry.service.js';
import { MetricsService } from './metrics/metrics.service.js';

async function bootstrap(): Promise<void> {
  // ---- Proxy application (port 8000) ---------------------------------------
  const app = await NestFactory.create(AppModule);
  const config = app.get(AppConfig);

  await app.listen(config.proxyPort);
  console.log(`proxy listening on :${config.proxyPort}`);

  // ---- Health + Metrics application (port 8081) — lightweight Express -----
  await startHealthServer(app);
}

async function startHealthServer(app: INestApplication): Promise<void> {
  const config = app.get(AppConfig);
  const registry = app.get(RegistryService);
  const metrics = app.get(MetricsService);

  const health = express();

  health.get('/healthz', (_req: Request, res: Response) => {
    res.json({ ok: true, ...registry.stats() });
  });

  health.get('/readyz', (_req: Request, res: Response) => {
    res.json({ ok: true, ...registry.stats() });
  });

  health.get('/metrics', async (_req: Request, res: Response) => {
    res.set('Content-Type', metrics.contentType());
    res.end(await metrics.registry());
  });

  health.listen(config.healthPort, () => {
    console.log(`health + metrics on :${config.healthPort}`);
  });
}

void bootstrap();
