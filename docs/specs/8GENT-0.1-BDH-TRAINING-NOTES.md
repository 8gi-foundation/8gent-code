# 8gent 0.1 - BDH Training Notes

**Companion to** `8GENT-0.1-BDH-ORCHESTRATOR.md`
**Captured:** 2026-04-28 from `pathwaycom/bdh@HEAD`
**Local clone:** `~/8gent-bdh/` (kept pristine; do not modify, all our work lives in 8gent-code)
**Status:** Reference only - **no training has been run yet**.

---

## 0. TL;DR for James

- Repo cloned to `~/8gent-bdh/`. 2.2 MB total. Three Python files, ~250 LOC, MIT licensed.
- Out of the box it trains a ~25M model on tiny Shakespeare in a few minutes on CUDA, untested time on MPS.
- **Vocab is byte-level (vocab_size=256).** No tokenizer needed - we feed JSON directly as bytes. This is a small but important architectural property for our use case.
- **Encoder, decoder, and encoder_v parameters are shared across layers.** `n_layer` does **not** multiply the parameter count. Default 6-layer ≈ 25M; we can drop to 5M by shrinking embedding dim and MLP multiplier.
- **MPS caveats exist** (BF16 support, `torch.compile`, autocast). Section 5 has the patch list.
- **Concrete configs for our target sizes** are in Section 4.
- **Phase 0 first run:** James runs `python train.py` once with the upstream defaults to confirm the rig works. Then we patch for our use case.

---

## 1. Repo inventory

```
~/8gent-bdh/
├── LICENSE.md          # MIT, Pathway Technology Inc., 2025
├── README.md           # Paper context + scaling claims + Sudoku benchmark blurb
├── bdh.py              # 172 LOC - the entire model
├── train.py            # 127 LOC - tiny Shakespeare training loop
├── requirements.txt    # 3 lines: torch, numpy, requests
└── figs/               # 3 PNGs (architecture, vocab, scaling)
```

That is everything. There is no test suite, no eval harness, no checkpoint loader, no inference server, no data pipeline. The repo is a reference implementation of the architecture, not a training framework.

**Implication:** we are building the surrounding infrastructure (data pipeline, eval, checkpointing, inference) ourselves. The 8gent-code spec already plans for this in `packages/eight-bdh/`.

---

## 2. Model anatomy (`bdh.py`)

```python
@dataclasses.dataclass
class BDHConfig:
    n_layer: int = 6
    n_embd: int = 256
    dropout: float = 0.1
    n_head: int = 4
    mlp_internal_dim_multiplier: int = 128
    vocab_size: int = 256
```

The core ideas, mapped to lines of code:

| Concept | Where in the code |
|---|---|
| **Byte-level vocab** | `vocab_size: int = 256` (default), feeds raw bytes |
| **Linear attention (no softmax)** | `Attention.forward`: `scores = (QR @ KR.mT).tril(diagonal=-1); return scores @ V` - no softmax in the path |
| **RoPE positional encoding** | `get_freqs`, `phases_cos_sin`, `rope` |
| **ReLU sparsity (monosemanticity source)** | `x_sparse = F.relu(x_latent)` and `y_sparse = F.relu(y_latent)` |
| **Hebbian-style synapse** | `xy_sparse = x_sparse * y_sparse` (excitatory cross-product) |
| **LayerNorm without affine** | `nn.LayerNorm(D, elementwise_affine=False, bias=False)` |
| **Parameter sharing across layers** | `encoder`, `encoder_v`, `decoder` defined once in `__init__`, reused in `for level in range(C.n_layer)` |

The forward pass:
1. Embed tokens, then LayerNorm.
2. For each layer: project to sparse latent, apply linear attention with the sparse Q/K and dense V, project back, multiply with input sparsity (`xy_sparse`), project to embedding dim, add residual.
3. Final projection to vocab logits.

