"""
Fine-tune a TinyStories-pretrained BDH on ToolBench / function-calling data.

Stage 2 of the byte-level pipeline. Loads the pretrain checkpoint produced
by `pretrain_tinystories.py`, points the same trainer at the ToolBench bins,
and continues with a smaller learning rate. Same model, same loss
(cross-entropy on next byte). The model just sees a different distribution.

Run (after `prep_toolbench.py` and a finished pretrain):
  python3 packages/eight-bdh/trainer/finetune_toolbench.py

Env overrides:
  BDH_DEVICE       cuda | mps | cpu        (default: auto)
  BDH_MAX_ITERS    int                     (default: 4000)
  BDH_BATCH        int                     (default: 32)
  BDH_BLOCK        int                     (default: 512)
  BDH_LR           float                   (default: 2e-4 — lower than pretrain)
  BDH_WD           float                   (default: 0.1)
  BDH_LOG          int                     (default: 25)
  BDH_EVAL         int                     (default: 250)
  BDH_SEED         int                     (default: 1338)
  BDH_PRETRAIN     path to pretrain .pt    (default: tinystories-pretrain.pt)
  BDH_OUT          path to fine-tune .pt   (default: toolbench-finetune.pt)

Outputs:
  packages/eight-bdh/checkpoints/toolbench-finetune.pt
  packages/eight-bdh/trainer/local/toolbench-finetune-train-log.jsonl
"""

from __future__ import annotations

import json
import os
import sys
import time
from contextlib import nullcontext
from pathlib import Path

import numpy as np
import torch

# ── Paths ────────────────────────────────────────────────────────────────

REPO_ROOT = Path(__file__).resolve().parents[3]
PKG_DIR = REPO_ROOT / "packages" / "eight-bdh"
DATA_DIR = PKG_DIR / "data"
CKPT_DIR = PKG_DIR / "checkpoints"
LOG_DIR = PKG_DIR / "trainer" / "local"
CKPT_DIR.mkdir(parents=True, exist_ok=True)
LOG_DIR.mkdir(parents=True, exist_ok=True)

TRAIN_BIN = DATA_DIR / "toolbench-train.bin"
VAL_BIN = DATA_DIR / "toolbench-val.bin"

DEFAULT_PRETRAIN = CKPT_DIR / "tinystories-pretrain.pt"
DEFAULT_OUT = CKPT_DIR / "toolbench-finetune.pt"
PRETRAIN = Path(os.environ.get("BDH_PRETRAIN", str(DEFAULT_PRETRAIN)))
OUT_CKPT = Path(os.environ.get("BDH_OUT", str(DEFAULT_OUT)))
LOG = LOG_DIR / "toolbench-finetune-train-log.jsonl"

BDH_REPO = Path(os.environ.get("BDH_REPO", str(Path.home() / "8gent-bdh")))
if not (BDH_REPO / "bdh.py").exists():
    print(
        f"ERROR: cannot find bdh.py at {BDH_REPO}. "
        f"Clone https://github.com/pathwaycom/bdh there or set BDH_REPO=<path>.",
        file=sys.stderr,
    )
    sys.exit(1)
sys.path.insert(0, str(BDH_REPO))
import bdh  # noqa: E402

# ── Config ───────────────────────────────────────────────────────────────

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
MAX_ITERS = int(os.environ.get("BDH_MAX_ITERS", 4000))
LEARNING_RATE = float(os.environ.get("BDH_LR", 2e-4))
WEIGHT_DECAY = float(os.environ.get("BDH_WD", 0.1))
LOG_FREQ = int(os.environ.get("BDH_LOG", 25))
EVAL_FREQ = int(os.environ.get("BDH_EVAL", 250))
SEED = int(os.environ.get("BDH_SEED", 1338))


# ── Device / dtype (mirror pretrain) ─────────────────────────────────────


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
        return "float32", torch.float32
    return "float32", torch.float32


def make_autocast_ctx(device: torch.device, dtype: torch.dtype):
    if device.type == "cuda":
        return torch.amp.autocast(device_type="cuda", dtype=dtype)
    return nullcontext()


# ── Data ─────────────────────────────────────────────────────────────────


