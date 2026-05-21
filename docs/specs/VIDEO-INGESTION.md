# Video Ingestion - Marlin Sidecar + extract_video Spec

Status: DRAFT (RFC). Parent issue: 8gi-foundation/8gent-code#2326 (multimodal KG ingestion). Related: #980 (media understanding pipeline).

## 1. Why video ingestion exists

Knowledge Graph v1 (`packages/memory`) is text-only. Every extractor in `packages/memory/extractor.ts` reads a code-centric source: tool results, `package.json`, shell commands, chat messages. When a user hands 8gent a video - a screen recording, a demo, a meeting capture, a clip - there is no path that turns it into graph nodes. The video is opaque.

This spec defines that path. It is the video lane of #2326.

The honest framing of the model choice matters, because it shapes the whole design:

- **Marlin-2B** (`NemoStation/Marlin-2B`, Apache 2.0) is a video vision-language model fine-tuned from Qwen3.5-2B. Its modalities are video frames plus text. It produces a scene paragraph and timestamped events. **It has no audio tower. It does not transcribe speech.**
- Transcription needs a separate ASR model. This spec uses **`mlx-whisper`** (Apple-Silicon-native Whisper), which lives in the same Python venv as Marlin so the sidecar stays a single process.

Marlin sees. Whisper hears. The sidecar runs both warm and the `extract_video` tool fuses their outputs onto one timeline. Neither model alone gives "all the structured schema from a video"; the fusion does.

## 2. Scope

In scope:

- The `packages/eyes/marlin` Python sidecar: process model, lifecycle, JSON-RPC protocol.
- The `extract_video` tool registered in `packages/eight/tools.ts`.
- The `VideoExtraction` output schema.
- Chunk-and-merge for videos longer than Marlin's 2-minute window.
- `packages/memory/video-extractor.ts` and the `EntityType` / `RelationshipType` enum extension.
- Security review of `trust_remote_code`.
- 8gent-computer integration contract.
- Edge cases.

Out of scope (explicit non-goals):

- Image, PDF, and pure-audio ingestion. Those are sibling lanes of #2326, not this spec. The sidecar's `transcribe` method is reusable by the audio lane, but wiring that lane is separate work.
- Real-time / streaming video. This spec is file-in, structure-out, batch.
- Video generation or editing. That is the #1025-#1037 cluster.
- An MLX port of Marlin. The transformers + MPS path ships first; an MLX port is a later optimization tracked separately.

## 3. Architecture

```
                video file (mp4/mov/webm/...)
                          │
   ┌──────────────────────▼───────────────────────┐
   │  extract_video tool   (packages/eight/tools)  │
   │  - resolves + validates path                  │
   │  - spawns / attaches sidecar                   │
   │  - chunk planning for >120s videos            │
   │  - merges sidecar results → VideoExtraction   │
   └──────────────────────┬───────────────────────┘
                          │ stdio JSON-RPC 2.0
   ┌──────────────────────▼───────────────────────┐
   │  packages/eyes/marlin   (Python sidecar)      │
   │  - long-lived process, two models warm        │
   │  - Marlin-2B  → scene + events  (MPS)         │
   │  - mlx-whisper → transcript     (MLX)         │
   │  - torchcodec/av video decode                 │
   └──────────────────────┬───────────────────────┘
                          │ VideoExtraction
   ┌──────────────────────▼───────────────────────┐
   │  packages/memory/video-extractor.ts            │
   │  - fuse events + transcript on shared timeline│
   │  - stage-2 LLM triple extraction              │
   │  - emit ExtractionResult with provenance       │
   └──────────────────────┬───────────────────────┘
                          │
   ┌──────────────────────▼───────────────────────┐
   │  KnowledgeGraph (graph.ts) + entity-dedup      │
   │  + concept-linker + sqlite-vec embeddings      │
   └────────────────────────────────────────────────┘
```

Eyes perceives, memory structures, graph stores. The Python dependency is quarantined to one package (`packages/eyes/marlin`); the rest of the path stays Bun/TS.

