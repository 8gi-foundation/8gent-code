#!/usr/bin/env bash
# deploy-fleet.sh
# Deploys all 8 officer vessels from board-vessels.yaml.
# Uses shared vessel-factory Dockerfile and daemon.
#
# Usage:
#   ./scripts/deploy-fleet.sh                    # deploy all
#   ./scripts/deploy-fleet.sh --vessel rishi      # deploy one
#   ./scripts/deploy-fleet.sh --dry-run           # print what would run
#
# Prerequisites:
#   - fly CLI authenticated
#   - bun + yq installed (yq for YAML parsing)
#   - Secrets exported in shell: TELEGRAM_BOT_TOKEN, JAMES_TELEGRAM_CHAT_ID

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG="$REPO_ROOT/config/board-vessels.yaml"
FACTORY="$REPO_ROOT/scripts/vessel-factory"
TEMPLATE="$FACTORY/fly.toml.template"

DRY_RUN=false
TARGET_VESSEL=""

# ── CLI args ──────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case $1 in
    --dry-run) DRY_RUN=true; shift ;;
    --vessel)  TARGET_VESSEL="${2:-}"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

# ── Prereq checks ─────────────────────────────────────────────────────────
check_prereqs() {
  for cmd in fly yq bun; do
    if ! command -v "$cmd" &>/dev/null; then
      echo "ERROR: '$cmd' not found. Install it first."
      exit 1
    fi
  done

  if [[ -z "${TELEGRAM_BOT_TOKEN:-}" ]]; then
    echo "ERROR: TELEGRAM_BOT_TOKEN not set. Export it first."
    exit 1
  fi
  if [[ -z "${JAMES_TELEGRAM_CHAT_ID:-}" ]]; then
    echo "ERROR: JAMES_TELEGRAM_CHAT_ID not set. Export it first."
    exit 1
  fi
}

# ── Deploy one vessel ─────────────────────────────────────────────────────
deploy_vessel() {
  local vessel_key="$1"

  local fly_app code name title soul catchphrase tools

  fly_app=$(yq ".vessels.${vessel_key}.fly_app" "$CONFIG")
  code=$(yq ".vessels.${vessel_key}.code" "$CONFIG")
  name=$(yq ".vessels.${vessel_key}.name" "$CONFIG")
  title=$(yq ".vessels.${vessel_key}.title" "$CONFIG")
  soul=$(yq ".vessels.${vessel_key}.soul" "$CONFIG")
  catchphrase=$(yq ".vessels.${vessel_key}.catchphrase" "$CONFIG")
  tools=$(yq ".vessels.${vessel_key}.tools | join(\",\")" "$CONFIG")

  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  Deploying: $name ($code) -> $fly_app"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  if [[ "$DRY_RUN" == "true" ]]; then
    echo "[DRY RUN] Would deploy $fly_app with VESSEL_CODE=$code VESSEL_NAME=$name"
    return
  fi

  # 1. Create app if it doesn't exist
  if ! fly apps list | grep -q "$fly_app"; then
    echo "Creating app: $fly_app"
    fly apps create "$fly_app" --org personal 2>/dev/null || true
  fi

  # 2. Generate fly.toml for this vessel
  local tmp_toml
  tmp_toml=$(mktemp /tmp/fly_toml_XXXXXX.toml)
  sed \
    -e "s|{{FLY_APP}}|$fly_app|g" \
    -e "s|{{VESSEL_CODE}}|$code|g" \
    -e "s|{{VESSEL_NAME}}|$name|g" \
    -e "s|{{VESSEL_TITLE}}|$title|g" \
    "$TEMPLATE" > "$tmp_toml"

  # 3. Set secrets
  echo "Setting secrets for $fly_app..."
  fly secrets set \
    "VESSEL_SOUL=$soul" \
    "VESSEL_CATCHPHRASE=$catchphrase" \
    "VESSEL_TOOLS=$tools" \
    "TELEGRAM_BOT_TOKEN=$TELEGRAM_BOT_TOKEN" \
    "JAMES_TELEGRAM_CHAT_ID=$JAMES_TELEGRAM_CHAT_ID" \
    --app "$fly_app" --stage

  # 4. Deploy from factory, using the generated toml
  echo "Deploying $fly_app..."
  fly deploy \
    --config "$tmp_toml" \
    --dockerfile "$FACTORY/Dockerfile" \
    --app "$fly_app" \
    --remote-only \
    --wait-timeout 120

  rm -f "$tmp_toml"
  echo "DEPLOYED: $name ($code) at https://$fly_app.fly.dev"
}

# ── Main ──────────────────────────────────────────────────────────────────
main() {
  check_prereqs

  echo "8GI Fleet Deploy"
  echo "Config: $CONFIG"
  echo ""

  # Get vessel keys from YAML
  local vessels
  vessels=$(yq '.vessels | keys | .[]' "$CONFIG")

  for vessel_key in $vessels; do
    if [[ -n "$TARGET_VESSEL" && "$vessel_key" != "$TARGET_VESSEL" ]]; then
      continue
    fi
    deploy_vessel "$vessel_key"
  done

  echo ""
  echo "Fleet deploy complete."

  if [[ "$DRY_RUN" != "true" ]]; then
    echo ""
    echo "Verifying health..."
    for vessel_key in $vessels; do
      if [[ -n "$TARGET_VESSEL" && "$vessel_key" != "$TARGET_VESSEL" ]]; then
        continue
      fi
      local fly_app
      fly_app=$(yq ".vessels.${vessel_key}.fly_app" "$CONFIG")
      local code
      code=$(yq ".vessels.${vessel_key}.code" "$CONFIG")
      local status
      status=$(curl -sf "https://${fly_app}.fly.dev/health" 2>/dev/null | \
               bun -e "const d=await Bun.stdin.text(); console.log(JSON.parse(d).status)" 2>/dev/null || echo "sleeping")
      echo "  $code ($fly_app): $status"
    done
  fi
}

main