def get_batch(split: str, device: torch.device) -> tuple[torch.Tensor, torch.Tensor]:
    path = TRAIN_BIN if split == "train" else VAL_BIN
    if not path.exists():
        print(f"ERROR: {path} not found. Run prep_toolbench.py first.", file=sys.stderr)
        sys.exit(1)
    data = np.memmap(path, dtype=np.uint8, mode="r")
    if len(data) <= BLOCK_SIZE + 1:
        raise RuntimeError(
            f"{path} only has {len(data)} bytes; need > {BLOCK_SIZE + 1}"
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


def count_params(model: torch.nn.Module) -> int:
    return sum(p.numel() for p in model.parameters())


# ── Train loop ───────────────────────────────────────────────────────────


def main() -> None:
    if not PRETRAIN.exists():
        print(
            f"ERROR: pretrain checkpoint not found at {PRETRAIN}. "
            "Run pretrain_tinystories.py first or set BDH_PRETRAIN=<path>.",
            file=sys.stderr,
        )
        sys.exit(1)

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
        f"device={device} dtype={dtype_name} block={BLOCK_SIZE} "
        f"batch={BATCH_SIZE} max_iters={MAX_ITERS} lr={LEARNING_RATE}"
    )
    print(f"loading pretrain weights from {PRETRAIN}")

    model = bdh.BDH(CONFIG_5M).to(device)
    state = torch.load(PRETRAIN, map_location=device)
    if isinstance(state, dict) and "model" in state:
        model.load_state_dict(state["model"])
        prev_iter = int(state.get("iter", 0))
    else:
        # raw state_dict
        model.load_state_dict(state)
        prev_iter = 0
    print(
        f"loaded checkpoint (prev pretrain iters={prev_iter}). "
        f"params={count_params(model):,}"
    )

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
            "stage": "finetune",
            "device": str(device),
            "dtype": dtype_name,
            "config": CONFIG_5M.__dict__,
            "block_size": BLOCK_SIZE,
            "batch_size": BATCH_SIZE,
            "max_iters": MAX_ITERS,
            "learning_rate": LEARNING_RATE,
            "weight_decay": WEIGHT_DECAY,
            "seed": SEED,
            "pretrain_ckpt": str(PRETRAIN),
            "pretrain_iters": prev_iter,
        }
    )

    model.train()
    x, y = get_batch("train", device)
    loss_acc = 0.0
    loss_steps = 0
    t_log = time.time()

    for step in range(MAX_ITERS):
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
                f"step {step:>5}/{MAX_ITERS}  ft_loss {avg:.4f}  iters/s {ips:.2f}"
            )
            log({"event": "train", "step": step, "loss": avg, "iters_per_sec": ips})
            loss_acc = 0.0
            loss_steps = 0
            t_log = time.time()

        if step > 0 and step % EVAL_FREQ == 0:
            metrics = estimate_loss(model, device)
            print(
                f"step {step:>5}  eval train={metrics['train']:.4f} "
                f"val={metrics['val']:.4f}"
            )
            log({"event": "eval", "step": step, **metrics})
            torch.save(
                {
                    "iter": step,
                    "model": model.state_dict(),
                    "config": CONFIG_5M.__dict__,
                    "stage": "finetune",
                    "pretrain_ckpt": str(PRETRAIN),
                },
                OUT_CKPT,
            )
            log({"event": "checkpoint", "step": step, "path": str(OUT_CKPT)})

    final = estimate_loss(model, device)
    print(f"final  train={final['train']:.4f} val={final['val']:.4f}")
    log({"event": "eval_final", **final})

    torch.save(
        {
            "iter": MAX_ITERS,
            "model": model.state_dict(),
            "config": CONFIG_5M.__dict__,
            "stage": "finetune",
            "pretrain_ckpt": str(PRETRAIN),
        },
        OUT_CKPT,
    )
    log({"event": "checkpoint_final", "path": str(OUT_CKPT)})

    # Smoke test on the ToolBench format the model just learned.
    model.eval()
    prompt = torch.tensor(
        bytearray("TASK: book a flight from Dublin to Lisbon next Tuesday\nTOOLS:", "utf-8"),
        dtype=torch.long,
        device=device,
    ).unsqueeze(0)
    out = model.generate(prompt, max_new_tokens=300, top_k=20)
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
