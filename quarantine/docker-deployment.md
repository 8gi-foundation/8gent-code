# Docker Deployment - Eight Daemon

## Status: Quarantine (untested)

Docker configuration for running the Eight daemon with a local Ollama instance.

## Quick Start

```bash
docker compose up -d
```

This starts two services:
- **daemon** - Eight daemon on port 18789
- **ollama** - Local LLM server on port 11434

## Pull a Model

After first start, pull the default model into Ollama:

```bash
docker exec eight-ollama ollama pull qwen3.5:14b
```

## Architecture

```
Host:18789 -> eight-daemon (Bun, WebSocket gateway)
                |
                +-> eight-ollama (Ollama, port 11434)

Volumes:
  eight-data    -> /root/.8gent (daemon config, memory DB, logs)
  ollama-models -> /root/.ollama (downloaded model weights)
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OLLAMA_HOST` | `http://ollama:11434` | Ollama endpoint (set by compose) |
| `EIGHT_DATA_DIR` | `/root/.8gent` | Daemon data directory |

## Production Notes

- The daemon exposes a WebSocket gateway - put nginx/caddy in front for TLS in production.
- Ollama models persist across container restarts via the `ollama-models` volume.
- The `eight-data` volume holds the memory DB, config, and logs.
- Health check pings localhost:18789 every 30s.

## Fly.io

The existing Fly.io deployment at eight-vessel.fly.dev remains the primary deployment target. This Docker setup is for local/self-hosted scenarios.
