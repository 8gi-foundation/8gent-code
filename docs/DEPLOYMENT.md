# Deployment

How to deploy the 8gent daemon to Fly.io.

## Prerequisites

- [flyctl](https://fly.io/docs/hands-on/install-flyctl/) installed
- Fly.io account authenticated (`fly auth login`)
- Ollama instance accessible from the deployment (see Model Hosting below)

## Quick Deploy

```bash
# Create the app (first time only)
fly apps create 8gent-daemon

# Create persistent volume for state (first time only)
fly volumes create 8gent_data --region dub --size 1

# Set auth token (recommended for production)
fly secrets set DAEMON_AUTH_TOKEN=your-secret-token

# Deploy
fly deploy
```

## Connect

```
WebSocket: wss://8gent-daemon.fly.dev
Health:    https://8gent-daemon.fly.dev/health
```

### Test the connection

```bash
# Against Fly deployment
DAEMON_URL=wss://8gent-daemon.fly.dev bun run scripts/test-ws-client.ts

# With auth token
DAEMON_URL=wss://8gent-daemon.fly.dev DAEMON_AUTH_TOKEN=your-secret-token bun run scripts/test-ws-client.ts
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama API endpoint |
| `DEFAULT_MODEL` | `qwen3.5:14b` | Default model for agent sessions |
| `DEFAULT_RUNTIME` | `ollama` | Provider: `ollama`, `lmstudio`, `openrouter` |
| `OPENROUTER_API_KEY` | - | Required if runtime is `openrouter` |
| `DAEMON_AUTH_TOKEN` | - | WebSocket auth token (set via `fly secrets`) |

Set secrets (not visible in fly.toml):
```bash
fly secrets set OPENROUTER_API_KEY=sk-or-...
fly secrets set DAEMON_AUTH_TOKEN=your-secret-token
```

## Model Hosting

The daemon needs an LLM to process prompts. Options:

### Option 1: OpenRouter (easiest for cloud)

No GPU needed. Set the runtime to OpenRouter:

```bash
fly secrets set OPENROUTER_API_KEY=sk-or-...
```

Update fly.toml:
```toml
[env]
  DEFAULT_RUNTIME = "openrouter"
  DEFAULT_MODEL = "google/gemini-2.5-flash:free"
```

### Option 2: External Ollama

Run Ollama on a GPU machine and point the daemon at it:

```bash
fly secrets set OLLAMA_HOST=https://your-ollama-host.example.com
```

### Option 3: Ollama on Fly GPU (future)

Fly.io supports GPU machines. Deploy Ollama as a separate Fly app with a GPU, then connect the daemon to it.

## Volume Management

The daemon persists state to `/root/.8gent/` (mounted from the `8gent_data` volume):

| File | Purpose |
|------|---------|
| `daemon.log` | Append-only event log |
| `daemon-state.json` | Session metadata (saved on shutdown) |
| `cron.json` | Scheduled jobs |
| `config.json` | Daemon configuration |
| `memory/` | SQLite memory database |

### Volume commands

```bash
# List volumes
fly volumes list

# Extend volume
fly volumes extend <vol-id> --size 5

# SSH into the machine to inspect state
fly ssh console
cat /root/.8gent/daemon.log | tail -20
```

## Health Check

```bash
curl https://8gent-daemon.fly.dev/health
```

Returns:
```json
{
  "status": "ok",
  "sessions": 0,
  "uptime": 3600.5
}
```

Fly checks this endpoint every 30 seconds. Unhealthy machines are restarted automatically.

## Scaling

The default config runs 1 machine with auto-stop (stops when idle, starts on request). For always-on:

```bash
fly scale count 1 --max-per-region 1
```

In fly.toml, set:
```toml
auto_stop_machines = "off"
min_machines_running = 1
```

## Logs

```bash
# Stream live logs
fly logs

# Last 100 lines
fly logs --no-tail
```

## Region

Default region is `dub` (Dublin). To change:

```bash
fly regions set lax  # Los Angeles
```

## Architecture

```
Client (8gent.app / 8gent OS / Telegram)
    |
    | wss://8gent-daemon.fly.dev
    |
Fly.io Machine (dub)
    |
    +-- Bun runtime
    |   +-- packages/daemon/index.ts
    |   +-- WebSocket gateway (:18789)
    |   +-- Heartbeat (30min interval)
    |   +-- Cron scheduler
    |
    +-- /root/.8gent/ (Fly volume)
    |   +-- daemon.log
    |   +-- cron.json
    |   +-- memory/
    |
    +-- Ollama (external)
        http://ollama-host:11434
```