**No softmax. No KV cache. No FFN.** The "MLP" is implicit in the encoder/decoder projections plus the Hebbian product.

This is genuinely small. For comparison, a vanilla 6-layer GPT-2 small at the same hidden dim would have ~10x the parameter count.

---

## 3. Training script anatomy (`train.py`)

What it does out of the box:

```
1. Detect CUDA. If absent, drop to CPU. (MPS is commented out, lines 14-16.)
2. Pick BF16 if CUDA supports it, else FP16.
3. Download tiny Shakespeare to `input.txt` if missing.
4. Build BDH with defaults (~25M).
5. torch.compile the model.
6. AdamW, lr=1e-3, weight_decay=0.1.
7. 3000 iters, batch 32, block 512, log every 100.
8. Generate 100 tokens from "To be or " as sanity check.
```

What it does **not** do (gaps we will fill):

- No eval split, no validation loss tracked.
- No checkpointing. The model dies at the end of the script.
- No early stopping.
- No gradient accumulation (limits effective batch size).
- No mixed-precision on MPS (autocast wrapped in `nullcontext()` for non-CUDA - line 27-31).
- No data loader abstraction; the file is mmap'd raw.
- No metric logging beyond stdout.

**Implication:** for Phase 0 the upstream `train.py` is sufficient to confirm the rig works. For Phase 1 we replace it with our own trainer that handles the JSONL corpus, the two-head loss (decision + concept), and proper checkpointing.

---

## 4. Parameter count math and target configs

Critical insight: **`encoder`, `encoder_v`, and `decoder` are shared across all layers.** Param count is:

```
total ≈ 3 × (n_head × n_embd × N)  +  2 × (vocab_size × n_embd)
where N = mlp_internal_dim_multiplier × n_embd / n_head
```

`n_layer` affects **compute** (how many times we loop through the shared weights) but not **parameter count**.

### Target configs (computed locally, 2026-04-28)

| Target | n_embd (D) | n_head | mlp_mult | N (per-head latent) | Param count |
|---|---|---|---|---|---|
| Phase 0 (5M) | **160** | 4 | **64** | 2,560 | **5.0M** |
| Phase 1 (10M) | **160** | 4 | **128** | 5,120 | **9.9M** |
| Upstream default | 256 | 4 | 128 | 8,192 | 25.3M |
| Stretch (Phase 2 scale-up) | 384 | 8 | 128 | 6,144 | ~24.5M (still under 100M) |

For the spec's "100M scale-up" goal, the lever is `n_embd` and `mlp_mult` together. We will tune empirically; the math just tells us the rough envelope.

### Why these specific configs

- **Phase 0 (160/64):** small enough to train in 1-2h on M2 Max, large enough that the architecture is exercising real capacity. Hits exactly 5M, easy to remember.
- **Phase 1 (160/128):** keeps `n_embd` constant from Phase 0 so we can warm-start if needed. Doubles the latent dim where the sparsity actually lives. Nearly 10M.
- **n_head=4 throughout Phase 0/1:** stay close to upstream defaults until we have signal that more heads help routing tasks specifically.
- **n_layer=6 throughout:** also upstream default. Layer count affects compute, not capacity, so we can revisit later without changing model size.

---

## 5. MPS-specific gotchas (must address before Phase 0)

The upstream script targets CUDA. Running on M2 Max requires a small set of patches:

### 5.1 Device selection

Current (line 13):
```python
device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
```

Patch: prefer MPS over CPU on Apple Silicon.
```python
if torch.cuda.is_available():
    device = torch.device("cuda")
elif torch.backends.mps.is_available():
    device = torch.device("mps")
else:
    device = torch.device("cpu")
```

### 5.2 dtype selection

Current logic (lines 17-21) only enables BF16 for CUDA. **MPS BF16 support has been improving in PyTorch 2.x but is still uneven**, especially for `torch.compile`'d graphs. Safer default for MPS: FP16 with GradScaler, or FP32.

