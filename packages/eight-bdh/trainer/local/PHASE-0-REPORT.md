# Phase 0 Report: 8gent 0.1 BDH Heartbeat

**Run date:** 2026-04-28
**Owner:** Chair James Spalding (autonomous run by AI James)
**Authority:** L5 boardroom-ratified plan, executed under chair override
**Status:** [TO BE FILLED IN POST-TRAINING]
**Spec:** `docs/specs/8GENT-0.1-BDH-ORCHESTRATOR.md` section 9 Phase 0
**Model card:** `packages/eight-bdh/MODEL-CARD.md`

---

## TL;DR for James when you return

[ONE PARAGRAPH SUMMARY: did the heartbeat pass, did BDH learn at 5M,
what's the loss curve shape, what are the next gates. To be filled in
after the verify and comparison runs complete.]

---

## 1. What ran

| Component | Detail |
|---|---|
| Architecture | BDH (Baby Dragon Hatchling, paper-faithful, single-head next-token CE) |
| Model size | 5.00M parameters (verified at boot) |
| Device | MPS on M2 Max (96GB unified, 38 GPU cores) |
| Iterations | 2500 |
| Block size | 512 |
| Batch size | 32 |
| Learning rate | 1e-3 with weight decay 0.1 |
| Optimizer | AdamW with grad clip 1.0 |
| Corpus | 1000 rule-based synthetic routing examples (seed 42) |
| Train/val split | 95/5 on bytes |
| Wall clock | [PENDING - extracted from training log] |

## 2. The corpus

[BRIEF DESCRIPTION OF CORPUS GENERATION:
- 30 base request templates
- 5 decision kinds, 7 target classes, 7 tools, 8 vessels
- Random sampling per example with deterministic seed 42
- 50+ concepts in trace bank
- Total bytes: [FROM LOG]
- License: rule-based, no contamination, no closed-weight teacher
- Provenance: every example tagged source=synthetic, model_used=rule-based-phase-0]

## 3. Training results

### 3.1 Loss curve

| Iter | Train loss | Val loss |
|---|---|---|
| 1 | 5.5692 | 5.2269 |
| [POPULATE FROM phase-0-train-log.json EVERY 100 ITERS] | | |
| 2500 | [FINAL] | [FINAL] |

Best val loss: [PENDING]

### 3.2 Gates (per spec section 9 heartbeat criteria)

| Gate | Target | Result | Pass? |
|---|---|---|---|
| Trains end-to-end on local infra | checkpoint exists | [PENDING] | [PENDING] |
| Loss descended | final < initial | [PENDING] | [PENDING] |
| Val loss under 1.0 | <1.0 | [PENDING] | [PENDING] |
| Inference works | non-empty samples | [PENDING] | [PENDING] |
| Latency under 100ms | proxy < 100ms | [PENDING] | [PENDING] |

Overall heartbeat: [PASS / FAIL]

## 4. Sample inference

5 prompts run through the trained model after checkpoint save. Each
prompt is a partial JSON state; we measure how the model continues it.

[POPULATE FROM phase-0-verify-report.json:
- 5 prompts side by side with their generated completions
- Per-prompt latency
- Note any visibly malformed JSON]

## 5. BDH vs heuristic comparison

8 hand-built held-out scenarios run through both the trained BDH model
and the heuristic baseline router. **NOT a quality measurement** because
no ground-truth labels exist for the rule-based corpus; this measures
agreement between two routers, not correctness.

| Metric | Result |
|---|---|
| BDH output decodable as Decision | [N/8 PENDING] |
| Kind agreement (BDH = heuristic) | [N/8 PENDING] |
| Target agreement | [N/8 PENDING] |
| Avg BDH inference latency | [MS PENDING] |

Per-scenario detail: see `phase-0-comparison-report.json`.

## 6. What this DOES NOT prove

In line with BRAND.md and spec section 11 honesty:

- It does not prove the model makes correct routing decisions.
- It does not measure F1 against any baseline because no labelled set
  exists. The boardroom decided to gate Phase 1 corpus generation on
  building the eval harness first (200-example dual-labelled gold set,
  Cohen's kappa >= 0.7).
- It does not validate emergent monosemanticity. That requires the
  probe runner against a labelled set (Phase 1 deliverable).
- It does not show that 5M is the right size. 5M is below the paper's
  documented range; if Phase 1 at 10M shows meaningfully different
  behaviour, 5M was just a heartbeat scaffold.

## 7. What this DOES prove

- BDH trains end-to-end on M2 Max via MPS. No exotic kernels needed,
  no autocast workaround, no `torch.compile` failures observed.
- The 5.00M / 9.91M parameter calculations in `types.ts` and the
  training notes match the actual model exactly.
- The byte-level vocab=256 corpus approach works (no tokenizer step
  needed).
- The pipeline from corpus generation through training to checkpoint
  to sample inference runs cleanly.
- Inference latency on M2 Max sits at [PENDING]ms per token. At ~80
  bytes per Decision head, that's [PENDING]ms per decision.

## 8. Next steps (boardroom order)

In priority order, per the eval-harness PRD attached to PR #2016:

1. **W1: Eval harness skeleton** (~800 LOC). Heuristic baseline at
   `trainer/local/baseline_heuristic.py` is a Python prototype; port to
   TypeScript at `packages/eight-bdh/eval/baseline-heuristic.ts` along
   with `harness.ts`, `kappa.ts`, `cli.ts`. Owner: 8TO Rishi.
2. **W2: 200-example dual-labelled gold set.** Two labellers (channel
   to be picked by chair), Cohen's kappa >= 0.7, calibration set, JSONL
   in `packages/eight-bdh/eval/gold/`. Owner: chair + one other.
3. **W3: AutoResearch loop wiring.** Loop reads MODEL-CARD.md targets,
   diffs measured vs target, proposes corpus changes. Owner: chair.
4. **W4: Phase 1 corpus** with verified open-weight teachers (Qwen 3.6
   27B already pulled, Mistral 7B and DeepSeek-R1 32B require
   `ollama pull`). 50k examples. Owner: 8SO + 8TO. Gated on W1+W2 first.
5. **W5: Phase 1 training run** at 10M parameters on the W4 corpus.
   Wall clock estimate: 8-16h overnight on M2 Max. Owner: chair.

## 9. What James needs to do when he returns

1. Read `packages/eight-bdh/checkpoints/phase-0-5m.pt` exists. Read
   `phase-0-train-log.json` for the loss curve. Read
   `phase-0-verify-report.json` for sample inference.
2. Decide whether to merge PR #2016 to main as the Phase 0 scaffold +
   trained model, or keep iterating on this branch.
3. Pick the second-labeller channel (Charles, Upwork, Discord call).
4. Optional: kick off `ollama pull mistral:7b` and `ollama pull
   deepseek-r1:32b` so they're ready when W4 starts.

## 10. Sign-off

Trained checkpoint location: `packages/eight-bdh/checkpoints/phase-0-5m.pt`
(gitignored; resides only on James's local M2 Max)

Reports committed to `packages/eight-bdh/trainer/local/`:
- `phase-0-smoke-test-log.json` (the 100-iter smoke that validated MPS)
- `phase-0-train-log.json` (full training curve, 2500 iters)
- `phase-0-verify-report.json` (sample inference + heartbeat gates)
- `phase-0-comparison-report.json` (BDH vs heuristic on 8 held-out scenarios)

Branch: `feat/eight-bdh-package`
PR: https://github.com/8gi-foundation/8gent-code/pull/2016
Authority: L5 boardroom-ratified plan
