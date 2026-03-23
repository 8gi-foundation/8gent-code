#!/bin/bash
#
# Deploy Your Own 8gent Vessel
# One command to get Eight running in the cloud with Telegram access.
#
# Prerequisites:
#   - flyctl installed (brew install flyctl)
#   - fly auth login (already authenticated)
#   - A Telegram bot token (from @BotFather)
#
# Usage:
#   ./scripts/deploy-vessel.sh <app-name> <telegram-bot-token> <telegram-chat-id>
#
# Example:
#   ./scripts/deploy-vessel.sh artale-vessel 123456:ABC... 987654321
#
# What this does:
#   1. Creates a Fly.io app
#   2. Creates a persistent volume
#   3. Sets secrets (Telegram token, OpenRouter key)
#   4. Deploys the Vessel container
#   5. Your bot messages you "Eight is online"
#

set -e

APP_NAME="${1:?Usage: $0 <app-name> <telegram-bot-token> <telegram-chat-id>}"
TG_TOKEN="${2:?Missing Telegram bot token. Get one from @BotFather}"
TG_CHAT_ID="${3:?Missing Telegram chat ID. Message @userinfobot to get yours}"
REGION="${4:-ams}"

echo "=== Deploying 8gent Vessel: $APP_NAME ==="
echo "Region: $REGION"
echo ""

# Step 1: Create app
echo "[1/5] Creating Fly app..."
fly apps create "$APP_NAME" 2>/dev/null || echo "App already exists"

# Step 2: Create volume
echo "[2/5] Creating persistent volume..."
fly volumes create eight_data --region "$REGION" --size 1 --app "$APP_NAME" --yes 2>/dev/null || echo "Volume already exists"

# Step 3: Set secrets
echo "[3/5] Setting secrets..."
fly secrets set \
  TELEGRAM_BOT_TOKEN="$TG_TOKEN" \
  TELEGRAM_CHAT_ID="$TG_CHAT_ID" \
  DEFAULT_MODEL="auto:free" \
  DEFAULT_RUNTIME="openrouter" \
  --app "$APP_NAME"

# Step 4: Create temporary fly.toml
TMPDIR=$(mktemp -d)
cat > "$TMPDIR/fly.toml" <<EOF
app = "$APP_NAME"
primary_region = "$REGION"

[build]
  dockerfile = "Dockerfile"

[env]
  DEFAULT_RUNTIME = "openrouter"
  DEFAULT_MODEL = "auto:free"

[http_service]
  internal_port = 18789
  force_https = true
  auto_stop_machines = "stop"
  auto_start_machines = true
  min_machines_running = 1

  [http_service.concurrency]
    type = "connections"
    hard_limit = 100
    soft_limit = 50

[mounts]
  source = "eight_data"
  destination = "/root/.8gent"

[[vm]]
  size = "shared-cpu-1x"
  memory = "1024mb"
EOF

# Copy Dockerfile and entrypoint from vessel repo
VESSEL_DIR="$(dirname "$0")/../"
if [ -f "$HOME/8gent-vessel/Dockerfile" ]; then
  cp "$HOME/8gent-vessel/Dockerfile" "$TMPDIR/Dockerfile"
  cp "$HOME/8gent-vessel/entrypoint.sh" "$TMPDIR/entrypoint.sh"
elif [ -f "$VESSEL_DIR/docker/Dockerfile.daemon" ]; then
  cp "$VESSEL_DIR/docker/Dockerfile.daemon" "$TMPDIR/Dockerfile"
fi

# Step 5: Deploy
echo "[4/5] Deploying..."
cd "$TMPDIR"
fly deploy --app "$APP_NAME"

echo ""
echo "[5/5] Verifying..."
sleep 10
curl -s "https://$APP_NAME.fly.dev/health" || echo "Waiting for startup..."

echo ""
echo "=== Vessel Deployed ==="
echo ""
echo "  App:       $APP_NAME"
echo "  URL:       https://$APP_NAME.fly.dev"
echo "  WebSocket: wss://$APP_NAME.fly.dev"
echo "  Health:    https://$APP_NAME.fly.dev/health"
echo ""
echo "  Your bot should message you on Telegram now."
echo "  If not, wait 60 seconds for the container to start."
echo ""
echo "  Commands:"
echo "    fly logs --app $APP_NAME     # View logs"
echo "    fly ssh console --app $APP_NAME  # SSH into container"
echo "    fly apps restart $APP_NAME   # Restart"
echo ""
echo "  Optional: Set OpenRouter API key for better model selection:"
echo "    fly secrets set OPENROUTER_API_KEY=sk-or-... --app $APP_NAME"
echo ""
echo "  Optional: Set Groq key for voice transcription:"
echo "    fly secrets set GROQ_API_KEY=gsk_... --app $APP_NAME"
echo ""
