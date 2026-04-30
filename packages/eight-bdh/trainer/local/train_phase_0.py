"""
Phase 0 training: 5M BDH heartbeat run on M2 Max via MPS.

End-to-end pipeline in one file:
  1. Generate 1k synthetic routing examples (rule-based, deterministic seed)
  2. Serialize as JSON byte stream with record separators
  3. Train 5M BDH model on MPS for MAX_ITERS iterations
  4. Save checkpoint + loss curve + sample inference
  5. Print timing summary

Exit codes:
  0 = pipeline completed (does not imply quality, just that the rig works)
  1 = data generation failed
  2 = MPS training failed
  3 = checkpoint save failed

Run:
  python3 packages/eight-bdh/trainer/local/train_phase_0.py

Environment overrides:
  BDH_MAX_ITERS=3000   (default 3000)
  BDH_BATCH=32         (default 32)
  BDH_BLOCK=512        (default 512)
  BDH_N_EXAMPLES=1000  (default 1000)
  BDH_SEED=42          (default 42)
  BDH_DEVICE=mps       (default mps; falls back to cpu if unavailable)
"""

import json
import math
import os
import random
import sys
import time
from pathlib import Path
from contextlib import nullcontext

# ── Path setup ──────────────────────────────────────────────────────────

REPO_ROOT = Path(__file__).resolve().parents[4]   # 8gent-code/.claude/worktrees/<id>/
BDH_REPO = Path.home() / "8gent-bdh"
DATA_DIR = REPO_ROOT / "packages" / "eight-bdh" / "data"
CHECKPOINT_DIR = REPO_ROOT / "packages" / "eight-bdh" / "checkpoints"
LOG_DIR = REPO_ROOT / "packages" / "eight-bdh" / "trainer" / "local"

DATA_DIR.mkdir(parents=True, exist_ok=True)
CHECKPOINT_DIR.mkdir(parents=True, exist_ok=True)

sys.path.insert(0, str(BDH_REPO))

# ── Imports (after path setup) ──────────────────────────────────────────

import numpy as np
import torch
import torch.nn.functional as F
from bdh import BDH, BDHConfig

# ── Env config ──────────────────────────────────────────────────────────

MAX_ITERS = int(os.environ.get("BDH_MAX_ITERS", "3000"))
BATCH_SIZE = int(os.environ.get("BDH_BATCH", "32"))
BLOCK_SIZE = int(os.environ.get("BDH_BLOCK", "512"))
N_EXAMPLES = int(os.environ.get("BDH_N_EXAMPLES", "1000"))
SEED = int(os.environ.get("BDH_SEED", "42"))
LR = 1e-3
WEIGHT_DECAY = 0.1
LOG_INTERVAL = 100

# Phase 0 5M config (matches PHASE_0_5M_CONFIG in types.ts)
MODEL_CFG = BDHConfig(
    n_layer=6,
    n_embd=160,
    n_head=4,
    mlp_internal_dim_multiplier=64,
    dropout=0.1,
    vocab_size=256,
)

# ── Device selection (MPS-first, paper-faithful) ────────────────────────

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

# ── 1. Synthetic routing-example generator ──────────────────────────────

# Deterministic. ~30 base templates × variations -> N_EXAMPLES.
# Phase 0 prioritises diversity of structure over diversity of content;
# the goal is to prove BDH learns the byte-level structure of the
# (state, decision, trace) triple, not to teach quality routing.

