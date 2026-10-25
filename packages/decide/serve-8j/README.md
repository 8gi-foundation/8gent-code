# serve-8j

Serves **8J** on this machine for `packages/decide` (the `8j` backend, `backends/eightj.ts`).

8J is Artale's System One decision model, published as HF `8GI/8j`: a Qwen3-0.6B backbone with a
LoRA adapter and a small attention head that scores named options in one forward pass, with no
generation. The model, its training and its card are Artale's work. This folder is the
`serve_8j.py` the card names, which was not published with the weights, plus an inference-only
rebuild of the 8GI/8j-eval Space's loading code.

| File | What it is |
|---|---|
| `judge8j.py` | Inference only. The Space's prompt layout, position ids, attention mask and head, token for token. The LoRA adapter is merged into the backbone weights at load time (`W += alpha/r * B @ A`), so serving needs no PEFT. Every name and path comes from the checkpoint's `meta.json` and `adapter_config.json`. |
| `serve_8j.py` | `POST /v1/systemone` and `GET /health`, stdlib `http.server`, one request at a time. Binds to a loopback address only (IPv4 `127.0.0.0/8`, IPv6 `::1`, or `localhost`) and refuses anything else. Never logs a request. A model error is a 500 with no verdict. |
| `parity_check.py` | Proves `judge8j` matches the Space's own `answer()` on recorded commands. |
| `test_serve_8j.py` | HTTP layer with a fake model: contract, validation, loopback-only, 500 on model error. Stdlib only. |
| `export_onnx.py` | ONNX export of the merged backbone plus head, then weight-only 8-bit quantisation. Writes outside the repo. |
| `run_onnx.py` | The phone side: numpy plus onnxruntime only. Rebuilds the inputs from token spans, prints pYes per prompt, latency p50/p95 and peak RSS. |
| `onnx_check.py` | Agreement of the fp32 and int8 graphs with judge8j on the held-out judge-set split, and the encoded split for `run_onnx.py`. |
| `phone/test-split.jsonl` | The 187 held-out guard prompts (PR #4863), tokenised. Token ids only, no weights. |
| `test_run_onnx.py` | `run_onnx.inputs` layout rules. numpy only. |

## Run

```bash
# a venv with the pyproject dependencies (torch, transformers, safetensors)
python serve_8j.py --ckpt ~/.8gent/models/8j/<run> --port 8086
# then, for 8gent-code:
export EIGHT_8J_URL=http://127.0.0.1:8086
```

The checkpoint is a published run folder from `8GI/8j` (`meta.json`, `adapter_config.json`,
`adapter_model.safetensors`, `head.pt`, `temperatures.json`). The backbone named in `meta.json`
loads through the Hugging Face cache (`HF_HOME`; `HF_HUB_OFFLINE=1` once cached).

## Contract

```
POST /v1/systemone
{"state": "...", "guidance": "optional",
 "questions": {"<id>": {"type": "noul" | "choice" | "score", "instructions": "...",
                        "criteria": {"false": "...", "true": "..."} | {"<key>": "<text>" | null} | ["<level>", ...]}}}
-> {"model": "<run>", "answers": {"<id>": {"type": "noul", "noul": p_yes}
                                         | {"type": "choice", "choice": "<key>", "probabilities": {"<key>": p}}
                                         | {"type": "score", "score": e, "probabilities": [p, ...]}},
    "latency_ms": n}
GET /health -> {"ok": true, "model": "<run>", "base": "<backbone>"}
```

Probabilities only. Thresholds belong to the caller: `packages/decide/calibration/8j-<model>.json`.

## Evidence

- Parity, 23 Oct 2026: 84 commands, rebuilt vs the Space's `answer()` on CPU fp32, largest
  `|p_yes difference|` 6.1e-6 (`parity_check.py --tol 1e-4` passes).
- `python -m unittest test_serve_8j`: 10 tests (the `::1` bind skips on a host with no IPv6).

## Phone runtime (ONNX)

```bash
python export_onnx.py --ckpt ~/.8gent/models/8j/<run> --out ~/.8gent/models/8j/onnx
python onnx_check.py --ckpt ~/.8gent/models/8j/<run> --onnx-dir ~/.8gent/models/8j/onnx \
  --results <judge-set results.json> --calibration <calibration/8j-<run>.json> --write-encoded phone/test-split.jsonl
python run_onnx.py --model ~/.8gent/models/8j/onnx/8j-int8.onnx --meta ~/.8gent/models/8j/onnx/8j-meta.json \
  --encoded phone/test-split.jsonl
```

Agreement on the 187 held-out prompts (23 Oct 2026, Mac). Tolerances were set before the run:

| | tolerance | measured |
|---|---|---|
| inputs rebuilt by `run_onnx.inputs` equal judge8j's tensors | all | 187 / 187 |
| fp32 ONNX vs judge8j | max \|dp\| <= 1e-4 | 1.9e-5, pass |
| int8 vs judge8j | max \|dp\| <= 0.02 | **0.0276, fail** (6 of 187 over; mean 0.0047) |
| int8 verdict changes at the fitted lines (0.096898, 0.217487) | 0 | **0**, pass |

int8 here is weight-only 8-bit (`MatMulNBits`, blocks of 32, symmetric). Activations stay fp32,
and the 622 MB embedding table stays fp32, so the file is 1.06 GB. Variants measured on the same
prompts:

| variant | max \|dp\| | verdict changes |
|---|---:|---:|
| dynamic int8 (`quantize_dynamic`, activations quantised too) | 0.757 | 75 |
| dynamic int8, per-channel, weight matmuls only | 0.676 | 78 |
| weight-only, blocks of 16 | 0.030 | 0 |
| weight-only, head left fp32 | 0.028 | 0 |
| weight-only, asymmetric | 0.045 | 2 |

Mac reference, not a phone: `run_onnx.py` on the int8 graph gave p50 535 ms, p95 650 to 812 ms and
peak RSS about 2.6 GB, measured with the machine's load average around 16. Phone numbers come
from CI on the termux arm64 image. `phone/test-split.jsonl` is already tokenised, so those
numbers exclude tokenisation; the phone still needs a tokenizer to judge live commands.
