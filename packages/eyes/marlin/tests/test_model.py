"""Model layer behaviour testable without weights.

The real MarlinVideoModel cannot run inference here (gated weights), but two
things are testable and important: the placeholder-revision guard, and the
mock model's configurable edge-case behaviour.
"""

import pytest

from marlin_sidecar import constants
from marlin_sidecar.errors import RpcError
from marlin_sidecar.model import MarlinVideoModel, MockVideoModel


def test_real_model_refuses_to_load_on_placeholder_revision():
    # Loading Marlin runs trust_remote_code; doing that against the
    # placeholder pin would be unreviewed code execution. The model must
    # refuse with a clear internal error.
    model = MarlinVideoModel()
    with pytest.raises(RpcError) as excinfo:
        model.load(
            constants.DEFAULT_VISION_MODEL,
            constants.MARLIN_REVISION,  # the placeholder
            constants.DEFAULT_AUDIO_MODEL,
            "cpu",
        )
    assert excinfo.value.code == constants.ERR_INTERNAL
    assert "placeholder" in excinfo.value.message.lower()


def test_real_model_starts_unloaded():
    assert MarlinVideoModel().loaded is False


def test_mock_model_load_returns_pinned_vision_id():
    model = MockVideoModel()
    info = model.load(
        constants.DEFAULT_VISION_MODEL,
        constants.MARLIN_REVISION,
        constants.DEFAULT_AUDIO_MODEL,
        "mps",
    )
    assert info.vision_model.endswith(constants.MARLIN_REVISION)
    assert model.loaded is True


def test_mock_caption_before_load_raises_model_not_loaded():
    model = MockVideoModel()
    with pytest.raises(RpcError) as excinfo:
        model.caption(__file__, 0.0, 10.0, 2.0, 240, 2048)
    assert excinfo.value.code == constants.ERR_MODEL_NOT_LOADED


def test_mock_caption_truncates_when_window_exceeds_max_frames():
    # A dense window: many sampled frames, low max_frames cap -> truncated.
    model = MockVideoModel(duration_sec=120.0, sampled_frames=2000)
    model.load("v", "r", "a", "cpu")
    result = model.caption(__file__, 0.0, 120.0, 2.0, max_frames=240,
                           max_tokens=2048)
    assert result.truncated is True
    assert result.frame_count <= 240