## 4. The sidecar: `packages/eyes/marlin`

### 4.1 Process model

The sidecar is a long-lived Python process. Model cold-load (Marlin ~4-5GB BF16, Whisper ~150MB) is expensive, so the process loads both models once on `initialize` and keeps them warm for the session. A one-shot subprocess-per-call would re-pay the multi-second load every time and is explicitly rejected.

Concurrency: the sidecar serves one inference at a time. A single Apple GPU cannot usefully run two video models in parallel, so requests queue inside the sidecar in arrival order. The tool side must not assume parallelism.

### 4.2 Transport

Newline-delimited JSON-RPC 2.0 over the sidecar's stdin/stdout. One JSON object per line. stderr is reserved for human-readable logs and is never parsed. This matches the daemon protocol's framing discipline (`docs/specs/DAEMON-PROTOCOL.md`) without requiring a socket.

Rationale for stdio over a localhost port: no port allocation, no bind conflicts, no firewall prompt on macOS, lifecycle is tied to the parent automatically (parent dies → pipe closes → sidecar exits).

### 4.3 Lifecycle

1. **Spawn.** The tool spawns `python -m marlin_sidecar` inside the provisioned venv (see §11) with `PYTORCH_ENABLE_MPS_FALLBACK=1` set.
2. **Ready handshake.** The sidecar emits one `{"jsonrpc":"2.0","method":"ready","params":{"pid":...}}` notification when the process is up but before models are loaded.
3. **initialize.** The tool sends `initialize`; the sidecar loads both models and replies with device, model ids, and load time. This call may take tens of seconds on first run.
4. **Serve.** The sidecar handles `caption`, `find`, `transcribe`, `extract`, `health`.
5. **Idle shutdown.** After a configurable idle timeout (default 300s) with no requests, the sidecar exits to free ~5GB of RAM. The tool transparently re-spawns on the next call.
6. **shutdown.** Explicit graceful stop.

### 4.4 Device selection

- Default device is `mps`. The reference Marlin example uses `device_map={"":"cuda"}`; the sidecar substitutes `mps` on Apple Silicon.
- `PYTORCH_ENABLE_MPS_FALLBACK=1` is mandatory: parts of the Qwen3.5-VL video tower may lack Metal kernels and must fall back to CPU. This is correctness-preserving but can be slow; §10 covers the performance consequence.
- If MPS is unavailable (Intel Mac, unsupported torch), the sidecar falls back to `cpu` and emits a warning in the `initialize` response. CPU inference is supported but slow enough that the tool surfaces it to the user.

## 5. JSON-RPC API reference

All requests are JSON-RPC 2.0. `id` is a string or integer chosen by the caller. Times are floating-point seconds, media-relative (0.0 = first frame), never wall-clock.

### 5.1 `initialize`

Loads both models. Idempotent: a second call returns the cached state.

Request params:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `visionModel` | string | `NemoStation/Marlin-2B` | HF repo id of the vision model |
| `visionRevision` | string | (pinned commit) | HF commit hash, pinned for `trust_remote_code` safety (§9) |
| `audioModel` | string | `mlx-community/whisper-base-mlx` | mlx-whisper model id |
| `device` | string | `mps` | `mps`, `cpu` |

Result:

```json
{
  "ready": true,
  "device": "mps",
  "mpsFallback": true,
  "models": { "vision": "NemoStation/Marlin-2B@<commit>", "audio": "whisper-base-mlx" },
  "loadMs": 18420,
  "warnings": []
}
```

### 5.2 `caption`

Runs Marlin caption mode on a single window of at most 240 frames (~2 min). Does not chunk; the tool is responsible for chunk planning (§8).

Request params:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `path` | string | required | Absolute path to the video file |
| `startSec` | number | `0` | Window start offset, used for timestamp rebasing |
| `endSec` | number | duration | Window end offset |
| `fps` | number | `2.0` | Frame sample rate |
| `maxFrames` | number | `240` | Hard cap; the model's ceiling |
| `maxTokens` | number | `2048` | Max generation tokens |

