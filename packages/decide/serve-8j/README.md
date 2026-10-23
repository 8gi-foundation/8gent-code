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
