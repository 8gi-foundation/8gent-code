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
    # Autonomous benchmark mode with adaptive HyperAgent pipeline
    # After completion, falls back to daemon mode (keeps process alive)
    ITERS=${AUTORESEARCH_ITERATIONS:-5}
    echo "[board-vessel] AUTORESEARCH mode: ${ITERS} iterations with ${MODEL}"
    bun run /app/scripts/nightly-train.ts \
      --sequential --skip-training \
      --iterations "${ITERS}" \
      --model "${MODEL}" || true
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
