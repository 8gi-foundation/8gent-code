"""
Probe all 4 trained checkpoints with identical prompts.
Apples-to-apples comparison for the Phase 2 synthesis report.

Run:
  python3 packages/eight-bdh/trainer/local/probe_all_checkpoints.py

Outputs:
  packages/eight-bdh/trainer/local/probe-comparison.json
  human-readable side-by-side to stdout
"""

import json
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[4]
BDH_REPO = Path.home() / "8gent-bdh"
CHECKPOINT_DIR = REPO_ROOT / "packages" / "eight-bdh" / "checkpoints"
LOG_DIR = REPO_ROOT / "packages" / "eight-bdh" / "trainer" / "local"
REPORT_PATH = LOG_DIR / "probe-comparison.json"

sys.path.insert(0, str(BDH_REPO))

import torch
from bdh import BDH, BDHConfig

CHECKPOINTS = {
    "phase-0": CHECKPOINT_DIR / "phase-0-5m.pt",
    "phase-1": CHECKPOINT_DIR / "phase-1-explore-5m.pt",
    "phase-2a": CHECKPOINT_DIR / "phase-2a-scale-5m.pt",
    "phase-2b": CHECKPOINT_DIR / "phase-2b-capacity-10m.pt",
}

# Identical prompts to test all 4 models on the same probes.
PROBES = [
    {
        "id": "doc-continuation",
        "prompt": "<<doc:packages/eight-bdh/MODEL-CARD.md>>\n# Model Card\n\nThe 8gent 0.1 BDH",
        "expected": "doc/markdown style continuation",
    },
    {
        "id": "session-schema",
        "prompt": "<<session:abc12345.json>>\n{\"createdAt\":\"",
        "expected": "valid ISO timestamp + JSON fields",
    },
    {
        "id": "blog-prefix",
        "prompt": "<<blog:content/blog/welcome-to-the-circle.mdx>>\n---\ntitle: \"",
        "expected": "blog title + frontmatter",
    },
    {
        "id": "memorisation-front",
        "prompt": "front",
        "expected": "should NOT regurgitate 'frontier teacher. Diversity is structural'",
    },
    {
        "id": "memorisation-frontier",
        "prompt": "frontier",
        "expected": "should NOT continue 'teacher. Diversity is structural'",
    },
    {
        "id": "no-prefix",
        "prompt": "\n",
        "expected": "default style; what's the model's null distribution?",
    },
    {
        "id": "unseen-tag",
        "prompt": "<<email:user@example.com>>\n",
        "expected": "model has never seen this prefix in training; coherent or noise?",
    },
    {
        "id": "harness-claim",
        "prompt": "8gent is",
        "expected": "completion of a natural English statement; tests if any English emerges",
    },
]


def select_device():
    if torch.cuda.is_available():
        return torch.device("cuda")
    if torch.backends.mps.is_available() and torch.backends.mps.is_built():
        return torch.device("mps")
    return torch.device("cpu")


DEVICE = select_device()
print(f"[probe] device={DEVICE}", flush=True)


def load_checkpoint(path):
    if not path.exists():
        return None
    ckpt = torch.load(path, map_location=DEVICE, weights_only=False)
    cfg_d = ckpt["config"]
    cfg = BDHConfig(
        n_layer=cfg_d["n_layer"],
        n_embd=cfg_d["n_embd"],
        n_head=cfg_d["n_head"],
        mlp_internal_dim_multiplier=cfg_d["mlp_internal_dim_multiplier"],
        dropout=cfg_d["dropout"],
        vocab_size=cfg_d["vocab_size"],
    )
    model = BDH(cfg).to(DEVICE)
    model.load_state_dict(ckpt["model_state_dict"])
    model.eval()
    return model, ckpt


def generate(model, prompt: str, n_tokens: int = 200, temperature: float = 0.7, top_k: int = 40) -> str:
    prompt_bytes = prompt.encode("utf-8")
    if not prompt_bytes:
        prompt_bytes = b"\n"
    idx = torch.tensor([list(prompt_bytes)], dtype=torch.long, device=DEVICE)
    with torch.no_grad():
        out_idx = model.generate(idx, max_new_tokens=n_tokens, temperature=temperature, top_k=top_k)
    new_bytes = out_idx[0, idx.shape[1]:].tolist()
    return bytes(new_bytes).decode("utf-8", errors="replace")


# Memorisation tracking phrases
MEMORISATION_PHRASES = [
    "frontier teacher",
    "Diversity is structural",
    "rule-based-phase-0",
    "Phase 0 heartbeat corpus",
]


def check_memorisation(text: str) -> list[str]:
    """Return list of Phase 0 corpus phrases that appear verbatim in text."""
    return [p for p in MEMORISATION_PHRASES if p in text]


# Run all probes on all checkpoints
results = []
checkpoint_meta = {}

for phase_name, path in CHECKPOINTS.items():
    print(f"\n[probe] === {phase_name}: {path.name} ===", flush=True)
    loaded = load_checkpoint(path)
    if loaded is None:
        print(f"[probe] checkpoint missing: {path}; skipping", flush=True)
        continue
    model, ckpt = loaded
    n_params = sum(p.numel() for p in model.parameters())
    training_meta = ckpt.get("training", {})
    checkpoint_meta[phase_name] = {
        "model_id": ckpt.get("model_id"),
        "params_M": round(n_params / 1e6, 2),
        "best_val_loss": training_meta.get("best_val_loss"),
        "corpus_bytes": training_meta.get("corpus_bytes"),
        "iters": training_meta.get("max_iters"),
        "wall_clock_min": round((training_meta.get("train_seconds") or 0) / 60, 1),
    }
    print(f"  params: {n_params/1e6:.2f}M, best val: {training_meta.get('best_val_loss')}", flush=True)

    for probe in PROBES:
        text = generate(model, probe["prompt"])
        memo = check_memorisation(text)
        results.append({
            "phase": phase_name,
            "probe_id": probe["id"],
            "prompt": probe["prompt"],
            "completion": text,
            "memorisation_hits": memo,
            "completion_first_120": text[:120],
        })
        memo_flag = f" [MEMORISED: {memo}]" if memo else ""
        print(f"  {probe['id']:24s}: {text[:100]!r}{memo_flag}", flush=True)


# Summary stats
def mem_count(phase: str) -> int:
    return sum(len(r["memorisation_hits"]) for r in results if r["phase"] == phase)


def avg_completion_len(phase: str) -> float:
    rows = [r for r in results if r["phase"] == phase]
    if not rows:
        return 0
    return sum(len(r["completion"]) for r in rows) / len(rows)


print("\n[probe] === SUMMARY ===", flush=True)
for phase in CHECKPOINTS.keys():
    if phase not in checkpoint_meta:
        continue
    meta = checkpoint_meta[phase]
    print(
        f"  {phase:10s} {meta['params_M']:>5.2f}M  "
        f"corpus_bytes={meta['corpus_bytes']:>10}  "
        f"best_val={meta['best_val_loss']:.4f}  "
        f"memorisation_hits={mem_count(phase)}",
        flush=True,
    )


with REPORT_PATH.open("w") as fh:
    json.dump({
        "checkpoint_meta": checkpoint_meta,
        "probes": [{"id": p["id"], "prompt": p["prompt"], "expected": p["expected"]} for p in PROBES],
        "results": results,
    }, fh, indent=2)
print(f"\n[probe] wrote {REPORT_PATH.relative_to(REPO_ROOT)}", flush=True)
