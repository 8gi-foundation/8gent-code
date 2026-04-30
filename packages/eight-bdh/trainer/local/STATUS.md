# Phase 0 Training Status

**Started:** 2026-04-28 16:43 BST (Tue Apr 28, ~08:43 PST)
**Owner:** Chair James Spalding (autonomous run while James away ~6h)
**Mode:** Heartbeat per spec section 9, Phase 0

## What is running

A 5M-parameter BDH model is training on the M2 Max via MPS for 2500 iterations.

| Setting | Value | Source |
|---|---|---|
| Architecture | BDH (paper-faithful, single-head next-token CE) | spec section 4.4 Option A |
| Parameters | 5.00M (verified at boot) | PHASE_0_5M_CONFIG in types.ts |
| Device | MPS (M2 Max) | M2 Max with 96GB unified |
| Corpus | 1000 rule-based synthetic routing examples | trainer/local/train_phase_0.py |
| Examples seed | 42 | reproducible |
| Max iters | 2500 | reduced from spec's 3000 to fit budget |
| Block size | 512 | upstream default |
| Batch | 32 | upstream default |
| Learning rate | 1e-3 with weight_decay 0.1 | upstream default |
| Optimizer | AdamW with grad clip 1.0 | standard |

## Why rule-based corpus, not Qwen-generated

Phase 0 is a heartbeat per spec section 9. Goal: prove the rig trains, the model learns byte-level structure, the checkpoint saves, the sample output decodes. **Quality of routing decisions is a Phase 1 concern.** Time budget did not allow ~90 min of Qwen 27B inference for 1k examples on top of training. Rule-based deterministic generation produces 1k structurally-valid (state, decision, trace) JSON triples in <1 second, which is sufficient for a heartbeat.

Phase 1 will use the verified open-weight teachers from MODEL-CARD.md section 6.2 (Qwen 3.6 27B + Mistral 7B + DeepSeek-R1 32B), gated on the eval harness landing first per the boardroom decision.

## Smoke test (already passed)

Pre-flight 100-iter run on 200 examples, completed 2026-04-28 16:43 BST.

| Metric | Value | Result |
|---|---|---|
| Boot to first iter | OK | MPS device selected, BDH model loaded at 5.00M params |
| Train loss iter 1 | 5.5692 | Random init (close to log(256) = 5.55) |
| Train loss iter 100 | 0.5807 | Dropped 10x in 100 iters |
| Val loss iter 100 | 0.5466 | Lower than train, no overfit on smoke |
| Wall clock | 8.6 minutes | ~5.2s per iter on M2 Max with block 512 |
| Sample output | Partial JSON syntax | Model learned brace and quote patterns |
| Exit code | 0 | Pipeline complete |

Smoke log archived at `phase-0-smoke-test-log.json`.

## Expected full-run timeline

Based on smoke test rate of 5.2s/iter:

| Stage | ETA | Cumulative |
|---|---|---|
| Boot + corpus generation | 0.05 min | 0.05 min |
| 2500 training iterations | ~217 min (~3.6h) | ~3.6h |
| Save checkpoint + log | 0.5 min | ~3.6h |
| Sample inference | 1 min | ~3.6h |

Pipeline expected to complete around 2026-04-28 20:20 BST.

## Where to find results when training completes

| Artifact | Path |
|---|---|
| Trained checkpoint | `packages/eight-bdh/checkpoints/phase-0-5m.pt` |
| Training log (JSON, full loss curve) | `packages/eight-bdh/trainer/local/phase-0-train-log.json` |
| Stdout / stderr from the run | `packages/eight-bdh/trainer/local/phase-0-full-run.log` |
| Corpus | `packages/eight-bdh/data/phase-0-seed-42.{bin,jsonl}` |

The `.bin` corpus, `.pt` checkpoint, and the full-run `.log` are gitignored (large binaries / non-deterministic). The training-log JSON and the smoke log are committed.

## Heartbeat ship-gate criteria

Per spec section 9 Phase 0:
- Trains end-to-end on local infra: pending (in progress)
- 70% decision-kind accuracy on 100-example toy holdout: not measured in this run (eval harness is a Phase 1 prerequisite)
- <100ms inference latency on M-series: pending (sample inference at end of run)

The spec's 70% accuracy gate cannot be measured today because the rule-based corpus does not have a held-out test set with ground-truth labels. That is exactly why the boardroom moved the eval harness ahead of bulk corpus generation. **Phase 0 success here means the rig trains, not that the model is good.**

## Risks named, in priority order

1. **MPS may hit unsupported ops mid-training.** Smoke test ran 100 iters clean, so this is unlikely but not eliminated. If the run dies, the next run will fall back to CPU (slow but correct) or move to a 10M run on a smaller iteration count.
2. **5M is below the paper's documented 10M-1B range.** Pathway has not published evidence that BDH-GPU learns at 5M. Smoke test shows it does for our byte-level routing corpus. If the full run shows a plateau at high loss, jump straight to 10M for the next run rather than tuning at 5M.
3. **Rule-based corpus has limited semantic diversity.** Model will learn the byte-level grammar quickly and may overfit to template variations. This is OK for Phase 0 heartbeat; Phase 1 corpus from open-weight teachers will fix it.

## What I did NOT do

- Did not pull `pathwaycom/bdh` as a git subtree (spec calls it "Phase 0 step 1, run manually"). Imported from `~/8gent-bdh/` read-only instead. Equivalent for our purposes; the upstream code is unmodified and the runtime is paper-faithful.
- Did not generate corpus via Qwen 3.6 27B locally. Time budget did not allow.
- Did not run an evaluation harness against a labelled gold set. That is the Phase 1 prerequisite per the boardroom decision and the model card.
- Did not wire the trained model into `packages/eight-bdh/index.ts` decide() path. The checkpoint exists; wiring happens after Phase 1 gates pass.

## How to read the loss curve when you return

Open `phase-0-train-log.json` in a viewer. Both `loss_curve_train` and `loss_curve_val` are arrays of `[iter, loss]` pairs. Healthy heartbeat:
- Train loss starts near 5.55 (log 256).
- Both curves drop below 1.0 within the first few hundred iters.
- Val loss tracks train loss without significant divergence (rule-based corpus should not produce meaningful overfit signal).
- Final val loss likely between 0.05 and 0.3 depending on whether the model saturated on the corpus structure.

If train loss is stuck above 4.0 after 500 iters, or NaN appears, the rig is broken and the run failed. If val loss diverges from train by more than 2x, the model is overfitting (still fine for Phase 0, just notable).

End of status.
