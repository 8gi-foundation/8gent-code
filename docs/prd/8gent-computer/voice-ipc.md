# Voice IPC Protocol: 8gent Computer Swift App <-> packages/voice

Status: draft spec, no code yet.
Parent PRD: [#1746](https://github.com/8gi-foundation/8gent-code/issues/1746).
Related: PR [#1747](https://github.com/8gi-foundation/8gent-code/pull/1747), issues [#1749](https://github.com/8gi-foundation/8gent-code/issues/1749), [#1750](https://github.com/8gi-foundation/8gent-code/issues/1750), [#1757](https://github.com/8gi-foundation/8gent-code/issues/1757).

This document defines how the 8gent Computer Swift app (today: Lil Eight,
`apps/lil-eight/`) calls into the TypeScript voice pipeline in
`packages/voice/` for capture, transcription, and synthesis. It does not
change voice internals. It does not touch Swift code. It defines the wire
contract only.

## 1. Transport decision

**Reuse the existing daemon WebSocket** at `ws://localhost:18789`, add a new
session `channel` value of `"voice"`.

Rationale:

- The daemon WebSocket already exists and Lil Eight already speaks it. See
  `apps/lil-eight/LilEight/main.swift:2185` (`class DaemonClient`, default
  `port: 18789`, `URLSessionWebSocketTask`).
- The session model already carries a `channel` field (`os`, `app`,
  `telegram`, `discord`, `api`). Extending the enum is cheap.
- A second loopback WS doubles auth surface, doubles reconnect logic, doubles
  the ports users must trust. Rejected.
- An out-of-process spawn per utterance blows the latency budget in
  section 3. Rejected.

Alternatives considered:

- **Second dedicated WS on a separate port.** Cleaner isolation but adds a
  second auth handshake and a second port to bind. Not worth the cost at this
  scale.
- **Unix domain socket.** Does not match the existing transport and the PRD
  correction comment on #1746 already ruled out introducing a second IPC
  surface.
- **gRPC.** Overkill for single-host, same-user IPC. No.

## 2. Message shapes

All messages are JSON envelopes over the daemon WebSocket. Audio payloads are
base64-encoded PCM16 mono at a fixed sample rate (section 3). Every message
carries a `sessionId` scoping it to a voice session inside the `voice`
channel.

```ts
// Client (Swift app) -> server (packages/voice via daemon).

type VoiceClientMessage =
  | { kind: "voice.start";     sessionId: string; sampleRate: 16000; mode: "stt" | "full-duplex" }
  | { kind: "voice.chunk";     sessionId: string; seq: number; audio: string /* base64 PCM16 */ }
  | { kind: "voice.stop";      sessionId: string }
  | { kind: "voice.tts.request"; sessionId: string; text: string; voice?: string /* KittenTTS voice id */ }
  | { kind: "voice.cancel";    sessionId: string };

// Server -> client.

type VoiceServerMessage =
  | { kind: "voice.ready";      sessionId: string }
  | { kind: "voice.transcript"; sessionId: string; text: string; final: boolean; seq: number }
  | { kind: "voice.tts.audio";  sessionId: string; seq: number; audio: string /* base64 PCM16 */; final: boolean }
  | { kind: "voice.error";      sessionId: string; code: VoiceErrorCode; message: string }
  | { kind: "voice.end";        sessionId: string };

type VoiceErrorCode =
  | "permission_denied"
  | "device_unavailable"
  | "model_not_loaded"
  | "auth_failed"
  | "backpressure"
  | "internal";
```

Notes:

- `seq` is monotonic per session per direction. Lets the client detect drops
  without acks.
- `final: true` on `voice.transcript` means end of utterance. Partial
  transcripts are `final: false`.
- `voice.tts.audio` streams chunks. `final: true` closes the synthesis.
- `voice.cancel` tears down any in-flight STT or TTS for that session.

## 3. Backpressure and latency budget

- Sample rate: 16 kHz PCM16 mono. One byte per 31.25 microseconds of audio.
- Chunk size: 320 ms of audio = 10240 bytes raw, ~13.7 KB base64. Balances
  WebSocket frame overhead against latency.
- Max in-flight `voice.chunk` messages per session without a `voice.ready`
  ack: 3. If the client exceeds this, server emits `voice.error`
  (`backpressure`) and the client must pause the mic.
- Target latency (first partial transcript after first chunk):
  - p50: 350 ms.
  - p99: 900 ms.
- Target latency (first TTS chunk after `voice.tts.request`):
  - p50: 250 ms.
  - p99: 700 ms.

These numbers assume the model is loaded. Cold-start model load is excluded
and reported via `voice.error` (`model_not_loaded`) if it exceeds 2 s.

## 4. Error model

- `permission_denied`: the OS denied mic or speaker access. Swift app should
  surface the TCC prompt.
- `device_unavailable`: no input/output device bound. Retry on device change.
- `model_not_loaded`: local STT or TTS engine is not ready. Client should
  back off and retry with exponential delay.
- `auth_failed`: WebSocket handshake rejected. Do not retry without fresh
  Keychain token.
- `backpressure`: client sent chunks faster than server can consume. Client
  pauses for at least one `voice.ready` round trip.
- `internal`: anything else. Human-readable `message` required.

Every error terminates the session unless explicitly marked otherwise. The
client must open a new `voice.start` to continue.

## 5. Auth

- The daemon WebSocket already requires a token in the connect handshake
  (see `docs/specs/DAEMON-PROTOCOL.md`).
- The voice channel reuses that token. No second handshake.
- Token is stored in the macOS Keychain under bundle id `com.8gent.computer`,
  fetched by the Swift app at launch, and passed in the WS upgrade request.
  Karen (#1748) owns the Keychain spec.

## 6. Out of scope for v1

- Barge-in (interrupting TTS mid-speech). Deferred.
- Multi-speaker diarization. Deferred.
- On-device wake word ("Hey 8gent"). Deferred.
- ElevenLabs or any paid TTS vendor. Per global rule, voiceover defaults to
  **KittenTTS** only. ElevenLabs has zero approved use cases.
- Remote STT/TTS providers. v1 is local-first by Principle 2.

## 7. Non-goals of this document

- No changes to `packages/voice/` internals (`tts-engine.ts`,
  `transcriber.ts`, `vad.ts`, `full-duplex-provider.ts` stay as they are).
- No Swift implementation. That is #1750's call.
- No UX copy. That is #1749's call.
- No security review. That is #1748's call. This doc defers on Keychain
  mechanics.

## 8. Open questions

1. Does `packages/voice` need a new entry point that speaks this protocol, or
   do we add a thin router in `packages/daemon/` that translates voice
   messages into calls to `packages/voice`? Default answer: router in
   `packages/daemon/`, keep `packages/voice` transport-agnostic.
2. Should `voice.tts.audio` be raw PCM16 or OGG/Opus? PCM16 for v1 (simplest
   for Swift to play via `AVAudioPlayerNode`), revisit if bandwidth matters.
3. Should partial transcripts be rate-limited? Default: yes, max one partial
   per 200 ms.

Answers wanted before the first implementation PR lands.
