"""Model layer for the Marlin sidecar.

This module defines the ``VideoModel`` interface that the JSON-RPC layer
talks to, plus two implementations:

- ``MockVideoModel``: returns deterministic fixture data. No weights, no
  torch. Used by the unit suite and by ``--mock`` for protocol smoke tests.
- ``MarlinVideoModel``: the real implementation. Loads Marlin-2B via
  transformers + MPS and mlx-whisper. It imports torch/transformers lazily
  so that importing this module never drags in the heavy dependencies.

``MARLIN_REVISION`` is pinned to a real, 8SO-reviewed commit. The real load
path still refuses to load against the ``PLACEHOLDER_REVISION`` sentinel, so
trust_remote_code never runs un-reviewed if an old config supplies it.

Spec: docs/specs/VIDEO-INGESTION.md sections 4, 5.
"""

from __future__ import annotations

import abc
import os
from dataclasses import dataclass, field
from typing import Any

from . import clip, constants, errors


def _apply_video_env() -> None:
    """Set Marlin's video-preprocessing env vars before transformers loads.

    ``modeling_marlin.py`` documents that ``FORCE_QWENVL_VIDEO_READER``,
    ``VIDEO_MAX_PIXELS``, ``FPS``, ``FPS_MAX_FRAMES`` and ``FPS_MIN_FRAMES``
    must be set before the model module is imported, and itself applies them
    via ``os.environ.setdefault`` at import time. ``setdefault`` is
    first-writer-wins, so the sidecar sets them here (during ``load``, before
    any transformers import) to the spec section 12 limits. Per-window
    ``fps`` / ``maxFrames`` overrides are applied directly to the loaded
    video processor in ``caption`` - see ``_configure_video_processor``.
    """
    os.environ.setdefault("FORCE_QWENVL_VIDEO_READER", "torchcodec")
    os.environ.setdefault("VIDEO_MAX_PIXELS", "200704")
    os.environ.setdefault("FPS", str(constants.DEFAULT_FPS))
    os.environ.setdefault("FPS_MAX_FRAMES", str(constants.MAX_FRAMES))
    os.environ.setdefault("FPS_MIN_FRAMES", str(constants.MIN_FRAMES))


# --- Result dataclasses (shapes mirror the JSON-RPC results in spec section 5) ---


@dataclass
class CaptionResult:
    """Result of a single-window caption call (spec section 5.2)."""

    scene: str
    events: list[dict[str, Any]]  # each: {"start", "end", "description"}
    frame_count: int
    truncated: bool


@dataclass
class FindResult:
    """Result of a find call (spec section 5.3)."""

    span: dict[str, float] | None  # {"start", "end"} or None
    format_ok: bool


@dataclass
class TranscribeResult:
    """Result of a transcribe call (spec section 5.4)."""

    language: str
    transcript: list[dict[str, Any]]  # each: {"start", "end", "text"}
    has_audio: bool


@dataclass
class ProbeResult:
    """Lightweight container probe used for chunk planning and validation."""

    duration_sec: float
    has_video: bool
    has_audio: bool
    # Estimated number of frames a window would sample at the given fps.
    # Used to detect the -33004 too-short condition before inference.
    sampled_frames_at_default_fps: int


@dataclass
class LoadInfo:
    """Result of loading both models (feeds the initialize response)."""

    device: str
    mps_fallback: bool
    vision_model: str   # already includes "@<revision>"
    audio_model: str
    load_ms: int
    warnings: list[str] = field(default_factory=list)


