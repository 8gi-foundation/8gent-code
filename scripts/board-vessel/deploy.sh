#!/bin/bash
set -e

# Deploy a board vessel to Fly.io
# Usage: ./deploy.sh <MEMBER_CODE>
# Example: ./deploy.sh 8TO

MEMBER=$1

if [ -z "$MEMBER" ]; then
  echo "Usage: ./deploy.sh <MEMBER_CODE>"
  echo "Members: 8EO 8TO 8PO 8DO 8SO"
  exit 1
fi

# Board member config
declare -A NAMES ROLES
NAMES[8EO]="Daniel"
NAMES[8TO]="Rishi"
NAMES[8PO]="Samantha"
NAMES[8DO]="Moira"
NAMES[8SO]="Karen"

ROLES[8EO]="8gent Executive Officer"
ROLES[8TO]="8gent Technology Officer"
ROLES[8PO]="8gent Product Officer"
ROLES[8DO]="8gent Design Officer"
ROLES[8SO]="8gent Security Officer"

NAME=${NAMES[$MEMBER]}
ROLE=${ROLES[$MEMBER]}

if [ -z "$NAME" ]; then
  echo "Unknown member: $MEMBER"
  echo "Valid: 8EO 8TO 8PO 8DO 8SO"
  exit 1
fi

# Derive app name (lowercase)
MEMBER_LOWER=$(echo "$MEMBER" | tr '[:upper:]' '[:lower:]')
APP_NAME="8gi-${MEMBER_LOWER}-vessel"

echo "[deploy] Deploying ${NAME} (${MEMBER}) as ${APP_NAME}"

# Load token from governance .env
ENV_FILE="${HOME}/8gi-governance/.env"
TOKEN_VAR="DISCORD_BOT_TOKEN_${MEMBER}"

if [ -f "$ENV_FILE" ]; then
  TOKEN=$(grep "^${TOKEN_VAR}=" "$ENV_FILE" | cut -d'=' -f2-)
fi

if [ -z "$TOKEN" ]; then
  echo "[deploy] WARNING: ${TOKEN_VAR} not found in ${ENV_FILE}"
  echo "[deploy] You will need to set the secret manually:"
  echo "  fly secrets set DISCORD_BOT_TOKEN=<token> -a ${APP_NAME}"
fi

# Go to repo root (Dockerfile expects COPY from repo root)
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

# Generate fly.toml for this member
cat > scripts/board-vessel/fly.deploy.toml <<EOF
app = "${APP_NAME}"
primary_region = "ams"

[build]
  dockerfile = "scripts/board-vessel/Dockerfile"

[env]
  OLLAMA_HOST = "0.0.0.0:11434"
  BOARD_MEMBER_CODE = "${MEMBER}"
  BOARD_MEMBER_NAME = "${NAME}"
  BOARD_MEMBER_ROLE = "${ROLE}"
  OLLAMA_MODEL = "qwen3:latest"

[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = "stop"
  auto_start_machines = true
  min_machines_running = 0

[[vm]]
  size = "shared-cpu-1x"
  memory = "512mb"
EOF

# Create app if it doesn't exist
fly apps list | grep -q "$APP_NAME" || fly apps create "$APP_NAME" --org personal

# Set the bot token secret
if [ -n "$TOKEN" ]; then
  echo "[deploy] Setting DISCORD_BOT_TOKEN secret"
  echo "$TOKEN" | fly secrets set DISCORD_BOT_TOKEN=- -a "$APP_NAME"
fi

# Deploy
echo "[deploy] Deploying to Fly.io..."
fly deploy --config scripts/board-vessel/fly.deploy.toml -a "$APP_NAME"

echo "[deploy] ${NAME} (${MEMBER}) deployed to ${APP_NAME}.fly.dev"
echo "[deploy] Health check: https://${APP_NAME}.fly.dev/health"

# Cleanup generated toml
rm -f scripts/board-vessel/fly.deploy.toml