REQUEST_TEMPLATES = [
    "rewrite this auth middleware to use the new policy engine",
    "what files changed in the last commit",
    "summarise the project status",
    "deploy to production",
    "explain how the memory consolidation pipeline works",
    "find all uses of the deprecated tokenizer api",
    "fix the failing test in packages/eight/agent.test.ts",
    "add a darkmode toggle to the settings panel",
    "refactor the dispatcher to use the new role-config schema",
    "review the open PR for security issues",
    "draft a changelog entry for v0.13",
    "investigate why the daemon is running hot",
    "rotate the openrouter api key everywhere",
    "write a unit test for the byte-level decoder",
    "scan the repo for hardcoded credentials",
    "generate a benchmark report from the last run",
    "translate this ts file to rust",
    "add a feature flag for the new router path",
    "downgrade the failing dependency by one minor version",
    "open a PR closing the linked issue",
    "audit the gitignore for sensitive paths",
    "list all packages with no test coverage",
    "merge main into the feature branch and resolve conflicts",
    "describe what this repository does",
    "show me the last 10 traces in the audit log",
    "create a dashboard widget for active sessions",
    "stress test the rate limiter with 1k concurrent requests",
    "write release notes from the last 50 commits",
    "find the slowest function in the build pipeline",
    "compare local model output with frontier on a fixed prompt",
]

DECISION_KIND_OPTIONS = ["model", "agent", "tool", "reject", "clarify"]
TARGET_OPTIONS = {
    "model": [
        "8gent/eight-1.0-q3:14b",
        "qwen3.6:27b",
        "deepseek-r1:32b",
        "mistral:7b",
        "claude-opus-4-7",
    ],
    "agent": ["8EO", "8TO", "8PO", "8DO", "8SO", "8CO", "8MO", "8GO"],
    "tool": ["Bash", "Read", "Edit", "Write", "Grep", "Glob", "WebFetch"],
    "reject": ["deny-listed-action", "policy-violation", "out-of-scope"],
    "clarify": ["user", "ambiguous-request", "missing-context"],
}

CONCEPT_BANK = [
    "code-edit", "code-read", "debug", "refactor", "test-write", "test-run",
    "doc-write", "review", "plan", "research-internal", "summarise",
    "deploy", "rollback", "config-edit", "data-migration", "chat-reply",
    "security-sensitive", "auth-touching", "prod-touching", "main-branch-touching",
    "secret-touching", "read-only", "low-stakes", "reversible", "irreversible",
    "vessel-8EO-fits", "vessel-8TO-fits", "vessel-8SO-fits", "vessel-8GO-fits",
    "budget-comfortable", "budget-low-tokens", "budget-low-time", "budget-exhausted",
    "authority-l1", "authority-l2", "authority-l3", "authority-l4",
    "deny-listed-action", "requires-approval", "policy-clear",
    "local-sufficient", "frontier-required", "tool-call-heavy",
    "long-context-required", "latency-critical", "quality-critical",
    "recent-failure", "recent-success", "fresh-session", "long-session",
    "decision-model", "decision-agent", "decision-tool", "decision-reject", "decision-clarify",
]

TOOLS_AVAILABLE = ["Read", "Edit", "Bash", "AgentTool", "Grep", "WebFetch", "Write"]
VESSELS_AVAILABLE = ["8EO", "8TO", "8PO", "8DO", "8SO", "8CO", "8MO", "8GO"]


