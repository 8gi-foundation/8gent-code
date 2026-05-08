# Fly Deployment Update

## What

Updated Fly.io deployment configuration for the Eight Vessel daemon.

## Files

| File | Purpose |
|------|---------|
| `fly-daemon.toml` | Fly.io config - app name, region, port, health checks, scaling |
| `scripts/deploy-vessel-fly.sh` | Build, deploy, verify health, report status |

## Config Summary

- **App:** eight-vessel
- **Region:** ams (Amsterdam)
- **Internal port:** 18789
- **Health check:** GET /health every 15s, 5s timeout, 30s grace period
- **Scaling:** min 1, max 1 (auto-stop disabled)
- **VM:** shared-cpu-1x, 1024mb RAM

## Deploy Script

`scripts/deploy-vessel-fly.sh` does three things:

1. Runs `fly deploy` with the daemon config
2. Polls /health up to 6 times (10s intervals) until HTTP 200
3. Prints connection URLs and log commands

## Relationship to Existing Files

- `scripts/deploy-vessel.sh` - existing generic "deploy your own vessel" script (unchanged)
- `fly-daemon.toml` - new, dedicated config for the eight-vessel daemon
- `scripts/deploy-vessel-fly.sh` - new, focused deploy script for the daemon

## Usage

```bash
# One-time auth
fly auth login

# Deploy
./scripts/deploy-vessel-fly.sh
```

## Verification

```bash
curl https://eight-vessel.fly.dev/health
fly logs --app eight-vessel
```