Result:

```json
{
  "scene": "A developer walks through a terminal-based coding agent...",
  "events": [
    { "start": 0.0,  "end": 4.2,  "description": "The terminal opens and a prompt is typed." },
    { "start": 4.2,  "end": 11.8, "description": "An agent plan is rendered as a checklist." }
  ],
  "frameCount": 142,
  "truncated": false
}
```

`truncated` is `true` if the window exceeded `maxFrames` and was downsampled.

### 5.3 `find`

Runs Marlin find mode: resolves a natural-language query to a span.

Request params: `path`, `event` (string, the query), optional `startSec` / `endSec`.

Result:

```json
{ "span": { "start": 14.3, "end": 18.2 }, "formatOk": true }
```

If the event is not located, `span` is `null` and `formatOk` is `false`.

### 5.4 `transcribe`

Runs mlx-whisper on the full audio track. Whisper has no 2-minute limit, so the whole file is transcribed in one call regardless of length.

Request params:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `path` | string | required | Absolute path to the video file |
| `language` | string | `auto` | ISO-639-1 code or `auto` for detection |
| `audioTrack` | number | `0` | Index of the audio track to use |

Result:

```json
{
  "language": "en",
  "transcript": [
    { "start": 0.6,  "end": 3.1,  "text": "Let me show you the plan rail." },
    { "start": 3.4,  "end": 7.9,  "text": "Each step is a task with a status." }
  ],
  "hasAudio": true
}
```

If the file has no audio track, `hasAudio` is `false` and `transcript` is `[]`.

### 5.5 `extract`

Convenience method. Runs `caption` (with internal chunk-and-merge if the video exceeds the window) plus `transcribe`, and returns the merged structure. This is the method `extract_video` calls in the common case.

Request params: `path`, optional `fps`, `language`, `query` (if present, also runs `find`), `maxChunkSec` (default `120`).

Result: a `VideoExtraction` object (§7).

### 5.6 `health`

Result: `{ "status": "ok", "uptimeSec": 412, "rssMb": 5180, "device": "mps", "queueDepth": 0 }`.

### 5.7 `shutdown`

Graceful stop. Result `{ "stopped": true }`, then the process exits.

### 5.8 Error codes

Standard JSON-RPC plus an application range. Errors are returned as `{"jsonrpc":"2.0","id":...,"error":{"code":...,"message":...,"data":...}}`.

| Code | Name | Meaning |
|------|------|---------|
| -32700 | Parse error | Malformed JSON line |
| -32600 | Invalid request | Not a valid JSON-RPC object |
| -32601 | Method not found | Unknown method |
| -32602 | Invalid params | Missing or wrong-typed params |
| -32603 | Internal error | Uncaught sidecar exception |
| -33001 | Model not loaded | `caption`/`find`/etc. called before `initialize` |
| -33002 | Video decode failed | torchcodec/av could not decode the file |
| -33003 | Unsupported format | Container or codec not supported |
| -33004 | Video too short | Fewer than 4 sampled frames (Marlin minimum) |
| -33005 | Out of memory | MPS/host allocation failed; `data.suggestion` carries a lower `fps` |
| -33006 | No audio track | `transcribe` called on a file with no audio (only when caller forced audio) |

## 6. The `extract_video` tool

Registered in `packages/eight/tools.ts`. Tagged `[VIDEO]` in the description (consistent with `[FILE]` on the PDF tools). Off by default behind a capability flag (§11) so a fresh install never carries the PyTorch dependency unless the user opts in.

Tool schema:

```jsonc
{
  "name": "extract_video",
  "description": "[VIDEO] Extracts structured information from a video file: a scene summary, timestamped visual events, and a speech transcript. Use to understand screen recordings, demos, meetings, or clips, or to ingest a video into the knowledge graph. Runs fully local on-device.",
  "parameters": {
    "type": "object",
    "properties": {
      "path":  { "type": "string", "description": "Path to the video file" },
      "mode":  { "type": "string", "enum": ["full","visual","audio"], "description": "full = events + transcript (default); visual = events only; audio = transcript only" },
      "query": { "type": "string", "description": "Optional natural-language event to locate; returns the matching time span" },
      "ingest":{ "type": "boolean", "description": "If true, write the result into the knowledge graph (default false)" }
    },
    "required": ["path"]
  }
}
```

