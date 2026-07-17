import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { config, hashKey } from './config.js';
import { registry } from './registry.js';

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length',
  'authorization', 'x-api-key', // credentials never pass through
]);

function deny(res: ServerResponse, code: number, message: string): void {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { type: 'proxy_error', message } }));
}

function extractKey(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  const xApiKey = req.headers['x-api-key'];
  return typeof xApiKey === 'string' ? xApiKey : undefined;
}

async function readBody(req: IncomingMessage, limit = 20 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export function startProxy(): void {
  const server = createServer(async (req, res) => {
    try {
      // 1. Authenticate the virtual key
      const key = extractKey(req);
      if (!key) return deny(res, 401, 'missing bearer token or x-api-key');
      const route = registry.lookup(hashKey(key));
      if (!route) return deny(res, 401, 'invalid API key');

      const entry = registry.getChannel(route.channelName);
      if (!entry?.upstreamKey) {
        return deny(res, 503, `channel "${route.channelName}" unavailable`);
      }
      const { channel, upstreamKey } = entry;

      // 2. Buffer body to enforce the model allowlist (chat requests are small;
      //    the RESPONSE is streamed untouched, which is what matters for SSE)
      const body = await readBody(req);
      if (route.models && body.length > 0) {
        let model: string | undefined;
        try { model = (JSON.parse(body.toString('utf8')) as { model?: string }).model; } catch { /* non-JSON */ }
        if (model && !route.models.includes(model)) {
          return deny(res, 403, `model "${model}" not allowed for this key`);
        }
      }

      // 3. Forward upstream with real credentials
      const upstream = new URL(req.url ?? '/', channel.spec.baseURL);
      const headers: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (v !== undefined && !HOP_BY_HOP.has(k)) headers[k] = v;
      }
      headers['content-length'] = String(body.length);
      if (channel.spec.type === 'anthropic') headers['x-api-key'] = upstreamKey;
      else headers['authorization'] = `Bearer ${upstreamKey}`;

      const doRequest = upstream.protocol === 'https:' ? httpsRequest : httpRequest;
      const proxied = doRequest(
        upstream,
        { method: req.method, headers, timeout: 600_000 },
        (upRes) => {
          res.writeHead(upRes.statusCode ?? 502, upRes.headers);
          upRes.pipe(res); // streams SSE token-by-token
        },
      );
      proxied.on('timeout', () => proxied.destroy(new Error('upstream timeout')));
      proxied.on('error', (err) => {
        console.error(`upstream error [${route.namespace}/${route.proxyKeyName}]:`, err.message);
        if (!res.headersSent) deny(res, 502, 'upstream request failed');
        else res.destroy();
      });
      res.on('close', () => proxied.destroy()); // client hung up → cancel upstream
      proxied.end(body);
    } catch (err) {
      console.error('proxy error:', err);
      if (!res.headersSent) deny(res, 500, 'internal proxy error');
    }
  });

  server.listen(config.proxyPort, () => console.log(`proxy listening on :${config.proxyPort}`));

  createServer((req, res) => {
    if (req.url === '/healthz' || req.url === '/readyz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...registry.stats() }));
    } else {
      res.writeHead(404).end();
    }
  }).listen(config.healthPort, () => console.log(`health on :${config.healthPort}`));
}