class VideoModel(abc.ABC):
    """Interface the JSON-RPC layer depends on.

    Keeping this abstract is what makes the protocol, error codes, lifecycle
    and chunk-and-merge logic testable without model weights.
    """

    @abc.abstractmethod
    def load(self, vision_model: str, vision_revision: str, audio_model: str,
             device: str) -> LoadInfo:
        """Load both models. May take tens of seconds for the real model."""

    @abc.abstractmethod
    def probe(self, path: str) -> ProbeResult:
        """Probe a media file: duration, track presence, frame estimate.

        Raises RpcError(-33002) on decode failure, (-33003) on unsupported
        container/codec.
        """

    @abc.abstractmethod
    def caption(self, path: str, start_sec: float, end_sec: float, fps: float,
                max_frames: int, max_tokens: int) -> CaptionResult:
        """Caption a single window. Pure single-window primitive: never chunks.

        Times in the returned events are WINDOW-RELATIVE (0.0 = window start).
        Rebasing onto the absolute timeline is the caller's job (spec section 8).
        """

    @abc.abstractmethod
    def find(self, path: str, event: str, start_sec: float,
             end_sec: float) -> FindResult:
        """Resolve a natural-language event to a time span."""

    @abc.abstractmethod
    def transcribe(self, path: str, language: str,
                   audio_track: int) -> TranscribeResult:
        """Transcribe the full audio track. Whisper has no window limit."""

    @property
    @abc.abstractmethod
    def loaded(self) -> bool:
        """True once load() has succeeded."""


# ---------------------------------------------------------------------------
# Mock implementation
# ---------------------------------------------------------------------------


class MockVideoModel(VideoModel):
    """Deterministic fixture model. No torch, no weights.

    Behaviour is configurable so tests can drive edge cases:

    - ``duration_sec``       : reported probe duration.
    - ``has_audio``          : whether probe reports an audio track.
    - ``sampled_frames``     : frame count probe reports at default fps;
                               set below MIN_FRAMES to exercise -33004.
    - ``decode_error``       : if set, probe raises -33002 with this detail.
    - ``unsupported``        : if set, probe raises -33003 with this detail.
    - ``oom_on_caption``     : if True, caption raises -33005.
    """

    def __init__(
        self,
        duration_sec: float = 96.0,
        has_audio: bool = True,
        sampled_frames: int = 192,
        decode_error: str | None = None,
        unsupported: str | None = None,
        oom_on_caption: bool = False,
    ) -> None:
        self.duration_sec = duration_sec
        self.has_audio = has_audio
        self.sampled_frames = sampled_frames
        self.decode_error = decode_error
        self.unsupported = unsupported
        self.oom_on_caption = oom_on_caption
        self._loaded = False
        # Records every caption() window for assertions in chunk tests.
        self.caption_calls: list[tuple[float, float]] = []

    @property
    def loaded(self) -> bool:
        return self._loaded

    def load(self, vision_model: str, vision_revision: str, audio_model: str,
             device: str) -> LoadInfo:
        self._loaded = True
        return LoadInfo(
            device=device,
            mps_fallback=(device == "mps"),
            vision_model=f"{vision_model}@{vision_revision}",
            audio_model=audio_model.rsplit("/", 1)[-1],
            load_ms=10,
            warnings=[],
        )

    def probe(self, path: str) -> ProbeResult:
        if self.unsupported is not None:
            raise errors.unsupported_format(self.unsupported)
        if self.decode_error is not None:
            raise errors.video_decode_failed(self.decode_error)
        return ProbeResult(
            duration_sec=self.duration_sec,
            has_video=True,
            has_audio=self.has_audio,
            sampled_frames_at_default_fps=self.sampled_frames,
        )

    def caption(self, path: str, start_sec: float, end_sec: float, fps: float,
                max_frames: int, max_tokens: int) -> CaptionResult:
        if not self._loaded:
            raise errors.model_not_loaded()
        if self.oom_on_caption:
            raise errors.out_of_memory(suggested_fps=max(fps / 2.0, 0.5))
        self.caption_calls.append((start_sec, end_sec))

        window = max(end_sec - start_sec, 0.0)
        # Estimate frames for this window proportional to the probe estimate.
        frames = max(
            int(round(self.sampled_frames * (window / max(self.duration_sec, 0.001)))),
            constants.MIN_FRAMES,
        )
        truncated = frames > max_frames
        frames = min(frames, max_frames)
        if frames < constants.MIN_FRAMES:
            raise errors.video_too_short(frames)

        # Two window-relative fixture events. Deterministic so chunk tests
        # can assert exact rebased timestamps.
        mid = window / 2.0
        events = [
            {"start": 0.0, "end": round(mid, 3),
             "description": "A terminal opens and a prompt is typed."},
            {"start": round(mid, 3), "end": round(window, 3),
             "description": "An agent plan renders as a checklist."},
        ]
        return CaptionResult(
            scene=f"Mock scene for window {start_sec:.1f}-{end_sec:.1f}s.",
            events=events,
            frame_count=frames,
            truncated=truncated,
        )

    def find(self, path: str, event: str, start_sec: float,
             end_sec: float) -> FindResult:
        if not self._loaded:
            raise errors.model_not_loaded()
        # "missing" anywhere in the query simulates a not-found result.
        if "missing" in event.lower():
            return FindResult(span=None, format_ok=False)
        return FindResult(
            span={"start": round(start_sec + 2.0, 3),
                  "end": round(start_sec + 6.0, 3)},
            format_ok=True,
        )

    def transcribe(self, path: str, language: str,
                   audio_track: int) -> TranscribeResult:
        if not self._loaded:
            raise errors.model_not_loaded()
        if not self.has_audio:
            return TranscribeResult(language="", transcript=[], has_audio=False)
        detected = "en" if language == "auto" else language
        transcript = [
            {"start": 0.6, "end": 3.1, "text": "Let me show you the plan rail."},
            {"start": 3.4, "end": 7.9, "text": "Each step is a task with a status."},
        ]
        return TranscribeResult(
            language=detected, transcript=transcript, has_audio=True,
        )


