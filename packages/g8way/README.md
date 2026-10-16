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

## Extra upstreams (8J command judge)

`G8WAY_UPSTREAMS` (JSON array, see `upstreams.ts`) routes models by prefix to an
OpenAI-compatible upstream. `upstreams.example.json` holds one entry: `8j`, the command
judge served from the private HF Space `8GI/8j-eval` (ZeroGPU). The last user message is
the shell command; the reply content is `allow`, `ask` or `block`, then a `p_yes=` line.
Bands in the Space: p_yes below 0.05 allow, 0.05 to 0.5 ask, above 0.5 block. They were
picked on the same 40 synthetic commands the checkpoints were evaluated on, so they need
a held-out set before anything relies on them. The Space does not stream.

To enable it on a g8way host:

```bash
export G8WAY_UPSTREAMS="$(cat packages/g8way/upstreams.example.json)"
export G8WAY_ALLOWED_MODELS="<existing list>,8j/v5-final"   # 8j/20261014-125031 is the other model
export EIGHT_ALLOW_HOSTED=1                                  # the Space is a hosted, non-loopback upstream
export G8WAY_8J_KEYS=hf_...                                  # a READ-ONLY HF token, see below
```

`G8WAY_8J_KEYS` must be a fine-grained HF token with read access only, limited to the
`8GI/8j-eval` Space. Never use a token with write scope: g8way holds it in memory and
sends it on every 8j request.

Restart g8way after exporting these. The upstream config is read once at startup, so a
running process keeps its old routes until it restarts.

Keys come only from the env var named by `keysEnv`. A bad config throws at startup.
Models outside `8j/` keep going to OpenRouter unchanged.

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