Patch:
```python
if device.type == "cuda" and torch.cuda.is_bf16_supported():
    dtype = "bfloat16"
elif device.type == "mps":
    dtype = "float16"   # or "float32" if FP16 instability shows up
else:
    dtype = "float32"
```

### 5.3 Autocast context

Current (lines 27-31):
```python
ctx = (
    torch.amp.autocast(device_type=device.type, dtype=ptdtype)
    if "cuda" in device.type
    else nullcontext()
)
```

This **disables mixed precision on MPS entirely**, which leaves a lot of perf on the table. Patch:
```python
ctx = (
    torch.amp.autocast(device_type=device.type, dtype=ptdtype)
    if device.type in ("cuda", "mps")
    else nullcontext()
)
```

Caveat: not all ops in BDH may support MPS autocast cleanly. If we see NaN losses or "op not implemented" errors, fall back to `nullcontext()` for MPS and run in pure FP32. Slower, but correct.

### 5.4 `torch.compile` on MPS

Current (line 94):
```python
model = torch.compile(model)
```

`torch.compile` on MPS is **partial** as of PyTorch 2.x. It often works but can hit unsupported ops, especially with custom buffers like the RoPE `freqs` tensor in `bdh.py`.

Patch: make compile opt-in for MPS via env var.
```python
if device.type == "cuda" or os.environ.get("BDH_COMPILE_MPS"):
    model = torch.compile(model)
```

Phase 0 first run: leave compile off on MPS. Confirm correctness first, optimise second.

### 5.5 Pin memory

Current (lines 76-78) only pin-and-async on CUDA. MPS does not benefit from `pin_memory()`. The existing `else` branch (line 81-82) handles this correctly. **No patch needed.**

### 5.6 Summary of MPS patches

Five small edits to `train.py`. Total diff ~15 lines. We will keep the upstream `bdh.py` model file completely untouched in Phase 0.

---

## 6. What runs out of the box

If James runs `python train.py` right now on M2 Max with no patches:

| Behaviour | What happens |
|---|---|
| Device | Falls through to **CPU** (because MPS branch is commented out). |
| dtype | FP16 (because no CUDA, falls to else branch). |
| Autocast | `nullcontext()` (CPU path). |
| `torch.compile` | Runs, may hit MPS-unrelated CPU compile issues. |
| Speed | Painfully slow. CPU FP32 effectively, 25M model, 3000 iters, batch 32, block 512. Estimate **6-10 hours** for the toy run on CPU only. |

Verdict: **do not run upstream `train.py` unmodified on this rig.** The minimum patch is the device selection (Section 5.1). With that, a 25M model on tiny Shakespeare on M2 Max via MPS should take roughly 30-60 minutes for 3000 iters at the upstream config.

---

## 7. Pre-flight checklist (before James runs anything)

Order matters.

### 7.1 Environment

- [ ] Confirm Python 3.11+ available: `python3 --version`
- [ ] Create a venv: `cd ~/8gent-bdh && python3 -m venv .venv && source .venv/bin/activate`
- [ ] Install deps: `pip install -r requirements.txt`
- [ ] Verify torch sees MPS: `python -c "import torch; print(torch.backends.mps.is_available(), torch.backends.mps.is_built())"`. Both must be `True`.

### 7.2 Sanity check (untouched repo)

- [ ] **Skip the upstream `python train.py` invocation.** It will run on CPU and waste hours. Apply Section 5.1 patch first.

### 7.3 Patched smoke test (5 minutes)

- [ ] Apply the 5 patches in Section 5 to a **local copy** (do NOT push to the upstream repo).
- [ ] Drop `MAX_ITERS` from 3000 to 100 in `train.py` for the smoke test.
- [ ] Run `python train.py`. Expected: device prints "mps", loss decreases over 100 iters, sample text generation completes. ~2 minutes.
- [ ] If loss is NaN: disable autocast on MPS (revert Section 5.3). If still NaN: drop dtype to FP32. Re-run.

