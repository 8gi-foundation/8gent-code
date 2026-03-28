#!/bin/bash
set -e

MEMBER=${BOARD_MEMBER_CODE:-UNKNOWN}
echo "[board-vessel] Starting vessel for ${MEMBER}"

# Start Ollama in background
ollama serve &
OLLAMA_PID=$!
sleep 5

# Pull the model
MODEL=${OLLAMA_MODEL:-qwen3:latest}
echo "[board-vessel] Pulling ${MODEL}"
ollama pull "${MODEL}"

echo "[board-vessel] ${MEMBER} vessel ready - launching daemon"

# Run the board vessel daemon
exec bun run /app/scripts/board-vessel/daemon.ts
