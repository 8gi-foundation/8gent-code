"""Window clipping and timestamp rebasing for single-window caption/find.

Spec: docs/specs/VIDEO-INGESTION.md sections 5.2, 5.3, 8, 13.

``modeling_marlin.caption()`` and ``.find()`` always process the WHOLE file:
neither has a start/end window parameter. The sidecar's ``caption`` and
``find`` methods take ``startSec`` / ``endSec``, so a sub-range request must
physically clip the video to that range with ffmpeg before inference, then
rebase the model's clip-relative timestamps back onto the original timeline.

This module holds that math and the ffmpeg command construction as free
functions so the windowing logic is unit-testable without model weights or a
real decode (the ffmpeg call itself still needs a video, but command
construction, the whole-file detection and the rebasing are pure).
"""

from __future__ import annotations

import os
import subprocess
import tempfile
from typing import Any

# A request whose start is within this many seconds of 0 and whose end is
# within this many seconds of the probed duration is treated as "the whole
# file" - no clip is cut, the model runs directly on the original path.
WHOLE_FILE_EPSILON_SEC = 0.25


def is_whole_file(start_sec: float, end_sec: float, duration_sec: float) -> bool:
    """True if [start_sec, end_sec] covers the whole file within tolerance.

    When this holds, ``caption`` / ``find`` skip ffmpeg and run the model on
    the original path directly, which is both faster and lossless.
    """
    starts_at_zero = start_sec <= WHOLE_FILE_EPSILON_SEC
    ends_at_duration = end_sec >= (duration_sec - WHOLE_FILE_EPSILON_SEC)
    return starts_at_zero and ends_at_duration


def ffmpeg_clip_command(src: str, dst: str, start_sec: float,
                        end_sec: float) -> list[str]:
    """Build the ffmpeg argv that cuts [start_sec, end_sec] of ``src`` to ``dst``.

    ``-ss`` before ``-i`` seeks fast; ``-t`` bounds the duration. The stream
    is re-encoded (not stream-copied) so the clip starts on a clean keyframe
    and frame timestamps begin at 0 - stream-copy would leave a non-zero
    start PTS that breaks clip-relative rebasing. H.264 + yuv420p keeps the
    clip in a format Marlin's decoder handles.
    """
    duration = max(end_sec - start_sec, 0.0)
    return [
        "ffmpeg", "-y", "-loglevel", "error",
        "-ss", f"{start_sec:.3f}",
        "-i", src,
        "-t", f"{duration:.3f}",
        "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-an",  # captioning is visual-only; audio handled by transcribe
        "-reset_timestamps", "1",
        dst,
    ]


def _safe_unlink(path: str) -> None:
    """Delete ``path`` if present, swallowing OSError."""
    try:
        os.unlink(path)
    except OSError:
        pass


def cut_window(src: str, start_sec: float, end_sec: float) -> str:
    """Cut [start_sec, end_sec] of ``src`` to a temp mp4 and return its path.

    On success the caller owns the returned file and must delete it. On any
    failure - ffmpeg exiting non-zero, or ``subprocess.run`` itself raising -
    this function deletes its own temp file before propagating, so a failed
    clip never leaks a ``marlin-clip-*.mp4`` into the temp dir. Raises
    ``RuntimeError`` if ffmpeg exits non-zero, with the ffmpeg stderr tail in
    the message so a clip failure is diagnosable.
    """
    handle = tempfile.NamedTemporaryFile(
        prefix="marlin-clip-", suffix=".mp4", delete=False,
    )
    handle.close()
    dst = handle.name
    cmd = ffmpeg_clip_command(src, dst, start_sec, end_sec)
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True)
    except BaseException:
        # ffmpeg missing, OS error spawning, interrupt - own the cleanup.
        _safe_unlink(dst)
        raise
    if proc.returncode != 0:
        _safe_unlink(dst)
        raise RuntimeError(
            f"ffmpeg clip failed (exit {proc.returncode}): "
            f"{proc.stderr.strip()[-500:]}"
        )
    return dst


def rebase_to_window(events: list[dict[str, Any]], window_start: float,
                     window_end: float) -> list[dict[str, Any]]:
    """Rebase clip-relative event times onto the absolute timeline.

    When a sub-range was clipped, the model saw a clip whose first frame is
    t=0. Add ``window_start`` so every event sits on the original timeline,
    then clamp ``end`` to ``window_end`` so a model overshoot past the clip
    cannot escape the requested window (spec section 13).
    """
    rebased: list[dict[str, Any]] = []
    for ev in events:
        start = float(ev["start"]) + window_start
        end = min(float(ev["end"]) + window_start, window_end)
        start = min(start, end)
        rebased.append({
            "start": round(start, 3),
            "end": round(end, 3),
            "description": ev["description"],
        })
    return rebased


def rebase_span(span: tuple[float, float] | None, window_start: float,
                window_end: float) -> dict[str, float] | None:
    """Rebase a clip-relative find() span onto the absolute timeline.

    Returns ``{"start", "end"}`` clamped to ``window_end``, or ``None`` when
    the model located nothing (``span is None``).
    """
    if span is None:
        return None
    start = float(span[0]) + window_start
    end = min(float(span[1]) + window_start, window_end)
    start = min(start, end)
    return {"start": round(start, 3), "end": round(end, 3)}
