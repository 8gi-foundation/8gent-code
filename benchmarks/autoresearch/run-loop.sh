#!/bin/bash
# 8gent vs Claude Code - Autoresearch Runner
# Run this in background: nohup ./run-loop.sh &

# Resolve the repo root from this script's own location so the loop runs
# on any host. The script lives at benchmarks/autoresearch/run-loop.sh.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/../.." || { echo "Cannot resolve repo root" >&2; exit 1; }

LOG_FILE="benchmarks/autoresearch/run.log"
RESULTS_FILE="benchmarks/results.tsv"

echo "Starting autoresearch loop at $(date)" >> $LOG_FILE
echo "═══════════════════════════════════════════════════" >> $LOG_FILE

# Run indefinitely until 8gent wins or manually stopped
while true; do
    echo "Starting iteration at $(date)" >> $LOG_FILE

    # Run the harness
    bun run benchmarks/autoresearch/harness.ts >> $LOG_FILE 2>&1
    EXIT_CODE=$?

    if [ $EXIT_CODE -eq 0 ]; then
        echo "8gent has surpassed Claude Code! Loop complete." >> $LOG_FILE
        break
    fi

    # Short pause before next iteration
    sleep 5
done

echo "Autoresearch loop ended at $(date)" >> $LOG_FILE
