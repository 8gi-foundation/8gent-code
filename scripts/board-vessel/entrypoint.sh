#!/bin/bash
set -e

MEMBER=${BOARD_MEMBER_CODE:-UNKNOWN}
MODE=${VESSEL_MODE:-daemon}
INFERENCE=${INFERENCE_MODE:-proxy}
echo "[board-vessel] Starting vessel for ${MEMBER} in ${MODE} mode (inference: ${INFERENCE})"

# Only start Ollama if in ollama inference mode (factory/local)
if [ "${INFERENCE}" = "ollama" ]; then
  if command -v ollama &>/dev/null; then
    ollama serve &
    sleep 5
    MODEL=${OLLAMA_MODEL:-qwen3:latest}
    echo "[board-vessel] Pulling ${MODEL}"
    ollama pull "${MODEL}"
  else
    echo "[board-vessel] WARN: INFERENCE_MODE=ollama but ollama not installed. Falling back to proxy."
    export INFERENCE_MODE=proxy
  fi
fi

MODEL=${OLLAMA_MODEL:-auto:free}
echo "[board-vessel] ${MEMBER} vessel ready - model: ${MODEL}"

case "${MODE}" in
  autoresearch)
    # Check if we already completed autoresearch recently (prevent restart loop)
    MARKER="/root/.8gent/autoresearch-completed"
    if [ -f "${MARKER}" ]; then
      MARKER_AGE=$(( $(date +%s) - $(stat -c %Y "${MARKER}" 2>/dev/null || stat -f %m "${MARKER}" 2>/dev/null || echo 0) ))
      if [ "${MARKER_AGE}" -lt 3600 ]; then
        echo "[board-vessel] Autoresearch completed ${MARKER_AGE}s ago. Skipping to daemon mode."
        exec bun run packages/board-vessel/vessel.ts
      fi
    fi

    # Autonomous benchmark mode with adaptive HyperAgent pipeline
    ITERS=${AUTORESEARCH_ITERATIONS:-5}
    echo "[board-vessel] AUTORESEARCH mode: ${ITERS} iterations with ${MODEL}"
    bun run /app/scripts/nightly-train.ts \
      --sequential --skip-training \
      --iterations "${ITERS}" \
      --model "${MODEL}" || true

    # Mark completion so restarts don't re-run immediately
    date > "${MARKER}"
    echo "[board-vessel] Autoresearch complete. Falling back to daemon mode."
    exec bun run packages/board-vessel/vessel.ts
    ;;
  daemon)
    # Standard board vessel daemon (default)
    exec bun run packages/board-vessel/vessel.ts
    ;;
  *)
    echo "[board-vessel] Unknown mode: ${MODE}"
    exit 1
    ;;
esac
