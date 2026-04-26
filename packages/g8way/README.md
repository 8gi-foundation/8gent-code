# @8gent/g8way

Lotus-class model proxy. OpenAI-compatible HTTP gateway with Clerk JWT
auth, per-tenant rate limiting, OpenRouter routing, and structured
stdout usage logging.

Designed for the Hetzner prod box behind Caddy. Caddy terminates TLS
on `api.8gentos.com` and reverse-proxies to `127.0.0.1:8080`.

## Endpoints

| Method | Path                    | Auth   | Description                              |
|--------|-------------------------|--------|------------------------------------------|
| GET    | `/healthz`              | none   | Liveness probe                           |
| GET    | `/v1/models`            | Bearer | List allowed models                      |
| POST   | `/v1/chat/completions`  | Bearer | OpenAI-compatible chat completions       |

Auth is Clerk JWT via the `Authorization: Bearer <token>` header.
Tokens are verified against Clerk's JWKS (RS256) using `@8gent/auth`.

Tenant resolution: `org_id` claim wins, otherwise the Clerk `sub`
becomes the tenant id. Plan is read from `public_metadata.plan` and
defaults to `free`.

## Run locally

```bash
cd packages/g8way
bun install

# Required for prod boot
export OPENROUTER_API_KEY=...
export CLERK_PUBLISHABLE_KEY=pk_live_...

# Optional
export G8WAY_PORT=8080
export CLERK_FRONTEND_API=https://clerk.8gent.app
export G8WAY_ALLOWED_MODELS="anthropic/claude-sonnet-4-6,openai/gpt-4o,google/gemini-2.0-flash-001"
export G8WAY_DEFAULT_MODEL=anthropic/claude-sonnet-4-6

bun run start
```

For unauthenticated dev mode:

```bash
G8WAY_REQUIRE_AUTH=false G8WAY_PORT=18080 bun run start
```

## Rate limits

Token bucket per tenant, per minute. Defaults:

| Plan | Requests/min | Tokens/min |
|------|--------------|------------|
| free | 20           | 50,000     |
| pro  | 200          | 500,000    |
| team | 1,000        | 5,000,000  |

In-process for now (single-node). When we shard, swap the bucket map
for a Redis SCRIPT or move to a sidecar limiter.

## Usage logging

One JSON line per request to stdout. Vector tails the container log
and ships to Loki.

```json
{
  "ts": "2026-04-26T18:00:00.000Z",
  "type": "g8way.usage",
  "tenant_id": "org_42",
  "clerk_user_id": "user_abc",
  "plan": "pro",
  "model_requested": "anthropic/claude-sonnet-4-6",
  "model_resolved": "anthropic/claude-sonnet-4-6",
  "upstream": "openrouter",
  "prompt_tokens": 312,
  "completion_tokens": 188,
  "total_tokens": 500,
  "latency_ms": 842,
  "status": 200,
  "stream": false
}
```

## Tests

```bash
bun test
```

24 tests cover auth (token shape + tenant resolution), the rate
limiter (refill, exhaustion, per-tenant isolation), and the routes
(model gating, rate-limit 429, upstream 502, usage log shape).

## Architecture

```
Caddy (api.8gentos.com)
   |
   v
g8way :8080
  ├─ clerkAuth     -> @8gent/auth validateToken (jose RS256)
  ├─ rateLimiter   -> per-tenant token bucket
  ├─ OpenRouter    -> https://openrouter.ai/api/v1
  └─ usageLogger   -> stdout JSON -> Vector -> Loki -> Grafana
```

Issue: [#1842](https://github.com/8gi-foundation/8gent-code/issues/1842)
