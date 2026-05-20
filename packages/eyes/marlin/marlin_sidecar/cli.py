"""`marlin` command-line entry point.

Spec: docs/specs/VIDEO-INGESTION.md section 12 (the `marlin bench` subcommand).

Subcommands:
  marlin serve   - run the JSON-RPC sidecar on stdio (same as `python -m marlin_sidecar`).
  marlin bench   - benchmark inference latency on a real video.

`marlin bench` is a STUB. It needs real Marlin weights to produce a number,
and NemoStation/Marlin-2B is a gated HuggingFace repo whose weights cannot
be downloaded in this build environment. The subcommand wiring, argument
parsing and report shape are real; the measured numbers are not yet
obtainable. Per the verify-before-claiming rule, no roadmap line may claim
"runs locally at X seconds" until this produces a real measurement.
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
    """Benchmark stub. Requires real weights to produce a latency number."""
    print("marlin bench", file=sys.stderr)
    print(f"  video:  {args.video}", file=sys.stderr)
    print(f"  device: {args.device}", file=sys.stderr)
    print("", file=sys.stderr)

    try:
        from .model import MarlinVideoModel

        model = MarlinVideoModel()
        t0 = time.monotonic()
        model.load(
            constants.DEFAULT_VISION_MODEL,
            constants.MARLIN_REVISION,
            constants.DEFAULT_AUDIO_MODEL,
            args.device,
        )
        load_ms = int((time.monotonic() - t0) * 1000)

        t0 = time.monotonic()
        probe = model.probe(args.video)
        model.caption(args.video, 0.0, min(probe.duration_sec, 120.0),
                      constants.DEFAULT_FPS, constants.MAX_FRAMES,
                      constants.DEFAULT_MAX_TOKENS)
        caption_ms = int((time.monotonic() - t0) * 1000)

        print(f"  load:    {load_ms} ms", file=sys.stderr)
        print(f"  caption: {caption_ms} ms (first 120s window)", file=sys.stderr)
        return 0
    except Exception as exc:
        # Expected in any environment without gated weights / a placeholder pin.
        print(f"  benchmark unavailable: {exc}", file=sys.stderr)
        print(
            "  This is a STUB. Real numbers require the gated "
            "NemoStation/Marlin-2B weights and a non-placeholder "
            "MARLIN_REVISION pin.",
            file=sys.stderr,
        )
        return 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="marlin",
        description="Marlin+Whisper video understanding sidecar for 8gent-code.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    serve = sub.add_parser("serve", help="run the JSON-RPC sidecar on stdio")
    serve.set_defaults(func=_cmd_serve)

    bench = sub.add_parser("bench", help="benchmark inference latency (stub)")
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
