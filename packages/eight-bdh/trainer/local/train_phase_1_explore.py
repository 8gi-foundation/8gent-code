"""
Phase 1 exploratory training: 5M BDH on the harness's natural data stream.

Per chair amendment 2026-04-28 (spec section 0.5): no labelled corpus,
no router-specific gates. Train on what the harness actually produces:
session replays, spec docs, the model card, the boardroom decision
docs, the Phase 0 corpus, public blog content. Let capabilities surface
from data quality.

Same architecture as Phase 0 (5M, paper-faithful, no concept supervision)
so the run is apples-to-apples on capacity, different on data quality.

Run:
  python3 packages/eight-bdh/trainer/local/train_phase_1_explore.py

Outputs:
  packages/eight-bdh/checkpoints/phase-1-explore-5m.pt
  packages/eight-bdh/data/phase-1-explore-corpus.bin
  packages/eight-bdh/trainer/local/phase-1-explore-train-log.json

Env overrides (same as train_phase_0.py):
  BDH_MAX_ITERS=2500
  BDH_BATCH=32
  BDH_BLOCK=512
  BDH_SEED=43
  BDH_DEVICE=mps
  BDH_SESSION_SAMPLES=200      (how many session replays to include)
"""

import json
import math
import os
import random
import re
import sys
import time
from pathlib import Path

# ── Paths ───────────────────────────────────────────────────────────────

REPO_ROOT = Path(__file__).resolve().parents[4]
BDH_REPO = Path.home() / "8gent-bdh"
HARNESS_HOME = Path.home() / "8gent-dev"
WORLD_REPO = Path.home() / "8gent-world"
SESSIONS_DIR = Path.home() / ".8gent" / "sessions"

DATA_DIR = REPO_ROOT / "packages" / "eight-bdh" / "data"
CHECKPOINT_DIR = REPO_ROOT / "packages" / "eight-bdh" / "checkpoints"
LOG_DIR = REPO_ROOT / "packages" / "eight-bdh" / "trainer" / "local"

DATA_DIR.mkdir(parents=True, exist_ok=True)
CHECKPOINT_DIR.mkdir(parents=True, exist_ok=True)

sys.path.insert(0, str(BDH_REPO))

import numpy as np
import torch
import torch.nn.functional as F
from bdh import BDH, BDHConfig

# ── Env config ──────────────────────────────────────────────────────────

MAX_ITERS = int(os.environ.get("BDH_MAX_ITERS", "2500"))
BATCH_SIZE = int(os.environ.get("BDH_BATCH", "32"))
BLOCK_SIZE = int(os.environ.get("BDH_BLOCK", "512"))
SEED = int(os.environ.get("BDH_SEED", "43"))
SESSION_SAMPLES = int(os.environ.get("BDH_SESSION_SAMPLES", "200"))
LR = 1e-3
WEIGHT_DECAY = 0.1
LOG_INTERVAL = 100

MODEL_CFG = BDHConfig(
    n_layer=6,
    n_embd=160,
    n_head=4,
    mlp_internal_dim_multiplier=64,
    dropout=0.1,
    vocab_size=256,
)

# ── Device selection ───────────────────────────────────────────────────


def select_device():
    requested = os.environ.get("BDH_DEVICE", "mps")
    if requested == "cpu":
        return torch.device("cpu")
    if requested == "cuda" and torch.cuda.is_available():
        return torch.device("cuda")
    if torch.backends.mps.is_available() and torch.backends.mps.is_built():
        return torch.device("mps")
    return torch.device("cpu")


DEVICE = select_device()
print(f"[boot] device={DEVICE} torch={torch.__version__}", flush=True)
print(f"[boot] config 5M: n_embd={MODEL_CFG.n_embd} mlp_mult={MODEL_CFG.mlp_internal_dim_multiplier}", flush=True)

# ── PII scrub (matches packages/eight-bdh/scripts/_shared.ts) ──────────

EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
# Phone regex - tightened to avoid matching ISO 8601 timestamps. Requires
# either a leading + (E.164) or a (NNN) area-code prefix or a strict
# 3-3-4 NANP format with consistent separators. ISO dates like
# "2026-04-28" no longer match.
PHONE_RE = re.compile(
    r"(?:\+\d{1,3}[\s.-]?\d{2,4}[\s.-]?\d{3,4}[\s.-]?\d{0,4})"
    r"|(?:\(\d{3}\)\s*\d{3}[\s.-]?\d{4})"
    r"|(?:\b\d{3}[.-]\d{3}[.-]\d{4}\b)"
)
OPENAI_KEY_RE = re.compile(r"sk-[a-zA-Z0-9]{20,}")
GITHUB_PAT_RE = re.compile(r"ghp_[a-zA-Z0-9]{20,}")
XAI_KEY_RE = re.compile(r"xai-[a-zA-Z0-9]{20,}")
ANTHROPIC_KEY_RE = re.compile(r"sk-ant-[a-zA-Z0-9-]{20,}")

