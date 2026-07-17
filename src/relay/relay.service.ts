import { Injectable } from '@nestjs/common';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { RegistryService } from '../registry/registry.service.js';
import { ChannelPickerService } from './channel-picker.service.js';
import { RateLimiterService } from './rate-limiter.service.js';
import { MetricsService } from '../metrics/metrics.service.js';
import { buildPassthroughHeaders, buildPassthroughURL, extractModelFromBody } from './adaptors/passthrough.adaptor.js';
import { convertOpenAIToAnthropic, buildAnthropicURL } from './adaptors/anthropic.adaptor.js';
import type { Route } from '../common/types.js';
import type { Channel } from '../common/types.js';

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length',
  'authorization', 'x-api-key',
]);

export interface RelayResult {
  statusCode: number;
  success: boolean;
  channel: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  ttfbMs: number;
  errorType?: string;
  retries: number;
}

@Injectable()
export class RelayService {
  constructor(
    private readonly registry: RegistryService,
    private readonly channelPicker: ChannelPickerService,
    private readonly rateLimiter: RateLimiterService,
    private readonly metrics: MetricsService,
  ) {}

  getModels(): Array<{ id: string; object: string; created: number; owned_by: string }> {
    const models: Array<{ id: string; object: string; created: number; owned_by: string }> = [];
    const seen = new Set<string>();
    for (const entry of this.registry.getAllChannels()) {
      if ((entry.channel.spec.status ?? 'Enabled') !== 'Enabled') continue;
      const channelModels = entry.channel.spec.models;
      if (channelModels && channelModels.length > 0) {
        for (const m of channelModels) {
          if (!seen.has(m)) {
            seen.add(m);
            models.push({ id: m, object: 'model', created: 0, owned_by: entry.channel.spec.type });
          }
        }
      }
    }
    return models;
  }

  async relayChatCompletion(
    route: Route,
    body: Buffer,
    originalHeaders: Record<string, string | string[]>,
    res: any,
  ): Promise<RelayResult> {
    const startTime = Date.now();
    const model = extractModelFromBody(body) ?? 'unknown';

    const entry = this.registry.getChannel(route.channelName);
    if (!entry?.upstreamKey) {
      return { statusCode: 503, success: false, channel: route.channelName, model,
        inputTokens: 0, outputTokens: 0, latencyMs: 0, ttfbMs: 0, errorType: 'channel_unavailable', retries: 0 };
    }

    const pkKey = `${route.namespace}/${route.proxyKeyName}`;
    if (!this.rateLimiter.checkRPM(pkKey, 0)) {
      return { statusCode: 429, success: false, channel: route.channelName, model,
        inputTokens: 0, outputTokens: 0, latencyMs: 0, ttfbMs: 0, errorType: 'rate_limit', retries: 0 };
    }

    const fallbacks = this.registry.getEnabledChannels()
      .filter((e) => e.channel.metadata!.name !== route.channelName);

    const channels = [entry, ...fallbacks];
    let lastResult: RelayResult | null = null;

    for (let i = 0; i < Math.min(channels.length, 3); i++) {
      const ch = channels[i];
      const result = await this.tryChannel(ch.channel, ch.upstreamKey!, route, body, originalHeaders, res, startTime);
      if (result.success) {
        this.recordMetrics(route, result);
        return { ...result, retries: i };
      }
      lastResult = result;
      if (result.statusCode !== 429 && result.statusCode < 500) break;
    }

    const final = lastResult ?? { statusCode: 502, success: false, channel: route.channelName, model,
      inputTokens: 0, outputTokens: 0, latencyMs: Date.now() - startTime, ttfbMs: 0, errorType: 'all_channels_failed', retries: 0 };
    this.recordMetrics(route, final);
    return final;
  }

