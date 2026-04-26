# 8gent Computer realtime loop — Phase 2.4-2.7 lessons

**Date:** 2026-04-26
**Status:** Reference for Phase 3 (cua loop wiring) and Phase 7 (wake phrase)
**Origin:** PR #1884 (`feat(8gent-computer): Phase 2.4-2.7 STT, WS client, TTS, smoke`)
**Related specs:** [DAEMON-PROTOCOL.md](DAEMON-PROTOCOL.md)

---

## Context

Phase 2.4-2.7 shipped the voice round-trip skeleton for the 8gent Computer NSPanel: hotkey → STT → WS → daemon → token stream → sentence-buffered TTS. Everything below is what we learned doing it, written so Phase 3 (cua loop) and Phase 7 (wake phrase) do not relearn the same things.

The cua loop is the screenshot-perceive-decide-act inner loop ([#1864](https://github.com/8gi-foundation/8gent-code/issues/1864), [#1865](https://github.com/8gi-foundation/8gent-code/issues/1865), [#1867](https://github.com/8gi-foundation/8gent-code/issues/1867)) wrapping the `cua-driver` MIT binary via [`packages/hands/`](../../packages/hands/). It runs *inside* the same daemon turn that voice is streaming over. The two cannot be designed in isolation.

---

## Latency budget — 1.2s human-perception target

The intuitive target is "feels like a real conversation." Practical breakdown for a single voice turn (wake → speak → answer audible):

| Stage | Budget | Notes |
|---|---|---|
| Wake detection | 150 ms | livekit-wakeword on-device; cold mic until fired |
| Mic warm-up + first STT partial | 200 ms | `SFSpeechRecognizer` `requiresOnDeviceRecognition=true` |
| User finishes speaking → STT final | 80 ms after silence | endpointer kick-in |
| WS frame to daemon `/computer` | 5 ms | loopback, already connected |
| Daemon plan + first cua perceive | 300 ms | screenshot + a11y tree + first vision call |
| First decide token | 200 ms | local LLM streaming |
| First TTS sentence audible | 250 ms | `AVSpeechSynthesizer` cold-start to first sample |
| **Total to first audible reply** | **~1.2 s** | |

Anything above 1.5s feels broken. Anything below 800ms feels uncanny. The cua loop's `perceive` step is the fattest swing point — see Phase 3 implications below.

---

## STT findings (SpeechCapture.swift)

- **Use `requiresOnDeviceRecognition = true`.** Off-device STT is faster on first partial but ships audio to Apple. Violates 8gent's local-by-default principle and breaks the "captions never persisted" guarantee in v0.
- **Partials arrive every ~80-120ms** during sustained speech. Render them; do not wait for `isFinal`.
- **Endpointer is conservative.** Roughly 800ms of silence before `isFinal` fires. For voice-cua we will likely want a custom VAD that finalises on the user pausing for breath, not on full silence. Punted to Phase 4+.
- **Mic permission prompt is a UX cliff.** Both `NSMicrophoneUsageDescription` and `NSSpeechRecognitionUsageDescription` must be in `Info.plist` *and* the prompt only fires on first panel-open, not on app launch. This is correct but means the very first hotkey press will *feel* slow. Document this in onboarding.
- **Captions live-only.** Strings flow Swift → SwiftUI → garbage collector. Never logged, never persisted in v0. Phase 4 trace viewer ([#1869](https://github.com/8gi-foundation/8gent-code/issues/1869)) needs an explicit opt-in before this changes.

---

## WS transport findings (DaemonClient.swift)

- **`URLSessionWebSocketTask` works fine without a third-party dep.** Resist adding Starscream / SwiftNIO. One less thing to license-audit.
- **Exponential reconnect with cap.** 0.5s → 1s → 2s → ... → 30s cap. The 30s ceiling matters: on dev loops the daemon is down for tens of seconds during restart, and we do not want minute-long reconnects.
- **30s app-level ping.** Native WS ping/pong is not exposed reliably across macOS versions. Roll our own.
- **Configurable callback queue.** Headless mode runs without a main runloop. The default `URLSession.shared.delegateQueue` deadlocks the headless smoke. Pass an `OperationQueue` explicitly.
- **Frame ordering is not guaranteed *across* reconnects.** During Phase 3, `tool_call` and `tool_result` events for the cua loop may arrive after a `done` if a reconnect happens mid-turn. The session protocol needs a sequence number; this is a v1.1 → v1.2 concern. Open question in [#1864](https://github.com/8gi-foundation/8gent-code/issues/1864).
- **`protocol_version` rejection works.** Mismatched-version frames are dropped silently with a logged warning. Forward-compat path is clean.

---

## TTS findings (SpeechReply.swift)

- **`AVSpeechSynthesizer` over `NSSpeechSynthesizer`.** The latter is deprecated on macOS 14+ and prints loud warnings. Use AV.
- **Sentence-buffer on `.`, `?`, `!`, newline.** Speaking per-token is unintelligible (every word interrupts the previous). Buffer until a sentence boundary, then `speak()`. The trailing buffer flushes on `done`.
- **`stop()` interrupts mid-utterance.** Hotkey-press during reply must cancel the current synthesis cleanly. AVSpeechSynthesizer's `stopSpeaking(at: .immediate)` works; `.word` boundary is too laggy.
- **`EIGHT_TTS_VOICE` env override.** Lets us A/B voices without rebuild. Default is `com.apple.voice.compact.en-US.Samantha` (loaded reliably across macOS versions). Phase 4 will likely swap to KittenTTS for offline, brand-aligned voice.
- **Cold-start of first sentence is ~250ms.** Pre-warming the synthesiser with an empty `speak("")` at panel open shaves it to ~80ms. Do this when the user opens the panel, not when the first sentence arrives.

---

## Approval flow timing (NemoClaw `approval_required`)

- **Approval interrupts the stream, not just the UI.** When the daemon emits `approval_required`, the WS connection holds; the daemon awaits a `{ "type": "approval_response", ... }` frame from the client.
- **TTS must pause too.** Currently `SpeechReply` keeps speaking the last buffered sentence even after the approval sheet appears. Phase 3 fix: pause synthesis on `approval_required`, resume on approve, cancel on deny.
- **Headless mode exits 3 on approval.** Non-interactive contexts cannot approve. CI smoke must use a daemon configured with auto-approve for the smoke-test policy bundle, never via Swift-side bypass.

---

## Phase 3 implications (cua loop)

The cua loop is `screenshot → perceive → decide → act → screenshot → ...`. Voice changes how this loop is shaped:

1. **Perceive must be cheap-first.** Always try `packages/eight/accessibility-tree-first` ([#1865](https://github.com/8gi-foundation/8gent-code/issues/1865)) before committing to a vision call. A11y tree query is single-digit ms; vision call is 200-1000ms. The latency budget cannot afford vision on every step.
2. **Tool-call events stream alongside tokens.** When the loop fires a click, that should emit `{ type: "tool_call", name: "click", ... }` *immediately*, not at end-of-turn. The voice client already renders tool-call markers in the panel. Phase 3 wiring must respect this ordering.
3. **Decide cannot block speech.** If the model is mid-decision and the user starts speaking again (interrupt), the daemon should cancel the in-flight decide turn and start a new one. The Phase 2 panel already triggers `agent.abort()` on hotkey-press; cua must subscribe to the same abort signal.
4. **Each act should emit a `tool_result` token-equivalent.** So the TTS layer can synthesise narration ("clicked Save") if the user wants spoken progress. Default is silent; opt-in via Settings.
5. **Vision prompt template ([#1866](https://github.com/8gi-foundation/8gent-code/issues/1866)) should be voice-aware.** When voice is active, prefer terse vision outputs (one-line action) over verbose chain-of-thought. The CoT belongs in the trace viewer ([#1869](https://github.com/8gi-foundation/8gent-code/issues/1869)), not the audible reply.

---

## livekit-wakeword integration pattern (Phase 7)

Replaces the Picovoice spec in [#1875](https://github.com/8gi-foundation/8gent-code/issues/1875). LiveKit's wake-word is Apache 2.0 and runs on-device, which matches Principle 2.

**Where it slots:**

```
[ Mic always cold ]
        |
        v
[ livekit-wakeword (always on, <2% CPU) ]
        |
        v  (fires on "Hey 8gent")
[ Open NSPanel + warm SFSpeechRecognizer + warm AVSpeechSynthesizer ]
        |
        v
[ Existing Phase 2.4-2.7 round-trip ]
```

**Constraints:**

- **Cold mic until wake.** The wake engine has its own audio tap. `SFSpeechRecognizer` does not start until wake fires. Two consequences: (a) user gets a privacy guarantee that nothing is transcribed pre-wake; (b) STT first-partial latency includes mic warm-up, ~200ms.
- **Default off.** Hotkey remains the default activation. Wake phrase is opt-in via Settings ([#1876](https://github.com/8gi-foundation/8gent-code/issues/1876)).
- **Phrase: "Hey 8gent"** (4 syllables, brand-reinforcing, well-distinguished). "Hey 8" is too short for reliable wake detection.
- **No cloud fallback.** If the on-device wake model is unavailable (rare; library bundles it), wake is disabled with a Settings warning. We never ship wake audio off-device.
- **CPU budget: <2% sustained on M3+.** If livekit-wakeword overshoots this in our integration, we either downsample the audio tap or fall back to hotkey-only and file a follow-up issue.

**Headless smoke for wake:**

The mock daemon ([`apps/8gent-computer/scripts/mock-daemon.ts`](../../apps/8gent-computer/scripts/mock-daemon.ts)) handles the WS side. Phase 7 needs an analogous wake harness: feed a known-positive WAV through the wake engine in CI, assert it fires; feed a known-negative WAV, assert it does not. No mic involvement in CI.

---

## Open questions

- **WS sequence numbers.** Cross-reconnect frame ordering is undefined. Tracked as comment thread on [#1864](https://github.com/8gi-foundation/8gent-code/issues/1864) — needs a v1.2 protocol bump.
- **Custom VAD vs Apple endpointer.** Apple's 800ms silence threshold is too long for natural conversation. Phase 4+.
- **TTS swap to KittenTTS.** Offline, brand-aligned voice. Currently AV. Phase 5+ once Kitten ships a stable Swift binding.
- **Multi-tab cua.** A11y tree and screenshot are window-scoped. Daemon-managed multi-window cua sessions are out of scope until v1.

---

## What did NOT make Phase 2.4-2.7 (so Phase 3 doesn't assume it)

- No real cua loop. The mock daemon answers any prompt with `pong: <prompt>`.
- No vision pipeline. Qwen 3.6-27B template is [#1866](https://github.com/8gi-foundation/8gent-code/issues/1866).
- No accessibility-tree query. Phase 1 stub still in place; replaced in [#1882](https://github.com/8gi-foundation/8gent-code/issues/1882).
- No smoke-test corpus for cua actions. [#1867](https://github.com/8gi-foundation/8gent-code/issues/1867).
- No wake phrase. Picovoice spec in [#1875](https://github.com/8gi-foundation/8gent-code/issues/1875) is being patched to livekit-wakeword by governance in parallel.
- No memory or trace viewer. Phase 4-5.
