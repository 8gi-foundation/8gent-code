# Flow Telemetry Schema v1

**Status:** Wave 1 (Resonant Flow, boardroom GO 2026-08-10). Pending the Chair's
readability approval of `~/.8gent/flow/SAMPLE-FOR-JAMES.md` before go-live.
**Owner:** `packages/telemetry/flow-stream.ts` is the ONLY writer.
**Store:** `~/.8gent/flow/telemetry.jsonl` (override dir with `FLOW_TELEMETRY_DIR`).

## What this is

A passive, local-only stream aggregating signals the daemon ALREADY captures:

| Signal | Existing source |
|---|---|
| LLM call latency | `packages/telemetry/events.ts` (`LLMEvent.latencyMs`) |
| Huddle turn spoken duration | `packages/daemon/huddle-routes.ts` -> `FloorMachine.noteTurnAudio` (`packages/table/floor.ts`) |
| Officer thinking/idle transitions | `packages/daemon/table-presence.ts` (`announceActivity`) |
| Table message timestamps | `~/.8gent/table/table.db` `messages.created_at` |
| Notification dispatch timestamps | `packages/daemon/notifications.ts` dispatch sites |

**Zero new capture of the human.** No sensors, no audio, no video, no affect
inference, no physiological anything. The ambient-sensing decision record
remains BLOCKING and this stream stays entirely on its near side.

## Access rules (staging gates - these are enforced, not advisory)

1. **Every field in every kind is `local-only`.** NOTHING in this stream may
   enter a cloud model prompt. Not summarized, not quoted, not embedded. Local
   model aggregation is permitted; the derived metrics functions
   (`packages/telemetry/flow-metrics.ts`) are the intended reader.
2. **Off-box shipping is banned by construction.** The existing telemetry
   emitter writes to stdout for Vector -> Loki. Flow records deliberately do
   NOT go through that emitter; they append only to the local JSONL file. Do
   not add a flow sink that leaves the machine.
3. **No message content, ever.** Message records carry timestamps and author
   identity only. Huddle turn records carry durations, never text.
4. **Single writer.** Only `flow-stream.ts` writes the file. Readers:
   `flow-metrics.ts`, the sample renderer, and the Chair.
5. **Audit:** every refused write is logged loudly with its reason
   (`[flow-telemetry] SCHEMA DRIFT`), so drift is detected, never silently
   absorbed (live-huddle amendment 4).

## Schema-drift monitoring

- `validateFlowRecord()` is strict: unknown fields, missing required fields,
  wrong types, or a version other than `1` REFUSE the write and log the reason.
- `scanForDrift()` sweeps an existing JSONL file and reports invalid lines.
- A test (`flow-schema-doc.test.ts`) diffs the field tables in THIS document
  against the field specs in code. Changing one without the other fails CI.
  Schema changes bump `v` and update this document in the same PR.

## Envelope (all kinds)

| Field | Type | Required | Access | Description |
|---|---|---|---|---|
| `v` | number | yes | local-only | Schema version. Literal `1`. |
| `kind` | string | yes | local-only | One of the five kinds below. |
| `ts` | string | yes | local-only | ISO-8601 event time. |

## Kinds

### `llm_latency` - one model call completed

Mirrored passively from the existing `LLMEvent` via `installFlowTap()`.
Token counts and cost stay on the original event; flow needs timing only.

| Field | Type | Required | Access | Description |
|---|---|---|---|---|
| `provider` | string | yes | local-only | Provider name, e.g. `ollama`. |
| `model` | string | yes | local-only | Model id. |
| `latencyMs` | number | yes | local-only | Wall-clock latency of the call. |
| `channel` | string | no | local-only | Daemon channel (`os`, `telegram`, ...). |
| `sessionId` | string | no | local-only | Session correlation id. |

### `turn_audio` - a huddle turn's real spoken length

The measured narration duration `noteTurnAudio` already feeds the floor.

| Field | Type | Required | Access | Description |
|---|---|---|---|---|
| `huddleId` | string | yes | local-only | Huddle id. |
| `turnId` | string | yes | local-only | Turn id. |
| `holder` | string | yes | local-only | Floor holder, e.g. `agent:8TO`. |
| `durationMs` | number | yes | local-only | Measured audio duration. |

### `presence` - an officer thinking/idle transition

The same lifecycle `announceActivity` records; one record per transition.
A thinking run is the span from a `thinking` record to its paired `idle`
for the same `channelId` + `agentId`.

| Field | Type | Required | Access | Description |
|---|---|---|---|---|
| `channelId` | string | yes | local-only | Table channel id. |
| `agentId` | string | yes | local-only | Prefixed id, e.g. `agent:8TO`. |
| `state` | string | yes | local-only | `thinking` or `idle`. |

### `notification` - a human-facing notification was dispatched or deferred

One record per dispatch decision. `disposition` is the flow-mode hook:
until the breakpoint deferral queue ships, every record is `delivered`
and the deferred count is honestly zero.

| Field | Type | Required | Access | Description |
|---|---|---|---|---|
| `ntype` | string | yes | local-only | `NotificationType`, e.g. `task-complete`. |
| `disposition` | string | yes | local-only | `delivered` or `deferred`. |
| `channel` | string | yes | local-only | `telegram`, `macos`, or `email`. |

### `message` - a table message landed (timestamp only)

| Field | Type | Required | Access | Description |
|---|---|---|---|---|
| `channelId` | string | yes | local-only | Table channel id. |
| `authorId` | string | yes | local-only | Prefixed author id, e.g. `human:james`. |
| `authorKind` | string | yes | local-only | `human` or `agent`. |

## Derived metrics (readers, not fields)

`packages/telemetry/flow-metrics.ts` computes, from records alone:

- **Interruptions per hour** - delivered notifications per observed hour.
- **Longest uninterrupted thinking runs** - top thinking->idle spans with no
  delivered notification inside them.
- **Deferred vs delivered counts** - present now, deferred pinned at zero
  until flow mode ships. No fabricated baseline.

## Retention

Local JSONL, append-only, never shipped. Rotation is a later concern; the
fortnight A/B pilot's volume is trivial (well under 1 MB).
