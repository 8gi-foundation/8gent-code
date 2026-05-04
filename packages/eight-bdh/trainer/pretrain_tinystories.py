"""
Pretrain BDH on TinyStories — 5M params, M2 Max MPS, byte-level.

This is the upstream Pathway train.py with the MPS branch wired up and the
data path repointed at the TinyStories bins. Standard cross-entropy loss
only — no ontology head, no auxiliary objective. Monosemanticity is the
job of the architecture, not the training signal.

Run (after `python3 prep_tinystories.py`):
  python3 packages/eight-bdh/trainer/pretrain_tinystories.py

Env overrides:
  BDH_DEVICE       cuda | mps | cpu        (default: auto)
  BDH_MAX_ITERS    int                     (default: 12000)
  BDH_BATCH        int                     (default: 32)
  BDH_BLOCK        int                     (default: 512)
  BDH_LR           float                   (default: 1e-3)
  BDH_WD           float                   (default: 0.1)
  BDH_LOG          int  iters per stdout   (default: 50)
  BDH_EVAL         int  iters per val pass (default: 500)
  BDH_SEED         int                     (default: 1337)
  BDH_COMPILE      0|1  torch.compile      (default: 0)
  BDH_RESUME       path to .pt to resume   (default: none)

Outputs:
  packages/eight-bdh/checkpoints/tinystories-pretrain.pt
  packages/eight-bdh/trainer/local/tinystories-pretrain-train-log.jsonl
"""

from __future__ import annotations

import json
import math
import os
import sys
import time
from contextlib import nullcontext
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F

# ── Paths ────────────────────────────────────────────────────────────────

REPO_ROOT = Path(__file__).resolve().parents[3]
PKG_DIR = REPO_ROOT / "packages" / "eight-bdh"
DATA_DIR = PKG_DIR / "data"
CKPT_DIR = PKG_DIR / "checkpoints"
LOG_DIR = PKG_DIR / "trainer" / "local"
CKPT_DIR.mkdir(parents=True, exist_ok=True)
LOG_DIR.mkdir(parents=True, exist_ok=True)

TRAIN_BIN = DATA_DIR / "tinystories-train.bin"
VAL_BIN = DATA_DIR / "tinystories-val.bin"
CKPT = CKPT_DIR / "tinystories-pretrain.pt"
LOG = LOG_DIR / "tinystories-pretrain-train-log.jsonl"

# Make the upstream bdh module importable. The repo lives at ~/8gent-bdh
# per the spec; let users override with BDH_REPO.
BDH_REPO = Path(os.environ.get("BDH_REPO", str(Path.home() / "8gent-bdh")))
if not (BDH_REPO / "bdh.py").exists():
    print(
        f"ERROR: cannot find bdh.py at {BDH_REPO}. "
        f"Clone https://github.com/pathwaycom/bdh there or set BDH_REPO=<path>.",
        file=sys.stderr,
    )
    sys.exit(1)
sys.path.insert(0, str(BDH_REPO))
import bdh  # noqa: E402  (import-after-path-edit is intentional)

# ── Config (5M, byte-level) ──────────────────────────────────────────────

CONFIG_5M = bdh.BDHConfig(
    n_layer=6,
    n_embd=160,
    n_head=4,
    mlp_internal_dim_multiplier=64,
    dropout=0.1,
    vocab_size=256,
)

BLOCK_SIZE = int(os.environ.get("BDH_BLOCK", 512))
BATCH_SIZE = int(os.environ.get("BDH_BATCH", 32))
MAX_ITERS = int(os.environ.get("BDH_MAX_ITERS", 12000))
LEARNING_RATE = float(os.environ.get("BDH_LR", 1e-3))
WEIGHT_DECAY = float(os.environ.get("BDH_WD", 0.1))
LOG_FREQ = int(os.environ.get("BDH_LOG", 50))
EVAL_FREQ = int(os.environ.get("BDH_EVAL", 500))
SEED = int(os.environ.get("BDH_SEED", 1337))
DO_COMPILE = os.environ.get("BDH_COMPILE", "0") == "1"
RESUME = os.environ.get("BDH_RESUME", "")


# ── Device / dtype selection (CUDA / MPS / CPU) ──────────────────────────