  private tryChannel(
    channel: Channel, upstreamKey: string, route: Route,
    body: Buffer, originalHeaders: Record<string, string | string[]>,
    res: any, startTime: number,
  ): Promise<RelayResult> {
    const model = extractModelFromBody(body) ?? 'unknown';
    let ttfbMs = 0, firstByte = true;

    return new Promise((resolve) => {
      try {
        let upstreamURL: URL;
        let upstreamBody: Buffer;
        let upstreamHeaders: Record<string, string | string[]>;

        if (channel.spec.type === 'anthropic') {
          const adapted = convertOpenAIToAnthropic(body);
          if (!adapted) {
            resolve({ statusCode: 400, success: false, channel: channel.metadata!.name!, model,
              inputTokens: 0, outputTokens: 0, latencyMs: Date.now() - startTime, ttfbMs: 0, errorType: 'bad_request', retries: 0 });
            return;
          }
          upstreamURL = buildAnthropicURL(channel);
          upstreamBody = Buffer.from(adapted.body);
          upstreamHeaders = this.stripHeaders(originalHeaders);
          upstreamHeaders['x-api-key'] = upstreamKey;
          upstreamHeaders['anthropic-version'] = '2023-06-01';
          upstreamHeaders['content-type'] = 'application/json';
        } else {
          upstreamURL = buildPassthroughURL(channel, '/v1/chat/completions');
          upstreamBody = body;
          upstreamHeaders = buildPassthroughHeaders({
            channel, upstreamKey, body, headers: this.stripHeaders(originalHeaders),
            path: '/v1/chat/completions',
          });
        }

        upstreamHeaders['content-length'] = String(upstreamBody.length);

        const doRequest = upstreamURL.protocol === 'https:' ? httpsRequest : httpRequest;
        const proxied = doRequest(
          upstreamURL,
          { method: 'POST', headers: upstreamHeaders, timeout: 600_000 },
          (upRes: IncomingMessage) => {
            if (firstByte) { ttfbMs = Date.now() - startTime; firstByte = false; }

            const isStream = upRes.headers?.['content-type']?.includes('text/event-stream') ?? false;

            if (!isStream) {
              const chunks: Buffer[] = [];
              upRes.on('data', (chunk: Buffer) => chunks.push(chunk));
              upRes.on('end', () => {
                const responseBody = Buffer.concat(chunks).toString('utf8');
                res.writeHead(upRes.statusCode ?? 502, upRes.headers);
                res.end(responseBody);
                const usage = this.extractUsage(responseBody);
                resolve({
                  statusCode: upRes.statusCode ?? 502,
                  success: (upRes.statusCode ?? 502) < 400,
                  channel: channel.metadata!.name!, model,
                  inputTokens: usage?.input ?? 0, outputTokens: usage?.output ?? 0,
                  latencyMs: Date.now() - startTime, ttfbMs, retries: 0,
                });
              });
            } else {
              res.writeHead(upRes.statusCode ?? 502, upRes.headers);
              upRes.pipe(res);
              upRes.on('end', () => {
                resolve({
                  statusCode: upRes.statusCode ?? 502,
                  success: (upRes.statusCode ?? 502) < 400,
                  channel: channel.metadata!.name!, model,
                  inputTokens: 0, outputTokens: 0, latencyMs: Date.now() - startTime, ttfbMs, retries: 0,
                });
              });
            }
          },
        );

        proxied.on('timeout', () => {
          proxied.destroy(new Error('upstream timeout'));
          resolve({ statusCode: 504, success: false, channel: channel.metadata!.name!, model,
            inputTokens: 0, outputTokens: 0, latencyMs: Date.now() - startTime, ttfbMs, errorType: 'upstream_timeout', retries: 0 });
        });

        proxied.on('error', (err: Error) => {
          console.error(`upstream error [${route.namespace}/${route.proxyKeyName} -> ${channel.metadata!.name}]:`, err.message);
          resolve({ statusCode: 502, success: false, channel: channel.metadata!.name!, model,
            inputTokens: 0, outputTokens: 0, latencyMs: Date.now() - startTime, ttfbMs, errorType: 'upstream_error', retries: 0 });
        });

        res.on('close', () => proxied.destroy());
        proxied.end(upstreamBody);
      } catch (err) {
        resolve({ statusCode: 500, success: false, channel: channel.metadata!.name!, model,
          inputTokens: 0, outputTokens: 0, latencyMs: Date.now() - startTime, ttfbMs, errorType: 'internal_error', retries: 0 });
      }
    });
  }

  private stripHeaders(headers: Record<string, string | string[]>): Record<string, string | string[]> {
    const out: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(headers)) {
      if (v !== undefined && !HOP_BY_HOP.has(k)) out[k] = v;
    }
    return out;
  }

  private extractUsage(body: string): { input: number; output: number; total: number } | null {
    try {
      const parsed = JSON.parse(body);
      if (parsed.usage) {
        return {
          input: parsed.usage.prompt_tokens ?? parsed.usage.input_tokens ?? 0,
          output: parsed.usage.completion_tokens ?? parsed.usage.output_tokens ?? 0,
          total: parsed.usage.total_tokens ?? 0,
        };
      }
    } catch {}
    return null;
  }

  private recordMetrics(route: Route, result: RelayResult): void {
    const labels = { channel: result.channel, model: result.model };
    const fullLabels = { ...labels, proxykey_ns: route.namespace, proxykey_name: route.proxyKeyName };

    this.metrics.requestsTotal.inc({ ...fullLabels, status_code: String(result.statusCode) });
    if (result.inputTokens > 0) this.metrics.tokensTotal.inc({ ...labels, type: 'input' }, result.inputTokens);
    if (result.outputTokens > 0) this.metrics.tokensTotal.inc({ ...labels, type: 'output' }, result.outputTokens);
    this.metrics.requestDuration.observe(labels, result.latencyMs / 1000);
    if (result.ttfbMs > 0) this.metrics.ttfb.observe(labels, result.ttfbMs / 1000);
    if (result.errorType) this.metrics.errorsTotal.inc({ ...labels, error_type: result.errorType });
    if (result.retries > 0) this.metrics.retriesTotal.inc({ channel: result.channel }, result.retries);
  }
}
