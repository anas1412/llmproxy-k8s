# llmproxy

A lightweight Kubernetes-native LLM proxy — give your tenants API keys that forward to your LLM providers. No database, no Redis. Just CRDs and Secrets.

## How it works

1. **You** create a `Channel` CRD in the operator namespace with your real provider API key
2. **Your tenants** create `ProxyKey` CRDs in their own namespaces
3. **llmproxy** mints a virtual API key for each ProxyKey, stores it in a tenant Secret, and starts proxying requests

```
Tenant app  ──POST /v1/chat/completions──▶  llmproxy  ──▶  OpenAI / Anthropic
               (virtual key)                  │
                                              │
                                         Kubernetes CRDs
                                         (no database needed)
```

## Quick start

### 1. Install

```bash
kubectl create namespace llmproxy-system
kubectl apply -f deploy/crds.yaml
kubectl apply -f deploy/operator.yaml
```

### 2. Add a provider

```bash
# Store your real API key
kubectl create secret generic openai-real-key \
  --namespace llmproxy-system \
  --from-literal=apiKey=sk-YOUR_REAL_KEY

# Register it as a channel
cat <<EOF | kubectl apply -f -
apiVersion: llmproxy.llmproxy.io/v1alpha1
kind: Channel
metadata:
  name: openai
  namespace: llmproxy-system
spec:
  type: openai
  baseURL: https://api.openai.com
  keySecretRef: { name: openai-real-key }
  priority: 10
  models: [gpt-4o, gpt-4o-mini]
EOF
```

### 3. Give a tenant access

```bash
cat <<EOF | kubectl apply -f -
apiVersion: llmproxy.llmproxy.io/v1alpha1
kind: ProxyKey
metadata:
  name: my-app
  namespace: my-team
spec:
  channelRef: openai
  models: [gpt-4o-mini]
  quota: 100          # optional: lifetime cost limit
  periodType: monthly # optional: daily | weekly | monthly
EOF
```

### 4. Get the virtual key

```bash
kubectl get secret my-app-llmproxy -n my-team \
  -o jsonpath='{.data.LLMPROXY_KEY}' | base64 -d
```

### 5. Use it

```bash
curl -X POST http://llmproxy.llmproxy-system:8000/v1/chat/completions \
  -H "Authorization: Bearer sk-proxy-YOUR_VIRTUAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hello"}]}'
```

## Features

- **No database, no Redis** — everything lives in Kubernetes CRDs and Secrets
- **Virtual API keys** — tenants never see your real provider keys
- **Per-tenant isolation** — each ProxyKey lives in the tenant's namespace with its own Secret
- **Model allowlists** — restrict which models each key can access
- **Quota limits** — lifetime and period-based cost quotas
- **IP restrictions** — limit keys to specific CIDR ranges
- **Priority-weighted routing** — distribute load across multiple channels
- **Automatic retry** — fails over to alternate channels on upstream errors
- **SSE streaming** — response streaming passes through natively
- **Prometheus metrics** — request counts, token usage, latency, costs, error rates
- **Management API** — CRUD endpoints for channels and proxy keys
- **Send to multiple LLM providers** — send to whatever provider matches the type on the channel. Supported out of the box:
  - any OpenAI-compatible provider (OpenAI, DeepSeek, Groq, Together, OpenRouter, etc)
  - Anthropic

## ProxyKey Secret

When a ProxyKey is created, llmproxy creates a Secret in the same namespace:

| Key | Value |
|-----|-------|
| `LLMPROXY_KEY` | The virtual API key (`sk-proxy-...`) |
| `LLMPROXY_ENDPOINT` | URL to reach the proxy |
| `LLMPROXY_CHANNEL` | Which channel this key routes to |

The Secret is owned by the ProxyKey — deleting the ProxyKey automatically cleans up the Secret.

## Prometheus metrics

Scrape `http://llmproxy.llmproxy-system:8081/metrics`:

| Metric | Type | Labels |
|--------|------|--------|
| `llmproxy_requests_total` | Counter | channel, model, proxykey_ns, proxykey_name, status_code |
| `llmproxy_tokens_total` | Counter | channel, model, type |
| `llmproxy_cost_dollars_total` | Counter | channel, model |
| `llmproxy_errors_total` | Counter | channel, model, error_type |
| `llmproxy_rate_limited_total` | Counter | channel, tier, reason |
| `llmproxy_request_duration_seconds` | Histogram | channel, model |
| `llmproxy_ttfb_seconds` | Histogram | channel, model |
| `llmproxy_retries_total` | Counter | channel |
| `llmproxy_keys_minted_total` | Counter | channel |
| `llmproxy_channels_active` | Gauge | type |

## API reference

### Relay (port 8000)

| Endpoint | Description |
|----------|-------------|
| `POST /v1/chat/completions` | OpenAI-compatible chat relay |
| `POST /v1/messages` | Anthropic Messages API |
| `GET /v1/models` | List available models |

### Health & metrics (port 8081)

| Endpoint | Description |
|----------|-------------|
| `GET /healthz` | Liveness probe |
| `GET /readyz` | Readiness probe |
| `GET /metrics` | Prometheus scrape |

