#!/usr/bin/env bash
# Iterative Telegram updates while a BDH training run is in flight.
# Reads the training log, picks plain-English summaries based on iter
# count, sends audio (KittenTTS via Jasper voice) + text companion.
#
# Run alongside a training in background:
#   bash packages/eight-bdh/trainer/local/training_monitor.sh \
#     packages/eight-bdh/trainer/local/phase-2a-scale-full-run.log
#
# Sleeps 25 min between checks. Exits when the log shows
# "[done] phase ... complete" or after MAX_CHECKS sweeps.

set -euo pipefail

LOG_PATH="${1:?usage: training_monitor.sh <log_path>}"
SLEEP_SECS="${SLEEP_SECS:-1500}"   # 25 min
MAX_CHECKS="${MAX_CHECKS:-6}"      # 2.5h total monitoring window
PHASE_NAME="${PHASE_NAME:-Phase 2a}"

if [ ! -f "$LOG_PATH" ]; then
  echo "[monitor] log not found at $LOG_PATH; waiting for it" >&2
fi

prev_iter=0

for ((i=1; i<=MAX_CHECKS; i++)); do
  sleep "$SLEEP_SECS"

  if [ ! -f "$LOG_PATH" ]; then
    echo "[monitor] check $i: log still not present" >&2
    continue
  fi

  # Pull the most recent iter line and parse iter + losses
  last_iter_line=$(grep -E "^\[train\] iter" "$LOG_PATH" | tail -1 || true)
  if [ -z "$last_iter_line" ]; then
    echo "[monitor] check $i: no iter lines yet" >&2
    continue
  fi

  iter=$(echo "$last_iter_line" | sed -nE 's/.*iter ([0-9]+)\/([0-9]+).*/\1/p')
  total=$(echo "$last_iter_line" | sed -nE 's/.*iter ([0-9]+)\/([0-9]+).*/\2/p')
  train_loss=$(echo "$last_iter_line" | sed -nE 's/.*train_loss=([0-9.]+).*/\1/p')
  val_loss=$(echo "$last_iter_line" | sed -nE 's/.*val_loss=([0-9.]+).*/\1/p')
  eta_min=$(echo "$last_iter_line" | sed -nE 's/.*eta=([0-9.]+)min.*/\1/p')

  if [ -z "$iter" ] || [ "$iter" = "$prev_iter" ]; then
    echo "[monitor] check $i: no new iters since last check; continuing" >&2
    continue
  fi
  prev_iter="$iter"

  # If training is already done, send a completion teaser and exit
  if grep -q "^\[done\] phase" "$LOG_PATH"; then
    {
      echo "$PHASE_NAME training complete. Final iter $iter of $total. Train loss $train_loss, val loss $val_loss. I'm reading the samples now and will send the full report shortly."
    } | ~/.claude/bin/kittentts-telegram --voice Jasper --caption "$PHASE_NAME complete - report incoming" || true
    {
      echo "$PHASE_NAME finished cleanly at iter $iter / $total."
      echo ""
      echo "Final losses: train $train_loss, val $val_loss."
      echo ""
      echo "I'll fire the verify script and the comparison probes against Phase 1, then post the full report with samples and the next-experiment decision."
    } | ~/.claude/bin/send-telegram || true
    echo "[monitor] training complete detected; exiting"
    exit 0
  fi

  # Plain-English narrative depending on where we are in the run
  pct=$(( iter * 100 / total ))

  if [ "$pct" -le 15 ]; then
    narrative="Just past the warm-up. The model started near five point five which is what random byte-level prediction looks like, and it should drop fast in the first couple hundred iterations as it figures out the broad shape of the corpus."
  elif [ "$pct" -le 40 ]; then
    narrative="Through the rapid-descent phase. Training loss is at $train_loss, validation at $val_loss. The gap between the two is the model's tendency to overfit - small gap means it's generalising, big gap means it's memorising."
  elif [ "$pct" -le 70 ]; then
    narrative="Past the halfway point. Loss curves usually plateau in this stretch. Whatever the val loss settles to is roughly what the final number will be, plus or minus a tenth."
  else
    narrative="Final stretch. Train loss is still ticking down; val loss is the honest signal. The gap right now is $train_loss versus $val_loss."
  fi

  audio_text="$PHASE_NAME update. Iter $iter of $total, about $pct percent done, ETA $eta_min minutes. $narrative"

  echo "$audio_text" | ~/.claude/bin/kittentts-telegram --voice Jasper --caption "$PHASE_NAME at $pct%" || true

  {
    echo "$PHASE_NAME progress: iter $iter / $total ($pct%), ETA $eta_min min."
    echo ""
    echo "Train loss: $train_loss"
    echo "Val loss: $val_loss"
    echo ""
    echo "Plain English: $narrative"
    echo ""
    echo "Phase 1 reference for comparison: best val 1.116 at iter 700 of 2500. Anything below 1.0 here is meaningfully better; anything above 1.2 is meaningfully worse."
  } | ~/.claude/bin/send-telegram || true

  echo "[monitor] check $i sent: iter $iter pct $pct%"
done

echo "[monitor] reached MAX_CHECKS; exiting"
