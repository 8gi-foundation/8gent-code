"""JSON-RPC error type for the Marlin sidecar.

Spec: docs/specs/VIDEO-INGESTION.md section 5.8.
"""

from __future__ import annotations

from typing import Any

from . import constants


class RpcError(Exception):
    """A JSON-RPC error.

    Raised anywhere in request handling; the dispatcher catches it and
    serialises it into a JSON-RPC error response. ``code`` must be one of
    the codes in spec section 5.8. ``data`` is optional structured detail
    (for example ``{"suggestion": 1.0}`` on an out-of-memory error).
    """

    def __init__(
        self,
        code: int,
        message: str | None = None,
        data: Any | None = None,
    ) -> None:
        self.code = code
        # Fall back to the canonical name for the code when no message given.
        self.message = message or constants.ERROR_NAMES.get(code, "Error")
        self.data = data
        super().__init__(self.message)

    def to_dict(self) -> dict[str, Any]:
        """Serialise to the JSON-RPC ``error`` member."""
        obj: dict[str, Any] = {"code": self.code, "message": self.message}
        if self.data is not None:
            obj["data"] = self.data
        return obj


# Convenience constructors. Each maps to one row of the spec section 5.8 table.


def parse_error(detail: str = "Malformed JSON line") -> RpcError:
    return RpcError(constants.ERR_PARSE, detail)


def invalid_request(detail: str = "Not a valid JSON-RPC object") -> RpcError:
    return RpcError(constants.ERR_INVALID_REQUEST, detail)


def method_not_found(method: str) -> RpcError:
    return RpcError(constants.ERR_METHOD_NOT_FOUND, f"Method not found: {method}")


def invalid_params(detail: str) -> RpcError:
    return RpcError(constants.ERR_INVALID_PARAMS, detail)


def internal_error(detail: str) -> RpcError:
    return RpcError(constants.ERR_INTERNAL, detail)


def model_not_loaded() -> RpcError:
    return RpcError(
        constants.ERR_MODEL_NOT_LOADED,
        "Model not loaded: call initialize before this method",
    )


def video_decode_failed(detail: str) -> RpcError:
    return RpcError(constants.ERR_VIDEO_DECODE_FAILED, f"Video decode failed: {detail}")


def unsupported_format(detail: str) -> RpcError:
    return RpcError(
        constants.ERR_UNSUPPORTED_FORMAT,
        f"Unsupported format: {detail}. Try re-encoding to H.264 mp4.",
    )


def video_too_short(frame_count: int) -> RpcError:
    return RpcError(
        constants.ERR_VIDEO_TOO_SHORT,
        f"Video too short: only {frame_count} frames sampled, Marlin needs at least "
        f"{constants.MIN_FRAMES}",
    )


def out_of_memory(suggested_fps: float) -> RpcError:
    return RpcError(
        constants.ERR_OUT_OF_MEMORY,
        "Out of memory during inference",
        data={"suggestion": {"fps": suggested_fps}},
    )


def no_audio_track() -> RpcError:
    return RpcError(
        constants.ERR_NO_AUDIO_TRACK,
        "No audio track: transcribe was called with audio forced on a silent file",
    )
