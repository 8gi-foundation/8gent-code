#!/bin/bash
set -e

echo "[factory] Starting vessel ${VESSEL_ID:-001}"

# Start Ollama in background
ollama serve &
OLLAMA_PID=$!
sleep 5

# Pull the model (qwen3.5 - faster than 14B)
echo "[factory] Pulling qwen3.5:latest"
ollama pull qwen3.5:latest

# Clone the repo
echo "[factory] Cloning repo"
git clone https://github.com/8gi-foundation/8gent-code.git /app/repo
cd /app/repo

# Auth with GitHub
echo "$GH_TOKEN" | gh auth login --with-token

# Vessel-specific queue slice: 100 items per vessel, offset by VESSEL_ID
VESSEL_ID=${VESSEL_ID:-001}
VESSEL_NUM=${VESSEL_ID#0}
VESSEL_NUM=${VESSEL_NUM#0}  # strip double leading zeros (001 -> 1)
OFFSET=$(( (VESSEL_NUM - 1) * 100 ))

echo "[factory] Vessel $VESSEL_ID: offset=$OFFSET count=100"

# Run factory with slice
bun run scripts/utility-factory.ts --offset $OFFSET --count 100

echo "[factory] Vessel $VESSEL_ID complete"

# Keep Ollama running until the factory finishes (already done above)
kill $OLLAMA_PID 2>/dev/null || true
