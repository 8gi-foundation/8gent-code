#!/usr/bin/env bash
# Run the Terminal-Bench 2.0 easy slice with 8gent-code against a local model.
#
#   benchmarks/terminal-bench/run-easy-slice.sh [model] [task ...]
#
# Defaults: model ollama/qwen3.5:9b, tasks = every task tagged difficulty = "easy"
# in the task folder (4 in the 89-task set: cobol-modernization, fix-git,
# overfull-hbox, prove-plus-comm).
#
# Needs: Docker running, the model served by Ollama (or LM Studio), and
#   TB_HOME  folder holding the fetched harness (default ~/.8gent/bench-harnesses/terminal-bench)
#            with venv/ (harbor installed), tb2-tasks/ (clone of terminal-bench-2).
# One heavy job at a time: refuses to start while the pilot lock is held.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
TB_HOME="${TB_HOME:-$HOME/.8gent/bench-harnesses/terminal-bench}"
MODEL="${1:-ollama/qwen3.5:9b}"
[ $# -gt 0 ] && shift || true

[ -e "$HOME/.8gent/rishi-pilot/pilot.lock" ] && { echo "pilot.lock held, queue this run" >&2; exit 75; }
docker info >/dev/null 2>&1 || { echo "Docker is not reachable" >&2; exit 1; }

if [ ! -f "$REPO/dist/cli.js" ]; then (cd "$REPO" && bun run build); fi

TASKS=("$@")
if [ ${#TASKS[@]} -eq 0 ]; then
  while IFS= read -r f; do TASKS+=("$(basename "$(dirname "$f")")"); done \
    < <(grep -l 'difficulty = "easy"' "$TB_HOME"/tb2-tasks/*/task.toml)
fi

ARGS=()
for t in "${TASKS[@]}"; do ARGS+=(-i "$t"); done

# Telemetry off: nothing leaves the machine except the bun runtime download.
export HARBOR_TELEMETRY=0
export EIGHTGENT_TB_BUNDLE="$REPO/dist/cli.js"
export PYTHONPATH="$HERE${PYTHONPATH:+:$PYTHONPATH}"

exec "$TB_HOME/venv/bin/harbor" run \
  --path "$TB_HOME/tb2-tasks" \
  "${ARGS[@]}" \
  --agent eightgent_harbor:EightGentCode \
  --model "$MODEL" \
  --n-concurrent 1 \
  --jobs-dir "$TB_HOME/jobs" \
  --job-name "easy-$(date +%Y%m%d-%H%M%S)"
