"""
Phase 3c tool-call: 5M BDH on a tool-call-focused corpus extracted
from Claude Code session JSONLs.

Hypothesis: BDH's intended role is the routing core (tool selection +
plan structure). Phase 2 used a heterogeneous workspace corpus (67% raw
code, 14% sessions, 8% docs, 7% world, 4% blog). Phase 3c tests whether
training on ONLY tool-call exchanges (every assistant tool_use paired
with its tool_result) produces a sharper routing signal at fixed
parameter count and similar byte budget.

Comparable baselines:
  - Phase 2a 5M / 5.67MB / heterogeneous   -> val_loss 0.934
  - Phase 2b 10M / 5.67MB / heterogeneous  -> val_loss 0.885
  - Phase 3c 5M / ~5MB / tool-calls only   -> ?

If Phase 3c's val_loss beats Phase 2a's 0.934 by a meaningful margin,
the shape of the data matters more than its volume - and the routing-core
training plan should center on tool-call data going forward. If it
underperforms, the heterogeneous mix wins and the eval harness becomes
even more important to actually score routing rather than just byte loss.

Tagging:
  <<toolcall:NAME>>
  <input json, single line>
  <<toolresult>>
  <result body, capped at ~2000 chars>
  <<endtoolcall>>

Run:
  python3 packages/eight-bdh/trainer/local/train_phase_3c_toolcalls.py

Outputs:
  packages/eight-bdh/checkpoints/phase-3c-toolcalls-5m.pt
  packages/eight-bdh/data/phase-3c-toolcalls-corpus.bin
  packages/eight-bdh/trainer/local/phase-3c-toolcalls-train-log.json

Env overrides:
  BDH_MAX_ITERS=2500
  BDH_DEVICE=mps
"""

import hashlib
import json
import os
import random
import re
import sys
import time
from pathlib import Path

# Paths
REPO_ROOT = Path(__file__).resolve().parents[4]
BDH_REPO = Path.home() / "8gent-bdh"
PROJECTS_DIR = Path.home() / ".claude" / "projects"

DATA_DIR = REPO_ROOT / "packages" / "eight-bdh" / "data"
CHECKPOINT_DIR = REPO_ROOT / "packages" / "eight-bdh" / "checkpoints"
LOG_DIR = REPO_ROOT / "packages" / "eight-bdh" / "trainer" / "local"

DATA_DIR.mkdir(parents=True, exist_ok=True)
CHECKPOINT_DIR.mkdir(parents=True, exist_ok=True)

sys.path.insert(0, str(BDH_REPO))

import numpy as np
import torch
from bdh import BDH, BDHConfig

# Env config (Pathway-faithful)
MAX_ITERS = int(os.environ.get("BDH_MAX_ITERS", "2500"))
BATCH_SIZE = int(os.environ.get("BDH_BATCH", "32"))
BLOCK_SIZE = int(os.environ.get("BDH_BLOCK", "512"))
SEED = int(os.environ.get("BDH_SEED", "45"))
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

TOOL_RESULT_CHAR_CAP = 2000  # cap each tool_result body
TOOL_INPUT_CHAR_CAP = 800    # cap each tool_use input json
MIN_BYTES_TARGET = 5_000_000  # BDHTraining/BuildCorpus.md hard rule


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
print(f"[boot] config 5M: n_embd={MODEL_CFG.n_embd}", flush=True)

# PII scrub (canonical regex per BDHTraining/BuildCorpus.md)
EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
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