Tool behaviour:

1. Resolve `path` to an absolute real path; reject traversal and symlink escape (§9).
2. Validate it is a video by container sniff, not extension alone.
3. If the sidecar capability is not installed, return a structured error instructing the user to run the install step. Never silently no-op.
4. Spawn or attach to the sidecar; `initialize` if needed.
5. Call `extract` (or `caption`/`transcribe` alone for `visual`/`audio` mode).
6. If `query` is set, also call `find`.
7. Assemble a `VideoExtraction`.
8. If `ingest` is true, hand the result to `video-extractor.ts` (§9 of the KG section below) and return a summary plus the created node count.
9. On sidecar crash, restart once and retry; on a second failure, return the error with the sidecar's stderr tail in `data`.

## 7. Output schema: `VideoExtraction`

Lives in `packages/eyes/types.ts` (extends the existing eyes types) and is re-exported from `packages/eyes/index.ts`.

```ts
/** A visually observed event with a media-relative time span. */
export interface VideoEvent {
  start: number;        // seconds, media-relative
  end: number;          // seconds, media-relative
  description: string;  // natural-language, from Marlin
}

/** A span of transcribed speech. */
export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  speaker?: string;     // reserved; diarization is a future lane, undefined for now
}

/** A located time span (Marlin find mode). */
export interface VideoSpan {
  start: number;
  end: number;
}

/** The full structured extraction of one video. */
export interface VideoExtraction {
  videoId: string;            // content hash (sha256 of file bytes), stable id
  path: string;               // absolute path at extraction time
  durationSec: number;
  chunked: boolean;           // true if the video exceeded one Marlin window
  chunkCount: number;
  scene: string;              // overall scene paragraph (merged if chunked)
  events: VideoEvent[];       // sorted by start, what was seen
  transcript: TranscriptSegment[]; // sorted by start, what was said
  find?: {                    // present only if a query was passed
    query: string;
    span: VideoSpan | null;
    formatOk: boolean;
  };
  models: { vision: string; audio: string };
  generatedAt: number;        // epoch ms
}
```

Example `VideoExtraction` (abbreviated):

```json
{
  "videoId": "sha256:9f2c...",
  "path": "/Users/j/recordings/demo.mp4",
  "durationSec": 96.4,
  "chunked": false,
  "chunkCount": 1,
  "scene": "A developer demonstrates the 8gent plan rail in a terminal UI.",
  "events": [
    { "start": 0.0, "end": 4.2, "description": "The terminal opens and a prompt is typed." },
    { "start": 4.2, "end": 11.8, "description": "An agent plan renders as a checklist." }
  ],
  "transcript": [
    { "start": 0.6, "end": 3.1, "text": "Let me show you the plan rail." },
    { "start": 3.4, "end": 7.9, "text": "Each step is a task with a status." }
  ],
  "models": { "vision": "NemoStation/Marlin-2B@<commit>", "audio": "whisper-base-mlx" },
  "generatedAt": 1747772693000
}
```

## 8. Chunk-and-merge

Marlin caps at 240 frames / ~2 minutes per window. Videos longer than that must be chunked or they silently truncate. Chunking lives in the tool, not the sidecar's `caption` method, so `caption` stays a pure single-window primitive.

Algorithm:

