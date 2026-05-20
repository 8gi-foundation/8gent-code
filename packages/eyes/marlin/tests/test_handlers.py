"""JSON-RPC method handlers against the mock model (spec section 5)."""

import json

import pytest

from marlin_sidecar import constants, protocol
from marlin_sidecar.handlers import Session
from marlin_sidecar.model import MockVideoModel


@pytest.fixture
def session():
    return Session(model=MockVideoModel())


def call(session, method, params=None, req_id=1):
    request = {"jsonrpc": "2.0", "method": method, "id": req_id}
    if params is not None:
        request["params"] = params
    return json.loads(protocol.dispatch(json.dumps(request), session))


# --- initialize --------------------------------------------------------------


def test_initialize_returns_ready_and_device(session):
    resp = call(session, "initialize")
    r = resp["result"]
    assert r["ready"] is True
    assert r["device"] == constants.DEFAULT_DEVICE
    assert "vision" in r["models"]
    assert "audio" in r["models"]
    assert isinstance(r["loadMs"], int)


def test_initialize_pins_revision_in_vision_model_id(session):
    resp = call(session, "initialize")
    # The placeholder pin must be visible in the model id string.
    assert constants.MARLIN_REVISION in resp["result"]["models"]["vision"]


def test_initialize_is_idempotent(session):
    first = call(session, "initialize")["result"]
    second = call(session, "initialize")["result"]
    assert first == second


def test_initialize_honours_device_cpu(session):
    resp = call(session, "initialize", {"device": "cpu"})
    assert resp["result"]["device"] == "cpu"


# --- caption -----------------------------------------------------------------


def test_caption_returns_scene_and_events(session):
    call(session, "initialize")
    resp = call(session, "caption", {"path": __file__})
    r = resp["result"]
    assert isinstance(r["scene"], str)
    assert isinstance(r["events"], list)
    assert "frameCount" in r
    assert "truncated" in r


def test_caption_rejects_end_before_start(session):
    call(session, "initialize")
    resp = call(session, "caption", {"path": __file__, "startSec": 50, "endSec": 10})
    assert resp["error"]["code"] == constants.ERR_INVALID_PARAMS


def test_caption_does_not_chunk(session):
    # caption is a pure single-window primitive: one model call regardless
    # of duration. A 600s mock video must still produce exactly one call.
    session.model = MockVideoModel(duration_sec=600.0)
    call(session, "initialize")
    call(session, "caption", {"path": __file__})
    assert len(session.model.caption_calls) == 1


# --- find --------------------------------------------------------------------


def test_find_returns_span_when_located(session):
    call(session, "initialize")
    resp = call(session, "find", {"path": __file__, "event": "plan renders"})
    r = resp["result"]
    assert r["formatOk"] is True
    assert r["span"] is not None
    assert "start" in r["span"] and "end" in r["span"]


def test_find_returns_null_span_when_not_located(session):
    call(session, "initialize")
    resp = call(session, "find", {"path": __file__, "event": "the missing scene"})
    r = resp["result"]
    assert r["formatOk"] is False
    assert r["span"] is None


# --- transcribe --------------------------------------------------------------


def test_transcribe_returns_segments(session):
    call(session, "initialize")
    resp = call(session, "transcribe", {"path": __file__})
    r = resp["result"]
    assert r["hasAudio"] is True
    assert len(r["transcript"]) > 0
    assert r["language"] == "en"


def test_transcribe_no_audio_returns_empty(session):
    session.model = MockVideoModel(has_audio=False)
    call(session, "initialize")
    resp = call(session, "transcribe", {"path": __file__})
    r = resp["result"]
    assert r["hasAudio"] is False
    assert r["transcript"] == []


def test_transcribe_explicit_language_overrides_auto(session):
    call(session, "initialize")
    resp = call(session, "transcribe", {"path": __file__, "language": "fr"})
    assert resp["result"]["language"] == "fr"


# --- extract -----------------------------------------------------------------


def test_extract_returns_video_extraction_shape(session):
    call(session, "initialize")
    resp = call(session, "extract", {"path": __file__})
    r = resp["result"]
    for key in ("videoId", "path", "durationSec", "chunked", "chunkCount",
                "scene", "events", "transcript", "models", "generatedAt"):
        assert key in r, f"missing key {key}"
    assert r["videoId"].startswith("sha256:")


def test_extract_short_video_is_not_chunked(session):
    session.model = MockVideoModel(duration_sec=96.0)
    call(session, "initialize")
    r = call(session, "extract", {"path": __file__})["result"]
    assert r["chunked"] is False
    assert r["chunkCount"] == 1
    assert len(session.model.caption_calls) == 1


def test_extract_long_video_chunks_and_merges(session):
    # 300s at default 120s windows -> 3 windows, 3 caption calls.
    session.model = MockVideoModel(duration_sec=300.0, sampled_frames=600)
    call(session, "initialize")
    r = call(session, "extract", {"path": __file__})["result"]
    assert r["chunked"] is True
    assert r["chunkCount"] == 3
    assert len(session.model.caption_calls) == 3


def test_extract_chunked_events_are_rebased_onto_absolute_timeline(session):
    # With 300s / 120s windows, the second window starts at 120s. Its first
    # mock event must therefore start at or after 120s, never window-relative.
    session.model = MockVideoModel(duration_sec=300.0, sampled_frames=600)
    call(session, "initialize")
    r = call(session, "extract", {"path": __file__})["result"]
    starts = [e["start"] for e in r["events"]]
    assert max(starts) >= 120.0
    # Events stay sorted and within duration.
    assert starts == sorted(starts)
    assert all(e["end"] <= r["durationSec"] + 0.001 for e in r["events"])


def test_extract_audio_is_not_chunked(session):
    # transcribe is called exactly once even for a long chunked video.
    session.model = MockVideoModel(duration_sec=600.0, sampled_frames=1200)
    call(session, "initialize")
    r = call(session, "extract", {"path": __file__})["result"]
    assert r["chunked"] is True
    # The mock transcript has 2 fixed segments regardless of chunk count.
    assert len(r["transcript"]) == 2


def test_extract_with_query_includes_find_block(session):
    call(session, "initialize")
    r = call(session, "extract", {"path": __file__, "query": "plan renders"})["result"]
    assert "find" in r
    assert r["find"]["query"] == "plan renders"
    assert r["find"]["span"] is not None


def test_extract_without_query_omits_find_block(session):
    call(session, "initialize")
    r = call(session, "extract", {"path": __file__})["result"]
    assert "find" not in r


def test_extract_too_short_video_errors_before_inference(session):
    session.model = MockVideoModel(sampled_frames=2)
    call(session, "initialize")
    resp = call(session, "extract", {"path": __file__})
    assert resp["error"]["code"] == constants.ERR_VIDEO_TOO_SHORT
    # No caption call should have happened.
    assert len(session.model.caption_calls) == 0


# --- health ------------------------------------------------------------------


def test_health_reports_status_and_uptime(session):
    call(session, "initialize")
    r = call(session, "health")["result"]
    assert r["status"] == "ok"
    assert r["uptimeSec"] >= 0
    assert r["device"] == constants.DEFAULT_DEVICE
    assert r["queueDepth"] == 0


def test_health_works_before_initialize(session):
    # health must answer even with no model loaded (it is a liveness probe).
    r = call(session, "health")["result"]
    assert r["status"] == "ok"


# --- shutdown ----------------------------------------------------------------


def test_shutdown_sets_flag_and_acknowledges(session):
    r = call(session, "shutdown")["result"]
    assert r["stopped"] is True
    assert session.shutdown_requested is True