def stringify_tool_result(content) -> str:
    """tool_result.content can be str, list of {type:text|tool_reference|...}.
    Coerce to a compact string."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if not isinstance(block, dict):
                parts.append(str(block))
                continue
            btype = block.get("type")
            if btype == "text":
                parts.append(block.get("text", ""))
            elif btype == "tool_reference":
                parts.append(f"[tool_reference {block.get('tool_name', '')}]")
            elif btype == "image":
                parts.append("[image]")
            else:
                parts.append(json.dumps(block, ensure_ascii=False))
        return "\n".join(parts)
    if isinstance(content, dict):
        return json.dumps(content, ensure_ascii=False)
    return str(content)


def extract_tool_call_exchanges():
    """Walk every JSONL in ~/.claude/projects, build a map of tool_use_id ->
    (tool_name, input). On encountering tool_result, emit a tagged exchange
    string. Also captures top-level toolUseResult if present (more structured
    than the inline content). Returns list of exchange strings."""
    if not PROJECTS_DIR.exists():
        print(f"[corpus] FAIL: {PROJECTS_DIR} not found", flush=True)
        return []

    exchanges = []
    by_tool = {}
    files_seen = 0
    files_with_calls = 0
    pending_calls = {}  # tool_use_id -> (name, input_json_str)

    jsonl_files = sorted(PROJECTS_DIR.rglob("*.jsonl"))
    print(f"[corpus] scanning {len(jsonl_files)} session JSONLs", flush=True)

    for fp in jsonl_files:
        files_seen += 1
        local_pending = {}  # per-file
        had_call = False
        try:
            with fp.open("r", encoding="utf-8", errors="ignore") as f:
                for line in f:
                    try:
                        o = json.loads(line)
                    except Exception:
                        continue

                    # assistant tool_use
                    if o.get("type") == "assistant":
                        msg = o.get("message", {})
                        content = msg.get("content") or []
                        if isinstance(content, list):
                            for block in content:
                                if isinstance(block, dict) and block.get("type") == "tool_use":
                                    tid = block.get("id")
                                    name = block.get("name", "Unknown")
                                    inp = block.get("input", {})
                                    inp_s = json.dumps(inp, separators=(",", ":"), ensure_ascii=False)
                                    if len(inp_s) > TOOL_INPUT_CHAR_CAP:
                                        inp_s = inp_s[:TOOL_INPUT_CHAR_CAP] + "...[truncated]"
                                    if tid:
                                        local_pending[tid] = (name, inp_s)

                    # user tool_result (matches a prior tool_use)
                    if o.get("type") == "user":
                        msg = o.get("message", {})
                        content = msg.get("content") or []
                        if isinstance(content, list):
                            for block in content:
                                if isinstance(block, dict) and block.get("type") == "tool_result":
                                    tid = block.get("tool_use_id")
                                    if tid not in local_pending:
                                        continue
                                    name, inp_s = local_pending.pop(tid)
                                    # Prefer top-level toolUseResult if present
                                    raw_result = o.get("toolUseResult")
                                    if raw_result is not None:
                                        if isinstance(raw_result, (dict, list)):
                                            result_s = json.dumps(raw_result, separators=(",", ":"), ensure_ascii=False)
                                        else:
                                            result_s = str(raw_result)
                                    else:
                                        result_s = stringify_tool_result(block.get("content"))
                                    if len(result_s) > TOOL_RESULT_CHAR_CAP:
                                        result_s = result_s[:TOOL_RESULT_CHAR_CAP] + "...[truncated]"
                                    # Build the tagged exchange
                                    exchange = (
                                        f"<<toolcall:{name}>>\n"
                                        f"{inp_s}\n"
                                        f"<<toolresult>>\n"
                                        f"{scrub(result_s)}\n"
                                        f"<<endtoolcall>>"
                                    )
                                    exchanges.append(exchange)
                                    by_tool[name] = by_tool.get(name, 0) + 1
                                    had_call = True
        except Exception as e:
            print(f"[corpus] skip {fp.name}: {e}", flush=True)
            continue
        if had_call:
            files_with_calls += 1

    print(f"[corpus] files_seen={files_seen} files_with_calls={files_with_calls}", flush=True)
    print(f"[corpus] total tool exchanges: {len(exchanges)}", flush=True)
    print(f"[corpus] top tools: {sorted(by_tool.items(), key=lambda x: -x[1])[:10]}", flush=True)
    return exchanges, by_tool


def build_corpus():
    rng = random.Random(SEED)
    exchanges, by_tool = extract_tool_call_exchanges()
    if not exchanges:
        print("[corpus] FATAL: no exchanges extracted", flush=True)
        sys.exit(2)
    rng.shuffle(exchanges)
    blob = "\n\n".join(exchanges).encode("utf-8")
    return blob, by_tool


t0 = time.time()
print("[corpus] building Phase 3c tool-call corpus", flush=True)
data_bytes, by_tool = build_corpus()
data_path = DATA_DIR / "phase-3c-toolcalls-corpus.bin"
data_path.write_bytes(data_bytes)
sha = hashlib.sha256(data_bytes).hexdigest()
print(f"[corpus] wrote {len(data_bytes):,} bytes to {data_path.relative_to(REPO_ROOT)}", flush=True)
print(f"[corpus] sha256={sha}", flush=True)
print(f"[corpus] elapsed: {time.time() - t0:.1f}s", flush=True)

# Manifest
manifest_path = DATA_DIR / "phase-3c-toolcalls-manifest.json"
manifest = {
    "phase": "3c-toolcalls",
    "seed": SEED,
    "total_bytes": len(data_bytes),
    "exchange_count": sum(by_tool.values()),
    "tool_distribution": dict(sorted(by_tool.items(), key=lambda x: -x[1])),
    "sha256": sha,
    "scrub_regex_version": "phase-1-fixed-iso-timestamps",
    "tagging_convention": "<<toolcall:NAME>>\\n{input}\\n<<toolresult>>\\n{result}\\n<<endtoolcall>>",
    "tool_input_char_cap": TOOL_INPUT_CHAR_CAP,
    "tool_result_char_cap": TOOL_RESULT_CHAR_CAP,
}
with manifest_path.open("w") as fh:
    json.dump(manifest, fh, indent=2)
print(f"[corpus] manifest -> {manifest_path.relative_to(REPO_ROOT)}", flush=True)

if len(data_bytes) < MIN_BYTES_TARGET:
    print(f"[corpus] WARN: corpus is {len(data_bytes):,} bytes, below 5MB BuildCorpus rule", flush=True)
    print("[corpus] continuing anyway because Phase 3c is an exploration of corpus shape, not volume", flush=True)
else:
    print(f"[corpus] OK: corpus exceeds 5MB ({len(data_bytes)/1e6:.2f}MB)", flush=True)

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
CHECKPOINT_PATH = CHECKPOINT_DIR / "phase-3c-toolcalls-5m.pt"
EARLY_STOP_PATIENCE = 300  # iters without val improvement before stopping
best_val_loss_so_far = float("inf")
patience_counter = 0
best_val_ckpt_path = CHECKPOINT_PATH.parent / (CHECKPOINT_PATH.stem + "-best-val.pt")

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
        if vloss.item() < best_val_loss_so_far:
            best_val_loss_so_far = vloss.item()
            patience_counter = 0
            torch.save({
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
                    "phase": "3c-toolcalls",
                    "max_iters": MAX_ITERS,
                    "batch_size": BATCH_SIZE,
                    "block_size": BLOCK_SIZE,
                    "lr": LR,
                    "weight_decay": WEIGHT_DECAY,
                    "seed": SEED,
                    "device": str(DEVICE),
                    "best_val_loss": best_val_loss_so_far,
                    "corpus_bytes": len(data_bytes),
                    "corpus_sha256": sha,
                    "tool_distribution": dict(sorted(by_tool.items(), key=lambda x: -x[1])),
                    "saved_at_iter": iter_n,
                },
                "phase": 3,
                "subphase": "c-toolcalls",
                "model_id": "8gent-0.1.0-bdh-r:5m-phase-3c-toolcalls",
            }, best_val_ckpt_path)
            print(f"[train] new best val {vloss.item():.4f} at iter {iter_n} — saved best-val checkpoint", flush=True)
        else:
            patience_counter += LOG_INTERVAL
            if patience_counter >= EARLY_STOP_PATIENCE:
                print(f"[train] early stop at iter {iter_n}: no val improvement in {EARLY_STOP_PATIENCE} iters. Best was {best_val_loss_so_far:.4f}", flush=True)
                break

t_train_end = time.time()
train_seconds = t_train_end - t_train_start
print(f"[train] done in {train_seconds/60:.1f}min, best val_loss={best_val_loss_so_far:.4f}", flush=True)

checkpoint_path = CHECKPOINT_DIR / "phase-3c-toolcalls-5m.pt"
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
            "phase": "3c-toolcalls",
            "max_iters": MAX_ITERS,
            "batch_size": BATCH_SIZE,
            "block_size": BLOCK_SIZE,
            "lr": LR,
            "weight_decay": WEIGHT_DECAY,
            "seed": SEED,
            "device": str(DEVICE),
            "train_seconds": train_seconds,
            "best_val_loss": best_val_loss_so_far,
            "final_train_loss": losses_log[-1][1] if losses_log else None,
            "final_val_loss": val_losses_log[-1][1] if val_losses_log else None,
            "corpus_bytes": len(data_bytes),
            "corpus_sha256": sha,
            "tool_distribution": dict(sorted(by_tool.items(), key=lambda x: -x[1])),
        },
        "phase": 3,
        "subphase": "c-toolcalls",
        "model_id": "8gent-0.1.0-bdh-r:5m-phase-3c-toolcalls",
    },
    checkpoint_path,
)
print(f"[save] checkpoint written to {checkpoint_path.relative_to(REPO_ROOT)}", flush=True)

log_path = LOG_DIR / "phase-3c-toolcalls-train-log.json"
with log_path.open("w") as fh:
    json.dump(
        {
            "phase": "3c-toolcalls",
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
            "corpus_sha256": sha,
            "tool_distribution": dict(sorted(by_tool.items(), key=lambda x: -x[1])),
            "train_seconds": train_seconds,
            "best_val_loss": best_val_loss_so_far,
            "loss_curve_train": losses_log,
            "loss_curve_val": val_losses_log,
            "train_bytes": len(train_data),
            "val_bytes": len(val_data),
        },
        fh,
        indent=2,
    )
print(f"[log] -> {log_path.relative_to(REPO_ROOT)}", flush=True)
print(f"[done] phase 3c-toolcalls complete in {(time.time()-t0)/60:.1f}min total", flush=True)