# Known private client names to scrub (defence in depth even though
# we already cleaned the public surfaces; a session log might contain
# raw mentions in the user's prompts).
CLIENT_NAMES = [
    "FoodstackOS", "Foodstackai", "Foodstack",
    "SCF Design Lab", "EasyRFP",
    "Brotherhood Tattoo", "VoiceAISpace", "Veets",
]


def scrub(s: str) -> str:
    s = EMAIL_RE.sub("[REDACTED-EMAIL]", s)
    s = PHONE_RE.sub("[REDACTED-PHONE]", s)
    s = OPENAI_KEY_RE.sub("[REDACTED-KEY]", s)
    s = GITHUB_PAT_RE.sub("[REDACTED-KEY]", s)
    s = XAI_KEY_RE.sub("[REDACTED-KEY]", s)
    s = ANTHROPIC_KEY_RE.sub("[REDACTED-KEY]", s)
    for name in CLIENT_NAMES:
        s = s.replace(name, "[CLIENT]")
    return s


# ── Corpus sources ──────────────────────────────────────────────────────


def load_doc_sources():
    """Static documentation: spec, model card, notices, ontology rationale,
    chair amendment, principle docs."""
    sources = []

    targets = [
        # Spec docs
        REPO_ROOT / "docs" / "specs" / "8GENT-0.1-BDH-ORCHESTRATOR.md",
        REPO_ROOT / "docs" / "specs" / "8GENT-0.1-BDH-TRAINING-NOTES.md",
        # eight-bdh package docs
        REPO_ROOT / "packages" / "eight-bdh" / "MODEL-CARD.md",
        REPO_ROOT / "packages" / "eight-bdh" / "README.md",
        REPO_ROOT / "packages" / "eight-bdh" / "NOTICES.md",
        REPO_ROOT / "packages" / "eight-bdh" / "ONTOLOGY-RATIONALE.md",
        REPO_ROOT / "packages" / "eight-bdh" / "THRONE-PRD.md",
        REPO_ROOT / "packages" / "eight-bdh" / "trainer" / "README.md",
        REPO_ROOT / "packages" / "eight-bdh" / "trainer" / "local" / "STATUS.md",
        REPO_ROOT / "packages" / "eight-bdh" / "trainer" / "local" / "PHASE-0-REPORT.md",
        # Repo principle docs
        REPO_ROOT / "CLAUDE.md",
        REPO_ROOT / "BRAND.md",
        REPO_ROOT / "AGENTS.md",
        REPO_ROOT / "CONVENTIONS.md",
    ]

    for p in targets:
        if p.exists():
            try:
                text = p.read_text(encoding="utf-8", errors="ignore")
                sources.append({
                    "source": "doc",
                    "path": str(p.relative_to(REPO_ROOT)),
                    "text": scrub(text),
                })
            except Exception as e:
                print(f"[corpus] skip {p.name}: {e}", flush=True)
    return sources


def load_blog_sources():
    """8gent-world blog content: public-facing prose with house style."""
    sources = []
    blog_dir = WORLD_REPO / "content" / "blog"
    if not blog_dir.exists():
        return sources
    for p in sorted(blog_dir.glob("*.mdx")):
        try:
            text = p.read_text(encoding="utf-8", errors="ignore")
            sources.append({
                "source": "blog",
                "path": str(p.relative_to(WORLD_REPO)),
                "text": scrub(text),
            })
        except Exception as e:
            print(f"[corpus] skip blog {p.name}: {e}", flush=True)
    return sources