### 7.4 Phase 0 hello-world (after smoke test passes)

- [ ] Set the 5M config: `BDH_CONFIG = bdh.BDHConfig(n_embd=160, n_head=4, mlp_internal_dim_multiplier=64)`.
- [ ] Replace tiny Shakespeare with our orchestration corpus (Section 8).
- [ ] Run with `MAX_ITERS=3000` (or until loss plateaus on val split).
- [ ] Expected wall-clock on M2 Max: **1-2 hours**.

We are not at 7.4 yet. James runs 7.1 - 7.3 first when he is back at the machine.

---

## 8. Data pipeline (the part that does NOT exist yet)

This is what we have to build before Phase 0 can produce anything useful. Owned by `packages/eight-bdh/scripts/` per the spec.

| File | Status | Purpose |
|---|---|---|
| `collect-replays.ts` | not started | Mine `~/.8gent/sessions/` -> JSONL pairs |
| `generate-synthetic.ts` | not started | Frontier-model prompted corpus |
| `generate-adversarial.ts` | not started | Edge case generator |
| `judge.ts` | not started | AI SDK quality filter |
| `serialize-as-bytes.ts` | not started | JSONL -> byte stream for vocab=256 |
| `split.ts` | not started | train/val/test 90/5/5 |

**Phase 0 minimum:** 1k examples, all from `generate-synthetic.ts`. Frontier-model produces them; judge filters them; serialize converts to bytes; train.py reads bytes directly (this is what byte-level vocab buys us - **no tokenizer step**).

**Phase 0 byte format (proposed):**

Each example is a single byte stream of the form:
```
<STATE_JSON>\n<DECISION_JSON>\n<TRACE_JSON>\n
```
We rely on the byte vocab to learn the JSON structure. Special bytes (0xFE, 0xFF) used as record separators if needed.

This is the cheapest possible path. We can move to a small BPE later if byte-level proves too inefficient on long structured contexts.

---

## 9. Why we are not modifying `~/8gent-bdh/`

The clone stays clean for two reasons:
1. **Easy upstream pulls.** Pathway is actively iterating (the README mentions a 97.4% Sudoku result that is **not** in the open-source repo yet). When they release improvements, we want a clean `git pull`.
2. **All our additions go in `8gent-code`.** Per the spec, `packages/eight-bdh/` houses our trainer, data pipeline, integration. We can subtree-pull `bdh.py` into `packages/eight-bdh/trainer/upstream/` later if we want a vendored copy under our SemVer.

Treat `~/8gent-bdh/` as a read-only reference for now.

---

## 10. Open items for James (when back at machine)

In priority order:

1. **Run the environment check** (Section 7.1). Confirms torch sees MPS.
2. **Apply MPS patches and run the 100-iter smoke test** (Section 7.3). Confirms the rig trains BDH at all.
3. **Decide compile policy on MPS** based on smoke test behaviour. If it works, keep it. If it errors, leave it off.
4. **Approve the proposed 5M and 10M configs** in Section 4. These are calculated, not measured; if Pathway publishes scaling curves we should respect them.
5. **Confirm we want byte-level corpus** (Section 8) for Phase 0, with a path to BPE later if needed.

Once those are confirmed, the next agent (or future-James) can build the data pipeline without further input.

---

## 11. Status snapshot

| Item | Status |
|---|---|
| BDH repo cloned | Yes - `~/8gent-bdh/` |
| Repo inspected | Yes - this doc |
| Param count math verified | Yes - Section 4 |
| Target configs computed | Yes - Section 4 |
| MPS gotchas catalogued | Yes - Section 5 |
| Pre-flight checklist | Yes - Section 7 |
| Patches applied | **No** - James does this when back at the machine |
| Smoke test run | **No** |
| Phase 0 training run | **No** |
| Data pipeline built | **No** |

Nothing has been executed against the model. No GPU cycles consumed. James drives.
