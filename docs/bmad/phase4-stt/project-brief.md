# Phase 4: Speech-to-Text — Project Brief

## Vision

8gent Code becomes the first truly voice-controlled autonomous coding agent. By adding local Speech-to-Text via Whisper, developers get a full voice loop: speak commands, hear results. No cloud dependency, no API costs, no latency — just your voice and your machine.

## Problem Statement

Today, developers interact with 8gent through keyboard input only. This creates friction when:

- **Thinking out loud**: You're pacing, whiteboarding, or sketching architecture — but can't communicate with your agent without returning to the keyboard.
- **Repetitive strain**: Extended coding sessions strain hands and wrists. Voice input provides an alternative input modality.
- **Accessibility**: Developers with motor impairments or temporary injuries need voice as a primary input method.
- **Context switching**: Breaking flow to type interrupts the thought process. Speaking is closer to natural ideation.

## Solution

A `packages/voice` package providing local Speech-to-Text powered by whisper.cpp (via whisper-node), integrated into the TUI with hold-to-speak keybindings and visual feedback.

## Key Differentiators

| Feature | 8gent Voice | GitHub Copilot Voice | Cursor |
|---------|-------------|---------------------|--------|
| Local/offline | Yes (Whisper.cpp) | No (cloud only) | No voice |
| API costs | $0 | Per-request | N/A |
| Latency | ~200ms (Apple Silicon) | 500ms-2s | N/A |
| Privacy | Audio never leaves machine | Sent to cloud | N/A |
| Works offline | Yes | No | N/A |

## Success Metrics

- **P0**: Hold-to-speak transcribes speech into the command input within 500ms of release
- **P1**: Voice Activity Detection auto-starts/stops recording without manual trigger
- **P2**: Voice commands ("/voice commit") parsed and executed correctly
- **Adoption**: 20% of active sessions use voice input within 30 days of launch

## Target Users

1. **Power developers** who want hands-free coding while thinking
2. **Accessibility-first users** who need voice as primary input
3. **Mobile/tablet developers** using 8gent remotely where typing is awkward

## Dependencies

- `sox` (System On X) for microphone recording — installable via `brew install sox`
- `whisper-node` or equivalent Bun-compatible whisper.cpp bindings
- macOS/Linux microphone access (terminal needs mic permission)

## Non-Goals (Phase 4)

- Real-time voice conversation (that's Phase 5+)
- Voice-to-code generation (agent handles code, voice is just input)
- Multi-language transcription (English first, i18n later)
- Speaker identification / multi-user
