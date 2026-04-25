# 8gent Computer

Voice-first ambient computer-use agent for macOS. Press Cmd+Opt+Space, speak intent, agent perceives, plans, acts, replies.

This package is the Swift surface only. It connects to the 8gent-code daemon `/computer` route (`ws://127.0.0.1:18789/computer`).

## Status

Phase 2.1 to 2.7 (v0):

- NSApplication shell, accessory activation policy
- Cmd+Opt+Space global hotkey, no Accessibility prompt at launch
- Glass NSPanel, ultra-thin material, anchored 80px from bottom
- Static AudioWaveView placeholder
- On-device streaming speech recognition (`SFSpeechRecognizer`, `requiresOnDeviceRecognition = true`)
- WebSocket client for the daemon `/computer` channel with reconnect + backoff
- AVSpeechSynthesizer reply streaming, sentence-buffered, interruptible
- Approval prompts surface as a sheet above the panel (NemoClaw stays on the daemon, no second policy gate in Swift)
- Headless CLI for CI: `--headless --intent "..."` emits NDJSON to stdout, exits when `done` arrives

## Build

```bash
cd apps/8gent-computer
swift build
swift run 8gent-computer
```

For a packaged `.app`:

```bash
./build.sh
open "build/8gent Computer.app"
```

## Headless smoke test

Against a running daemon (`/computer` route on port 18789):

```bash
swift run 8gent-computer --headless --intent "hello, are you there"
```

Or against a mock daemon (same protocol, used by CI):

```bash
MOCK_PORT=18791 bun scripts/mock-daemon.ts &
EIGHT_DAEMON_URL=ws://127.0.0.1:18791/computer \
  swift run 8gent-computer --headless --intent "ping"
```

Exit codes: `0` done received, `1` invalid args, `2` connection failure or timeout, `3` approval required.

## Layout

| Path | Role |
|------|------|
| `Package.swift` | SPM manifest, macOS 14+ |
| `Info.plist` | App bundle metadata (LSUIElement = true, NSMicrophoneUsageDescription, NSSpeechRecognitionUsageDescription) |
| `Sources/EightGentComputerApp/main.swift` | Entrypoint, headless branch, AppDelegate |
| `Sources/EightGentComputerApp/HotkeyMonitor.swift` | Cmd+Opt+Space global + local NSEvent monitors |
| `Sources/EightGentComputerApp/MainPanel.swift` | NSPanel + visual effect view + SwiftUI host + caption + approval sheet |
| `Sources/EightGentComputerApp/AudioWaveView.swift` | Static placeholder waveform |
| `Sources/EightGentComputerApp/SpeechCapture.swift` | On-device SFSpeechRecognizer streaming with mic permission |
| `Sources/EightGentComputerApp/DaemonClient.swift` | URLSessionWebSocketTask client with reconnect + backoff |
| `Sources/EightGentComputerApp/SpeechReply.swift` | AVSpeechSynthesizer sentence-buffered TTS |
| `Sources/EightGentComputerApp/HeadlessMode.swift` | Headless runner for CI smoke |
| `Sources/EightGentComputerApp/Models/Event.swift` | Daemon protocol v1 wire types |
| `scripts/mock-daemon.ts` | CI mock for the `/computer` route |
| `build.sh` | Wraps `swift build` + .app bundling + ad-hoc sign |

## Notes

- SPM target is named `EightGentComputerApp` because Swift identifiers cannot start with a digit. The user-facing executable is `8gent-computer`.
- Hotkey uses read-only `addGlobalMonitorForEvents` (no Accessibility prompt at launch). Mic + speech permission requested on first panel open.
- Captions are NEVER logged or persisted in v0. Live-only on the panel.
- No third-party Swift packages. System frameworks only (AppKit, SwiftUI, AVFoundation, Speech, Foundation).
- TTS uses AVSpeechSynthesizer with the macOS default voice. Override via `EIGHT_TTS_VOICE` (BCP-47 language code or AVSpeechSynthesisVoice identifier). KittenTTS upgrade is a Phase 7+ follow-up; do not wire here.
