"""
Interactive REPL for the trained BDH checkpoints.

Usage:
  python3 packages/eight-bdh/trainer/local/play.py            # Phase 1 (default)
  python3 packages/eight-bdh/trainer/local/play.py --phase 0  # Phase 0 (rule-based corpus)

In the REPL:
  Type a prompt and hit Enter. The model continues it.
  Multi-line input: end with a single line containing only `\\\\` then Enter.

Commands (start with /):
  /temp 0.8       set sampling temperature (default 0.8)
  /topk 40        set top-k filter (default 40, 0 = disable)
  /len 200        set max tokens to generate (default 200)
  /switch 0|1     swap to Phase 0 or Phase 1 checkpoint
  /tags           list useful source tags to try
  /info           show current model + sampling config
  /q              quit (or Ctrl-C / Ctrl-D)

Source tags the model recognises (Phase 1 only):
  <<doc:packages/eight-bdh/MODEL-CARD.md>>\\n
  <<session:abc12345.json>>\\n
  <<blog:content/blog/some-post.mdx>>\\n
  <<phase-0-corpus:packages/eight-bdh/data/phase-0-seed-42.jsonl>>\\n
"""

import argparse
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[4]
BDH_REPO = Path.home() / "8gent-bdh"
CHECKPOINT_DIR = REPO_ROOT / "packages" / "eight-bdh" / "checkpoints"

sys.path.insert(0, str(BDH_REPO))

import torch
from bdh import BDH, BDHConfig

CHECKPOINTS = {
    0: CHECKPOINT_DIR / "phase-0-5m.pt",
    1: CHECKPOINT_DIR / "phase-1-explore-5m.pt",
}

USEFUL_TAGS = [
    "<<doc:packages/eight-bdh/MODEL-CARD.md>>\n",
    "<<doc:CLAUDE.md>>\n",
    "<<doc:BRAND.md>>\n",
    "<<session:abc12345.json>>\n",
    '<<session:abc12345.json>>\n{"createdAt":"',
    "<<blog:content/blog/welcome-to-the-circle.mdx>>\n",
    "<<phase-0-corpus:packages/eight-bdh/data/phase-0-seed-42.jsonl>>\n",
    # Try empty (default style)
    "",
    # Try unseen tag (probe)
    "<<email:user@example.com>>\n",
]


def select_device():
    if torch.cuda.is_available():
        return torch.device("cuda")
    if torch.backends.mps.is_available() and torch.backends.mps.is_built():
        return torch.device("mps")
    return torch.device("cpu")


DEVICE = select_device()


def load_checkpoint(phase: int):
    path = CHECKPOINTS.get(phase)
    if not path or not path.exists():
        raise FileNotFoundError(f"Checkpoint for phase {phase} not found at {path}")
    print(f"[play] loading {path.name} on {DEVICE}", flush=True)
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
    n = sum(p.numel() for p in model.parameters())
    print(f"[play] phase {phase} loaded: {n/1e6:.2f}M params", flush=True)
    return model, ckpt


def generate(model, prompt: str, max_new: int, temperature: float, top_k):
    if prompt:
        prompt_bytes = prompt.encode("utf-8")
        idx = torch.tensor([list(prompt_bytes)], dtype=torch.long, device=DEVICE)
    else:
        # Seed with a single newline byte so generate() has somewhere to start
        idx = torch.tensor([[ord("\n")]], dtype=torch.long, device=DEVICE)
    t0 = time.time()
    with torch.no_grad():
        out_idx = model.generate(
            idx,
            max_new_tokens=max_new,
            temperature=temperature,
            top_k=top_k if top_k > 0 else None,
        )
    elapsed_ms = (time.time() - t0) * 1000
    new_tokens = out_idx[0, idx.shape[1]:].tolist()
    new_text = bytes(new_tokens).decode("utf-8", errors="replace")
    return new_text, len(new_tokens), elapsed_ms


def read_multiline_prompt() -> str:
    """Read until EOF or a line equal to backslash. Empty line means single-line prompt."""
    try:
        first = input("> ")
    except (EOFError, KeyboardInterrupt):
        return "/q"
    if first.startswith("/"):
        return first
    if first.endswith("\\") and not first.endswith("\\\\"):
        # Continue on next line; first line minus trailing backslash plus newline
        lines = [first.rstrip("\\")]
        while True:
            try:
                ln = input("... ")
            except (EOFError, KeyboardInterrupt):
                break
            if ln == "\\":
                break
            lines.append(ln)
        return "\n".join(lines) + "\n"
    return first


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--phase", type=int, default=1, choices=[0, 1])
    parser.add_argument("--temp", type=float, default=0.8)
    parser.add_argument("--topk", type=int, default=40)
    parser.add_argument("--len", dest="max_len", type=int, default=200)
    args = parser.parse_args()

    phase = args.phase
    temp = args.temp
    top_k = args.topk
    max_len = args.max_len

    model, ckpt = load_checkpoint(phase)
    print(f"[play] device={DEVICE}, temp={temp}, top_k={top_k}, max_len={max_len}", flush=True)
    print('[play] type a prompt and Enter. /q to quit, /tags for examples, /switch to swap phase.', flush=True)

    while True:
        try:
            raw = read_multiline_prompt()
        except KeyboardInterrupt:
            print()
            break
        if not raw:
            continue
        if raw.startswith("/"):
            cmd, *rest = raw[1:].strip().split(maxsplit=1)
            arg = rest[0] if rest else ""
            if cmd in ("q", "quit", "exit"):
                break
            if cmd == "temp" and arg:
                try: temp = float(arg); print(f"[play] temp={temp}")
                except ValueError: print("[play] usage: /temp 0.8")
                continue
            if cmd == "topk" and arg:
                try: top_k = int(arg); print(f"[play] top_k={top_k}")
                except ValueError: print("[play] usage: /topk 40")
                continue
            if cmd == "len" and arg:
                try: max_len = int(arg); print(f"[play] max_len={max_len}")
                except ValueError: print("[play] usage: /len 200")
                continue
            if cmd == "switch" and arg:
                try:
                    new_phase = int(arg)
                    if new_phase in CHECKPOINTS:
                        model, ckpt = load_checkpoint(new_phase)
                        phase = new_phase
                except ValueError:
                    print("[play] usage: /switch 0 or /switch 1")
                continue
            if cmd == "tags":
                print("[play] useful source tags to try:")
                for t in USEFUL_TAGS:
                    print(f"   {t!r}")
                continue
            if cmd == "info":
                print(f"[play] phase={phase} model_id={ckpt.get('model_id','?')}")
                print(f"[play] best_val_loss={ckpt.get('training',{}).get('best_val_loss')}")
                print(f"[play] temp={temp} top_k={top_k} max_len={max_len}")
                continue
            print(f"[play] unknown command /{cmd}")
            continue

        text, n_tokens, ms = generate(model, raw, max_len, temp, top_k)
        print(text)
        print(f"[play] {n_tokens} tokens in {ms:.0f}ms ({ms/max(n_tokens,1):.1f} ms/tok)")

    print("[play] bye")


if __name__ == "__main__":
    main()
