// -- Music/DJ Benchmark -------------------------------------------------------
// Tests: packages/music/ (DJ, SoxSynth, Producer, Player)
// Validates YouTube streaming, internet radio, sox synth generation,
// and BPM detection - the four core capabilities of Eight's DJ power.

export const benchmark = {
  id: "AB010",
  name: "Music: DJ Streaming, Synth, and Analysis",
  ability: "music",
  difficulty: "hard" as const,

  prompt: `You are testing Eight's DJ and music production capabilities.
Prove that all four core music subsystems work by completing the tasks below.
Use the packages/music/ module directly - no mocking, no stubs.

--- Task 1: YouTube Streaming via mpv ---
Using the DJ class from packages/music/dj.ts:
  1. Instantiate a DJ and call doctor() to verify tool availability.
  2. Report which tools are present (mpv, yt-dlp, ffmpeg, sox).
  3. If mpv and yt-dlp are available, call play("lofi hip hop beats")
     and report the "Now playing:" result string.
  4. Call nowPlaying() and report the playback status.
  5. Call stop() to clean up.
If mpv or yt-dlp are missing, report that clearly and skip to Task 2.

--- Task 2: Internet Radio ---
Using the same DJ instance:
  1. List all available radio presets by calling radioPresets().
  2. Call radio("jazz") to tune to a jazz station via the Radio Browser API.
  3. Report the station name and country returned.
  4. Call nowPlaying() to confirm the stream is active.
  5. Call stop() to clean up.
If mpv is missing, report the doctor() output and skip to Task 3.

--- Task 3: Sox Synth Beat Generation ---
Using SoxSynth from packages/music/sox-synth.ts:
  1. Instantiate SoxSynth with a temporary output directory.
  2. Generate a 4-bar drum pattern at 120 BPM using the "four-four" pattern.
  3. Generate a bass line at 120 BPM for 4 bars in key "Am".
  4. Report both output file paths and confirm the files exist on disk.
  5. Report the file sizes in bytes to prove they contain audio data
     (a valid WAV should be at least several KB).

--- Task 4: BPM Detection ---
Using the DJ class:
  1. Take the drum pattern WAV generated in Task 3.
  2. Call dj.bpm(filePath) on it.
  3. Report the estimated BPM.
  4. The input was generated at 120 BPM - the detected BPM should be
     within a reasonable range (80-160 BPM). Note whether it is accurate.
If sox is not available, report that and explain what bpm() requires.

Format your answers with headers "TASK 1:", "TASK 2:", "TASK 3:", "TASK 4:"
so each section is identifiable. Include actual return values, file paths,
and sizes - not hypothetical descriptions.`,

  successCriteria: [
    "Task 1: doctor() called and tool availability reported for mpv, yt-dlp, ffmpeg, sox",
    "Task 1: play() called with a query string, or missing-tool reported clearly",
    "Task 1: nowPlaying() result shown, or skip reason stated",
    "Task 2: radioPresets() lists at least 10 genre presets",
    "Task 2: radio('jazz') returns a station name and country, or skip reason stated",
    "Task 2: nowPlaying() confirms active stream, or skip reason stated",
    "Task 3: SoxSynth instantiated with a temp directory",
    "Task 3: generateDrums called at 120 BPM, 4 bars, four-four pattern",
    "Task 3: generateBass called at 120 BPM, 4 bars, key Am",
    "Task 3: both output file paths reported and files confirmed to exist",
    "Task 3: file sizes reported and are non-trivial (several KB minimum)",
    "Task 4: bpm() called on the drum pattern file",
    "Task 4: estimated BPM reported and reasonableness assessed",
  ],

  scoring: [
    { metric: "tool_detection_and_youtube_stream", weight: 0.20 },
    { metric: "radio_preset_listing_and_tuning", weight: 0.20 },
    { metric: "sox_synth_drum_and_bass_generation", weight: 0.35 },
    { metric: "bpm_detection_on_generated_audio", weight: 0.25 },
  ],

  timeLimit: 120,
};

export default benchmark;