def pick_device() -> torch.device:
    forced = os.environ.get("BDH_DEVICE", "").lower().strip()
    if forced:
        return torch.device(forced)
    if torch.cuda.is_available():
        return torch.device("cuda")
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


def pick_dtype(device: torch.device) -> tuple[str, torch.dtype]:
    if device.type == "cuda" and torch.cuda.is_bf16_supported():
        return "bfloat16", torch.bfloat16
    if device.type == "cuda":
        return "float16", torch.float16
    if device.type == "mps":
        # bf16 on MPS is unstable on some torch builds; fp16 is safer for forward,
        # but mixed precision via autocast is also flaky on MPS. Use float32 for
        # the model and skip GradScaler. Throughput hit on M2 Max is acceptable
        # for a 5M model.
        return "float32", torch.float32
    return "float32", torch.float32


def make_autocast_ctx(device: torch.device, dtype: torch.dtype):
    if device.type == "cuda":
        return torch.amp.autocast(device_type="cuda", dtype=dtype)
    return nullcontext()


# ── Data loader ──────────────────────────────────────────────────────────


def get_batch(split: str, device: torch.device) -> tuple[torch.Tensor, torch.Tensor]:
    path = TRAIN_BIN if split == "train" else VAL_BIN
    if not path.exists():
        print(
            f"ERROR: {path} not found. Run prep_tinystories.py first.",
            file=sys.stderr,
        )
        sys.exit(1)
    data = np.memmap(path, dtype=np.uint8, mode="r")
    if len(data) <= BLOCK_SIZE + 1:
        raise RuntimeError(
            f"{path} only has {len(data)} bytes; need > BLOCK_SIZE+1 ({BLOCK_SIZE + 1})"
        )
    ix = torch.randint(len(data) - BLOCK_SIZE - 1, (BATCH_SIZE,))
    x = torch.stack(
        [torch.from_numpy(data[i : i + BLOCK_SIZE].astype(np.int64)) for i in ix]
    )
    y = torch.stack(
        [
            torch.from_numpy(data[i + 1 : i + 1 + BLOCK_SIZE].astype(np.int64))
            for i in ix
        ]
    )
    if device.type == "cuda":
        x = x.pin_memory().to(device, non_blocking=True)
        y = y.pin_memory().to(device, non_blocking=True)
    else:
        # MPS / CPU: pin_memory + non_blocking are CUDA-only.
        x = x.to(device)
        y = y.to(device)
    return x, y


@torch.no_grad()
def estimate_loss(model, device, n_batches: int = 20) -> dict[str, float]:
    out: dict[str, float] = {}
    model.eval()
    for split in ("train", "val"):
        losses = torch.zeros(n_batches)
        for k in range(n_batches):
            x, y = get_batch(split, device)
            _, loss = model(x, y)
            losses[k] = loss.item()
        out[split] = float(losses.mean().item())
    model.train()
    return out


# ── Param counting (sanity check 5M target) ──────────────────────────────


def count_params(model: torch.nn.Module) -> int:
    return sum(p.numel() for p in model.parameters())


# ── Train ────────────────────────────────────────────────────────────────


