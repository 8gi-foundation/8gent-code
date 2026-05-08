# Quarantine: Music/DJ Benchmark

## What

Ability benchmark (`AB010`) for the `packages/music/` power - tests all four core DJ subsystems:

1. **YouTube streaming** - DJ.play() via mpv + yt-dlp
2. **Internet radio** - DJ.radio() via Radio Browser API + mpv
3. **Sox synth generation** - SoxSynth.generateDrums() and generateBass()
4. **BPM detection** - DJ.bpm() via sox + ffmpeg onset analysis

## File

`benchmarks/categories/abilities/music-dj.ts`

## Dependencies

External tools (detected at runtime by DJ.doctor()):
- `mpv` - audio playback (Tasks 1, 2)
- `yt-dlp` - YouTube search/stream (Task 1)
- `sox` - synth generation and BPM detection (Tasks 3, 4)
- `ffmpeg` - BPM onset analysis (Task 4)

The benchmark handles missing tools gracefully - Tasks 1 and 2 skip cleanly if mpv is absent, Task 3 requires sox, Task 4 requires sox + ffmpeg.

## Scoring

| Metric | Weight | What it validates |
|--------|--------|-------------------|
| tool_detection_and_youtube_stream | 0.20 | doctor() reports tools, play() streams audio |
| radio_preset_listing_and_tuning | 0.20 | radioPresets() lists genres, radio() tunes a station |
| sox_synth_drum_and_bass_generation | 0.35 | SoxSynth produces WAV files with real audio data |
| bpm_detection_on_generated_audio | 0.25 | bpm() returns a reasonable estimate for known-BPM input |

## Risk

- Tasks 1-2 require network access (YouTube, Radio Browser API) and mpv installed
- Tasks 3-4 require sox installed locally
- BPM detection accuracy varies - the benchmark allows a wide range (80-160 for 120 BPM input)
- No files modified - this is a new benchmark only

## Exit criteria

Promote from quarantine when:
- [ ] Benchmark runs successfully in the harness on a machine with all four tools installed
- [ ] Sox-only tasks (3-4) pass on CI where mpv may not be available
- [ ] Scoring weights validated against at least 3 model runs