### Management (port 8000, requires admin key)

| Endpoint | Description |
|----------|-------------|
| `GET /api/v1/channels` | List all channels |
| `POST /api/v1/channels` | Create a channel |
| `PUT /api/v1/channels/:name` | Update a channel |
| `DELETE /api/v1/channels/:name` | Delete a channel |
| `POST /api/v1/channels/:name/test` | Test a channel |
| `GET /api/v1/proxykeys/:ns/:name` | Get a proxykey |
| `POST /api/v1/proxykeys` | Create a proxykey |
| `DELETE /api/v1/proxykeys/:ns/:name` | Delete a proxykey |

## Local testing with k3d

This spins up a full cluster, installs llmproxy, and tests a real relay request — all locally.

### Prerequisites

```bash
# Install k3d if you don't have it
curl -s https://raw.githubusercontent.com/k3d-io/k3d/main/install.sh | bash
```

### 1. Create a cluster

```bash
k3d cluster create llmproxy --servers 1 --agents 0
# Wait for it to be ready
kubectl wait --for=condition=Ready node --all --timeout=60s
```

### 2. Install llmproxy

```bash
kubectl create namespace llmproxy-system
kubectl apply -f deploy/crds.yaml
kubectl apply -f deploy/operator.yaml
kubectl wait --for=condition=Ready pod -l app=llmproxy -n llmproxy-system --timeout=120s
```

### 3. Store a test upstream key

Use any LLM provider key, or a mock server. To test without a real key, spin up a local echo server:

```bash
# In another terminal: a simple echo server on port 9999
python3 -c "
from http.server import HTTPServer, BaseHTTPRequestHandler
import json
class H(BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers['Content-Length']))
        data = json.loads(body)
        resp = {'choices':[{'message':{'content':f'echo: {data[\"messages\"][-1][\"content\"]}'}}],'usage':{'prompt_tokens':10,'completion_tokens':5,'total_tokens':15}}
        self.send_response(200)
        self.send_header('Content-Type','application/json')
        self.end_headers()
        self.wfile.write(json.dumps(resp).encode())
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type','application/json')
        self.end_headers()
        self.wfile.write(json.dumps({'object':'list','data':[{'id':'test-model','object':'model','created':0,'owned_by':'echo'}]}).encode())
HTTPServer(('',9999),H).serve_forever()
"
```

Then forward the port into the cluster so the operator can reach it:

```bash
# Forward host port 9999 to port 9999 on a k3d node (k3d runs on docker)
docker ps --filter name=k3d-llmproxy --format '{{.ID}}' | head -1 | xargs -I{} docker inspect {} --format '{{.NetworkSettings.IPAddress}}'
# Note the IP, then use it in the channel baseURL below
HOST_IP=$(docker ps --filter name=k3d-llmproxy-server --format '{{.ID}}' | head -1 | xargs docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')
```

### 4. Create a Channel + ProxyKey

```bash
# Store a fake upstream key
kubectl create secret generic test-key \
  --namespace llmproxy-system \
  --from-literal=apiKey=noop

# Point the channel at your echo server (or a real provider)
# Use the HOST_IP from above, or just use http://host.k3d.internal:9999
cat <<EOF | kubectl apply -f -
apiVersion: llmproxy.llmproxy.io/v1alpha1
kind: Channel
metadata:
  name: test
  namespace: llmproxy-system
spec:
  type: openai
  baseURL: http://host.k3d.internal:9999
  keySecretRef: { name: test-key }
  priority: 10
  models: [test-model]
EOF

# Give a tenant access
kubectl create namespace my-team
cat <<EOF | kubectl apply -f -
apiVersion: llmproxy.llmproxy.io/v1alpha1
kind: ProxyKey
metadata:
  name: test-app
  namespace: my-team
spec:
  channelRef: test
EOF

# Wait for reconciliation
sleep 3
```

### 5. Test it

```bash
# Port-forward the proxy to localhost
kubectl port-forward -n llmproxy-system svc/llmproxy 8000:proxy &
sleep 2

# Grab the virtual key
KEY=$(kubectl get secret test-app-llmproxy -n my-team \
  -o jsonpath='{.data.LLMPROXY_KEY}' | base64 -d)
echo "Virtual key: $KEY"

# List models
curl -s http://localhost:8000/v1/models | jq .

# Send a chat request
curl -s http://localhost:8000/v1/chat/completions \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"test-model","messages":[{"role":"user","content":"hello"}]}' | jq .

# Check metrics
curl -s http://localhost:8081/metrics | grep llmproxy_
```

### 6. Clean up

```bash
kill %1  # stop port-forward
k3d cluster delete llmproxy
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OPERATOR_NAMESPACE` | `llmproxy-system` | Namespace for channels and provider secrets |
| `PROXY_URL` | `http://llmproxy.llmproxy-system.svc...` | URL injected into tenant secrets |
| `PROXY_PORT` | `8000` | Proxy listen port |
| `HEALTH_PORT` | `8081` | Health + metrics port |
| `ADMIN_KEY` | `admin-change-me` | API key for management endpoints |

## Development

```bash
npm install
npm run build
npm start
```
