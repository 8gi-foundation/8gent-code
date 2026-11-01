"""Chunk-and-merge math (spec section 8). Pure functions, no model."""

from marlin_sidecar import chunk, constants


# --- plan_windows ------------------------------------------------------------


def test_short_video_is_one_window():
    windows = chunk.plan_windows(96.0, 120.0)
    assert windows == [(0.0, 96.0)]


def test_exact_window_boundary_is_one_window():
    windows = chunk.plan_windows(120.0, 120.0)
    assert windows == [(0.0, 120.0)]


def test_long_video_splits_into_even_windows():
    windows = chunk.plan_windows(360.0, 120.0)
    assert windows == [(0.0, 120.0), (120.0, 240.0), (240.0, 360.0)]


def test_windows_are_contiguous_and_cover_duration():
    windows = chunk.plan_windows(500.0, 120.0)
    assert windows[0][0] == 0.0
    assert windows[-1][1] == 500.0
    for (_, end), (next_start, _) in zip(windows, windows[1:]):
        assert end == next_start


def test_tiny_trailing_window_merges_into_previous():
    # 241s at 120s windows would be (0,120),(120,240),(240,241). The 1s tail
    # samples only 2 frames at 2fps, below the 4-frame minimum, so it merges.
    windows = chunk.plan_windows(241.0, 120.0)
    assert windows == [(0.0, 120.0), (120.0, 241.0)]


def test_trailing_window_kept_when_long_enough():
    # 260s -> (0,120),(120,240),(240,260). The 20s tail is well above the
    # 2s minimum, so it stays its own window.
    windows = chunk.plan_windows(260.0, 120.0)
    assert windows == [(0.0, 120.0), (120.0, 240.0), (240.0, 260.0)]


def test_zero_duration_returns_degenerate_window():
    assert chunk.plan_windows(0.0, 120.0) == [(0.0, 0.0)]


def test_one_hour_video_chunks_linearly():
    windows = chunk.plan_windows(3600.0, 120.0)
    assert len(windows) == 30
    assert windows[-1][1] == 3600.0


# --- rebase_events -----------------------------------------------------------


def test_rebase_shifts_window_relative_times_onto_absolute_timeline():
    events = [
        {"start": 0.0, "end": 4.0, "description": "a"},
        {"start": 4.0, "end": 10.0, "description": "b"},
    ]
    rebased = chunk.rebase_events(events, window_start=120.0)
    assert rebased[0]["start"] == 120.0
    assert rebased[0]["end"] == 124.0
    assert rebased[1]["start"] == 124.0
    assert rebased[1]["end"] == 130.0


def test_rebase_at_zero_is_identity():
    events = [{"start": 1.5, "end": 3.0, "description": "x"}]
    assert chunk.rebase_events(events, 0.0) == events


# --- jaccard -----------------------------------------------------------------


def test_jaccard_identical_strings():
    assert chunk.jaccard("a plan renders", "a plan renders") == 1.0


def test_jaccard_disjoint_strings():
    assert chunk.jaccard("terminal opens", "music plays") == 0.0


def test_jaccard_partial_overlap():
    # {the,plan,renders} vs {the,plan,closes} -> 2 shared / 4 union = 0.5
    assert chunk.jaccard("the plan renders", "the plan closes") == 0.5


def test_jaccard_ignores_punctuation_and_case():
    assert chunk.jaccard("Plan, renders!", "plan renders") == 1.0


# --- dedup_seams -------------------------------------------------------------


def test_seam_dedup_merges_near_identical_boundary_events():
    # Two windows: an event ending at the seam and one starting at the seam
    # with a near-identical description. They collapse into one.
    events = [
        {"start": 110.0, "end": 119.9, "description": "an agent plan renders as a checklist"},
        {"start": 120.0, "end": 128.0, "description": "an agent plan renders as a checklist now"},
    ]
    merged = chunk.dedup_seams(events)
    assert len(merged) == 1
    assert merged[0]["start"] == 110.0
    assert merged[0]["end"] == 128.0


def test_seam_dedup_keeps_distinct_events():
    events = [
        {"start": 110.0, "end": 119.9, "description": "the terminal opens"},
        {"start": 120.0, "end": 128.0, "description": "a file tree is browsed"},
    ]
    merged = chunk.dedup_seams(events)
    assert len(merged) == 2


def test_seam_dedup_keeps_similar_events_far_apart():
    # Same description but a 30s gap: not a seam, must not merge.
    events = [
        {"start": 10.0, "end": 20.0, "description": "an agent plan renders"},
        {"start": 50.0, "end": 60.0, "description": "an agent plan renders"},
    ]
    merged = chunk.dedup_seams(events)
    assert len(merged) == 2


def test_seam_dedup_keeps_longer_description():
    # Descriptions must clear the 0.8 Jaccard bar to merge at all. Here the
    # second adds one token to the first: 5 shared / 6 union = 0.833 > 0.8.
    short = "the agent plan renders a checklist"
    long = "the agent plan renders a full checklist"
    events = [
        {"start": 119.0, "end": 119.9, "description": short},
        {"start": 120.0, "end": 121.0, "description": long},
    ]
    merged = chunk.dedup_seams(events)
    assert len(merged) == 1
    assert merged[0]["description"] == long


def test_seam_dedup_empty_input():
    assert chunk.dedup_seams([]) == []


def test_seam_dedup_transitive_chain_collapses():
    # Three consecutive seam-duplicate events collapse to one span.
    desc = "the agent plan renders as a checklist"
    events = [
        {"start": 0.0, "end": 9.9, "description": desc},
        {"start": 10.0, "end": 19.9, "description": desc},
        {"start": 20.0, "end": 30.0, "description": desc},
    ]
    merged = chunk.dedup_seams(events, epsilon=0.5)
    assert len(merged) == 1
    assert merged[0]["start"] == 0.0
    assert merged[0]["end"] == 30.0


# --- clamp_events ------------------------------------------------------------


def test_clamp_pulls_overshooting_end_back_to_duration():
    events = [{"start": 95.0, "end": 99.0, "description": "x"}]
    clamped = chunk.clamp_events(events, duration_sec=96.4)
    assert clamped[0]["end"] == 96.4
    assert clamped[0]["start"] == 95.0


def test_clamp_leaves_in_bounds_events_untouched():
    events = [{"start": 1.0, "end": 5.0, "description": "x"}]
    assert chunk.clamp_events(events, 96.0) == events


def test_clamp_keeps_start_not_after_end():
    events = [{"start": 200.0, "end": 300.0, "description": "x"}]
    clamped = chunk.clamp_events(events, duration_sec=96.0)
    assert clamped[0]["end"] == 96.0
    assert clamped[0]["start"] <= clamped[0]["end"]


# --- merge_scenes ------------------------------------------------------------


def test_merge_scenes_concatenates_non_empty_paragraphs():
    merged = chunk.merge_scenes(["window one.", "", "window two."])
    assert merged == "window one.\n\nwindow two."


def test_merge_scenes_empty_list():
    assert chunk.merge_scenes([]) == ""