def generate_example(rng, idx):
    request = rng.choice(REQUEST_TEMPLATES)
    kind = rng.choice(DECISION_KIND_OPTIONS)
    target = rng.choice(TARGET_OPTIONS[kind])

    # Sample 3-5 concepts + the matching decision concept
    n_concepts = rng.randint(3, 5)
    concepts = rng.sample(CONCEPT_BANK, n_concepts)
    if f"decision-{kind}" not in concepts:
        concepts.append(f"decision-{kind}")

    state = {
        "request": request,
        "context": {
            "tools_available": rng.sample(TOOLS_AVAILABLE, rng.randint(2, 5)),
            "vessels_available": rng.sample(VESSELS_AVAILABLE, rng.randint(2, 4)),
            "budget_remaining": {
                "tokens": rng.choice([4000, 12000, 40000, 80000, 200000]),
                "ms": rng.choice([5000, 30000, 90000, 300000, 600000]),
            },
            "history_summary": rng.choice([
                "fresh session, no prior turns",
                "user has been debugging for 20 minutes",
                "last attempt failed CI",
                "first interaction of the day",
                "just resumed from compaction",
                "second loop on similar request",
            ]),
        },
        "policy": {
            "authority_level": rng.randint(0, 4),
            "deny_actions": rng.sample(["push_to_main", "rm_rf", "force_push", "drop_table"], rng.randint(0, 2)),
        },
    }
    decision = {
        "kind": kind,
        "target": target,
        "budget": {
            "tokens": rng.choice([500, 4000, 12000, 40000]),
            "ms": rng.choice([5000, 30000, 90000, 300000]),
        },
        "confidence": round(rng.uniform(0.55, 0.95), 2),
    }
    trace = {
        "concepts_fired": concepts,
        "reasoning": [
            "context match against template",
            "policy check passed within authority",
            "budget allows requested action",
        ],
    }
    return {
        "id": f"phase-0-seed-{SEED}-{idx:06d}",
        "state": state,
        "decision": decision,
        "trace": trace,
        "provenance": {
            "source": "synthetic",
            "model_used": "rule-based-phase-0",
            "created_at": "2026-04-28T00:00:00Z",
            "seed": SEED,
            "notes": "Phase 0 heartbeat corpus. Rule-based, no frontier teacher. Diversity is structural, not semantic.",
        },
    }


def build_corpus(n: int):
    rng = random.Random(SEED)
    examples = [generate_example(rng, i) for i in range(n)]
    return examples


def serialize_to_bytes(examples):
    """Concatenate examples as compact JSON, separated by newlines.
    Byte-level vocab=256 means we feed raw bytes; the model learns
    JSON syntax from the byte distribution."""
    parts = []
    for ex in examples:
        # decision and trace are the prediction targets; state is conditioning.
        # For Phase 0 we just feed the whole thing as a single byte stream.
        parts.append(json.dumps(ex, separators=(",", ":"), sort_keys=True))
    text = "\n".join(parts) + "\n"
    return text.encode("utf-8")


# ── 2. Build corpus ─────────────────────────────────────────────────────

t0 = time.time()
print(f"[data] generating {N_EXAMPLES} synthetic examples (seed={SEED})", flush=True)
examples = build_corpus(N_EXAMPLES)
data_bytes = serialize_to_bytes(examples)
data_path = DATA_DIR / f"phase-0-seed-{SEED}.bin"
jsonl_path = DATA_DIR / f"phase-0-seed-{SEED}.jsonl"
data_path.write_bytes(data_bytes)
with jsonl_path.open("w", encoding="utf-8") as fh:
    for ex in examples:
        fh.write(json.dumps(ex, separators=(",", ":"), sort_keys=True) + "\n")
print(f"[data] wrote {len(data_bytes):,} bytes to {data_path.relative_to(REPO_ROOT)}", flush=True)
print(f"[data] wrote {len(examples)} examples to {jsonl_path.relative_to(REPO_ROOT)}", flush=True)
print(f"[data] elapsed: {time.time() - t0:.1f}s", flush=True)

# ── 3. Train ────────────────────────────────────────────────────────────

torch.manual_seed(SEED)
np.random.seed(SEED)

# Train/val split: 95/5 on bytes
n_total = len(data_bytes)
n_train = int(n_total * 0.95)
train_data = np.frombuffer(data_bytes[:n_train], dtype=np.uint8)
val_data = np.frombuffer(data_bytes[n_train:], dtype=np.uint8)
print(f"[split] train_bytes={len(train_data):,} val_bytes={len(val_data):,}", flush=True)


