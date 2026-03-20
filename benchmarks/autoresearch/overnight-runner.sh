#!/bin/bash
# overnight-runner.sh — Runs autoresearch loop continuously until morning
# Alternates between agentic and fullstack categories
# Resets loop state between category switches to avoid stale data

set -e

cd "$(dirname "$0")/../.."
source ~/8gent-code/.env
export OPENROUTER_API_KEY

STOP_HOUR=7  # Stop at 7 AM
LOG_FILE="benchmarks/autoresearch/overnight.log"
STATE_FILE="benchmarks/autoresearch/loop-state.json"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

reset_state() {
  cat > "$STATE_FILE" << 'EOF'
{
  "iteration": 0,
  "mutations": [],
  "history": [],
  "startedAt": null,
  "lastRunAt": null
}
EOF
}

backup_state() {
  local category=$1
  local timestamp=$(date '+%Y%m%d-%H%M%S')
  cp "$STATE_FILE" "benchmarks/autoresearch/loop-state-${category}-${timestamp}.json" 2>/dev/null || true
}

run_category() {
  local category=$1
  local iterations=$2

  log "═══ Starting $category ($iterations iterations) ═══"
  backup_state "$category-pre"
  reset_state

  CATEGORY="$category" MAX_ITERATIONS="$iterations" bun benchmarks/autoresearch/autoresearch-loop.ts 2>&1 | tee -a "$LOG_FILE"

  backup_state "$category"
  log "═══ Finished $category ═══"
}

log "╔══════════════════════════════════════════════════════════════╗"
log "║     8GENT OVERNIGHT AUTORESEARCH — Running until ${STOP_HOUR}AM    ║"
log "╚══════════════════════════════════════════════════════════════╝"

ROUND=0
while true; do
  CURRENT_HOUR=$(TZ='America/Los_Angeles' date '+%H')
  # Only stop in the morning window (8 AM - 12 PM). Evening hours (17-23) should keep running.
  if [ "$CURRENT_HOUR" -ge "$STOP_HOUR" ] && [ "$CURRENT_HOUR" -lt "12" ]; then
    log "Morning stop: ${CURRENT_HOUR}:00 PST >= ${STOP_HOUR}:00. Stopping."
    break
  fi

  ROUND=$((ROUND + 1))
  log ""
  log "══════ ROUND $ROUND ══════"

  # Alternate between ALL categories — battle-test gets extra iterations
  case $((ROUND % 8)) in
    1) run_category "battle-test" 5 ;;
    2) run_category "agentic" 3 ;;
    3) run_category "fullstack" 3 ;;
    4) run_category "battle-test" 5 ;;
    5) run_category "ui-design" 3 ;;
    6) run_category "long-horizon" 3 ;;
    7) run_category "bug-fixing" 2 ;;
    0) run_category "feature-implementation" 2 ;;
  esac

  # Pause between rounds to respect rate limits
  log "Cooling down for 120s between rounds..."
  sleep 120
done

log ""
log "╔══════════════════════════════════════════════════════════════╗"
log "║     OVERNIGHT SESSION COMPLETE — Good morning James!       ║"
log "╚══════════════════════════════════════════════════════════════╝"
