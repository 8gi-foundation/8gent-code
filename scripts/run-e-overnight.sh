#!/bin/bash
# Run E — Overnight local pipeline: Gemma 4 via LMStudio, full sequential HyperAgent
# Rishi merges the PR once acceptance criteria are met.

set -e

REPO="/Users/jamesspalding/8gent-code"
BRANCH="research/run-e-gemma4-lmstudio"
ISSUE=1232
LOG="$HOME/.8gent/nightly.log"
RESULTS_SNAPSHOT="$REPO/research-log-run-e.json"

echo "[RUN-E] Starting at $(date)" | tee -a "$LOG"

cd "$REPO"
git checkout "$BRANCH"

# Clear old checkpoint so we start fresh
rm -f "$HOME/.8gent/run-checkpoint.json"

# Run the nightly train — 8 iterations, full sequential pipeline, LMStudio Gemma 4
INFERENCE_MODE=lmstudio \
LM_STUDIO_HOST=http://127.0.0.1:1234 \
  ~/.bun/bin/bun run scripts/nightly-train.ts \
  --iterations 8 \
  --model google/gemma-4-26b-a4b \
  --sequential \
  --skip-training

echo "[RUN-E] Pipeline complete at $(date)" | tee -a "$LOG"

# Snapshot the nightly log and learnings into the branch
cp "$HOME/.8gent/nightly.log" "$REPO/research/run-e-nightly.log" 2>/dev/null || true
cp "$HOME/.8gent/benchmark-learnings.log" "$REPO/research/run-e-learnings.log" 2>/dev/null || true
mkdir -p "$REPO/research"

# Write a brief results summary
PASS_COUNT=$(grep -c "→ PASS" "$HOME/.8gent/nightly.log" 2>/dev/null || echo 0)
FAIL_COUNT=$(grep -c "→ FAIL" "$HOME/.8gent/nightly.log" 2>/dev/null || echo 0)
AVG=$(grep "Benchmark summary" "$HOME/.8gent/nightly.log" 2>/dev/null | tail -1 || echo "unknown")

cat > "$REPO/research/run-e-summary.md" << SUMMARY
# Run E Results — $(date)

**Model:** google/gemma-4-26b-a4b (LMStudio local)
**Pipeline:** Full sequential — Analyst → Critic → Implementer
**Iterations:** 8

## Scores
- Total PASS: $PASS_COUNT
- Total FAIL: $FAIL_COUNT
- Last iteration: $AVG

## Learnings
See \`run-e-learnings.log\` for critic rejection patterns and failure analysis.
SUMMARY

git add research/ 2>/dev/null || true
git commit -m "research: Run E results — Gemma 4 LMStudio sequential pipeline

$(date): 8-iteration overnight run complete.
PASS: $PASS_COUNT | FAIL: $FAIL_COUNT
Last: $AVG

Closes #$ISSUE" 2>/dev/null || true

git push origin "$BRANCH" 2>/dev/null || true

# Open PR for Rishi to review and merge
gh pr create \
  --title "research: Run E — Gemma 4 LMStudio sequential pipeline results" \
  --body "$(cat <<PR
## Run E Complete

**Model:** google/gemma-4-26b-a4b (LMStudio, local 26B)
**Pipeline:** Full Analyst → Critic → Implementer (Run D sequential, enabled for first time locally)
**Iterations:** 8

## Results
- PASS: $PASS_COUNT
- FAIL: $FAIL_COUNT
- Summary: $AVG

## Files
- \`research/run-e-nightly.log\` — full run log
- \`research/run-e-learnings.log\` — critic rejection patterns
- \`research/run-e-summary.md\` — this summary

## Acceptance Criteria
- [ ] Average score ≥ 40
- [ ] At least 1 iteration ≥ 70
- [ ] No crash loops

Resolves #$ISSUE

cc @podjamz — Rishi to review and merge when criteria are met.
PR
)" \
  --base main \
  --head "$BRANCH" || echo "[RUN-E] PR already exists or failed — check GitHub"

echo "[RUN-E] Done. PR opened for Rishi." | tee -a "$LOG"
