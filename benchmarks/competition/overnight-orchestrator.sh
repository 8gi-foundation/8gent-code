#!/bin/bash
# overnight-orchestrator.sh — Full overnight competition: warmup → head-to-head → train → re-test → sync
#
# Schedule:
#   Phase 1 (10:45 PM - 1:00 AM): Autoresearch warmup on battle-test (5 iterations)
#   Phase 2 (1:00 AM - 4:00 AM):  Claude vs 8gent head-to-head on ALL categories
#   Phase 3 (4:00 AM - 5:30 AM):  Fine-tune via nightly-train.ts
#   Phase 4 (5:30 AM - 6:00 AM):  Re-run head-to-head on battle-test (measure improvement)
#   Phase 5 (6:00 AM - 6:30 AM):  Sync results to 8gent-world, generate summary
#   Hard stop: 7:00 AM PST
#
# Usage:
#   chmod +x benchmarks/competition/overnight-orchestrator.sh
#   ./benchmarks/competition/overnight-orchestrator.sh

set -euo pipefail

# ── Config ──────────────────────────────────────────────────────────────

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

STOP_HOUR=7
DATE_TAG=$(date +%Y%m%d)
LOG_DIR="$HOME/.8gent"
LOG_FILE="$LOG_DIR/overnight-competition-${DATE_TAG}.log"
COMPETITION_DIR="benchmarks/competition"
AUTORESEARCH_DIR="benchmarks/autoresearch"
STATE_FILE="${COMPETITION_DIR}/competition-state.json"

mkdir -p "$LOG_DIR"
mkdir -p "$COMPETITION_DIR"

# ── Logging ─────────────────────────────────────────────────────────────

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

log_header() {
  log ""
  log "╔══════════════════════════════════════════════════════════════╗"
  log "║  $1"
  log "╚══════════════════════════════════════════════════════════════╝"
}

# ── Telegram ────────────────────────────────────────────────────────────

send_telegram() {
  local text="$1"
  local token="${TELEGRAM_BOT_TOKEN:-8651805768:AAFvSVOMc7U9l2itsBUTWPzgBkPxdle4B4U}"
  local chat_id="${TELEGRAM_CHAT_ID:-5486040131}"
  curl -s -X POST "https://api.telegram.org/bot${token}/sendMessage" \
    -H "Content-Type: application/json" \
    -d "{\"chat_id\": \"${chat_id}\", \"text\": $(echo "$text" | jq -Rs .), \"parse_mode\": \"Markdown\"}" > /dev/null 2>&1
}

# ── Cleanup on interrupt ────────────────────────────────────────────────

