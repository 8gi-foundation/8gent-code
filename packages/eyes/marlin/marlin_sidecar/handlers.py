"""JSON-RPC method handlers for the Marlin sidecar.

Spec: docs/specs/VIDEO-INGESTION.md section 5.

Each handler takes the request ``params`` dict and the shared ``Session``
and returns a JSON-serialisable result. Handlers raise ``RpcError`` on any
failure; the dispatcher in protocol.py turns that into an error response.

The handlers depend only on the ``VideoModel`` interface, so the whole set
is exercised by the unit suite against ``MockVideoModel``.
"""

from __future__ import annotations

import hashlib
import os
import time
from typing import Any

from . import chunk, constants, errors
from .model import MarlinVideoModel, VideoModel


class Session:
    """Mutable sidecar state shared across requests.

    Holds the model, load info, start time and the timestamp of the last
    request (for idle-shutdown accounting). One Session per process.
    """

    def __init__(self, model: VideoModel | None = None) -> None:
        # Default to the real model; tests inject a MockVideoModel.
        self.model: VideoModel = model if model is not None else MarlinVideoModel()
        self.started_at = time.monotonic()
        self.last_request_at = time.monotonic()
        self.load_info: dict[str, Any] | None = None
        self.queue_depth = 0
        self.shutdown_requested = False

    def touch(self) -> None:
        """Record activity; resets the idle timer."""
        self.last_request_at = time.monotonic()

    def idle_sec(self) -> float:
        return time.monotonic() - self.last_request_at

    def uptime_sec(self) -> float:
        return time.monotonic() - self.started_at


# --- param helpers -----------------------------------------------------------


def _require(params: dict[str, Any], key: str, expected_type: type) -> Any:
    if key not in params:
        raise errors.invalid_params(f"missing required param '{key}'")
    value = params[key]
    # bool is a subtype of int; guard against bool slipping in as a number.
    if expected_type in (int, float) and isinstance(value, bool):
        raise errors.invalid_params(f"param '{key}' must be a {expected_type.__name__}")
    if not isinstance(value, expected_type):
        raise errors.invalid_params(
            f"param '{key}' must be a {expected_type.__name__}"
        )
    return value


def _optional(params: dict[str, Any], key: str, expected_type: type,
              default: Any) -> Any:
    if key not in params or params[key] is None:
        return default
    value = params[key]
    if expected_type in (int, float):
        if isinstance(value, bool):
            raise errors.invalid_params(f"param '{key}' must be a number")
        if isinstance(value, (int, float)):
            return float(value) if expected_type is float else int(value)
        raise errors.invalid_params(f"param '{key}' must be a number")
    if not isinstance(value, expected_type):
        raise errors.invalid_params(
            f"param '{key}' must be a {expected_type.__name__}"
        )
    return value


def _resolve_path(raw: str) -> str:
    """Resolve a path to a real absolute path and confirm it exists.

    Symlinks are followed by realpath; the tool layer (spec section 6) is
    responsible for traversal/root-escape policy. The sidecar only needs a
    canonical path it can hand to the decoder.
    """
    resolved = os.path.realpath(os.path.expanduser(raw))
    if not os.path.isfile(resolved):
        raise errors.invalid_params(f"file does not exist: {resolved}")
    return resolved


def _video_id(path: str) -> str:
    """Content hash (sha256 of file bytes) used as the stable video id."""
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(block)
    return f"sha256:{h.hexdigest()}"


# --- method handlers ---------------------------------------------------------


def handle_initialize(params: dict[str, Any], session: Session) -> dict[str, Any]:
    """initialize: load both models (spec section 5.1). Idempotent."""
    if session.model.loaded and session.load_info is not None:
        return session.load_info

    vision_model = _optional(params, "visionModel", str,
                             constants.DEFAULT_VISION_MODEL)
    vision_revision = _optional(params, "visionRevision", str,
                                constants.MARLIN_REVISION)
    audio_model = _optional(params, "audioModel", str,
                            constants.DEFAULT_AUDIO_MODEL)
    device = _optional(params, "device", str, constants.DEFAULT_DEVICE)
    if device not in constants.VALID_DEVICES:
        raise errors.invalid_params(
            f"device must be one of {constants.VALID_DEVICES}, got '{device}'"
        )

    info = session.model.load(vision_model, vision_revision, audio_model, device)
    result: dict[str, Any] = {
        "ready": True,
        "device": info.device,
        "mpsFallback": info.mps_fallback,
        "models": {"vision": info.vision_model, "audio": info.audio_model},
        "loadMs": info.load_ms,
        "warnings": info.warnings,
    }
    session.load_info = result
    return result


def _ensure_loaded(session: Session) -> None:
    if not session.model.loaded:
        raise errors.model_not_loaded()


def handle_caption(params: dict[str, Any], session: Session) -> dict[str, Any]:
    """caption: single-window caption (spec section 5.2). Never chunks."""
    _ensure_loaded(session)
    path = _resolve_path(_require(params, "path", str))
    probe = session.model.probe(path)

    start_sec = _optional(params, "startSec", float, 0.0)
    end_sec = _optional(params, "endSec", float, probe.duration_sec)
    fps = _optional(params, "fps", float, constants.DEFAULT_FPS)
    max_frames = _optional(params, "maxFrames", int, constants.MAX_FRAMES)
    max_tokens = _optional(params, "maxTokens", int, constants.DEFAULT_MAX_TOKENS)

    if end_sec <= start_sec:
        raise errors.invalid_params("endSec must be greater than startSec")
    max_frames = min(max_frames, constants.MAX_FRAMES)

    result = session.model.caption(path, start_sec, end_sec, fps,
                                   max_frames, max_tokens)
    return {
        "scene": result.scene,
        "events": result.events,
        "frameCount": result.frame_count,
        "truncated": result.truncated,
    }