def load_session_replays(rng, n: int):
    """Sample n session JSON replays from ~/.8gent/sessions/.
    PII-scrubbed. Each session is the raw JSON dumped compactly so the
    model sees the schema it actually lives in."""
    if not SESSIONS_DIR.exists():
        return []
    all_paths = sorted(SESSIONS_DIR.glob("*.json"))
    if not all_paths:
        return []
    sampled = rng.sample(all_paths, k=min(n, len(all_paths)))
    sources = []
    for p in sampled:
        try:
            raw = p.read_text(encoding="utf-8", errors="ignore")
            try:
                obj = json.loads(raw)
                compact = json.dumps(obj, separators=(",", ":"), sort_keys=True, ensure_ascii=False)
            except Exception:
                compact = raw
            sources.append({
                "source": "session",
                "path": p.name,
                "text": scrub(compact),
            })
        except Exception:
            continue
    return sources


def load_phase_0_corpus():
    """The Phase 0 rule-based corpus we already generated. Including it
    means the model continues to know the schema we used in Phase 0
    while broadening to the natural data."""
    p = DATA_DIR / "phase-0-seed-42.jsonl"
    if not p.exists():
        return []
    text = p.read_text(encoding="utf-8", errors="ignore")
    return [{
        "source": "phase-0-corpus",
        "path": str(p.relative_to(REPO_ROOT)),
        "text": scrub(text),
    }]


# ── Build corpus ────────────────────────────────────────────────────────


def build_corpus():
    rng = random.Random(SEED)

    docs = load_doc_sources()
    blog = load_blog_sources()
    sessions = load_session_replays(rng, SESSION_SAMPLES)
    phase_0 = load_phase_0_corpus()

    all_sources = docs + blog + sessions + phase_0
    rng.shuffle(all_sources)

    by_kind = {}
    for s in all_sources:
        by_kind[s["source"]] = by_kind.get(s["source"], 0) + 1
    print(f"[corpus] sources: {by_kind}", flush=True)

    parts = []
    for s in all_sources:
        # Tagged record with source for the model to learn distinct styles
        header = f"<<{s['source']}:{s['path']}>>\n"
        parts.append(header + s["text"].strip() + "\n")

    text = "\n".join(parts) + "\n"
    return text.encode("utf-8"), by_kind


# ── Run ─────────────────────────────────────────────────────────────────

t0 = time.time()
print("[corpus] building Phase 1 exploratory corpus from harness reality", flush=True)
data_bytes, source_counts = build_corpus()
data_path = DATA_DIR / "phase-1-explore-corpus.bin"
data_path.write_bytes(data_bytes)
print(f"[corpus] wrote {len(data_bytes):,} bytes to {data_path.relative_to(REPO_ROOT)}", flush=True)
print(f"[corpus] elapsed: {time.time() - t0:.1f}s", flush=True)

# Train/val split
torch.manual_seed(SEED)
np.random.seed(SEED)

n_total = len(data_bytes)
n_train = int(n_total * 0.95)
train_data = np.frombuffer(data_bytes[:n_train], dtype=np.uint8)
val_data = np.frombuffer(data_bytes[n_train:], dtype=np.uint8)
print(f"[split] train_bytes={len(train_data):,} val_bytes={len(val_data):,}", flush=True)


def get_batch(split: str):
    data = train_data if split == "train" else val_data
    if len(data) <= BLOCK_SIZE + 1:
        ix = np.array([0] * BATCH_SIZE)
    else:
        ix = np.random.randint(0, len(data) - BLOCK_SIZE - 1, size=BATCH_SIZE)
    x = np.stack([data[i : i + BLOCK_SIZE].astype(np.int64) for i in ix])
    y = np.stack([data[i + 1 : i + 1 + BLOCK_SIZE].astype(np.int64) for i in ix])
    return torch.from_numpy(x).to(DEVICE), torch.from_numpy(y).to(DEVICE)


# Build model
model = BDH(MODEL_CFG).to(DEVICE)
n_params = sum(p.numel() for p in model.parameters())
print(f"[model] params={n_params/1e6:.2f}M target=5M", flush=True)

optimizer = torch.optim.AdamW(model.parameters(), lr=LR, weight_decay=WEIGHT_DECAY)

print(f"[train] starting {MAX_ITERS} iters, batch={BATCH_SIZE}, block={BLOCK_SIZE}", flush=True)
t_train_start = time.time()

losses_log = []
val_losses_log = []
best_val_loss = float("inf")