PHASE="setup"
cleanup() {
  log ""
  log "!! Interrupted during phase: $PHASE"
  send_telegram "$(cat <<MSG
⚠️ *8gent Overnight Competition Interrupted*

Phase: \`${PHASE}\`
Time: $(date '+%H:%M %Z')
Log: \`${LOG_FILE}\`

Competition was interrupted. Check logs for details.
MSG
)"
  exit 1
}
trap cleanup SIGINT SIGTERM

# ── Time check helper ──────────────────────────────────────────────────

check_stop_time() {
  local current_hour
  current_hour=$(TZ='America/Los_Angeles' date '+%H')
  # Stop if we're in morning window (STOP_HOUR to 12)
  if [ "$current_hour" -ge "$STOP_HOUR" ] && [ "$current_hour" -lt "12" ]; then
    log "!! Hard stop reached: ${current_hour}:00 PST >= ${STOP_HOUR}:00"
    return 0
  fi
  return 1
}

wait_until_hour() {
  local target_hour=$1
  local description=$2
  log "Waiting for ${description} (target: ${target_hour}:00 PST)..."
  while true; do
    local current_hour
    current_hour=$(TZ='America/Los_Angeles' date '+%H')
    local current_min
    current_min=$(TZ='America/Los_Angeles' date '+%M')

    # For evening hours (>= 12), just compare directly
    # For morning hours (< 12), also compare directly
    if [ "$current_hour" -ge "$target_hour" ] 2>/dev/null; then
      # If target is a morning hour and current is evening, keep waiting
      if [ "$target_hour" -lt "12" ] && [ "$current_hour" -ge "12" ]; then
        sleep 60
        continue
      fi
      break
    fi

    # If we crossed midnight (current < 12, target < 12), check directly
    if [ "$current_hour" -lt "12" ] && [ "$target_hour" -lt "12" ] && [ "$current_hour" -ge "$target_hour" ]; then
      break
    fi

    sleep 60
  done
  log "Reached target time for: ${description}"
}

# ── Environment Setup ──────────────────────────────────────────────────

log_header "8GENT OVERNIGHT COMPETITION — $(date '+%Y-%m-%d')"
PHASE="setup"

log "Loading environment..."
if [ -f "$REPO_ROOT/.env" ]; then
  source "$REPO_ROOT/.env"
  export OPENROUTER_API_KEY
  export ANTHROPIC_API_KEY 2>/dev/null || true
  export OLLAMA_URL="${OLLAMA_URL:-http://localhost:11434}"
  log "Environment loaded from .env"
else
  log "WARNING: No .env file found at $REPO_ROOT/.env"
fi

# Export Telegram credentials
export TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-8651805768:AAFvSVOMc7U9l2itsBUTWPzgBkPxdle4B4U}"
export TELEGRAM_CHAT_ID="${TELEGRAM_CHAT_ID:-5486040131}"

# ── Prerequisites Check ────────────────────────────────────────────────

log "Checking prerequisites..."

# Check bun
if ! command -v bun &> /dev/null; then
  log "FATAL: bun not found in PATH"
  send_telegram "❌ *Overnight competition failed:* bun not installed"
  exit 1
fi
log "  ✓ bun $(bun --version)"

# Check Ollama
if ! curl -s "${OLLAMA_URL}/api/tags" > /dev/null 2>&1; then
  log "FATAL: Ollama not running at ${OLLAMA_URL}"
  send_telegram "❌ *Overnight competition failed:* Ollama not running at ${OLLAMA_URL}"
  exit 1
fi
log "  ✓ Ollama running at ${OLLAMA_URL}"

# Check eight model
EIGHT_MODEL="${EIGHT_MODEL:-eight:latest}"
if ! curl -s "${OLLAMA_URL}/api/tags" | jq -e ".models[] | select(.name == \"${EIGHT_MODEL}\")" > /dev/null 2>&1; then
  log "WARNING: Model '${EIGHT_MODEL}' not found in Ollama — head-to-head may fail"
  log "  Available models:"
  curl -s "${OLLAMA_URL}/api/tags" | jq -r '.models[].name' 2>/dev/null | while read -r m; do
    log "    - $m"
  done
else
  log "  ✓ Model '${EIGHT_MODEL}' available"
fi

# Check jq
if ! command -v jq &> /dev/null; then
  log "FATAL: jq not found (needed for Telegram messages)"
  exit 1
fi
log "  ✓ jq available"

log "All prerequisites OK"

# ── Send Start Notification ────────────────────────────────────────────

TOTAL_CATEGORIES=$(ls -d benchmarks/categories/*/ 2>/dev/null | wc -l | tr -d ' ')
send_telegram "$(cat <<MSG
🏁 *8gent Overnight Competition Started*

📅 $(date '+%Y-%m-%d %H:%M %Z')
🖥 Model: \`${EIGHT_MODEL}\`
📊 Categories: ${TOTAL_CATEGORIES}

*Schedule (PST):*
• 10:45 PM → Warmup (autoresearch × 5)
• 1:00 AM → Head-to-head vs Claude (ALL categories)
• 4:00 AM → Fine-tune (nightly-train)
• 5:30 AM → Re-test battle-test
• 6:00 AM → Sync to 8gent-world
• 7:00 AM → Hard stop

Log: \`${LOG_FILE}\`
MSG
)"

# ══════════════════════════════════════════════════════════════════════
# PHASE 1: Warmup — Autoresearch on battle-test (10:45 PM - 1:00 AM)
# ══════════════════════════════════════════════════════════════════════

PHASE="phase1-warmup"
log_header "PHASE 1: Autoresearch Warmup (battle-test × 5 iterations)"

if check_stop_time; then
  log "Stop time reached before Phase 1"
else
  # Backup and reset autoresearch state
  AUTORESEARCH_STATE="${AUTORESEARCH_DIR}/loop-state.json"
  if [ -f "$AUTORESEARCH_STATE" ]; then
    cp "$AUTORESEARCH_STATE" "${AUTORESEARCH_DIR}/loop-state-pre-competition-${DATE_TAG}.json"
    log "Backed up autoresearch state"
  fi

  log "Running autoresearch warmup: battle-test × 5..."
  CATEGORY="battle-test" MAX_ITERATIONS=5 bun "${AUTORESEARCH_DIR}/autoresearch-loop.ts" 2>&1 | tee -a "$LOG_FILE" || {
    log "WARNING: Autoresearch warmup exited with non-zero status"
  }

  # Backup post-warmup state
  if [ -f "$AUTORESEARCH_STATE" ]; then
    cp "$AUTORESEARCH_STATE" "${AUTORESEARCH_DIR}/loop-state-post-warmup-${DATE_TAG}.json"
  fi

  WARMUP_AVG=$(jq -r '.history[-1].avgScore // "N/A"' "$AUTORESEARCH_STATE" 2>/dev/null || echo "N/A")
  WARMUP_PASSING=$(jq -r '.history[-1].passing // "N/A"' "$AUTORESEARCH_STATE" 2>/dev/null || echo "N/A")
  WARMUP_MUTATIONS=$(jq -r '.mutations | length // 0' "$AUTORESEARCH_STATE" 2>/dev/null || echo "0")

  send_telegram "$(cat <<MSG
✅ *Phase 1 Complete — Warmup Done*

📊 Battle-test avg: ${WARMUP_AVG}%
✓ Passing: ${WARMUP_PASSING}
🧬 Mutations accumulated: ${WARMUP_MUTATIONS}

Moving to Phase 2: Head-to-head vs Claude...
MSG
)"

  log "Phase 1 complete. Avg: ${WARMUP_AVG}%, Passing: ${WARMUP_PASSING}, Mutations: ${WARMUP_MUTATIONS}"
fi

# ══════════════════════════════════════════════════════════════════════
# PHASE 2: Head-to-Head — Claude vs 8gent, ALL categories (1:00 AM - 4:00 AM)
# ══════════════════════════════════════════════════════════════════════

PHASE="phase2-headtohead"
log_header "PHASE 2: Head-to-Head — Claude vs 8gent (ALL categories)"

if check_stop_time; then
  log "Stop time reached before Phase 2"
else
  # Initialize competition state
  cat > "$STATE_FILE" << EOF
{
  "phase": "head-to-head",
  "startedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "model": "${EIGHT_MODEL}",
  "results": {},
  "summary": null
}
EOF

  log "Running overnight-competition.ts (head-to-head on ALL categories)..."
  if [ -f "${COMPETITION_DIR}/overnight-competition.ts" ]; then
    bun "${COMPETITION_DIR}/overnight-competition.ts" 2>&1 | tee -a "$LOG_FILE" || {
      log "WARNING: Head-to-head competition exited with non-zero status"
    }
  else
    log "WARNING: ${COMPETITION_DIR}/overnight-competition.ts not found — running head-to-head.ts instead"
    bun benchmarks/head-to-head.ts 2>&1 | tee -a "$LOG_FILE" || {
      log "WARNING: Head-to-head exited with non-zero status"
    }
  fi

  # Extract results summary
  if [ -f "$STATE_FILE" ]; then
    H2H_WINS=$(jq -r '[.results[].winner // empty] | map(select(. == "8gent")) | length' "$STATE_FILE" 2>/dev/null || echo "?")
    H2H_LOSSES=$(jq -r '[.results[].winner // empty] | map(select(. == "claude")) | length' "$STATE_FILE" 2>/dev/null || echo "?")
    H2H_TIES=$(jq -r '[.results[].winner // empty] | map(select(. == "tie")) | length' "$STATE_FILE" 2>/dev/null || echo "?")
    H2H_TOTAL=$(jq -r '[.results[].winner // empty] | length' "$STATE_FILE" 2>/dev/null || echo "?")
  else
    H2H_WINS="?"
    H2H_LOSSES="?"
    H2H_TIES="?"
    H2H_TOTAL="?"
  fi

  send_telegram "$(cat <<MSG
✅ *Phase 2 Complete — Head-to-Head Results*

🥊 8gent wins: ${H2H_WINS}
🤖 Claude wins: ${H2H_LOSSES}
🤝 Ties: ${H2H_TIES}
📊 Total matchups: ${H2H_TOTAL}

Moving to Phase 3: Fine-tuning...
MSG
)"

  log "Phase 2 complete. 8gent: ${H2H_WINS}W / ${H2H_LOSSES}L / ${H2H_TIES}T (${H2H_TOTAL} total)"
fi

# ══════════════════════════════════════════════════════════════════════
# PHASE 3: Fine-tune — nightly-train.ts (4:00 AM - 5:30 AM)
# ══════════════════════════════════════════════════════════════════════

PHASE="phase3-finetune"
log_header "PHASE 3: Fine-Tune via nightly-train.ts"

if check_stop_time; then
  log "Stop time reached before Phase 3"
else
  NIGHTLY_TRAIN="scripts/nightly-train.ts"
  if [ -f "$NIGHTLY_TRAIN" ]; then
    log "Running nightly-train.ts..."
    bun "$NIGHTLY_TRAIN" 2>&1 | tee -a "$LOG_FILE" || {
      log "WARNING: nightly-train.ts exited with non-zero status"
    }
    send_telegram "$(cat <<MSG
✅ *Phase 3 Complete — Fine-Tuning Done*

🧠 Model updated from competition data
Moving to Phase 4: Re-test battle-test...
MSG
)"
  else
    log "WARNING: ${NIGHTLY_TRAIN} not found — skipping fine-tune phase"
    send_telegram "⚠️ *Phase 3 Skipped* — nightly-train.ts not found"
  fi

  log "Phase 3 complete"
fi

# ══════════════════════════════════════════════════════════════════════
# PHASE 4: Re-test — Battle-test head-to-head (5:30 AM - 6:00 AM)
# ══════════════════════════════════════════════════════════════════════

PHASE="phase4-retest"
log_header "PHASE 4: Re-test battle-test (measure improvement)"

if check_stop_time; then
  log "Stop time reached before Phase 4"
else
  # Run autoresearch on battle-test again to measure post-training improvement
  log "Re-running battle-test to measure improvement..."
  CATEGORY="battle-test" MAX_ITERATIONS=1 bun "${AUTORESEARCH_DIR}/autoresearch-loop.ts" 2>&1 | tee -a "$LOG_FILE" || {
    log "WARNING: Battle-test retest exited with non-zero status"
  }

  AUTORESEARCH_STATE="${AUTORESEARCH_DIR}/loop-state.json"
  RETEST_AVG=$(jq -r '.history[-1].avgScore // "N/A"' "$AUTORESEARCH_STATE" 2>/dev/null || echo "N/A")
  RETEST_PASSING=$(jq -r '.history[-1].passing // "N/A"' "$AUTORESEARCH_STATE" 2>/dev/null || echo "N/A")

  # Calculate improvement
  IMPROVEMENT="N/A"
  if [ "$WARMUP_AVG" != "N/A" ] && [ "$RETEST_AVG" != "N/A" ]; then
    IMPROVEMENT=$(echo "$RETEST_AVG - $WARMUP_AVG" | bc 2>/dev/null || echo "N/A")
  fi

  send_telegram "$(cat <<MSG
✅ *Phase 4 Complete — Re-test Results*

📊 Battle-test avg (post-train): ${RETEST_AVG}%
✓ Passing: ${RETEST_PASSING}
📈 Improvement vs warmup: ${IMPROVEMENT} points

Moving to Phase 5: Sync & summary...
MSG
)"

  log "Phase 4 complete. Post-train avg: ${RETEST_AVG}%, Improvement: ${IMPROVEMENT}"
fi

# ══════════════════════════════════════════════════════════════════════
# PHASE 5: Sync — Push results to 8gent-world (6:00 AM - 6:30 AM)
# ══════════════════════════════════════════════════════════════════════

PHASE="phase5-sync"
log_header "PHASE 5: Sync results to 8gent-world"

if check_stop_time; then
  log "Stop time reached before Phase 5"
else
  SYNC_SCRIPT="${COMPETITION_DIR}/sync-results.ts"
  if [ -f "$SYNC_SCRIPT" ]; then
    log "Running sync-results.ts..."
    SYNC_OUTPUT=$(bun "$SYNC_SCRIPT" 2>&1 | tee -a "$LOG_FILE")
    log "Sync complete"
  else
    log "WARNING: ${SYNC_SCRIPT} not found — skipping sync"
    SYNC_OUTPUT="Sync script not found"
  fi
fi

# ══════════════════════════════════════════════════════════════════════
# Final Summary
# ══════════════════════════════════════════════════════════════════════

PHASE="summary"
log_header "OVERNIGHT COMPETITION COMPLETE"

END_TIME=$(date '+%Y-%m-%d %H:%M %Z')
LOG_SIZE=$(du -h "$LOG_FILE" | cut -f1)

send_telegram "$(cat <<MSG
🏆 *8gent Overnight Competition Complete*

📅 Finished: ${END_TIME}
🖥 Model: \`${EIGHT_MODEL}\`

*Results Summary:*
• Warmup avg: ${WARMUP_AVG:-N/A}% (${WARMUP_MUTATIONS:-0} mutations)
• H2H: 8gent ${H2H_WINS:-?}W / Claude ${H2H_LOSSES:-?}W / ${H2H_TIES:-?}T
• Post-train avg: ${RETEST_AVG:-N/A}%
• Improvement: ${IMPROVEMENT:-N/A} points

*Phases:*
✅ Phase 1: Autoresearch warmup
✅ Phase 2: Head-to-head vs Claude
✅ Phase 3: Fine-tune
✅ Phase 4: Re-test
✅ Phase 5: Sync to 8gent-world

📁 Log: \`${LOG_FILE}\` (${LOG_SIZE})

Good morning James! ☀️
MSG
)"

log "Competition finished at ${END_TIME}"
log "Log file: ${LOG_FILE} (${LOG_SIZE})"
log ""
log "╔══════════════════════════════════════════════════════════════╗"
log "║     OVERNIGHT COMPETITION COMPLETE — Good morning James!   ║"
log "╚══════════════════════════════════════════════════════════════╝"
