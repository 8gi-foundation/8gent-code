# 8gent Computer

Voice-first ambient computer-use agent for macOS. Press Cmd+Opt+Space, speak intent, agent perceives, plans, acts, replies.

This package is the Swift surface only. It depends on the 8gent-code daemon route added in Phase 1 (not wired in this scaffold).

## Status

Phase 2.1 to 2.3 scaffold:

- NSApplication shell, accessory activation policy
- Cmd+Opt+Space global hotkey, no Accessibility prompt at launch
- Glass NSPanel, ultra-thin material, anchored 80px from bottom
- Static AudioWaveView placeholder (animation lands in Phase 2.4)
- Headless CLI: `--headless --intent "..."` emits `{"status":"noop","headless_phase":"scaffold","intent":"..."}`

Phase 2.4 to 2.7 (speech recognition, websocket client, TTS, end-to-end smoke) land in a follow-up PR once the daemon route is in.

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

## Layout

| Path | Role |
|------|------|
| `Package.swift` | SPM manifest, macOS 14+ |
| `Info.plist` | App bundle metadata (LSUIElement = true) |
| `Sources/EightGentComputerApp/main.swift` | Entrypoint, headless branch, AppDelegate |
| `Sources/EightGentComputerApp/HotkeyMonitor.swift` | Cmd+Opt+Space global + local NSEvent monitors |
| `Sources/EightGentComputerApp/MainPanel.swift` | NSPanel + visual effect view + SwiftUI host |
| `Sources/EightGentComputerApp/AudioWaveView.swift` | Static placeholder waveform |
| `build.sh` | Wraps `swift build` + .app bundling + ad-hoc sign |

## Notes

- SPM target is named `EightGentComputerApp` because Swift identifiers cannot start with a digit. The user-facing executable is `8gent-computer`.
- We do not request Accessibility at launch. Hotkey works via read-only `addGlobalMonitorForEvents`. Phase 2.5 will ask once it needs full event taps.
- No third-party Swift packages. System frameworks only (AppKit, SwiftUI).