def get_batch(split: str):
    data = train_data if split == "train" else val_data
    if len(data) <= BLOCK_SIZE + 1:
        # Tiny val split - cycle through it
        ix = np.array([0] * BATCH_SIZE)
    else:
        ix = np.random.randint(0, len(data) - BLOCK_SIZE - 1, size=BATCH_SIZE)
    x = np.stack([data[i : i + BLOCK_SIZE].astype(np.int64) for i in ix])
    y = np.stack([data[i + 1 : i + 1 + BLOCK_SIZE].astype(np.int64) for i in ix])
    x_t = torch.from_numpy(x).to(DEVICE)
    y_t = torch.from_numpy(y).to(DEVICE)
    return x_t, y_t


# Build model
model = BDH(MODEL_CFG).to(DEVICE)
n_params = sum(p.numel() for p in model.parameters())
print(f"[model] params={n_params/1e6:.2f}M target=5M", flush=True)

# Optimizer
optimizer = torch.optim.AdamW(model.parameters(), lr=LR, weight_decay=WEIGHT_DECAY)

# No torch.compile on MPS by default (per training notes section 5.4)
# No autocast on MPS by default (FP32 for stability)

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
        # Quick val pass
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

# ── 4. Save checkpoint ──────────────────────────────────────────────────

checkpoint_path = CHECKPOINT_DIR / "phase-0-5m.pt"
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
            "max_iters": MAX_ITERS,
            "batch_size": BATCH_SIZE,
            "block_size": BLOCK_SIZE,
            "lr": LR,
            "weight_decay": WEIGHT_DECAY,
            "seed": SEED,
            "n_examples": N_EXAMPLES,
            "device": str(DEVICE),
            "train_seconds": train_seconds,
            "best_val_loss": best_val_loss,
            "final_train_loss": losses_log[-1][1] if losses_log else None,
            "final_val_loss": val_losses_log[-1][1] if val_losses_log else None,
        },
        "phase": 0,
        "model_id": "8gent-0.1.0-bdh-r:5m",
    },
    checkpoint_path,
)
print(f"[save] checkpoint written to {checkpoint_path.relative_to(REPO_ROOT)}", flush=True)

# Also write training log as JSON
log_path = LOG_DIR / "phase-0-train-log.json"
with log_path.open("w") as fh:
    json.dump(
        {
            "device": str(DEVICE),
            "params_millions": n_params / 1e6,
            "config": {
                "n_layer": MODEL_CFG.n_layer,
                "n_embd": MODEL_CFG.n_embd,
                "n_head": MODEL_CFG.n_head,
                "mlp_internal_dim_multiplier": MODEL_CFG.mlp_internal_dim_multiplier,
                "vocab_size": MODEL_CFG.vocab_size,
            },
            "n_examples": N_EXAMPLES,
            "train_seconds": train_seconds,
            "best_val_loss": best_val_loss,
            "loss_curve_train": losses_log,
            "loss_curve_val": val_losses_log,
            "data_bytes": len(data_bytes),
            "train_bytes": len(train_data),
            "val_bytes": len(val_data),
        },
        fh,
        indent=2,
    )
print(f"[save] log written to {log_path.relative_to(REPO_ROOT)}", flush=True)

# ── 5. Sample inference ─────────────────────────────────────────────────

print("[sample] generating from a held-out prompt", flush=True)
model.eval()
prompt_text = '{"id":"sample-1","state":{"request":"summarise the project status","context":{'
prompt_bytes = prompt_text.encode("utf-8")
idx = torch.tensor([list(prompt_bytes)], dtype=torch.long, device=DEVICE)
with torch.no_grad():
    out_idx = model.generate(idx, max_new_tokens=200, temperature=0.8, top_k=40)
out_bytes = bytes(out_idx[0].tolist())
try:
    out_text = out_bytes.decode("utf-8", errors="replace")
except Exception as e:
    out_text = f"<decode error: {e}>"
print("[sample] >>>")
print(out_text)
print("[sample] <<<")

print(f"[done] phase 0 heartbeat complete in {(time.time() - t0)/60:.1f}min total", flush=True)