1. **Plan.** Probe `durationSec`. Split into windows of at most `maxChunkSec` (default 120s). The final window may be short; if it would be under the 4-frame minimum, merge it into the previous window.
2. **Vision per window.** Call `caption` once per window with `startSec` / `endSec`. The sidecar samples frames within the window and returns events with window-relative times.
3. **Rebase.** Add the window's `startSec` to every event `start`/`end` so all events share one absolute media timeline.
4. **Seam dedup.** An event that ends within ε (default 0.5s) of a window boundary and an event in the next window that starts within ε with a near-identical description (token Jaccard > 0.8) are merged into one event spanning both.
5. **Scene merge.** Per-window scene paragraphs are concatenated, then passed through a stage-2 LLM summarization call to produce one coherent `scene`. If the LLM is unavailable, the concatenation is kept verbatim.
6. **Audio is not chunked.** Whisper transcribes the whole file in one `transcribe` call; it has no window limit.

Chunked extractions set `chunked: true` and `chunkCount`. Memory and time scale linearly with chunk count; the tool emits progress events per window.

## 9. Knowledge graph integration

### 9.1 The gap

`extractor.ts` has no video source. `video-extractor.ts` is the new file that closes it.

### 9.2 Two-stage extraction

Marlin and Whisper produce grounded natural-language facts, not graph triples. Stage 2 turns text into triples.

- **Stage 1 (perception).** The sidecar produces `VideoExtraction`.
- **Stage 2 (schema).** `video-extractor.ts` runs an LLM extraction pass (via the 8gent text provider, guarded by the existing `json-guard.ts`) over each event description and each transcript segment, emitting `ExtractedEntity[]` and `ExtractedRelationship[]` that conform to the existing `EntityType` / `RelationshipType` enums.

### 9.3 Events + transcript fusion

The fusion is the payoff. Events (seen) and transcript segments (said) share one media timeline. When a transcript segment and an event overlap in time, stage 2 is given both together as joint context, so a spoken sentence at 0:42 and a visual event at 0:42 resolve to the same grounded node instead of two disconnected ones. Overlap is computed as interval intersection on the timeline; non-overlapping segments are extracted alone.

### 9.4 Enum extension

`packages/memory/graph.ts` gains:

```ts
export type EntityType =
  | "file" | "function" | "package" | "person" | "session"
  | "decision" | "concept" | "preference" | "tool"
  | "video"   // NEW: a source video, keyed by videoId
  | "event";  // NEW: a timestamped moment within a video

export type RelationshipType =
  | "depends_on" | "implements" | "authored_by" | "decided"
  | "prefers" | "uses" | "contains" | "related_to"
  | "occurs_in"  // NEW: event occurs_in video
  | "precedes"   // NEW: event precedes event (temporal order)
  | "mentions";  // NEW: event/transcript mentions concept/person
```

This is additive. A migration in `packages/memory/migrations` is only needed if the column is a constrained enum at the SQLite level; if entity/relationship `type` is a free-text column, no migration runs and the change is purely TypeScript. The migration file checks this and is a no-op in the free-text case.

### 9.5 Provenance

Every entity and relationship derived from a video carries provenance in `metadata`:

```ts
metadata: {
  source: "video",
  videoId: "sha256:9f2c...",
  start: 42.0,   // media-relative seconds
  end: 47.5,
  modality: "visual" | "audio" | "fused"
}
```

This makes the graph queryable by time ("what happened between 0:30 and 1:00 of that video") and lets any node link back to the exact span it came from. The `find` method is the reverse path: a query resolves to a span for re-grounding or verification.

### 9.6 What is and is not stored

Per #2326's 8SO requirements: the graph stores the video `path`, the `videoId` hash, embeddings, and the extracted summaries/triples. It never stores raw frames, raw audio, or the video bytes. Frames exist only transiently inside the sidecar process during inference.

## 10. Security review: `trust_remote_code`

Marlin requires `trust_remote_code=True`, which executes `modeling_marlin.py` from the HF repo. This is arbitrary code execution and is the highest-risk part of the design.

Controls:

