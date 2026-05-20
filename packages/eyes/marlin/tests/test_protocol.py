"""JSON-RPC protocol framing, dispatch and error codes (spec section 5)."""

import json

import pytest

from marlin_sidecar import constants, protocol
from marlin_sidecar.handlers import Session
from marlin_sidecar.model import MockVideoModel


@pytest.fixture
def session():
    """A session backed by the mock model, with no idle watchdog."""
    return Session(model=MockVideoModel())


def call(session, method, params=None, req_id=1):
    """Dispatch one request and return the parsed response dict."""
    request = {"jsonrpc": "2.0", "method": method, "id": req_id}
    if params is not None:
        request["params"] = params
    raw = protocol.dispatch(json.dumps(request), session)
    return json.loads(raw) if raw is not None else None


# --- framing -----------------------------------------------------------------


def test_blank_line_yields_no_response():
    assert protocol.dispatch("   ", Session(model=MockVideoModel())) is None


def test_malformed_json_returns_parse_error():
    resp = json.loads(protocol.dispatch("{not json", Session(model=MockVideoModel())))
    assert resp["error"]["code"] == constants.ERR_PARSE


def test_non_object_request_returns_invalid_request():
    resp = json.loads(protocol.dispatch("[1,2,3]", Session(model=MockVideoModel())))
    assert resp["error"]["code"] == constants.ERR_INVALID_REQUEST


def test_wrong_jsonrpc_version_returns_invalid_request():
    bad = json.dumps({"jsonrpc": "1.0", "method": "health", "id": 1})
    resp = json.loads(protocol.dispatch(bad, Session(model=MockVideoModel())))
    assert resp["error"]["code"] == constants.ERR_INVALID_REQUEST


def test_missing_method_returns_invalid_request():
    bad = json.dumps({"jsonrpc": "2.0", "id": 1})
    resp = json.loads(protocol.dispatch(bad, Session(model=MockVideoModel())))
    assert resp["error"]["code"] == constants.ERR_INVALID_REQUEST


def test_unknown_method_returns_method_not_found(session):
    resp = call(session, "nonexistent")
    assert resp["error"]["code"] == constants.ERR_METHOD_NOT_FOUND


def test_notification_gets_no_response(session):
    # A request with no id is a notification: dispatch returns None.
    raw = protocol.dispatch(
        json.dumps({"jsonrpc": "2.0", "method": "health"}), session
    )
    assert raw is None


def test_response_echoes_request_id(session):
    call(session, "initialize")
    resp = call(session, "health", req_id="abc-123")
    assert resp["id"] == "abc-123"
    assert resp["jsonrpc"] == "2.0"


def test_array_params_rejected(session):
    bad = json.dumps({"jsonrpc": "2.0", "method": "health", "params": [1], "id": 1})
    resp = json.loads(protocol.dispatch(bad, session))
    assert resp["error"]["code"] == constants.ERR_INVALID_PARAMS


# --- ready handshake ---------------------------------------------------------


def test_ready_notification_has_pid_and_no_id():
    note = protocol.ready_notification(4242)
    assert note["method"] == "ready"
    assert note["params"]["pid"] == 4242
    assert "id" not in note


# --- error code coverage (spec section 5.8) ---------------------------------


def test_model_not_loaded_before_initialize(session):
    # caption before initialize -> -33001.
    resp = call(session, "caption", {"path": __file__})
    assert resp["error"]["code"] == constants.ERR_MODEL_NOT_LOADED


def test_invalid_params_missing_required(session):
    call(session, "initialize")
    resp = call(session, "caption", {})  # missing 'path'
    assert resp["error"]["code"] == constants.ERR_INVALID_PARAMS


def test_invalid_params_wrong_type(session):
    call(session, "initialize")
    resp = call(session, "caption", {"path": 123})
    assert resp["error"]["code"] == constants.ERR_INVALID_PARAMS


def test_invalid_params_bad_device(session):
    resp = call(session, "initialize", {"device": "cuda"})
    assert resp["error"]["code"] == constants.ERR_INVALID_PARAMS


def test_video_decode_failed_maps_to_33002(session):
    session.model = MockVideoModel(decode_error="moov atom not found")
    call(session, "initialize")
    resp = call(session, "extract", {"path": __file__})
    assert resp["error"]["code"] == constants.ERR_VIDEO_DECODE_FAILED


def test_unsupported_format_maps_to_33003(session):
    session.model = MockVideoModel(unsupported="exotic container")
    call(session, "initialize")
    resp = call(session, "extract", {"path": __file__})
    assert resp["error"]["code"] == constants.ERR_UNSUPPORTED_FORMAT


def test_video_too_short_maps_to_33004(session):
    # Probe reports 2 sampled frames, below the 4-frame minimum.
    session.model = MockVideoModel(sampled_frames=2)
    call(session, "initialize")
    resp = call(session, "extract", {"path": __file__})
    assert resp["error"]["code"] == constants.ERR_VIDEO_TOO_SHORT


def test_out_of_memory_maps_to_33005_with_fps_suggestion(session):
    session.model = MockVideoModel(oom_on_caption=True)
    call(session, "initialize")
    resp = call(session, "extract", {"path": __file__})
    assert resp["error"]["code"] == constants.ERR_OUT_OF_MEMORY
    assert "suggestion" in resp["error"]["data"]
    assert "fps" in resp["error"]["data"]["suggestion"]


def test_invalid_params_for_missing_file(session):
    call(session, "initialize")
    resp = call(session, "caption", {"path": "/no/such/file.mp4"})
    assert resp["error"]["code"] == constants.ERR_INVALID_PARAMS


def test_all_application_error_codes_have_names():
    for code in (constants.ERR_MODEL_NOT_LOADED, constants.ERR_VIDEO_DECODE_FAILED,
                 constants.ERR_UNSUPPORTED_FORMAT, constants.ERR_VIDEO_TOO_SHORT,
                 constants.ERR_OUT_OF_MEMORY, constants.ERR_NO_AUDIO_TRACK):
        assert code in constants.ERROR_NAMES
