# Phase 4: Speech-to-Text — Product Requirements Document

## Overview

Add local Speech-to-Text to 8gent Code, completing the voice loop (TTS output already exists). Users press a key to speak, Whisper transcribes locally, and text appears in the command input.

---

## Priority Tiers

### P0 — Core Voice Input (MVP)

**Hold-to-speak keybinding**

- Default: `Ctrl+Space` starts recording, release stops recording
- Configurable via `.8gent/config.json`
- Visual indicator shows recording state (pulsing mic icon)
- Audio captured via `sox`/`rec` subprocess to temporary WAV file
- Whisper transcribes WAV, result injected into command input
- User can edit transcribed text before submitting

**Whisper model management**

- First use: prompt to download Whisper model (tiny = 39MB default)
- Model stored in `~/.8gent/models/whisper/`
- Model selection: tiny (fast), base (balanced), small (accurate)
- Download shows progress bar

**Graceful degradation**

- If `sox` not installed: show install instructions, voice disabled
- If no microphone: show error, voice disabled
- If model not downloaded: prompt to download
- 8gent works perfectly fine without voice — it's opt-in

### P1 — Enhanced Experience

**Voice Activity Detection (VAD)**

- Auto-detect speech start/stop — no need to hold key
- Toggle between hold-to-speak and VAD modes
- Silence threshold configurable (default: 1.5s of silence = stop)

**Real-time partial transcription**

- Stream audio in 2-second chunks
- Show partial transcription as it comes in (dimmed, updating)
- Final transcription replaces partials when recording stops

**Noise handling**

- Skip transcription if audio is below energy threshold (no speech detected)
- Show "No speech detected" feedback instead of empty transcription

### P2 — Voice Commands & Continuous Mode

**Voice commands**

- Prefix detection: "voice commit", "voice plan", "voice status"
- Maps to slash commands: `/commit`, `/plan`, `/status`
- "Hey 8gent" wake word for hands-free activation

**Continuous listening mode**

- Toggle via `/voice continuous`
- Agent listens continuously, VAD segments speech
- Each speech segment transcribed and queued

---

## User Stories

### US-1: First-time voice setup
**As a** developer using 8gent for the first time with voice,
**I want** the system to guide me through setup (install sox, download model),
**So that** I can start using voice input without manual configuration.

**Acceptance Criteria:**
- [ ] If sox missing, show: "Voice input requires sox. Install with: brew install sox"
- [ ] If no Whisper model, prompt: "Download Whisper tiny model (39MB)? [Y/n]"
- [ ] Download shows progress bar with percentage and ETA
- [ ] After setup, voice works immediately without restart

### US-2: Hold-to-speak transcription
**As a** developer in a coding session,
**I want** to hold Ctrl+Space, speak my request, and release to transcribe,
**So that** I can give instructions without typing.

**Acceptance Criteria:**
- [ ] Pressing Ctrl+Space shows recording indicator (pulsing red mic)
- [ ] Audio level meter shows input is being captured
- [ ] Releasing Ctrl+Space stops recording and starts transcription
- [ ] Transcribed text appears in command input within 500ms
- [ ] User can edit text before pressing Enter to submit
- [ ] If transcription is empty, show "No speech detected"

### US-3: Voice toggle
**As a** developer who doesn't want voice,
**I want** voice to be completely disabled by default,
**So that** it doesn't interfere with my workflow.

**Acceptance Criteria:**
- [ ] Voice is OFF by default
- [ ] `/voice on` enables voice input
- [ ] `/voice off` disables voice input
- [ ] Voice state persists in `.8gent/config.json`
- [ ] No mic access or sox processes when voice is off

### US-4: Model selection
**As a** developer who wants better accuracy,
**I want** to choose between Whisper model sizes,
**So that** I can trade speed for accuracy based on my hardware.

**Acceptance Criteria:**
- [ ] `/voice model tiny` — fastest, least accurate (39MB)
- [ ] `/voice model base` — balanced (74MB)
- [ ] `/voice model small` — most accurate, slower (244MB)
- [ ] Model switch downloads if not cached, shows progress
- [ ] Current model shown in status bar when voice is active

### US-5: Cloud fallback
**As a** developer without sox or on a system where local Whisper doesn't work,
**I want** to use OpenAI Whisper API as a fallback,
**So that** I can still use voice input.

**Acceptance Criteria:**
- [ ] If `OPENAI_API_KEY` is set, cloud transcription available
- [ ] `/voice cloud` switches to cloud mode
- [ ] `/voice local` switches back to local mode
- [ ] Cloud mode shows latency warning on first use

---

## Configuration

```jsonc
// .8gent/config.json
{
  "voice": {
    "enabled": false,            // opt-in
    "mode": "local",             // "local" | "cloud"
    "model": "tiny",             // "tiny" | "base" | "small"
    "keybinding": "ctrl+space",  // hold-to-speak trigger
    "vadEnabled": false,         // P1: voice activity detection
    "vadSilenceMs": 1500,        // P1: silence threshold
    "language": "en",            // transcription language
    "modelsPath": "~/.8gent/models/whisper"
  }
}
```

---

## Technical Constraints

- Must work with Bun runtime (no Node-only native addons)
- sox subprocess for recording (no native mic bindings needed)
- Whisper model files in GGML format (compatible with whisper.cpp)
- Audio format: 16kHz mono WAV (Whisper's expected input)
- Max recording duration: 30 seconds (prevents runaway recordings)
- Temp files cleaned up after transcription
