#!/bin/bash
#
# Deploy the Eight Vessel daemon to Fly.io (Amsterdam)
#
# Uses fly-daemon.toml config. Does NOT modify existing deploy-vessel.sh.
#
# Prerequisites:
#   - flyctl installed (brew install flyctl)
#   - fly auth login
#
# Usage:
#   ./scripts/deploy-vessel-fly.sh
#

set -euo pipefail

APP="eight-vessel"
CONFIG="fly-daemon.toml"
HEALTH_URL="https://${APP}.fly.dev/health"
MAX_RETRIES=6
RETRY_INTERVAL=10

# Resolve repo root
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ ! -f "$CONFIG" ]; then
  echo "ERROR: $CONFIG not found in repo root."
  exit 1
fi

echo "=== Eight Vessel Deploy ==="
echo "App:    $APP"
echo "Config: $CONFIG"
echo ""

# Build and deploy
echo "[1/3] Deploying to Fly.io..."
fly deploy --config "$CONFIG" --app "$APP"

# Health check with retries
echo ""
echo "[2/3] Verifying health check..."
for i in $(seq 1 $MAX_RETRIES); do
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$HEALTH_URL" 2>/dev/null || echo "000")
  if [ "$HTTP_CODE" = "200" ]; then
    echo "Health check passed (HTTP 200)."
    break
  fi
  echo "  Attempt $i/$MAX_RETRIES - got HTTP $HTTP_CODE, retrying in ${RETRY_INTERVAL}s..."
  sleep "$RETRY_INTERVAL"
done

if [ "$HTTP_CODE" != "200" ]; then
  echo "WARNING: Health check did not return 200 after $MAX_RETRIES attempts."
  echo "Check logs: fly logs --app $APP"
  exit 1
fi

# Report
echo ""
echo "[3/3] Status"
echo "  URL:       https://${APP}.fly.dev"
echo "  WebSocket: wss://${APP}.fly.dev"
echo "  Health:    $HEALTH_URL"
echo "  Logs:      fly logs --app $APP"
echo ""
echo "=== Deploy complete ==="