1. **Pin the revision.** `visionRevision` is a specific HF commit hash, never a moving branch. The pinned hash is committed in the sidecar source. An upstream change cannot reach the user without a reviewed bump.
2. **Review on bump.** Any change to the pinned hash requires reading the diff of `modeling_marlin.py` and is an 8SO-labelled PR.
3. **Process isolation.** The sidecar is a separate process, not in-agent code. It satisfies #2326's "binary files processed in a sandboxed subprocess, never loaded directly into agent context." The sidecar runs with the user's permissions; a future hardening lane can add a seatbelt/sandbox-exec profile restricting it to its venv, the model cache, and the target video path.
4. **No network at inference time.** Models are downloaded once at install (§11). The sidecar runs offline; a network call during inference is a red flag and the hardening profile denies it.
5. **Opt-in.** The capability is off by default. Installing it is an explicit, consented user action.
6. **No file content in the graph.** Per §9.6.

This section must be signed off by 8SO (Karen) before the sidecar PR merges.

## 11. Install and runtime

8gent-code is a Bun/TS codebase. Marlin needs PyTorch (~2.5GB of wheels) plus mlx-whisper. This is never bundled by default.

- **Provisioning.** `8gent vision install` (or the equivalent capability-tier action) creates a `uv`-managed virtualenv under `~/.8gent/venvs/marlin/` and installs `transformers>=5.7.0`, `torch>=2.11.0`, `torchcodec`, `qwen-vl-utils>=0.0.14`, `av`, `pillow`, `mlx-whisper`.
- **Model cache.** Weights download to `~/.8gent/models/marlin-2b/` (pinned commit) and `~/.8gent/models/whisper-base-mlx/`. Marlin is Apache 2.0 and public, so a normal HF download is correct here. The BDH-weights-private rule does not apply.
- **Download integrity.** The installer verifies the sha256 of each downloaded shard; an interrupted download resumes rather than corrupting the cache.
- **Capability tier.** The flag follows the same off-by-default discipline as `packages/kernel` (the RL pipeline is off by default). A fresh `npm install -g @8gi-foundation/8gent-code` carries no Python.
- **torchcodec is the fragile dependency.** torchcodec on Apple Silicon is the most likely install failure. The installer probes a decode of a tiny bundled test clip and reports a clear error if it fails, rather than failing later at first use.

## 12. Performance and limits

- Marlin window: 240 frames max, 4 frames min, 2.0 fps default, 448x448 max per frame, 2048 gen tokens.
- Memory: Marlin ~4-5GB BF16 + Whisper-base ~150MB + frame activations. Tight on a 16GB M-series Mac with the frame cap; comfortable on 32GB+.
- Speed: first real benchmark on James's MacBook Pro (Apple Silicon, MPS), `marlin bench` against a 20s 640x480 30fps `testsrc` clip: cold model load 86.4s, caption latency 29.8s for the single window (greedy, 2048-token cap, 2.0 fps sampling). The visual tower runs on MPS. This is the only number a "runs locally" roadmap line may cite; longer or denser videos chunk and scale roughly linearly per 2-minute window. A `marlin bench` subcommand reproduces the measurement.
- Cold start: first `initialize` after install pays model load (~86s measured cold, including the offline weight read from cache). Warm calls do not.

## 13. Edge cases

