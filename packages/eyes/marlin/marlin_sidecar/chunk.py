"""Chunk-and-merge for videos longer than Marlin's ~2-minute window.

Spec: docs/specs/VIDEO-INGESTION.md section 8.

The brief for issue #2631 places chunk-and-merge inside the sidecar's
``extract`` method (per spec sections 5.5 and 8), while ``caption`` stays a
pure single-window primitive. This module holds that logic as free functions
so it is unit-testable without any model.

Pipeline:
  1. plan_windows    : split duration into <= maxChunkSec windows.
  2. rebase_events   : add window startSec to window-relative event times.
  3. dedup_seams     : merge near-identical events across a window boundary.
  4. clamp_events    : clamp event end to duration (spec section 13).
"""

from __future__ import annotations

from typing import Any

from . import constants


def plan_windows(duration_sec: float, max_chunk_sec: float) -> list[tuple[float, float]]:
    """Split a video duration into caption windows.

    Each window is at most ``max_chunk_sec`` long. The final window may be
    short; if it is short enough that it would sample fewer than the
    Marlin 4-frame minimum at the default fps, it is merged into the
    previous window (spec section 8 step 1).

    Returns a list of (start_sec, end_sec) tuples covering [0, duration_sec].
    A video at or under one window returns a single window.
    """
    if duration_sec <= 0:
        return [(0.0, 0.0)]
    if max_chunk_sec <= 0:
        max_chunk_sec = constants.DEFAULT_MAX_CHUNK_SEC

    windows: list[tuple[float, float]] = []
    start = 0.0
    while start < duration_sec:
        end = min(start + max_chunk_sec, duration_sec)
        windows.append((start, end))
        start = end

    # Merge a too-short trailing window into its predecessor. The minimum
    # viable window length is the time needed to sample MIN_FRAMES frames
    # at the default fps.
    min_window_sec = constants.MIN_FRAMES / constants.DEFAULT_FPS
    if len(windows) >= 2:
        last_start, last_end = windows[-1]
        if (last_end - last_start) < min_window_sec:
            prev_start, _prev_end = windows[-2]
            windows[-2] = (prev_start, last_end)
            windows.pop()

    return windows


def rebase_events(events: list[dict[str, Any]], window_start: float) -> list[dict[str, Any]]:
    """Shift window-relative event times onto the absolute media timeline.

    ``caption`` returns events with times measured from the window start
    (0.0 = first frame of the window). Adding ``window_start`` rebases them
    so every window's events share one timeline (spec section 8 step 3).
    """
    rebased: list[dict[str, Any]] = []
    for ev in events:
        rebased.append({
            "start": round(float(ev["start"]) + window_start, 3),
            "end": round(float(ev["end"]) + window_start, 3),
            "description": ev["description"],
        })
    return rebased


def _tokenize(text: str) -> set[str]:
    """Lowercase word-token set for Jaccard similarity."""
    return {tok for tok in "".join(
        c if c.isalnum() or c.isspace() else " " for c in text.lower()
    ).split() if tok}


def jaccard(a: str, b: str) -> float:
    """Token-Jaccard similarity of two descriptions, in [0.0, 1.0]."""
    ta, tb = _tokenize(a), _tokenize(b)
    if not ta and not tb:
        return 1.0
    if not ta or not tb:
        return 0.0
    inter = len(ta & tb)
    union = len(ta | tb)
    return inter / union if union else 0.0


def dedup_seams(
    events: list[dict[str, Any]],
    epsilon: float = constants.SEAM_EPSILON_SEC,
    jaccard_threshold: float = constants.SEAM_JACCARD_THRESHOLD,
) -> list[dict[str, Any]]:
    """Merge events that straddle a window boundary (spec section 8 step 4).

    Two adjacent events are merged into one spanning both when:
      - the first ends within ``epsilon`` seconds of the second's start, and
      - their descriptions have token-Jaccard above ``jaccard_threshold``.

    Input must be sorted by start. The merged event keeps the earlier
    start, the later end and the longer description. Merging is applied
    transitively so a chain of seam duplicates collapses to one event.
    """
    if not events:
        return []
    ordered = sorted(events, key=lambda e: (e["start"], e["end"]))
    merged: list[dict[str, Any]] = [dict(ordered[0])]

    for ev in ordered[1:]:
        prev = merged[-1]
        gap = ev["start"] - prev["end"]
        close = abs(gap) <= epsilon
        similar = jaccard(prev["description"], ev["description"]) > jaccard_threshold
        if close and similar:
            prev["end"] = max(prev["end"], ev["end"])
            prev["start"] = min(prev["start"], ev["start"])
            if len(ev["description"]) > len(prev["description"]):
                prev["description"] = ev["description"]
        else:
            merged.append(dict(ev))
    return merged


def clamp_events(events: list[dict[str, Any]], duration_sec: float) -> list[dict[str, Any]]:
    """Clamp event end times to the video duration (spec section 13).

    Marlin can emit a timestamp slightly beyond the real duration. Clamp
    rather than drop; a clamped event is still a valid observation.
    """
    clamped: list[dict[str, Any]] = []
    for ev in events:
        end = min(float(ev["end"]), duration_sec)
        start = min(float(ev["start"]), end)
        clamped.append({
            "start": round(start, 3),
            "end": round(end, 3),
            "description": ev["description"],
        })
    return clamped


def merge_scenes(window_scenes: list[str]) -> str:
    """Merge per-window scene paragraphs into one.

    Spec section 8 step 5 calls for a stage-2 LLM summarisation pass. The
    sidecar has no text LLM of its own, so it concatenates verbatim and
    leaves summarisation to the TS side (video-extractor.ts), exactly as
    the spec's "if the LLM is unavailable, the concatenation is kept
    verbatim" fallback prescribes.
    """
    return "\n\n".join(s.strip() for s in window_scenes if s.strip())