def main() -> None:
    torch.manual_seed(SEED)
    device = pick_device()
    dtype_name, ptdtype = pick_dtype(device)
    autocast = make_autocast_ctx(device, ptdtype)
    use_scaler = device.type == "cuda" and dtype_name == "float16"
    scaler = torch.amp.GradScaler(enabled=use_scaler) if use_scaler else None

    if device.type == "cuda":
        torch.backends.cuda.matmul.allow_tf32 = True
        torch.backends.cudnn.allow_tf32 = True

    print(
        f"device={device} dtype={dtype_name} "
        f"block={BLOCK_SIZE} batch={BATCH_SIZE} max_iters={MAX_ITERS} "
        f"lr={LEARNING_RATE} wd={WEIGHT_DECAY} compile={DO_COMPILE}"
    )
    print(
        f"corpus train={TRAIN_BIN.name} ({TRAIN_BIN.stat().st_size:,} bytes) "
        f"val={VAL_BIN.name} ({VAL_BIN.stat().st_size:,} bytes)"
    )

    model = bdh.BDH(CONFIG_5M).to(device)
    n_params = count_params(model)
    print(f"params={n_params:,} (~{n_params / 1e6:.2f}M)")

    start_iter = 0
    if RESUME:
        ckpt_path = Path(RESUME)
        if ckpt_path.exists():
            print(f"resuming from {ckpt_path}")
            state = torch.load(ckpt_path, map_location=device)
            model.load_state_dict(state["model"])
            start_iter = int(state.get("iter", 0))
        else:
            print(f"WARN: BDH_RESUME={RESUME} does not exist; starting fresh")

    if DO_COMPILE:
        try:
            model = torch.compile(model)  # type: ignore[assignment]
            print("torch.compile enabled")
        except Exception as exc:
            print(f"torch.compile failed ({exc}); continuing without compile")

    optimizer = torch.optim.AdamW(
        model.parameters(), lr=LEARNING_RATE, weight_decay=WEIGHT_DECAY
    )

    log_f = open(LOG, "a", buffering=1)

    def log(rec: dict) -> None:
        rec["t"] = round(time.time(), 3)
        log_f.write(json.dumps(rec) + "\n")

    log(
        {
            "event": "start",
            "device": str(device),
            "dtype": dtype_name,
            "params": n_params,
            "config": CONFIG_5M.__dict__,
            "block_size": BLOCK_SIZE,
            "batch_size": BATCH_SIZE,
            "max_iters": MAX_ITERS,
            "learning_rate": LEARNING_RATE,
            "weight_decay": WEIGHT_DECAY,
            "seed": SEED,
            "resume": RESUME or None,
            "start_iter": start_iter,
        }
    )

    model.train()
    x, y = get_batch("train", device)
    loss_acc = 0.0
    loss_steps = 0
    t_log = time.time()

    for step in range(start_iter, MAX_ITERS):
        with autocast:
            _, loss = model(x, y)
        x, y = get_batch("train", device)

        if scaler is not None:
            scaler.scale(loss).backward()
            scaler.step(optimizer)
            scaler.update()
        else:
            loss.backward()
            optimizer.step()
        optimizer.zero_grad(set_to_none=True)

        loss_acc += float(loss.item())
        loss_steps += 1

        if step % LOG_FREQ == 0:
            avg = loss_acc / max(1, loss_steps)
            dt = time.time() - t_log
            ips = loss_steps / dt if dt > 0 else 0.0
            print(
                f"step {step:>6}/{MAX_ITERS}  "
                f"train_loss {avg:.4f}  iters/s {ips:.2f}"
            )
            log({"event": "train", "step": step, "loss": avg, "iters_per_sec": ips})
            loss_acc = 0.0
            loss_steps = 0
            t_log = time.time()

        if step > 0 and step % EVAL_FREQ == 0:
            metrics = estimate_loss(model, device)
            print(
                f"step {step:>6}  eval train={metrics['train']:.4f} "
                f"val={metrics['val']:.4f}"
            )
            log({"event": "eval", "step": step, **metrics})
            torch.save(
                {
                    "iter": step,
                    "model": model.state_dict(),
                    "config": CONFIG_5M.__dict__,
                },
                CKPT,
            )
            log({"event": "checkpoint", "step": step, "path": str(CKPT)})

    final = estimate_loss(model, device)
    print(f"final  train={final['train']:.4f} val={final['val']:.4f}")
    log({"event": "eval_final", **final})

    torch.save(
        {
            "iter": MAX_ITERS,
            "model": model.state_dict(),
            "config": CONFIG_5M.__dict__,
        },
        CKPT,
    )
    log({"event": "checkpoint_final", "path": str(CKPT)})

    # Tiny generation smoke test so the user sees byte-level output works.
    model.eval()
    prompt = torch.tensor(
        bytearray("Once upon a time", "utf-8"), dtype=torch.long, device=device
    ).unsqueeze(0)
    out = model.generate(prompt, max_new_tokens=200, top_k=20)
    sample = bytes(out.to(torch.uint8).to("cpu").squeeze(0)).decode(
        errors="backslashreplace"
    )
    print("=" * 60)
    print(sample)
    print("=" * 60)
    log({"event": "sample", "text": sample})

    log_f.close()


if __name__ == "__main__":
    main()
