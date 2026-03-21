#!/bin/bash
# overnight-abilities.sh — Hard benchmark overnight run for v0.8.0
# Focus: long-horizon (hardest), battle-test (250+ tests), agentic (multi-tool)
# Goal: improve Eight's system prompt at utilizing tools and abilities

set -e

cd "$(dirname "$0")/../.."
source ~/8gent-code/.env
export OPENROUTER_API_KEY

STOP_HOUR=7
LOG_FILE="benchmarks/autoresearch/overnight-abilities.log"
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

  log "--- Starting $category ($iterations iterations) ---"
  backup_state "$category-pre"
  reset_state

  CATEGORY="$category" MAX_ITERATIONS="$iterations" bun benchmarks/autoresearch/autoresearch-loop.ts 2>&1 | tee -a "$LOG_FILE" || true

  backup_state "$category"
  log "--- Finished $category ---"
}

should_stop() {
  CURRENT_HOUR=$(TZ='America/Los_Angeles' date '+%H')
  if [ "$CURRENT_HOUR" -ge "$STOP_HOUR" ] && [ "$CURRENT_HOUR" -lt "12" ]; then
    return 0
  fi
  return 1
}

log "============================================================"
log "  8GENT OVERNIGHT v0.8.0 - Hard Benchmarks"
log "  Phase 1: long-horizon (5 iter) - hardest tasks"
log "  Phase 2: battle-test (5 iter) - 250+ execution tests"
log "  Phase 3: agentic (5 iter) - multi-tool orchestration"
log "  Phase 4: rotate all categories"
log "  Stop: ${STOP_HOUR}AM PST"
log "============================================================"

# Phase 1: Long-Horizon (hardest - 500+ line tasks, multi-step)
log ""
log "=== PHASE 1: LONG-HORIZON ==="
run_category "long-horizon" 5
should_stop && { log "Morning stop."; exit 0; }
sleep 60

# Phase 2: Battle-Test (production-grade, 250+ execution tests)
log ""
log "=== PHASE 2: BATTLE-TEST ==="
run_category "battle-test" 5
should_stop && { log "Morning stop."; exit 0; }
sleep 60

# Phase 3: Agentic (multi-tool orchestration tasks)
log ""
log "=== PHASE 3: AGENTIC ==="
run_category "agentic" 5
should_stop && { log "Morning stop."; exit 0; }
sleep 60

# Phase 4: Rotate remaining hard categories
ROUND=0
while true; do
  should_stop && break

  ROUND=$((ROUND + 1))
  log ""
  log "=== ROTATION ROUND $ROUND ==="

  case $((ROUND % 4)) in
    1) run_category "fullstack" 3 ;;
    2) run_category "long-horizon" 3 ;;
    3) run_category "battle-test" 3 ;;
    0) run_category "agentic" 3 ;;
  esac

  sleep 120
done

log ""
log "============================================================"
log "  OVERNIGHT COMPLETE - Good morning James!"
log "  Check: tail -100 $LOG_FILE"
log "  States: ls benchmarks/autoresearch/loop-state-*.json"
log "============================================================"