def handle_find(params: dict[str, Any], session: Session) -> dict[str, Any]:
    """find: resolve a query to a span (spec section 5.3)."""
    _ensure_loaded(session)
    path = _resolve_path(_require(params, "path", str))
    event = _require(params, "event", str)
    probe = session.model.probe(path)
    start_sec = _optional(params, "startSec", float, 0.0)
    end_sec = _optional(params, "endSec", float, probe.duration_sec)

    result = session.model.find(path, event, start_sec, end_sec)
    return {"span": result.span, "formatOk": result.format_ok}


def handle_transcribe(params: dict[str, Any], session: Session) -> dict[str, Any]:
    """transcribe: whisper over the full audio track (spec section 5.4)."""
    _ensure_loaded(session)
    path = _resolve_path(_require(params, "path", str))
    language = _optional(params, "language", str, "auto")
    audio_track = _optional(params, "audioTrack", int, 0)

    result = session.model.transcribe(path, language, audio_track)
    return {
        "language": result.language,
        "transcript": result.transcript,
        "hasAudio": result.has_audio,
    }


def handle_extract(params: dict[str, Any], session: Session) -> dict[str, Any]:
    """extract: caption (with internal chunk-and-merge) plus transcribe.

    Returns a VideoExtraction object (spec section 7). This is the method
    extract_video calls in the common case (spec section 5.5).

    Chunk-and-merge lives here, not in caption: caption stays a pure
    single-window primitive. For each window: caption, rebase, then dedup
    seams and clamp across the merged event list.
    """
    _ensure_loaded(session)
    path = _resolve_path(_require(params, "path", str))
    fps = _optional(params, "fps", float, constants.DEFAULT_FPS)
    language = _optional(params, "language", str, "auto")
    query = _optional(params, "query", str, None)
    max_chunk_sec = _optional(params, "maxChunkSec", float,
                              constants.DEFAULT_MAX_CHUNK_SEC)

    probe = session.model.probe(path)

    # Too-short guard before any inference (spec section 5.8 / 13).
    if probe.sampled_frames_at_default_fps < constants.MIN_FRAMES:
        raise errors.video_too_short(probe.sampled_frames_at_default_fps)

    # 1. Plan windows.
    windows = chunk.plan_windows(probe.duration_sec, max_chunk_sec)
    chunked = len(windows) > 1

    # 2. Caption each window and rebase its events.
    all_events: list[dict[str, Any]] = []
    window_scenes: list[str] = []
    for (w_start, w_end) in windows:
        cap = session.model.caption(path, w_start, w_end, fps,
                                    constants.MAX_FRAMES,
                                    constants.DEFAULT_MAX_TOKENS)
        window_scenes.append(cap.scene)
        all_events.extend(chunk.rebase_events(cap.events, w_start))

    # 3. Seam-dedup, then clamp to duration.
    if chunked:
        all_events = chunk.dedup_seams(all_events)
    all_events = chunk.clamp_events(all_events, probe.duration_sec)
    all_events.sort(key=lambda e: (e["start"], e["end"]))

    # 4. Merge scenes.
    scene = chunk.merge_scenes(window_scenes)

    # 5. Transcribe the whole file in one call (audio is never chunked).
    transcribe = session.model.transcribe(path, language, 0)
    transcript = sorted(transcribe.transcript, key=lambda s: (s["start"], s["end"]))

    extraction: dict[str, Any] = {
        "videoId": _video_id(path),
        "path": path,
        "durationSec": round(probe.duration_sec, 3),
        "chunked": chunked,
        "chunkCount": len(windows),
        "scene": scene,
        "events": all_events,
        "transcript": transcript,
        "models": (session.load_info or {}).get(
            "models", {"vision": "", "audio": ""}
        ),
        "generatedAt": int(time.time() * 1000),
    }

    # 6. Optional find pass.
    if query is not None:
        find_result = session.model.find(path, query, 0.0, probe.duration_sec)
        extraction["find"] = {
            "query": query,
            "span": find_result.span,
            "formatOk": find_result.format_ok,
        }

    return extraction


def handle_health(params: dict[str, Any], session: Session) -> dict[str, Any]:
    """health: liveness and resource snapshot (spec section 5.6)."""
    rss_mb = 0
    try:
        import resource

        # ru_maxrss is bytes on macOS, kilobytes on Linux.
        maxrss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        rss_mb = int(maxrss / (1024 * 1024)) if maxrss > 10_000_000 \
            else int(maxrss / 1024)
    except Exception:  # pragma: no cover - resource always present on unix
        rss_mb = 0

    device = (session.load_info or {}).get("device", constants.DEFAULT_DEVICE)
    # queue_depth counts in-flight requests; this health call is itself one
    # of them. The reported backlog excludes the running request.
    backlog = max(session.queue_depth - 1, 0)
    return {
        "status": "ok",
        "uptimeSec": int(session.uptime_sec()),
        "rssMb": rss_mb,
        "device": device,
        "queueDepth": backlog,
    }


def handle_shutdown(params: dict[str, Any], session: Session) -> dict[str, Any]:
    """shutdown: graceful stop (spec section 5.7)."""
    session.shutdown_requested = True
    return {"stopped": True}


# Method name -> handler. The dispatcher consults this table.
HANDLERS = {
    "initialize": handle_initialize,
    "caption": handle_caption,
    "find": handle_find,
    "transcribe": handle_transcribe,
    "extract": handle_extract,
    "health": handle_health,
    "shutdown": handle_shutdown,
}
