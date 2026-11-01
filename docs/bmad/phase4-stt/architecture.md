# Phase 4: Speech-to-Text — Technical Architecture

## Package Structure

```
packages/voice/
  package.json              ← Package manifest, deps
  types.ts                  ← VoiceConfig, TranscriptEvent, RecordingState, WhisperModel
  recorder.ts               ← Mic recording via sox subprocess (WAV output)
  model-manager.ts          ← Download/list/select Whisper GGML models
  transcriber.ts            ← Local Whisper transcription via whisper.cpp subprocess
  cloud-transcriber.ts      ← OpenAI Whisper API fallback
  vad.ts                    ← Voice Activity Detection (energy-based)
  index.ts                  ← VoiceEngine class — unified public API

apps/tui/src/
  hooks/useVoiceInput.ts    ← React hook wrapping VoiceEngine for TUI
  components/VoiceIndicator.tsx ← Recording status + audio level display
```

## Data Flow

```
┌─────────────────────────────────────────────────────┐
│                    TUI Layer                         │
│                                                      │
│  useVoiceInput() hook                                │
│    ├── Ctrl+Space pressed → voiceEngine.start()      │
│    ├── Ctrl+Space released → voiceEngine.stop()      │
│    ├── onPartialTranscript → update preview text     │
│    └── onFinalTranscript → inject into CommandInput  │
│                                                      │
│  VoiceIndicator component                            │
│    ├── Shows recording state (idle/recording/transcribing) │
│    ├── Audio level meter (from recorder)             │
│    └── Current model name                            │
└──────────────────┬──────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────┐
│              packages/voice (VoiceEngine)             │
│                                                      │
│  start()                                             │
│    └── recorder.start() → spawns `rec` subprocess    │
│         ├── Writes 16kHz mono WAV to temp file       │
│         └── Emits audioLevel events (RMS energy)     │
│                                                      │
│  stop()                                              │
│    └── recorder.stop() → kills `rec`, finalizes WAV  │
│         └── transcriber.transcribe(wavPath)           │
│              ├── LOCAL: spawns whisper.cpp CLI        │
│              │    └── Parses stdout → TranscriptEvent │
│              └── CLOUD: POST to OpenAI /v1/audio     │
│                   └── Parses JSON → TranscriptEvent  │
│                                                      │
│  Model Manager                                       │
│    ├── listModels() → available + downloaded          │
│    ├── downloadModel(name) → fetch GGML, show progress│
│    └── getModelPath(name) → local path or null       │
└─────────────────────────────────────────────────────┘
```

## Key Design Decisions

### 1. sox/rec for microphone recording

**Why:** Universal CLI tool, no native bindings, works on macOS/Linux, Bun subprocess-friendly.

```bash
# Record 16kHz mono WAV (Whisper's expected format)
rec -q -r 16000 -c 1 -b 16 /tmp/8gent-voice.wav
```

**Alternative considered:** PortAudio bindings — rejected because native addons are fragile with Bun.

### 2. whisper.cpp CLI subprocess (not whisper-node)

**Why:** whisper-node has C++ binding compatibility issues with Bun. The whisper.cpp CLI (`main` binary) is a standalone executable that works perfectly via subprocess. We download pre-built binaries or build from source.

```bash
# Transcribe with whisper.cpp CLI
./whisper.cpp/main -m models/ggml-tiny.bin -f /tmp/voice.wav --no-timestamps -nt
```

**Fallback:** If whisper.cpp binary not available, fall back to OpenAI Whisper API.

### 3. Streaming via chunked recording

For real-time partial transcription (P1):

```
[Record 2s chunk] → [Transcribe chunk] → [Emit partial]
[Record 2s chunk] → [Transcribe chunk] → [Emit partial]
[Stop recording]  → [Transcribe final] → [Emit final]
```

Each chunk is a separate WAV file transcribed independently. Partials are concatenated.

### 4. Model storage

```
~/.8gent/models/whisper/
  ggml-tiny.bin      (39MB)
  ggml-base.bin      (74MB)
  ggml-small.bin     (244MB)
```

Downloaded from Hugging Face `ggerganov/whisper.cpp` releases. SHA256 verified.

### 5. Hold-to-speak via Ink useInput

Ink's `useInput` fires on keydown. We detect `ctrl+space` to toggle recording state. Since terminal raw mode doesn't reliably detect keyup, we use a toggle approach: first press starts, second press stops.

### 6. VoiceEngine as EventEmitter

```typescript
class VoiceEngine extends EventEmitter {
  // Events:
  //   'recording-start'    → recording began
  //   'recording-stop'     → recording ended
  //   'audio-level'        → RMS energy level (0-1)
  //   'partial-transcript' → intermediate text
  //   'final-transcript'   → final transcribed text
  //   'error'              → something went wrong
  //   'model-download-progress' → download percentage
}
```

## Error Handling

| Scenario | Behavior |
|----------|----------|
| sox not installed | `VoiceEngine.isAvailable()` returns false, shows install hint |
| No microphone permission | Recorder emits error, user sees "Mic access denied" |
| Whisper binary missing | Falls back to cloud if API key set, else shows setup instructions |
| Model not downloaded | Prompts download before first use |
| Empty recording | Skips transcription, shows "No speech detected" |
| Transcription timeout | Kills process after 10s, shows timeout error |
| Cloud API failure | Shows error, suggests switching to local mode |

## Security & Privacy

- Audio files are temporary, deleted immediately after transcription
- Local mode: audio never leaves the machine
- Cloud mode: audio sent to OpenAI API (user must opt-in)
- No audio logging or persistence
- Mic access only while actively recording (no background listening in P0)

## Performance Targets

| Metric | Target | Model |
|--------|--------|-------|
| Transcription latency (5s audio) | <500ms | tiny |
| Transcription latency (5s audio) | <1.5s | base |
| Transcription latency (5s audio) | <4s | small |
| Memory usage | <200MB | tiny |
| Memory usage | <400MB | small |
| Recording start latency | <50ms | all |
| Word error rate | <15% | base |
