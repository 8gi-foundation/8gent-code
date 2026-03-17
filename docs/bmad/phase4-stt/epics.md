# Phase 4: Speech-to-Text — Epics & Stories

---

## Epic 1: Voice Package Foundation

**Goal:** Create `packages/voice` with core recording and transcription capabilities.

### Story 1.1: Package scaffolding
**Points:** 1
- Create `packages/voice/package.json` with dependencies
- Create `types.ts` with all type definitions
- Wire into monorepo workspaces

### Story 1.2: Mic recorder via sox
**Points:** 3
- Spawn `rec` subprocess to record 16kHz mono WAV
- Check sox availability with graceful error
- Emit audio level events (RMS energy from sox output)
- Support start/stop lifecycle
- Clean up temp files on stop
- Max recording duration safety (30s timeout)

### Story 1.3: Whisper model manager
**Points:** 3
- Define model catalog (tiny, base, small) with URLs and sizes
- Download models to `~/.8gent/models/whisper/`
- Show download progress (bytes received / total)
- List available and downloaded models
- Get model file path for transcription
- SHA256 verification of downloaded files

### Story 1.4: Local transcription via whisper.cpp
**Points:** 3
- Download/detect whisper.cpp binary
- Spawn whisper.cpp subprocess with model + WAV input
- Parse stdout for transcribed text
- Handle errors (timeout, crash, empty output)
- Return TranscriptEvent with text and confidence

### Story 1.5: Public API (VoiceEngine)
**Points:** 2
- EventEmitter-based VoiceEngine class
- `start()` / `stop()` / `isRecording()` / `isAvailable()`
- Wire recorder -> transcriber pipeline
- Configuration via VoiceConfig
- `onTranscript` callback registration

**Epic 1 Total: 12 points**

---

## Epic 2: TUI Integration

**Goal:** Wire voice into the TUI with keyboard controls and visual feedback.

### Story 2.1: useVoiceInput hook
**Points:** 3
- React hook wrapping VoiceEngine
- Keyboard trigger (Ctrl+Space toggle)
- State management: idle | recording | transcribing
- Returns: { isRecording, isTranscribing, transcript, audioLevel, start, stop, toggle }
- Auto-cleanup on unmount

### Story 2.2: VoiceIndicator component
**Points:** 2
- Recording state indicator (idle/recording/transcribing)
- Pulsing red mic icon when recording
- Audio level visualization (simple bar)
- Current Whisper model name
- Follows TUI color rules (no gray/white/black)

### Story 2.3: Transcript injection into CommandInput
**Points:** 2
- When final transcript received, append to current input value
- Show partial transcript as dimmed preview text
- User can edit before submitting
- Clear voice state after submission

### Story 2.4: Voice toggle in status bar
**Points:** 1
- Show mic icon in status bar when voice is enabled
- Icon changes color: cyan (ready), red (recording), yellow (transcribing)
- `/voice on|off` toggles visibility

### Story 2.5: First-run model download UX
**Points:** 2
- On first Ctrl+Space with no model, show download prompt
- Progress bar during download
- Success confirmation, then auto-start recording
- If sox missing, show install instructions instead

**Epic 2 Total: 10 points**

---

## Epic 3: Advanced Features (P1/P2)

**Goal:** Enhanced voice experience with VAD, streaming, and cloud fallback.

### Story 3.1: Voice Activity Detection
**Points:** 3
- Energy-based VAD using audio level from recorder
- Configurable silence threshold (default 1.5s)
- Auto-start on speech detected (above energy threshold)
- Auto-stop after silence duration exceeded
- Toggle between hold-to-speak and VAD modes

### Story 3.2: Streaming partial transcription
**Points:** 5
- Record in 2-second chunks (separate WAV files)
- Transcribe each chunk immediately
- Emit partial transcript events
- Concatenate partials for display
- Final pass on full audio for accuracy

### Story 3.3: OpenAI Whisper API fallback
**Points:** 2
- POST audio to OpenAI `/v1/audio/transcriptions`
- Use `OPENAI_API_KEY` from environment
- Return same TranscriptEvent format as local
- `/voice cloud` and `/voice local` to switch modes
- Show latency comparison on first cloud use

### Story 3.4: Voice commands parsing
**Points:** 3
- Detect command prefixes: "voice commit", "voice plan", etc.
- Map to slash commands
- "Hey 8gent" wake word detection (simple string match on transcript)
- Continuous listening mode toggle

**Epic 3 Total: 13 points**

---

## Summary

| Epic | Stories | Points | Priority |
|------|---------|--------|----------|
| 1: Voice Package Foundation | 5 | 12 | P0 |
| 2: TUI Integration | 5 | 10 | P0 |
| 3: Advanced Features | 4 | 13 | P1/P2 |
| **Total** | **14** | **35** | |

**Estimated timeline:** Epic 1+2 = 1 sprint (1 week), Epic 3 = 1 sprint (1 week)
