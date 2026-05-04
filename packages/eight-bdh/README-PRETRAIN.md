# BDH pretrain + fine-tune pipeline

Two-stage byte-level training for the 5M BDH orchestrator on M2 Max.

1. **Stage 1 — Pretrain on TinyStories.** Build a small language model that knows English at the byte level. Roughly 500 MB of children's-story text; the model learns spelling, word boundaries, simple syntax.
2. **Stage 2 — Fine-tune on ToolBench.** Continue from the pretrain checkpoint on function-calling data so the model learns the routing format `TASK / TOOLS / CALL`.

Standard cross-entropy loss only, on next-byte prediction. **No ontology head, no auxiliary objective.** Monosemantic synapses are a property of the BDH architecture, not of the loss; the experiment here is whether the architecture earns that property under straight LM pretraining.

## What's in this folder

| File | Stage | Purpose |
|---|---|---|
| `trainer/prep_tinystories.py` | 1 prep | Download `roneneldan/TinyStories`, write `data/tinystories-{train,val}.bin` |
| `trainer/prep_toolbench.py`   | 2 prep | Download Berkeley/Gorilla/ToolBench, write `data/toolbench-{train,val}.bin` |
| `trainer/pretrain_tinystories.py` | 1 train | MPS-patched 5M trainer, writes `checkpoints/tinystories-pretrain.pt` |
| `trainer/finetune_toolbench.py`   | 2 train | Resume from pretrain, train on ToolBench, writes `checkpoints/toolbench-finetune.pt` |
| `trainer/configs/phase-0-5m.json` | both  | Source-of-truth model config (already exists) |

All bin files are flat `uint8` streams the trainer `np.memmap`s. No tokenizer.

## Prereqs (one-time)

```bash
# Upstream BDH model code (defines the BDH and BDHConfig classes the trainers import)
git clone https://github.com/pathwaycom/bdh.git ~/8gent-bdh

# Python deps
pip install torch numpy datasets soundfile  # soundfile only needed for the smoke voice-note path
```

The trainers prefer Python 3.11+. On M2 Max, install `torch` via the regular pypi wheel — it ships with Metal/MPS support.

## Stage 1 — pretrain on TinyStories (~12k iters, ~1-2 h on M2 Max)

```bash
# 1. Build the bins. Takes 5-15 min depending on network and HF cache state.
python3 packages/eight-bdh/trainer/prep_tinystories.py

# 2. Train. Defaults to 12k iters, batch 32, block 512, lr 1e-3.
python3 packages/eight-bdh/trainer/pretrain_tinystories.py
```

Outputs:

- `packages/eight-bdh/checkpoints/tinystories-pretrain.pt`
- `packages/eight-bdh/trainer/local/tinystories-pretrain-train-log.jsonl`
- `packages/eight-bdh/data/tinystories-{train,val}.bin`
- `packages/eight-bdh/data/tinystories-meta.json`

The trainer auto-detects MPS on Apple Silicon and falls back to CPU otherwise. Force a device with `BDH_DEVICE=mps|cpu|cuda`. Useful env knobs:

| Env | Default | What it changes |
|---|---|---|
| `BDH_MAX_ITERS` | 12000 | Total optimisation steps |
| `BDH_BATCH` | 32 | Per-iter batch size |
| `BDH_BLOCK` | 512 | Context length in bytes |
| `BDH_LR` | 1e-3 | AdamW LR |
| `BDH_LOG` | 50 | Iters per stdout train log |
| `BDH_EVAL` | 500 | Iters per eval + checkpoint |
| `BDH_DEVICE` | auto | `cuda` / `mps` / `cpu` |
| `BDH_COMPILE` | 0 | `1` to try `torch.compile` (off by default — flaky on MPS) |
| `BDH_RESUME` | (unset) | Path to a `.pt` to resume training mid-stage |

## Stage 2 — fine-tune on ToolBench (~4k iters, ~30-45 min on M2 Max)

