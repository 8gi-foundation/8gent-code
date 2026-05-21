"""Window clipping and rebasing math.

clip.py turns a sidecar caption/find window request into either a
whole-file run or an ffmpeg-clipped sub-range run, then rebases the model's
clip-relative timestamps. The whole-file detection, ffmpeg command shape and
the rebasing arithmetic are pure and tested here without weights or a decode.
"""

from marlin_sidecar import clip


# --- is_whole_file ---------------------------------------------------------


def test_whole_file_true_for_exact_zero_to_duration():
    assert clip.is_whole_file(0.0, 20.0, 20.0) is True


def test_whole_file_true_within_epsilon():
    # Slightly inside both ends but within the 0.25s tolerance.
    assert clip.is_whole_file(0.1, 19.8, 20.0) is True


def test_whole_file_false_for_strict_subrange():
    assert clip.is_whole_file(5.0, 15.0, 20.0) is False


def test_whole_file_false_when_start_offset():
    assert clip.is_whole_file(3.0, 20.0, 20.0) is False


def test_whole_file_false_when_end_short():
    assert clip.is_whole_file(0.0, 10.0, 20.0) is False


# --- ffmpeg_clip_command ---------------------------------------------------


def test_clip_command_seeks_before_input():
    cmd = clip.ffmpeg_clip_command("in.mp4", "out.mp4", 5.0, 15.0)
    # -ss before -i is a fast input seek.
    assert cmd.index("-ss") < cmd.index("-i")


def test_clip_command_duration_is_window_length():
    cmd = clip.ffmpeg_clip_command("in.mp4", "out.mp4", 5.0, 15.0)
    t_idx = cmd.index("-t")
    assert cmd[t_idx + 1] == "10.000"


def test_clip_command_reencodes_and_resets_timestamps():
    cmd = clip.ffmpeg_clip_command("in.mp4", "out.mp4", 5.0, 15.0)
    assert "libx264" in cmd
    assert "-reset_timestamps" in cmd
    assert "-an" in cmd  # caption path is visual-only


def test_clip_command_negative_window_clamps_to_zero_duration():
    cmd = clip.ffmpeg_clip_command("in.mp4", "out.mp4", 15.0, 5.0)
    t_idx = cmd.index("-t")
    assert cmd[t_idx + 1] == "0.000"


# --- rebase_to_window ------------------------------------------------------


def test_rebase_to_window_shifts_by_window_start():
    events = [{"start": 0.0, "end": 4.0, "description": "a"}]
    out = clip.rebase_to_window(events, window_start=10.0, window_end=30.0)
    assert out[0]["start"] == 10.0
    assert out[0]["end"] == 14.0


def test_rebase_to_window_clamps_end_to_window_end():
    # A model overshoot past the clip must not escape the requested window.
    events = [{"start": 5.0, "end": 999.0, "description": "overshoot"}]
    out = clip.rebase_to_window(events, window_start=10.0, window_end=30.0)
    assert out[0]["end"] == 30.0


def test_rebase_to_window_keeps_start_below_end():
    events = [{"start": 50.0, "end": 60.0, "description": "x"}]
    out = clip.rebase_to_window(events, window_start=10.0, window_end=30.0)
    assert out[0]["start"] <= out[0]["end"] == 30.0


def test_rebase_to_window_preserves_description():
    events = [{"start": 1.0, "end": 2.0, "description": "a terminal opens"}]
    out = clip.rebase_to_window(events, window_start=10.0, window_end=30.0)
    assert out[0]["description"] == "a terminal opens"


def test_rebase_to_window_empty_list():
    assert clip.rebase_to_window([], 10.0, 30.0) == []


# --- rebase_span -----------------------------------------------------------


def test_rebase_span_none_passthrough():
    assert clip.rebase_span(None, 10.0, 30.0) is None


def test_rebase_span_shifts_by_window_start():
    span = clip.rebase_span((2.0, 6.0), window_start=10.0, window_end=30.0)
    assert span == {"start": 12.0, "end": 16.0}


def test_rebase_span_clamps_end_to_window_end():
    span = clip.rebase_span((2.0, 999.0), window_start=10.0, window_end=30.0)
    assert span["end"] == 30.0
    assert span["start"] <= span["end"]
