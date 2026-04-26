# 8gent Computer v0 voice round-trip smoke

**Status:** placeholder pending manual screen recording at PR review.
**Recording target:** `docs/audits/2026-04-25-8gent-computer-v0-smoke.mp4`
**PR:** Phase 2.4-2.7 stack (#1860, #1861, #1862, #1863).

## What the recording must show

1. App launched (`open "build/8gent Computer.app"` after `./build.sh`). Status item not in Dock (LSUIElement).
2. Press Cmd+Opt+Space. Glass NSPanel appears anchored at the bottom, "Listening..." caption visible.
3. First-launch only: macOS prompts for Microphone access, then Speech Recognition. Both granted.
4. Speak: "hello, are you there". Partial captions stream live in the panel.
5. Final transcript renders. Caption updates to streamed reply tokens. Status pulses (acting) / (thinking) when the daemon reports tool events.
6. AVSpeechSynthesizer reads the reply aloud via the macOS default voice once a sentence boundary lands.
7. Press Cmd+Opt+Space again. TTS interrupts mid-utterance. Panel hides.

## Headless-mode smoke (CI-runnable, already green locally)

Against the mock daemon at `apps/8gent-computer/scripts/mock-daemon.ts`:

```bash
$ MOCK_PORT=18791 bun apps/8gent-computer/scripts/mock-daemon.ts &
$ EIGHT_DAEMON_URL=ws://127.0.0.1:18791/computer \
    EIGHT_DAEMON_TIMEOUT_MS=8000 \
    apps/8gent-computer/.build/release/8gent-computer \
    --headless --intent "hello, are you there"
{"type":"state","value":"connecting"}
{"type":"state","value":"connected"}
{"chunk":"pong: hello, are you there","final":true,"sessionId":"s_mock_...","type":"token"}
{"reason":"turn-complete","sessionId":"s_mock_...","type":"done"}
{"type":"state","value":"disconnected"}
$ echo $?
0
```

## NemoClaw bypass check

Headless mode does NOT auto-approve. If the daemon emits `approval_required`, the
runner prints the event to stdout, writes a one-line note to stderr, and exits
with code 3. Approvals are an interactive concern in v0 and only resolved from
the panel sheet (or a future explicit `--approve` flag, out of scope here).
