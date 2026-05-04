"""
Prepare TinyStories for byte-level BDH pretraining.

Downloads roneneldan/TinyStories from HuggingFace, concatenates each story
followed by a separator byte (0x00), and writes train.bin / val.bin as flat
uint8 streams that the BDH trainer can np.memmap directly.

Why bytes only:
  BDH vocab_size = 256. No tokenizer. The model learns over raw UTF-8 bytes.

Usage:
  python3 packages/eight-bdh/trainer/prep_tinystories.py
  python3 packages/eight-bdh/trainer/prep_tinystories.py --max-stories 200000
  python3 packages/eight-bdh/trainer/prep_tinystories.py --val-fraction 0.005

Outputs:
  packages/eight-bdh/data/tinystories-train.bin
  packages/eight-bdh/data/tinystories-val.bin
  packages/eight-bdh/data/tinystories-meta.json   (size, byte counts, separator)
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

import numpy as np

REPO_ROOT = Path(__file__).resolve().parents[3]
DATA_DIR = REPO_ROOT / "packages" / "eight-bdh" / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)

TRAIN_BIN = DATA_DIR / "tinystories-train.bin"
VAL_BIN = DATA_DIR / "tinystories-val.bin"
META = DATA_DIR / "tinystories-meta.json"

# 0x00 between stories. Picked because real text never contains a NUL byte,
# so the model learns it as an unambiguous "story break" marker.
SEPARATOR = b"\x00"


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument(
        "--dataset",
        default="roneneldan/TinyStories",
        help="HuggingFace dataset id (default: roneneldan/TinyStories)",
    )
    p.add_argument(
        "--split",
        default="train",
        help="Dataset split to use as the training pool (default: train)",
    )
    p.add_argument(
        "--val-split",
        default="validation",
        help="Optional held-out split. Falls back to val-fraction split if missing.",
    )
    p.add_argument(
        "--max-stories",
        type=int,
        default=None,
        help="Cap on stories used (None = full split).",
    )
    p.add_argument(
        "--val-fraction",
        type=float,
        default=0.005,
        help="Fraction of train split reserved for val if --val-split unavailable.",
    )
    p.add_argument(
        "--seed",
        type=int,
        default=1337,
        help="Shuffle seed (used only when slicing val from train).",
    )
    return p.parse_args()


def load_dataset_or_die(name: str, split: str):
    try:
        from datasets import load_dataset  # type: ignore
    except ImportError:
        print(
            "ERROR: `datasets` is not installed.\n"
            "  pip install 'datasets>=2.18'  (or `uv pip install datasets`)\n",
            file=sys.stderr,
        )
        sys.exit(1)
    try:
        return load_dataset(name, split=split)
    except Exception as exc:
        print(f"ERROR loading {name}[{split}]: {exc}", file=sys.stderr)
        sys.exit(1)


def stories_to_bytes(stories, max_stories: int | None) -> tuple[bytes, int]:
    chunks: list[bytes] = []
    n = 0
    for ex in stories:
        text = ex.get("text") if isinstance(ex, dict) else None
        if not text:
            continue
        chunks.append(text.encode("utf-8", errors="replace"))
        chunks.append(SEPARATOR)
        n += 1
        if max_stories is not None and n >= max_stories:
            break
    return b"".join(chunks), n


def write_bin(path: Path, payload: bytes) -> None:
    arr = np.frombuffer(payload, dtype=np.uint8)
    with open(path, "wb") as f:
        f.write(arr.tobytes())


def main() -> None:
    args = parse_args()
    t0 = time.time()
    print(f"Loading {args.dataset}[{args.split}] ...")
    train_ds = load_dataset_or_die(args.dataset, args.split)

    val_ds = None
    if args.val_split:
        try:
            val_ds = load_dataset_or_die(args.dataset, args.val_split)
            print(f"Loaded held-out {args.val_split} split: {len(val_ds)} stories")
        except SystemExit:
            print(
                f"No {args.val_split} split. Will slice val from train at "
                f"{args.val_fraction:.4f} fraction."
            )
            val_ds = None

    if val_ds is None:
        # Carve last val_fraction off the (deterministically shuffled) train pool.
        idx = np.random.default_rng(args.seed).permutation(len(train_ds))
        cut = max(1, int(len(idx) * args.val_fraction))
        val_indices = idx[:cut].tolist()
        train_indices = idx[cut:].tolist()
        val_ds = train_ds.select(val_indices)
        train_ds = train_ds.select(train_indices)
        print(f"Sliced val={len(val_ds)} train={len(train_ds)}")

    print(f"Encoding train ...")
    train_bytes, n_train = stories_to_bytes(train_ds, args.max_stories)
    print(f"  stories={n_train} bytes={len(train_bytes):,}")
    write_bin(TRAIN_BIN, train_bytes)

    print(f"Encoding val ...")
    val_bytes, n_val = stories_to_bytes(val_ds, None)
    print(f"  stories={n_val} bytes={len(val_bytes):,}")
    write_bin(VAL_BIN, val_bytes)

    meta = {
        "dataset": args.dataset,
        "split": args.split,
        "val_split": args.val_split,
        "max_stories": args.max_stories,
        "val_fraction": args.val_fraction,
        "seed": args.seed,
        "separator_hex": SEPARATOR.hex(),
        "vocab_size": 256,
        "n_train_stories": n_train,
        "n_val_stories": n_val,
        "train_bytes": len(train_bytes),
        "val_bytes": len(val_bytes),
        "train_path": str(TRAIN_BIN.relative_to(REPO_ROOT)),
        "val_path": str(VAL_BIN.relative_to(REPO_ROOT)),
        "elapsed_sec": round(time.time() - t0, 2),
    }
    META.write_text(json.dumps(meta, indent=2) + "\n")
    print(f"Wrote {TRAIN_BIN}")
    print(f"Wrote {VAL_BIN}")
    print(f"Wrote {META}")


if __name__ == "__main__":
    main()
