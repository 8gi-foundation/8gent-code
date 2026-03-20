#!/bin/bash
# Run autoresearch using ONLY eight:latest, one benchmark category at a time
# Shorter timeout, single model, no fallback chain confusion

set -e
cd "$(dirname "$0")/.."
source .env 2>/dev/null || true
export OPENROUTER_API_KEY

LOG="$HOME/.8gent/eight-benchmarks-$(date +%Y%m%d-%H%M).log"
TOKEN="8651805768:AAFvSVOMc7U9l2itsBUTWPzgBkPxdle4B4U"
CHAT_ID="5486040131"

log() { echo "[$(date '+%H:%M:%S')] $1" | tee -a "$LOG"; }

send_telegram() {
  local text="$1"
  bun -e "
    fetch('https://api.telegram.org/bot${TOKEN}/sendMessage', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({chat_id:'${CHAT_ID}',text:$(printf '%s' "$text" | jq -Rs .),parse_mode:'Markdown'})
    }).then(r=>r.json()).then(d=>{if(!d.ok)console.error(d.description)})
  " 2>/dev/null
}

# Unload all models, load only eight
log "Clearing VRAM..."
curl -s http://localhost:11434/api/generate -d '{"model":"qwen3:14b","keep_alive":0}' > /dev/null 2>&1
curl -s http://localhost:11434/api/generate -d '{"model":"qwen3.5:latest","keep_alive":0}' > /dev/null 2>&1
curl -s http://localhost:11434/api/generate -d '{"model":"devstral:latest","keep_alive":0}' > /dev/null 2>&1
sleep 5

# Warm up eight
log "Loading eight:latest..."
curl -s http://localhost:11434/api/generate -d '{"model":"eight:latest","prompt":"ready","stream":false,"options":{"num_predict":5}}' > /dev/null 2>&1
log "eight:latest loaded"

send_telegram "🚀 *EIGHT SOLO BENCHMARKS*
Starting battle-test with eight:latest only
$(ollama ps 2>/dev/null | head -3)"

# Override models to use ONLY eight:latest via env
export MODELS_OVERRIDE="ollama::eight:latest"

# Run categories one at a time with 3 iterations each
CATEGORIES=("battle-test" "agentic" "fullstack" "bug-fixing" "ui-design" "long-horizon")

for cat in "${CATEGORIES[@]}"; do
  log "━━━ Starting: $cat ━━━"

  # Reset state for clean run
  cat > benchmarks/autoresearch/loop-state.json << 'EOF'
{"iteration":0,"mutations":[],"history":[],"startedAt":null,"lastRunAt":null}
EOF

  CATEGORY="$cat" MAX_ITERATIONS=2 bun benchmarks/autoresearch/autoresearch-loop.ts 2>&1 | tee -a "$LOG" || true

  # Read results and send telegram
  RESULT=$(python3 -c "
import json
try:
  s=json.load(open('benchmarks/autoresearch/loop-state.json'))
  if s.get('history'):
    h=s['history'][-1]
    scores='\\n'.join([f'  {\"✅\" if v>=80 else \"⚠️\" if v>=50 else \"❌\"} {k}: {v}' for k,v in sorted(h.get('scores',{}).items())])
    print(f'Avg: {h[\"avgScore\"]} | Pass: {h[\"passing\"]}/{h[\"total\"]}\\n{scores}')
  else:
    print('No results')
except: print('Parse error')
" 2>/dev/null)

  send_telegram "📊 *$cat complete*
$RESULT
_Next category starting..._"

  # Brief cooldown
  sleep 30
done

send_telegram "🏁 *ALL CATEGORIES DONE*
Check logs: $LOG
_Good morning James!_"

log "Done!"