| Case | Handling |
|------|----------|
| No audio track | `transcribe` returns `hasAudio:false`, `transcript:[]`. `extract` continues with visual only. |
| Silent video (audio track, no speech) | Whisper may hallucinate text on noise/music. Apply a no-speech-probability threshold; drop segments above it. |
| Video shorter than 4 sampled frames | `-33004`; tool reports the file is too short to caption. Transcript still attempted. |
| Corrupt / undecodable file | `-33002` with the decoder error in `data`. |
| Unsupported codec/container (rare HEVC variants, exotic containers) | `-33003`; tool suggests re-encoding to H.264 mp4. |
| Variable frame rate | torchcodec normalizes via timestamp-based sampling, not frame-index; events stay time-correct. |
| Rotated video (phone capture metadata) | Rotation metadata is honored at decode; frames are upright before they reach Marlin. |
| HDR video | Tone-mapped to SDR at decode; logged as a warning. |
| Multiple audio tracks | Default track 0; `audioTrack` param selects another. |
| Forced vs detected language | `language:"auto"` detects; an explicit code forces and skips detection. |
| Marlin timestamp beyond duration | Clamp event `end` to `durationSec`; log a warning. |
| `find` event not present | `span:null`, `formatOk:false`; tool reports "not found", not an error. |
| Long video (e.g. 1 hour) | Many chunks; linear time/memory; per-window progress emitted; user can cancel. |
| Sidecar crash mid-request | Tool restarts the sidecar once and retries; second failure returns the error with stderr tail. |
| Out of memory | `-33005` with a lower suggested `fps` in `data.suggestion`; tool may auto-retry once at the lower fps. |
| Concurrent `extract_video` calls | Sidecar queues; `health.queueDepth` exposes backlog. Tool does not assume parallelism. |
| Interrupted model download | Installer resumes from partial shards; sha256 verified before the model is marked ready. |
| Path traversal / symlink escape | Path resolved to a real absolute path; rejected if it escapes an allowed root or the user-passed location. |
| Non-video file passed | Container sniff fails fast before the sidecar is touched. |
| Huge file | Decoded as a stream; the whole file is never read into RAM. |
| Empty events from Marlin | `events:[]` is valid; `scene` is still returned. |
| Pinned `trust_remote_code` commit changed upstream | Irrelevant at runtime - the pinned hash is fetched; a bump is a reviewed PR. |
| Duplicate ingestion of the same video | `videoId` is the content hash; re-ingest updates the existing `video` node and bumps `mentionCount` rather than duplicating. |

## 14. 8gent-computer integration

The Electron app reuses the same sidecar and protocol. The contract:

- The **main process** owns the sidecar child process: spawn, the `initialize` handshake, idle shutdown, restart-on-crash. It exposes `extract_video` over Electron IPC to the renderer.
- The **renderer** never spawns Python. It calls `ipcRenderer.invoke("extract_video", { path, mode, query, ingest })` and receives a `VideoExtraction`.
- Install/provisioning is surfaced as a one-time consented action in the app UI (customer-facing copy: "Enable video understanding", never "install the AI sidecar").
- The sidecar binary, protocol, and `VideoExtraction` schema are identical to 8gent-code; only the host differs. No second implementation.

This is a follow-up PR after the 8gent-code sidecar and tool land; it is in scope for the overall effort but sequenced last.

## 15. Open questions

1. **mlx-whisper model size.** `whisper-base` is the default for speed; `whisper-small`/`large-v3` trade speed for accuracy. Default is `base`; making it user-configurable is cheap and probably worth it.
2. **Speaker diarization.** `TranscriptSegment.speaker` is reserved but unfilled. Diarization (who spoke) is a separate model and a separate lane; flagged, not built.
3. **Stage-2 extraction prompt.** The event/transcript-to-triple prompt needs the same care as `extractor.ts`'s existing logic. It should be a versioned prompt file, not an inline string.
4. **MLX port of Marlin.** Would cut memory and remove the MPS-fallback slowdown, but requires porting the custom video tower. Deferred; tracked as its own issue.

## 16. Issue map

- Parent: #2326 feat(kg): multimodal ingestion for Knowledge Graph (this is the video lane).
- Related: #980 media understanding pipeline.
- #2631 - Marlin+Whisper video sidecar (`packages/eyes/marlin`).
- #2632 - `extract_video` tool + chunk-and-merge.
- #2633 - `video-extractor.ts` + `EntityType`/`RelationshipType` extension.
- #2634 - wire `extract_video` into 8gent-computer.

## 17. Build sequence

1. This spec lands (its own PR).
2. Sidecar (`packages/eyes/marlin`) - depends on nothing; testable with a bundled clip.
3. `extract_video` tool - depends on the sidecar; testable against fixed sidecar JSON before the sidecar is real.
4. `video-extractor.ts` + enum extension - depends on the `VideoExtraction` schema only; testable with fake `VideoExtraction` fixtures.
5. 8gent-computer wiring - depends on a working sidecar + tool.

Steps 3 and 4 can proceed in parallel once the schema in §7 is frozen.