for iter_n in range(1, MAX_ITERS + 1):
    model.train()
    x, y = get_batch("train")
    _, loss = model(x, y)
    optimizer.zero_grad(set_to_none=True)
    loss.backward()
    torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
    optimizer.step()
    losses_log.append((iter_n, loss.item()))

    if iter_n % LOG_INTERVAL == 0 or iter_n == 1:
        model.eval()
        with torch.no_grad():
            xv, yv = get_batch("val")
            _, vloss = model(xv, yv)
        val_losses_log.append((iter_n, vloss.item()))
        elapsed = time.time() - t_train_start
        rate = iter_n / elapsed if elapsed > 0 else 0
        eta = (MAX_ITERS - iter_n) / rate if rate > 0 else 0
        print(
            f"[train] iter {iter_n}/{MAX_ITERS}  train_loss={loss.item():.4f}  "
            f"val_loss={vloss.item():.4f}  rate={rate:.1f}it/s  eta={eta/60:.1f}min",
            flush=True,
        )
        if vloss.item() < best_val_loss:
            best_val_loss = vloss.item()

t_train_end = time.time()
train_seconds = t_train_end - t_train_start
print(f"[train] done in {train_seconds/60:.1f}min, best val_loss={best_val_loss:.4f}", flush=True)

# Save checkpoint
checkpoint_path = CHECKPOINT_DIR / "phase-1-explore-5m.pt"
torch.save(
    {
        "model_state_dict": model.state_dict(),
        "config": {
            "n_layer": MODEL_CFG.n_layer,
            "n_embd": MODEL_CFG.n_embd,
            "n_head": MODEL_CFG.n_head,
            "mlp_internal_dim_multiplier": MODEL_CFG.mlp_internal_dim_multiplier,
            "dropout": MODEL_CFG.dropout,
            "vocab_size": MODEL_CFG.vocab_size,
        },
        "training": {
            "phase": "1-explore",
            "max_iters": MAX_ITERS,
            "batch_size": BATCH_SIZE,
            "block_size": BLOCK_SIZE,
            "lr": LR,
            "weight_decay": WEIGHT_DECAY,
            "seed": SEED,
            "device": str(DEVICE),
            "train_seconds": train_seconds,
            "best_val_loss": best_val_loss,
            "final_train_loss": losses_log[-1][1] if losses_log else None,
            "final_val_loss": val_losses_log[-1][1] if val_losses_log else None,
            "corpus_bytes": len(data_bytes),
            "source_counts": source_counts,
        },
        "phase": 1,
        "model_id": "8gent-0.1.0-bdh-r:5m-phase-1-explore",
    },
    checkpoint_path,
)
print(f"[save] checkpoint written to {checkpoint_path.relative_to(REPO_ROOT)}", flush=True)

log_path = LOG_DIR / "phase-1-explore-train-log.json"
with log_path.open("w") as fh:
    json.dump(
        {
            "phase": "1-explore",
            "device": str(DEVICE),
            "params_millions": n_params / 1e6,
            "config": {
                "n_layer": MODEL_CFG.n_layer,
                "n_embd": MODEL_CFG.n_embd,
                "n_head": MODEL_CFG.n_head,
                "mlp_internal_dim_multiplier": MODEL_CFG.mlp_internal_dim_multiplier,
                "vocab_size": MODEL_CFG.vocab_size,
            },
            "corpus_bytes": len(data_bytes),
            "source_counts": source_counts,
            "train_seconds": train_seconds,
            "best_val_loss": best_val_loss,
            "loss_curve_train": losses_log,
            "loss_curve_val": val_losses_log,
            "train_bytes": len(train_data),
            "val_bytes": len(val_data),
        },
        fh,
        indent=2,
    )
print(f"[save] log written to {log_path.relative_to(REPO_ROOT)}", flush=True)

# Sample inference - free-form prompts to see what the model has absorbed
print("[sample] generating from 3 free-form prompts", flush=True)
model.eval()
prompts = [
    "<<doc:packages/eight-bdh/MODEL-CARD.md>>\n# Model Card\n\nThe 8gent 0.1 BDH",
    "<<session:",
    "<<blog:content/blog/",
]
for i, prompt in enumerate(prompts, 1):
    prompt_bytes = prompt.encode("utf-8")
    idx = torch.tensor([list(prompt_bytes)], dtype=torch.long, device=DEVICE)
    with torch.no_grad():
        out_idx = model.generate(idx, max_new_tokens=200, temperature=0.8, top_k=40)
    out_bytes = bytes(out_idx[0].tolist())
    out_text = out_bytes.decode("utf-8", errors="replace")
    print(f"[sample {i}] >>>")
    print(out_text)
    print(f"[sample {i}] <<<")

print(f"[done] phase 1 explore complete in {(time.time() - t0)/60:.1f}min total", flush=True)
