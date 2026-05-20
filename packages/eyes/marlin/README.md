# packages/eyes/marlin

The Marlin+Whisper video understanding sidecar for 8gent-code.

Spec: [`docs/specs/VIDEO-INGESTION.md`](../../../docs/specs/VIDEO-INGESTION.md). This package implements section 4 (process model, lifecycle, MPS) and section 5 (JSON-RPC API). Issue: [#2631](https://github.com/8gi-foundation/8gent-code/issues/2631).

## What it is

A long-lived Python process that speaks newline-delimited JSON-RPC 2.0 over stdin/stdout. It runs two models warm:

- **Marlin-2B** (vision) - produces a scene paragraph and timestamped visual events. It sees. It has no audio tower.
- **mlx-whisper** (ASR) - produces a speech transcript. It hears.

The `extract` method fuses both onto one media timeline. The TS `extract_video` tool (issue #2632, separate PR) is the only intended caller.

## Why a Python sidecar

8gent-code is Bun/TS. Marlin needs PyTorch. The Python dependency is quarantined to this one package; the rest of the path stays Bun/TS. The sidecar is a separate process (not in-agent code), which also satisfies the #2326 sandboxing requirement for `trust_remote_code` (spec section 10).

## Running

```bash
# JSON-RPC sidecar on stdio
python -m marlin_sidecar

# or via the console script
marlin serve

# benchmark (stub - needs real weights)
marlin bench /path/to/video.mp4
```

`MARLIN_SIDECAR_MOCK=1` swaps in the deterministic mock model so the protocol can be exercised with no weights installed:

```bash
printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","method":"initialize","id":1}' \
  '{"jsonrpc":"2.0","method":"health","id":2}' \
  | MARLIN_SIDECAR_MOCK=1 python -m marlin_sidecar
```

`MARLIN_SIDECAR_IDLE_SEC` overrides the idle-shutdown timeout (default 300s).

## JSON-RPC methods

| Method | Purpose |
|--------|---------|
| `initialize` | Load both models. Idempotent. Returns device, model ids, load time. |
| `caption` | Single-window scene + events. Pure primitive: never chunks. |
| `find` | Resolve a natural-language query to a time span. |
| `transcribe` | Whisper over the full audio track. No window limit. |
| `extract` | `caption` (with internal chunk-and-merge) plus `transcribe`. Returns a `VideoExtraction`. |
| `health` | Liveness and resource snapshot. |
| `shutdown` | Graceful stop. |

Error codes are the full `-32xxx` / `-33xxx` range from spec section 5.8.

## Chunk-and-merge

Marlin caps at ~2 minutes per window. `extract` splits longer videos into windows, captions each, rebases window-relative timestamps onto the absolute timeline, seam-dedups events across window boundaries, and clamps to duration. `caption` stays a single-window primitive; the chunking lives in `extract` (`chunk.py`).

## Architecture

```
server.py     run loop, ready handshake, idle shutdown
protocol.py   JSON-RPC 2.0 framing, dispatch, error serialisation
handlers.py   the seven method handlers + Session state
chunk.py      chunk-and-merge math (plan, rebase, seam-dedup, clamp)
model.py      VideoModel interface + MockVideoModel + MarlinVideoModel
errors.py     RpcError and the spec section 5.8 error constructors
constants.py  model ids, pinned revision, limits, error codes
cli.py        `marlin` console script (serve, bench)
```

The `VideoModel` interface is what makes the protocol, error codes, lifecycle and chunk math testable without weights. `MockVideoModel` returns deterministic fixtures; `MarlinVideoModel` is the real (gated, unverified) implementation.

## Install (production)

Per spec section 11, this package is **not** bundled by default. A fresh `npm install -g @8gi-foundation/8gent-code` carries no Python. The video capability is opt-in: `8gent vision install` provisions a `uv`-managed venv under `~/.8gent/venvs/marlin/` and installs the inference dependencies (~2.5GB of wheels).

## Tests

```bash
uv pip install pytest
python -m pytest tests/
```

The suite (79 tests) covers the JSON-RPC protocol, every error code, the chunk-and-merge math, and the run-loop lifecycle - all against the mock model. **It does not test real inference.**

## Honest constraints

- `NemoStation/Marlin-2B` is a **gated** HuggingFace repo. Its weights and the `trust_remote_code` commit hash cannot be downloaded in the build environment. `MARLIN_REVISION` in `constants.py` is a clearly-marked placeholder (`PLACEHOLDER_PENDING_HF_ACCESS`), not a guessed hash. `MarlinVideoModel.load` refuses to load while the placeholder is in place.
- Real inference is **unverified**. `MarlinVideoModel.caption` / `find` are intentionally left unimplemented (they raise a clear error) because they depend on `modeling_marlin.py`, which is gated. They must be filled in against the real model after HF access lands.
- `marlin bench` is a **stub**. It needs real weights to produce a latency number. Per the verify-before-claiming rule, no roadmap line may claim "runs locally at X seconds" until `bench` produces a real measurement on hardware.