# ---------------------------------------------------------------------------
# Real implementation
# ---------------------------------------------------------------------------


class MarlinVideoModel(VideoModel):
    """Real Marlin-2B + mlx-whisper implementation.

    Heavy imports (torch, transformers, mlx_whisper, av/torchcodec) are done
    lazily inside methods so importing this module is cheap and the unit
    suite never needs them installed.

    UNVERIFIED: this path cannot be exercised in the PR build environment.
    See the module docstring.
    """

    def __init__(self) -> None:
        self._loaded = False
        self._device = constants.DEFAULT_DEVICE
        self._processor: Any = None
        self._vision: Any = None
        self._audio_model_id: str = constants.DEFAULT_AUDIO_MODEL
        self._vision_model_id: str = ""

    @property
    def loaded(self) -> bool:
        return self._loaded

    def load(self, vision_model: str, vision_revision: str, audio_model: str,
             device: str) -> LoadInfo:
        import time

        # Refuse to load against the placeholder sentinel. Loading Marlin
        # requires trust_remote_code=True; without a real reviewed commit
        # pin that would be arbitrary code execution from a moving target.
        if vision_revision == constants.PLACEHOLDER_REVISION:
            raise errors.internal_error(
                "vision revision is the placeholder sentinel "
                f"'{constants.PLACEHOLDER_REVISION}'. A real commit hash must "
                "be pinned (after an 8SO review of modeling_marlin.py) before "
                "the real model can be loaded. See constants.py."
            )

        t0 = time.monotonic()
        warnings: list[str] = []

        # Set video-preprocessing env vars before transformers (and the gated
        # modeling_marlin.py) are imported. modeling_marlin uses setdefault,
        # so the first writer wins - that must be us.
        _apply_video_env()

        try:
            import torch  # type: ignore
        except ImportError as exc:  # pragma: no cover - depends on env
            raise errors.internal_error(
                f"torch is not installed in this venv: {exc}"
            ) from exc

        # Device selection (spec section 4.4).
        resolved_device = device
        if device == "mps" and not torch.backends.mps.is_available():
            resolved_device = "cpu"
            warnings.append(
                "MPS is unavailable on this host; falling back to CPU. "
                "CPU video inference is supported but slow."
            )
        self._device = resolved_device

        try:
            from transformers import AutoModelForCausalLM, AutoProcessor  # type: ignore
        except ImportError as exc:  # pragma: no cover - depends on env
            raise errors.internal_error(
                f"transformers is not installed in this venv: {exc}"
            ) from exc

        try:
            self._processor = AutoProcessor.from_pretrained(
                vision_model, revision=vision_revision, trust_remote_code=True,
            )
            self._vision = AutoModelForCausalLM.from_pretrained(
                vision_model,
                revision=vision_revision,
                trust_remote_code=True,
                torch_dtype=torch.bfloat16,
                device_map={"": resolved_device},
            )
        except Exception as exc:  # pragma: no cover - needs gated weights
            raise errors.internal_error(
                f"failed to load Marlin vision model: {exc}"
            ) from exc

        # mlx-whisper loads lazily on first transcribe; just record the id.
        self._audio_model_id = audio_model
        self._vision_model_id = f"{vision_model}@{vision_revision}"
        self._loaded = True
        load_ms = int((time.monotonic() - t0) * 1000)

        return LoadInfo(
            device=resolved_device,
            mps_fallback=(resolved_device == "mps"),
            vision_model=self._vision_model_id,
            audio_model=audio_model.rsplit("/", 1)[-1],
            load_ms=load_ms,
            warnings=warnings,
        )

    def probe(self, path: str) -> ProbeResult:  # pragma: no cover - needs av
        try:
            import av  # type: ignore
        except ImportError as exc:
            raise errors.internal_error(f"av is not installed: {exc}") from exc

        try:
            container = av.open(path)
        except av.error.FFmpegError as exc:
            raise errors.video_decode_failed(str(exc)) from exc
        except Exception as exc:
            raise errors.unsupported_format(str(exc)) from exc

        try:
            video_streams = [s for s in container.streams if s.type == "video"]
            audio_streams = [s for s in container.streams if s.type == "audio"]
            if not video_streams:
                raise errors.unsupported_format("no video stream in container")
            vs = video_streams[0]
            duration_sec = float(
                (vs.duration or 0) * vs.time_base
            ) if vs.duration else float(container.duration or 0) / 1_000_000.0
            sampled = int(duration_sec * constants.DEFAULT_FPS)
            return ProbeResult(
                duration_sec=duration_sec,
                has_video=True,
                has_audio=bool(audio_streams),
                sampled_frames_at_default_fps=sampled,
            )
        finally:
            container.close()

    def _configure_video_processor(self, fps: float, max_frames: int) -> None:
        """Apply per-window fps / max_frames to the loaded video processor.

        ``modeling_marlin.caption()`` builds inputs via the processor's
        ``apply_chat_template`` with no per-call sampling args, so the only
        reliable per-window lever is the video processor's own attributes
        (``Qwen3VLVideoProcessor.fps`` / ``.max_frames``). transformers reads
        these at decode time. Setting them here honours the request's
        ``fps`` / ``maxFrames`` for this window. A no-op if the processor has
        no ``video_processor`` (older processor layouts).
        """
        vproc = getattr(self._processor, "video_processor", None)
        if vproc is None:
            return
        if hasattr(vproc, "fps"):
            vproc.fps = fps
        if hasattr(vproc, "max_frames"):
            vproc.max_frames = int(max_frames)
        if hasattr(vproc, "min_frames"):
            vproc.min_frames = constants.MIN_FRAMES

    def caption(self, path: str, start_sec: float, end_sec: float, fps: float,
                max_frames: int, max_tokens: int) -> CaptionResult:  # pragma: no cover
        if not self._loaded:
            raise errors.model_not_loaded()

        # modeling_marlin.caption() captions the WHOLE file: it has no window
        # parameter. For a strict sub-range we physically clip with ffmpeg,
        # caption the clip, then rebase clip-relative times by +start_sec.
        probe = self.probe(path)
        whole_file = clip.is_whole_file(start_sec, end_sec, probe.duration_sec)

        self._configure_video_processor(fps, max_frames)

        clip_path: str | None = None
        try:
            caption_path = path
            if not whole_file:
                try:
                    clip_path = clip.cut_window(path, start_sec, end_sec)
                except RuntimeError as exc:
                    raise errors.video_decode_failed(str(exc)) from exc
                caption_path = clip_path

            try:
                result = self._vision.caption(
                    caption_path, max_new_tokens=max_tokens,
                )
            except RuntimeError as exc:
                # MPS / CUDA OOM surfaces as a RuntimeError mentioning memory.
                msg = str(exc).lower()
                if "out of memory" in msg or "alloc" in msg:
                    raise errors.out_of_memory(
                        suggested_fps=max(fps / 2.0, 0.5)
                    ) from exc
                raise errors.internal_error(
                    f"Marlin caption generation failed: {exc}"
                ) from exc
        finally:
            if clip_path is not None:
                try:
                    os.unlink(clip_path)
                except OSError:
                    pass

        # modeling_marlin returns events as {start, end, description} dicts on
        # the captioned file's timeline. For a clipped sub-range that timeline
        # starts at 0, so rebase by +start_sec and clamp end to end_sec.
        raw_events = [dict(ev) for ev in result.get("events", [])]
        if whole_file:
            events = [
                {
                    "start": round(float(ev["start"]), 3),
                    "end": round(min(float(ev["end"]), end_sec), 3),
                    "description": ev["description"],
                }
                for ev in raw_events
            ]
        else:
            events = clip.rebase_to_window(raw_events, start_sec, end_sec)

        return CaptionResult(
            scene=result.get("scene", ""),
            events=events,
            # modeling_marlin does not expose the decoded frame count; report
            # the window's max_frames ceiling. truncated stays False because
            # the model never signals downsampling through its public API.
            frame_count=int(max_frames),
            truncated=False,
        )

    def find(self, path: str, event: str, start_sec: float,
             end_sec: float) -> FindResult:  # pragma: no cover
        if not self._loaded:
            raise errors.model_not_loaded()

        probe = self.probe(path)
        whole_file = clip.is_whole_file(start_sec, end_sec, probe.duration_sec)

        clip_path: str | None = None
        try:
            find_path = path
            if not whole_file:
                try:
                    clip_path = clip.cut_window(path, start_sec, end_sec)
                except RuntimeError as exc:
                    raise errors.video_decode_failed(str(exc)) from exc
                find_path = clip_path

            try:
                result = self._vision.find(find_path, event)
            except ValueError as exc:
                # modeling_marlin.find raises ValueError on an empty event.
                raise errors.invalid_params(str(exc)) from exc
            except RuntimeError as exc:
                msg = str(exc).lower()
                if "out of memory" in msg or "alloc" in msg:
                    raise errors.out_of_memory(suggested_fps=1.0) from exc
                raise errors.internal_error(
                    f"Marlin find generation failed: {exc}"
                ) from exc
        finally:
            if clip_path is not None:
                try:
                    os.unlink(clip_path)
                except OSError:
                    pass

        # find() returns span as a (start, end) tuple or None, on the
        # searched file's timeline. Rebase a sub-range span by +start_sec.
        model_span = result.get("span")
        if whole_file:
            if model_span is None:
                span = None
            else:
                s = float(model_span[0])
                e = min(float(model_span[1]), end_sec)
                span = {"start": round(min(s, e), 3), "end": round(e, 3)}
        else:
            span = clip.rebase_span(model_span, start_sec, end_sec)

        return FindResult(span=span, format_ok=bool(result.get("format_ok")))

    def transcribe(self, path: str, language: str,
                    audio_track: int) -> TranscribeResult:  # pragma: no cover
        if not self._loaded:
            raise errors.model_not_loaded()
        try:
            import mlx_whisper  # type: ignore
        except ImportError as exc:
            raise errors.internal_error(
                f"mlx-whisper is not installed: {exc}"
            ) from exc

        lang_arg = None if language == "auto" else language
        try:
            result = mlx_whisper.transcribe(
                path,
                path_or_hf_repo=self._audio_model_id,
                language=lang_arg,
                word_timestamps=False,
            )
        except Exception as exc:
            raise errors.video_decode_failed(str(exc)) from exc

        segments = []
        for seg in result.get("segments", []):
            # Drop hallucinated speech on noise/music (spec section 13).
            if seg.get("no_speech_prob", 0.0) > constants.NO_SPEECH_PROB_THRESHOLD:
                continue
            segments.append({
                "start": round(float(seg["start"]), 3),
                "end": round(float(seg["end"]), 3),
                "text": str(seg["text"]).strip(),
            })
        return TranscribeResult(
            language=str(result.get("language", language)),
            transcript=segments,
            has_audio=bool(segments) or True,
        )
