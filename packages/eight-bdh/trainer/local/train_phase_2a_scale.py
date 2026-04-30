"""
Phase 2a scale: 5M BDH on a 5-8MB harness corpus.

Per BDHTraining skill BuildCorpus.md: "Total bytes >= 5MB for any
training run claiming quality. Below 5MB is heartbeat only; expect
memorisation." Phase 1 used 1.48MB and showed memorisation
(verbatim regurgitation of Phase 0 strings on OOD prompts).

Phase 2a tests the corpus-size hypothesis directly:
  - Same 5M model architecture (no capacity change)
  - Same Pathway hyperparameters (block 512, batch 32, lr 1e-3, wd 0.1)
  - Same source mix proportions
  - 5x more session replays (1000 vs 200)
  - Drop Phase 0 carryover entirely (skill rule)
  - Expanded docs tree to grow doc share

If memorisation drops, the bottleneck was data volume.
If it persists, the bottleneck is capacity (5M too small) and Phase 2b
at 10M is the next experiment.

Run:
  python3 packages/eight-bdh/trainer/local/train_phase_2a_scale.py

Outputs:
  packages/eight-bdh/checkpoints/phase-2a-scale-5m.pt
  packages/eight-bdh/data/phase-2a-scale-corpus.bin
  packages/eight-bdh/trainer/local/phase-2a-scale-train-log.json

Env overrides:
  BDH_MAX_ITERS=2500
  BDH_BATCH=32
  BDH_BLOCK=512
  BDH_SEED=44
  BDH_SESSION_SAMPLES=1000
  BDH_DEVICE=mps
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

# ── Env config (Pathway-faithful per BDHTraining/Configure.md) ──────────

MAX_ITERS = int(os.environ.get("BDH_MAX_ITERS", "2500"))
BATCH_SIZE = int(os.environ.get("BDH_BATCH", "32"))
BLOCK_SIZE = int(os.environ.get("BDH_BLOCK", "512"))
SEED = int(os.environ.get("BDH_SEED", "44"))
SESSION_SAMPLES = int(os.environ.get("BDH_SESSION_SAMPLES", "1000"))
LR = 1e-3
WEIGHT_DECAY = 0.1
LOG_INTERVAL = 100

# Same 5M config as Phase 0 / Phase 1 (apples-to-apples on capacity)
MODEL_CFG = BDHConfig(
    n_layer=6,
    n_embd=160,
    n_head=4,
    mlp_internal_dim_multiplier=64,
    dropout=0.1,
    vocab_size=256,
)

# ── Device selection ────────────────────────────────────────────────────


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

# ── PII scrub (canonical regex per BDHTraining/BuildCorpus.md) ─────────

EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
# Tightened phone regex - does NOT match ISO timestamps like 2026-04-28
PHONE_RE = re.compile(
    r"(?:\+\d{1,3}[\s.-]?\d{2,4}[\s.-]?\d{3,4}[\s.-]?\d{0,4})"
    r"|(?:\(\d{3}\)\s*\d{3}[\s.-]?\d{4})"
    r"|(?:\b\d{3}[.-]\d{3}[.-]\d{4}\b)"
)
OPENAI_KEY_RE = re.compile(r"sk-[a-zA-Z0-9]{20,}")
GITHUB_PAT_RE = re.compile(r"ghp_[a-zA-Z0-9]{20,}")
XAI_KEY_RE = re.compile(r"xai-[a-zA-Z0-9]{20,}")
ANTHROPIC_KEY_RE = re.compile(r"sk-ant-[a-zA-Z0-9-]{20,}")

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
    """Expanded doc tree from Phase 1: adds bmad/, archive/, all root .md."""
    sources = []
    targets = []

    # Spec docs (everything in docs/specs/)
    specs_dir = REPO_ROOT / "docs" / "specs"
    if specs_dir.exists():
        targets.extend(sorted(specs_dir.glob("*.md")))

    # bmad docs
    bmad_dir = REPO_ROOT / "docs" / "bmad"
    if bmad_dir.exists():
        targets.extend(sorted(bmad_dir.rglob("*.md")))

    # archive
    archive_dir = REPO_ROOT / "docs" / "archive"
    if archive_dir.exists():
        targets.extend(sorted(archive_dir.glob("*.md")))

    # All other docs/ markdowns
    docs_dir = REPO_ROOT / "docs"
    if docs_dir.exists():
        for p in sorted(docs_dir.glob("*.md")):
            if p not in targets:
                targets.append(p)

    # eight-bdh package docs (full tree)
    bdh_pkg = REPO_ROOT / "packages" / "eight-bdh"
    if bdh_pkg.exists():
        for p in sorted(bdh_pkg.rglob("*.md")):
            targets.append(p)

    # Root .md files (CLAUDE.md, BRAND.md, AGENTS.md, CONVENTIONS.md, etc.)
    for p in sorted(REPO_ROOT.glob("*.md")):
        targets.append(p)

    seen = set()
    for p in targets:
        rp = str(p.resolve())
        if rp in seen:
            continue
        seen.add(rp)
        if p.exists() and p.is_file():
            try:
                text = p.read_text(encoding="utf-8", errors="ignore")
                if not text.strip():
                    continue
                sources.append({
                    "source": "doc",
                    "path": str(p.relative_to(REPO_ROOT)),
                    "text": scrub(text),
                })
            except Exception as e:
                print(f"[corpus] skip {p.name}: {e}", flush=True)
    return sources


def load_blog_sources():
    """8gent-world blog content."""
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
    """Take ALL valid session JSON replays (no sampling cap).
    Phase 1 sampled 200 and got 115 valid; Phase 2a tried 1000 and got
    119 because most session files are empty or near-empty. Iterating
    everything pulls in maximum byte volume from real harness state.
    PII-scrubbed."""
    if not SESSIONS_DIR.exists():
        return []
    all_paths = sorted(SESSIONS_DIR.glob("*.json"))
    if not all_paths:
        return []
    sources = []
    for p in all_paths:
        try:
            raw = p.read_text(encoding="utf-8", errors="ignore")
            if not raw.strip() or len(raw) < 50:
                continue
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


def load_code_sources():
    """TypeScript / JavaScript / Python source from 8gent-code packages
    and apps. The model sees real code in its natural shape: imports,
    type declarations, function bodies, comments. Adds substantial byte
    volume and gives the model code-completion patterns alongside the
    JSON / markdown styles."""
    sources = []
    candidate_dirs = [
        REPO_ROOT / "packages" / "eight-bdh",
        REPO_ROOT / "packages" / "memory",
        REPO_ROOT / "packages" / "permissions",
        REPO_ROOT / "packages" / "orchestration",
        REPO_ROOT / "packages" / "eight",
        REPO_ROOT / "packages" / "providers",
        REPO_ROOT / "packages" / "g8way",
        REPO_ROOT / "packages" / "daemon",
        REPO_ROOT / "packages" / "self-autonomy",
        REPO_ROOT / "packages" / "kernel",
        REPO_ROOT / "packages" / "tools",
        REPO_ROOT / "apps" / "tui",
        REPO_ROOT / "apps" / "dashboard",
        REPO_ROOT / "apps" / "debugger",
        REPO_ROOT / "apps" / "lil-eight",
        REPO_ROOT / "apps" / "8gent-bot",
        REPO_ROOT / "apps" / "vessel",
        REPO_ROOT / "apps" / "linkedin-vessel",
        REPO_ROOT / "scripts",
        BDH_REPO,  # Pathway upstream: bdh.py, train.py, README.md, LICENSE.md
    ]

    seen = set()
    for root in candidate_dirs:
        if not root.exists():
            continue
        for p in sorted(root.rglob("*")):
            if not p.is_file():
                continue
            if any(part in {"node_modules", "dist", ".next", "build", ".turbo"} for part in p.parts):
                continue
            if p.suffix not in {".ts", ".tsx", ".py", ".json", ".md"}:
                continue
            # Skip lockfiles and giant generated files
            if p.name in {"package-lock.json", "bun.lock", "yarn.lock", "tsconfig.tsbuildinfo"}:
                continue
            if p.stat().st_size > 800_000:  # skip files > 800KB to avoid swallowing one giant file
                continue
            rp = str(p.resolve())
            if rp in seen:
                continue
            seen.add(rp)
            try:
                text = p.read_text(encoding="utf-8", errors="ignore")
                if not text.strip():
                    continue
                sources.append({
                    "source": "code",
                    "path": str(p.relative_to(REPO_ROOT)),
                    "text": scrub(text),
                })
            except Exception:
                continue
    return sources


def load_world_content():
    """All markdown across 8gent-world content/ (blog already covered;
    this picks up any other markdown like updates, decks, governance)."""
    sources = []
    if not WORLD_REPO.exists():
        return sources
    content_dir = WORLD_REPO / "content"
    if not content_dir.exists():
        return sources
    seen = set()
    for p in sorted(content_dir.rglob("*")):
        if not p.is_file():
            continue
        if p.suffix not in {".md", ".mdx"}:
            continue
        if any(part in {"node_modules", ".next"} for part in p.parts):
            continue
        rp = str(p.resolve())
        if rp in seen:
            continue
        seen.add(rp)
        try:
            text = p.read_text(encoding="utf-8", errors="ignore")
            if not text.strip():
                continue
            sources.append({
                "source": "world",
                "path": str(p.relative_to(WORLD_REPO)),
                "text": scrub(text),
            })
        except Exception:
            continue
    return sources


# Phase 0 carryover INTENTIONALLY DROPPED per BDHTraining lessons:
# 1k routing triples drowned natural data signal in Phase 1, model
# regurgitated Phase 0 strings on OOD prompts.

# ── Build corpus ────────────────────────────────────────────────────────


def build_corpus():
    rng = random.Random(SEED)

    docs = load_doc_sources()
    blog = load_blog_sources()
    sessions = load_session_replays(rng, SESSION_SAMPLES)
    code = load_code_sources()
    world = load_world_content()

    all_sources = docs + blog + sessions + code + world
    rng.shuffle(all_sources)

    by_kind = {}
    by_kind_bytes = {}
    for s in all_sources:
        by_kind[s["source"]] = by_kind.get(s["source"], 0) + 1
        by_kind_bytes[s["source"]] = by_kind_bytes.get(s["source"], 0) + len(s["text"])
    print(f"[corpus] sources by count: {by_kind}", flush=True)
    print(f"[corpus] sources by bytes: {by_kind_bytes}", flush=True)

    parts = []
    for s in all_sources:
        header = f"<<{s['source']}:{s['path']}>>\n"
        parts.append(header + s["text"].strip() + "\n")

    text = "\n".join(parts) + "\n"
    return text.encode("utf-8"), by_kind, by_kind_bytes


# ── Run ─────────────────────────────────────────────────────────────────

t0 = time.time()
print("[corpus] building Phase 2a corpus (5M params, target 5MB+ bytes)", flush=True)
data_bytes, source_counts, source_bytes = build_corpus()
data_path = DATA_DIR / "phase-2a-scale-corpus.bin"
data_path.write_bytes(data_bytes)
print(f"[corpus] wrote {len(data_bytes):,} bytes to {data_path.relative_to(REPO_ROOT)}", flush=True)
print(f"[corpus] elapsed: {time.time() - t0:.1f}s", flush=True)

# HARD GATE: per BuildCorpus.md, >= 5MB for quality run.
# Aborting saves a 2h training run on a corpus too small for the experiment.
if len(data_bytes) < 5_000_000:
    print(f"[corpus] FAIL: corpus is {len(data_bytes):,} bytes, below 5MB threshold from BuildCorpus.md", flush=True)
    print("[corpus] aborting before training. expand corpus sources and retry.", flush=True)
    sys.exit(2)
print(f"[corpus] OK: corpus exceeds 5MB threshold ({len(data_bytes)/1e6:.1f}MB)", flush=True)

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
checkpoint_path = CHECKPOINT_DIR / "phase-2a-scale-5m.pt"
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
            "phase": "2a-scale",
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
            "source_bytes": source_bytes,
        },
        "phase": 2,
        "subphase": "a-scale",
        "model_id": "8gent-0.1.0-bdh-r:5m-phase-2a-scale",
    },
    checkpoint_path,
)
print(f"[save] checkpoint written to {checkpoint_path.relative_to(REPO_ROOT)}", flush=True)

log_path = LOG_DIR / "phase-2a-scale-train-log.json"
with log_path.open("w") as fh:
    json.dump(
        {
            "phase": "2a-scale",
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
            "source_bytes": source_bytes,
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

# Sample inference: same prompts as Phase 1 explore so we can compare directly
print("[sample] generating from 3 free-form prompts (same as Phase 1)", flush=True)
model.eval()
prompts = [
    "<<doc:packages/eight-bdh/MODEL-CARD.md>>\n# Model Card\n\nThe 8gent 0.1 BDH",
    "<<session:",
    "<<blog:content/blog/",
]

# Memorisation regression test: did the model learn the verbatim
# "frontier teacher" string from Phase 0 carryover? It should NOT
# since we dropped the carryover.
prompts.append("front")

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

print(f"[done] phase 2a complete in {(time.time() - t0)/60:.1f}min total", flush=True)
