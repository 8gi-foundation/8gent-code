# `packages/eight-bdh/trainer/`

Trainer harness for the 8gent 0.1 BDH orchestrator. Phase 0 scaffold.

This directory will host:

1. The pathwaycom/bdh subtree pull (vendored upstream, under `upstream/`).
2. The 8GI trainer harness (Python) that reads our JSON configs, loads our JSONL corpus, and writes checkpoints to `../models/`.

Neither the subtree nor the harness lives in this scaffold PR. The subtree pull is Phase 0 step 1 and is run manually by James after pre-flight passes (see `docs/specs/8GENT-0.1-BDH-TRAINING-NOTES.md` §7).

## Layout

```
trainer/
  configs/
    phase-0-5m.json       # 5M model, 1-2h on M2 Max
    phase-1-10m.json      # 9.9M model, 8-16h overnight
  upstream/               # (future) git subtree of pathwaycom/bdh
  README.md               # this file
```

## `configs/`

Each config is a JSON object with three top-level keys:

- `model`: a `BdhConfig` shape, mirrored exactly from `packages/eight-bdh/types.ts` (`PHASE_0_5M_CONFIG`, `PHASE_1_10M_CONFIG`). Keys: `n_layer`, `n_embd`, `n_head`, `mlp_internal_dim_multiplier`, `dropout`, `vocab_size`.
- `train`: hyperparameters - `lr`, `weight_decay`, `batch_size`, `block_size`, `max_iters`, `log_interval`, `device_priority`, `dtype_priority_mps`, `compile_mps`. Numbers come from `TRAINING-NOTES §4` and `§5`.
- `_meta`: phase index, target param count, wall-clock target on M2 Max, and the spec section the numbers came from.

### Why JSON, not TS

The trainer is Python (PyTorch + MPS). A TypeScript config file would force a TS to Python bridge or a code-generation step. JSON is read natively on both sides with zero ceremony. The TS source of truth (`packages/eight-bdh/types.ts`) is mirrored into JSON by hand for the two configs we have today; the values are pinned by the README and verified by a one-line parse check (see `packages/eight-bdh/README.md`).

If a third config is added, the `BdhConfig` field set in `types.ts` is canonical. If JSON drifts from the TS constant, the JSON is wrong.

## `upstream/`

Empty placeholder. Future home of the pathwaycom/bdh subtree.

Pull command (do NOT run as part of this scaffold):

```
git subtree add --prefix=packages/eight-bdh/trainer/upstream \
  https://github.com/pathwaycom/bdh.git main --squash
```

After the subtree lands, our harness imports `bdh.py` from `upstream/` and applies the five MPS patches catalogued in `TRAINING-NOTES §5` to a local trainer wrapper. The upstream code itself stays unmodified so future `git subtree pull` invocations apply cleanly.

## Why `~/8gent-bdh/` stays untouched

`TRAINING-NOTES §9`. Two reasons, restated briefly:

1. The clone at `~/8gent-bdh/` is a clean read-only reference to upstream. Pathway is iterating (the README mentions a 97.4% Sudoku result that is not in the open-source repo yet); when they release improvements we want a clean `git pull` with zero local diffs.
2. All 8GI additions live in `8gent-code` under `packages/eight-bdh/`. Subtree-pulling `bdh.py` into `trainer/upstream/` later is the path to a vendored copy under our SemVer, without touching the reference clone.

## Pre-flight (TRAINING-NOTES §7)

Before any training run, James runs the environment check (Python 3.11+, venv, `pip install -r requirements.txt`, MPS availability probe) and the 100-iter smoke test against the upstream `train.py` with the five MPS patches applied to a local copy. See `TRAINING-NOTES §7.1 - §7.3`. Do not invoke `python train.py` unmodified - it falls through to CPU and burns hours (`§6`).

## Status

| Item | Status |
|---|---|
| `configs/phase-0-5m.json` | Present (this scaffold) |
| `configs/phase-1-10m.json` | Present (this scaffold) |
| `upstream/` subtree | Not yet pulled |
| Trainer harness | Not yet written |
| Smoke test on M2 Max | Not yet run |

Phase 0 step 1 (subtree pull) is the next action when James is back at the machine.
