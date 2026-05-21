"""`marlin` command-line entry point.

Spec: docs/specs/VIDEO-INGESTION.md section 12 (the `marlin bench` subcommand).

Subcommands:
  marlin serve   - run the JSON-RPC sidecar on stdio (same as `python -m marlin_sidecar`).
  marlin bench   - benchmark inference latency on a real video.

`marlin bench` loads the real Marlin-2B weights (downloading ~5GB on first
run) and runs a real caption() pass, reporting cold-load time, caption
latency, the device used, and whether MPS fell back to CPU. Per the
verify-before-claiming rule, only a number this command actually measured
may back a "runs locally at X seconds" roadmap line.
"""

from __future__ import annotations

import argparse
import sys
import time

from . import constants
from .server import run_from_stdio


def _cmd_serve(_args: argparse.Namespace) -> int:
    return run_from_stdio()


def _cmd_bench(args: argparse.Namespace) -> int:
    """Load the real Marlin model and report real load + caption latency."""
    print("marlin bench", file=sys.stderr)
    print(f"  video:  {args.video}", file=sys.stderr)
    print(f"  device: {args.device} (requested)", file=sys.stderr)
    print("", file=sys.stderr)

    from .model import MarlinVideoModel

    model = MarlinVideoModel()

    # --- Cold load (first run downloads ~5GB of weights). ---
    print("  loading model (first run downloads weights)...", file=sys.stderr)
    t0 = time.monotonic()
    try:
        info = model.load(
            constants.DEFAULT_VISION_MODEL,
            constants.MARLIN_REVISION,
            constants.DEFAULT_AUDIO_MODEL,
            args.device,
        )
    except Exception as exc:
        print(f"  LOAD FAILED: {exc}", file=sys.stderr)
        return 1
    load_ms = int((time.monotonic() - t0) * 1000)

    print(f"  load:        {load_ms} ms ({load_ms / 1000.0:.1f} s)",
          file=sys.stderr)
    print(f"  device:      {info.device}", file=sys.stderr)
    print(f"  mps_fallback:{info.mps_fallback}", file=sys.stderr)
    for w in info.warnings:
        print(f"  warning:     {w}", file=sys.stderr)

    # --- Probe. ---
    try:
        probe = model.probe(args.video)
    except Exception as exc:
        print(f"  PROBE FAILED: {exc}", file=sys.stderr)
        return 1
    print(f"  duration:    {probe.duration_sec:.2f} s", file=sys.stderr)

    # --- Caption the whole file (a single window when <= ~2 min). ---
    window_end = min(probe.duration_sec, constants.DEFAULT_MAX_CHUNK_SEC)
    print(f"  captioning 0.0-{window_end:.1f}s ...", file=sys.stderr)
    t0 = time.monotonic()
    try:
        result = model.caption(
            args.video, 0.0, window_end,
            constants.DEFAULT_FPS, constants.MAX_FRAMES,
            constants.DEFAULT_MAX_TOKENS,
        )
    except Exception as exc:
        print(f"  CAPTION FAILED: {exc}", file=sys.stderr)
        return 1
    caption_ms = int((time.monotonic() - t0) * 1000)

    print("", file=sys.stderr)
    print("  === RESULT ===", file=sys.stderr)
    print(f"  caption latency: {caption_ms} ms ({caption_ms / 1000.0:.1f} s)",
          file=sys.stderr)
    print(f"  events:          {len(result.events)}", file=sys.stderr)
    print(f"  scene:           {result.scene}", file=sys.stderr)
    for ev in result.events:
        print(f"    [{ev['start']:.1f}-{ev['end']:.1f}s] {ev['description']}",
              file=sys.stderr)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="marlin",
        description="Marlin+Whisper video understanding sidecar for 8gent-code.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    serve = sub.add_parser("serve", help="run the JSON-RPC sidecar on stdio")
    serve.set_defaults(func=_cmd_serve)

    bench = sub.add_parser("bench", help="benchmark real inference latency")
    bench.add_argument("video", help="path to a video file to benchmark on")
    bench.add_argument("--device", default=constants.DEFAULT_DEVICE,
                       choices=list(constants.VALID_DEVICES))
    bench.set_defaults(func=_cmd_bench)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
