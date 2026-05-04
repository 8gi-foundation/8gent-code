"""
Prepare ToolBench / Berkeley Function Calling for byte-level BDH fine-tune.

Function-calling data — "given this task and these tools, pick the right
tool" — flattened into byte streams so it can fine-tune the same byte-level
model that pretrained on TinyStories.

Source datasets (try in order, take the first that loads):
  1. gorilla-llm/Berkeley-Function-Calling-Leaderboard
  2. ShishirPatil/gorilla
  3. ToolBench/ToolBench

Override with --dataset.

Format on disk: each example is concatenated into the bin as

  TASK: <user query>\n
  TOOLS: <one-line JSON list of tool schemas>\n
  CALL: <one-line JSON of the chosen function call>\n
  \x00

The trailing 0x00 separates examples (same convention as the TinyStories prep
script). The model sees TASK/TOOLS/CALL as plain bytes — no special tokens.

Usage:
  python3 packages/eight-bdh/trainer/prep_toolbench.py
  python3 packages/eight-bdh/trainer/prep_toolbench.py --dataset ToolBench/ToolBench
  python3 packages/eight-bdh/trainer/prep_toolbench.py --max-examples 50000

Outputs:
  packages/eight-bdh/data/toolbench-train.bin
  packages/eight-bdh/data/toolbench-val.bin
  packages/eight-bdh/data/toolbench-meta.json
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np

REPO_ROOT = Path(__file__).resolve().parents[3]
DATA_DIR = REPO_ROOT / "packages" / "eight-bdh" / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)

TRAIN_BIN = DATA_DIR / "toolbench-train.bin"
VAL_BIN = DATA_DIR / "toolbench-val.bin"
META = DATA_DIR / "toolbench-meta.json"

SEPARATOR = b"\x00"

CANDIDATE_DATASETS = [
    "gorilla-llm/Berkeley-Function-Calling-Leaderboard",
    "ShishirPatil/gorilla",
    "ToolBench/ToolBench",
]


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument(
        "--dataset",
        default=None,
        help="HuggingFace dataset id. Defaults: try the candidates in order.",
    )
    p.add_argument(
        "--split",
        default="train",
        help="Split to use (default: train). Some BFCL releases use 'test'.",
    )
    p.add_argument(
        "--max-examples",
        type=int,
        default=None,
        help="Cap on examples used (None = full split).",
    )
    p.add_argument(
        "--val-fraction",
        type=float,
        default=0.02,
        help="Held-out fraction for validation (default 0.02 = 2 percent).",
    )
    p.add_argument(
        "--seed",
        type=int,
        default=1337,
        help="Shuffle seed for the train/val split.",
    )
    return p.parse_args()


def try_load(name: str, split: str):
    try:
        from datasets import load_dataset  # type: ignore
    except ImportError:
        print(
            "ERROR: `datasets` is not installed.\n"
            "  pip install 'datasets>=2.18'\n",
            file=sys.stderr,
        )
        sys.exit(1)
    try:
        return load_dataset(name, split=split)
    except Exception as exc:
        print(f"  ! failed to load {name}[{split}]: {exc}")
        return None


def load_first_available(preferred: str | None, split: str):
    candidates = [preferred] if preferred else CANDIDATE_DATASETS
    for name in candidates:
        if name is None:
            continue
        print(f"Trying {name}[{split}] ...")
        ds = try_load(name, split)
        if ds is not None:
            print(f"  loaded {len(ds)} examples from {name}")
            return name, ds
    print(
        "ERROR: none of the candidate ToolBench datasets loaded. "
        "Pass --dataset <hf_id> with a known-good name, or check network / hf auth.",
        file=sys.stderr,
    )
    sys.exit(1)


def coerce_example(ex: dict) -> dict | None:
    """
    Map heterogeneous schemas (BFCL, gorilla, ToolBench) into a uniform
    {task, tools, call} dict. Returns None if the example can't be coerced.
    """
    if not isinstance(ex, dict):
        return None

    task = (
        ex.get("question")
        or ex.get("query")
        or ex.get("instruction")
        or ex.get("prompt")
        or ex.get("input")
    )
    tools = (
        ex.get("functions")
        or ex.get("tools")
        or ex.get("api")
        or ex.get("apis")
    )
    call = (
        ex.get("answer")
        or ex.get("ground_truth")
        or ex.get("output")
        or ex.get("response")
        or ex.get("function_call")
    )

    if not task or call is None:
        return None
    if tools is None:
        # Some BFCL splits embed the tool schema in the question; keep an empty list.
        tools = []
    return {"task": task, "tools": tools, "call": call}


def example_to_bytes(item: dict) -> bytes:
    task = str(item["task"]).strip()
    tools_json = json.dumps(item["tools"], ensure_ascii=False, separators=(",", ":"))
    call_json = (
        item["call"]
        if isinstance(item["call"], str)
        else json.dumps(item["call"], ensure_ascii=False, separators=(",", ":"))
    )
    block = (
        f"TASK: {task}\n"
        f"TOOLS: {tools_json}\n"
        f"CALL: {call_json}\n"
    )
    return block.encode("utf-8", errors="replace") + SEPARATOR


def encode(ds, max_examples: int | None) -> tuple[bytes, int, int]:
    chunks: list[bytes] = []
    used = 0
    skipped = 0
    for ex in ds:
        item = coerce_example(ex if isinstance(ex, dict) else dict(ex))
        if item is None:
            skipped += 1
            continue
        chunks.append(example_to_bytes(item))
        used += 1
        if max_examples is not None and used >= max_examples:
            break
    return b"".join(chunks), used, skipped


def write_bin(path: Path, payload: bytes) -> None:
    arr = np.frombuffer(payload, dtype=np.uint8)
    with open(path, "wb") as f:
        f.write(arr.tobytes())


def main() -> None:
    args = parse_args()
    t0 = time.time()

    name, ds = load_first_available(args.dataset, args.split)

    # Train/val split (deterministic).
    n = len(ds)
    rng = np.random.default_rng(args.seed)
    idx = rng.permutation(n)
    cut = max(1, int(n * args.val_fraction))
    val_idx = idx[:cut].tolist()
    train_idx = idx[cut:].tolist()
    train_ds = ds.select(train_idx)
    val_ds = ds.select(val_idx)

    print(f"Encoding train ({len(train_ds)} examples) ...")
    train_bytes, n_train, n_train_skipped = encode(train_ds, args.max_examples)
    print(f"  used={n_train} skipped={n_train_skipped} bytes={len(train_bytes):,}")
    write_bin(TRAIN_BIN, train_bytes)

    print(f"Encoding val ({len(val_ds)} examples) ...")
    val_bytes, n_val, n_val_skipped = encode(val_ds, None)
    print(f"  used={n_val} skipped={n_val_skipped} bytes={len(val_bytes):,}")
    write_bin(VAL_BIN, val_bytes)

    meta = {
        "dataset": name,
        "split": args.split,
        "max_examples": args.max_examples,
        "val_fraction": args.val_fraction,
        "seed": args.seed,
        "separator_hex": SEPARATOR.hex(),
        "block_format": "TASK: ...\\nTOOLS: ...\\nCALL: ...\\n",
        "vocab_size": 256,
        "n_train_examples": n_train,
        "n_val_examples": n_val,
        "n_train_skipped": n_train_skipped,
        "n_val_skipped": n_val_skipped,
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
