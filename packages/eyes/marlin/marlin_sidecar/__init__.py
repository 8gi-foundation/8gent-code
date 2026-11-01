"""marlin_sidecar - Marlin+Whisper video understanding sidecar for 8gent-code.

Spec: docs/specs/VIDEO-INGESTION.md.

A long-lived Python process that speaks newline-delimited JSON-RPC 2.0 over
stdin/stdout. Marlin-2B sees (scene + timestamped events); mlx-whisper hears
(speech transcript). The `extract` method fuses both onto one media timeline.

Run as:  python -m marlin_sidecar      (JSON-RPC sidecar on stdio)
   or:    marlin serve / marlin bench  (CLI entry point)
"""

__version__ = "0.1.0"

__all__ = ["__version__"]