```bash
# 1. Build the ToolBench bins.
python3 packages/eight-bdh/trainer/prep_toolbench.py
# To pin a specific HF dataset:
# python3 packages/eight-bdh/trainer/prep_toolbench.py --dataset gorilla-llm/Berkeley-Function-Calling-Leaderboard

# 2. Fine-tune. Auto-loads tinystories-pretrain.pt, lower lr (2e-4).
python3 packages/eight-bdh/trainer/finetune_toolbench.py
```

Outputs:

- `packages/eight-bdh/checkpoints/toolbench-finetune.pt`
- `packages/eight-bdh/trainer/local/toolbench-finetune-train-log.jsonl`
- `packages/eight-bdh/data/toolbench-{train,val}.bin`
- `packages/eight-bdh/data/toolbench-meta.json`

Fine-tune env knobs (same shape as pretrain):

| Env | Default | Notes |
|---|---|---|
| `BDH_MAX_ITERS` | 4000 | Shorter than pretrain by design |
| `BDH_LR` | 2e-4 | 5x lower than pretrain |
| `BDH_PRETRAIN` | `checkpoints/tinystories-pretrain.pt` | Source weights |
| `BDH_OUT` | `checkpoints/toolbench-finetune.pt` | Where to write the fine-tuned model |
| `BDH_BATCH`, `BDH_BLOCK`, `BDH_LOG`, `BDH_EVAL`, `BDH_DEVICE` | (same defaults as pretrain) |  |

The fine-tune trainer cross-entropy is identical to pretrain; the only difference is the data distribution and a smaller learning rate. The model sees `TASK: ...\nTOOLS: ...\nCALL: ...\n\x00` blocks repeatedly and learns the format implicitly.

## Data formats

**TinyStories bin.** Stories joined with a single 0x00 (NUL) byte:

```
<utf-8 story 1>\x00<utf-8 story 2>\x00<utf-8 story 3>\x00...
```

**ToolBench bin.** Each example is a fixed-shape block followed by 0x00:

```
TASK: book a flight from Dublin to Lisbon\n
TOOLS: [{"name":"flights.search","params":{...}},...]\n
CALL: {"name":"flights.search","args":{"from":"DUB","to":"LIS"}}\n
\x00
```

Both are `np.memmap(..., dtype=np.uint8)` so the trainer never holds the corpus in RAM.

## MPS patches applied

The upstream Pathway `train.py` is CUDA-first with a commented `mps` line. The trainers in this folder add:

- Auto device pick — `cuda` → `mps` → `cpu`, override with `BDH_DEVICE`.
- `float32` on MPS — fp16 autocast and bf16 are flaky on current torch + Apple Metal builds for this model size; we trade some throughput for stability. The 5M model still finishes pretrain in about 1-2 hours on M2 Max.
- No `GradScaler` outside CUDA fp16 — MPS doesn't need it.
- No `pin_memory` / `non_blocking` outside CUDA — Metal-side pinning is not supported.
- `torch.compile` defaulted off — can be flipped on with `BDH_COMPILE=1` when a stable Metal kernel ships.

## Sanity-checking the 5M target

Run `python3 packages/eight-bdh/cli.ts info` to print the architecture constants, or compute by hand:

```
n_embd      D = 160
n_head      nh = 4
mult        m = 64
N = m * D / nh = 2560

embed       256 * D                 =       40,960
encoder     nh * D * N              =    1,638,400
encoder_v   nh * D * N              =    1,638,400
decoder     (nh * N) * D            =    1,638,400
lm_head     D * 256                 =       40,960
                                    -----------
total                                ≈    4,997,120  (~5.0M)
```

`n_layer` controls how many times the BDH block recurs over shared weights — it does not change the param count.

## What this pipeline does NOT do

- No training kicked off. Both stages stop at the prep + checkpoint layer; you launch them manually.
- No `decide()` integration — that lives in `index.ts` and stays gated behind `EIGHT_BDH_ROUTER` per the orchestrator spec.
- No ontology supervision. If you want to compare against a two-head approach, the previous experiments live alongside in `trainer/local/train_phase_*.py` and aren't called by anything in this README.
- No quantisation or vessel deployment. `cli.ts` and the `LocalClient`/`VesselClient` shims handle that on the inference side.
