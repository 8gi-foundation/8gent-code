# Harness Protocol

Revision `2026-11-12`. Status: draft, first slice. Flag: `EIGHT_HARNESS_PROTOCOL=1` (ships off).

One interface for driving any coding harness the same way: this repo's own loop, a shell, or
another CLI on the machine. 8gent Code then runs many harnesses through one seam instead of one
bespoke path per runtime.

Code: `packages/harness/protocol/` (types, conformance rubric, spawner adapter).
Tests: `bun test packages/harness/__tests__/protocol.test.ts`.

## 1. Why

Today there are four ways 8gent Code starts work somewhere else, and no two speak alike:

| Path | File | Shape | Stream | Cancel | Sessions |
| --- | --- | --- | --- | --- | --- |
| Process spawner | `packages/orchestration/universal-spawner.ts` | `spawnCLIAgent(runtime, task)` runs a hosted CLI (`--print`) or `sh -c`; returns a handle whose promise resolves with buffered stdout, stderr and exit code | No: output arrives at the end | No public call; only its own timeout kill and `resetCLIAgents()` | No |
| Delegation tools | `packages/orchestration/delegation-tools.ts` | `spawn_agent` / `check_agent` / `list_agents` tools; gates every process child (depth cap, plan mode, shell sanitiser, System One, hosted opt-in, provider pin), then calls the spawner or the in-process pool; the caller polls | Poll only | No | No |
| In-process pool | `packages/daemon/agent-pool.ts` | One loop instance per daemon session; `chat()` per message, events bridged to the daemon bus | Yes, via bus events | `session:abort` | Yes |
| Meta-harness | `packages/harness/index.ts`, `adapters/cli.ts` | `Harness.run(task)` yields `StatusEvent`s (`queued`, `working`, `needs_input`, `done`, `error`); registry, runner, HTTP `/harness/*`; generic CLI adapter opt-in via `EIGHGENT_CLI_HARNESSES` | Yes | Only by abandoning the stream | No |

The daemon wire protocol (`docs/specs/DAEMON-PROTOCOL.md`) is the richest of these: sessions,
`prompt`, then `agent:thinking`, `tool:start`, `tool:result`, `agent:stream`, `session:end`, plus
abort. It is a client-to-daemon protocol, though, not a contract a harness implements.

The gap: no single contract says what starting a harness, sending it a turn, watching it work,
stopping it and asking what it can do look like, and no test can tell whether a harness gets it
right. This spec is that contract and that test.

## 2. The interface

```ts
interface HarnessAdapter {
  readonly id: string;
  capabilities(): HarnessCapabilities;              // pure, stable
  start(options?: StartOptions): Promise<HarnessSession>;
  send(sessionId: string, input: TurnInput): HarnessTurn;
  cancel(turnId: string): Promise<boolean>;
  stop(sessionId: string): Promise<void>;
}

interface HarnessTurn {
  id: string;
  sessionId: string;
  events(): AsyncIterable<HarnessEvent>;            // every event from seq 0, for any reader
  done: Promise<TurnEnded>;                         // the turn.ended event; never rejects
}
```

Six verbs, matching the brief: start, send a turn, stream events, cancel, capabilities, stop.

- **start** opens a session: a working directory, extra environment, a per-turn time limit.
- **send** begins one turn and returns at once. It throws `HarnessError` only when the turn
  cannot begin: `session_not_found`, `session_busy`, `empty_input`. Anything that goes wrong
  after the turn began ends the turn `failed` instead. Two error channels, never mixed.
- **events** is replayable. A reader who starts late, or a second reader, gets the same events
  from seq 0. Nothing is lost to a slow subscriber.
- **cancel** returns true only when a running turn was told to stop; false for an unknown or
  finished turn. The turn then ends `cancelled`.
- **stop** cancels any running turn, waits for it to end, and forgets the session. Calling it
  twice is fine.
- **capabilities** is a plain object, the same every call.

### Capabilities

| Field | Meaning |
| --- | --- |
| `protocol` | The revision the adapter was built to (`2026-11-12`). |
| `harness` | Equals the adapter's `id`. |
| `streaming` | `text.delta` events arrive while the turn runs. |
| `sessions` | A later turn sees earlier ones. |
| `cancel` | `cancel()` stops a running turn. |
| `maxConcurrentTurns` | Turns one session may run at once; `1` means a second send is `session_busy`. |
| `local` | Nothing the turn sends leaves this device. |

Every field is always present; false means no. `local` is ours and exists because of principle 2:
a caller can refuse every non-local harness without knowing anything else about it.

### Events

Every event carries `seq` (0, then +1 per event, no gaps) and `turnId`.

| Type | Fields | When |
| --- | --- | --- |
| `turn.started` | `sessionId`, `harness` | Always first, seq 0. |
| `text.delta` | `text` | A piece of the answer. Joined in seq order they are the whole output. |
| `tool.started` | `tool` | The harness began a tool call it really made. |
| `tool.finished` | `tool`, `ok` | That call ended. |
| `log` | `text` | Diagnostic output (a process's stderr). Not part of the answer. |
| `turn.ended` | `status`, `output`, `error?`, `reason?`, `durationMs` | Always last, exactly once. |

`status` is one of:

- `completed`: finished. `output` is the deltas joined.
- `failed`: went wrong. `error` is present and not empty. Only `failed` carries `error`.
- `cancelled`: someone asked it to stop. Never reported as `failed`. Partial output kept.
- `incomplete`: stopped short without an error; `reason` says why (e.g. `timeout`).

No field is ever estimated. `tool.*` events and token counts appear only when the harness
really reports them; a plain CLI reports neither, so its adapter emits neither (the same honesty
rule as `packages/harness/SPEC.md`).

`TurnLog` in `types.ts` implements numbering, replay and the single end, so every adapter gets
ordering right the same way instead of each rewriting it.

## 3. How existing runtimes map

| Runtime | Adapter | Status |
| --- | --- | --- |
| Shell (`sh -c`) through `spawnCLIAgent` | `spawnerHarness("shell")`, id `spawner:shell` | **Built in this slice.** stdout to `text.delta`, stderr to `log`, exit 0 to `completed`, other exit to `failed` with the stderr tail, spawner timeout to `incomplete`/`timeout`, cancel kills the process. `local: true`, `sessions: false`. |
| Hosted CLI through `spawnCLIAgent` | `spawnerHarness(HOSTED_CLI_RUNTIME)` | Same class, `local: false`, and the same gate as `spawn_agent`: refused without `EIGHT_ALLOW_HOSTED=1`, by the permission mode, or by a provider pin. Only its refusals are tested, with an empty `PATH` (no network, no model calls). |
| In-process loop (`AgentPool`) | Next slice | `chat()` maps to a turn; `onToolStart`/`onToolEnd` to `tool.*`; stream chunks to `text.delta`; `session:abort` to cancel. `sessions: true`. |
| Meta-harness `Harness.run` and `CliHarness` | Next slice: a bridge | A `HarnessAdapter` can be served as a `Harness` (`turn.started` to `queued`, deltas to `working`, `completed` to `done`, the rest to `error`), so the registry and `/harness/*` HTTP routes serve both without a second HTTP surface. |

There is one gate, not two copies. `planProcessChild` in `packages/orchestration/delegation-tools.ts`
holds every check a process child passes, and both `spawn_agent` and the spawner adapter call it:

- the depth cap;
- the permission mode: a caller in plan mode starts nothing, and the child's mode is clamped to
  the caller's;
- for the hosted runtime: the `EIGHT_ALLOW_HOSTED=1` opt-in, the mode's refusal of a hosted
  child, and the provider pin;
- for the shell: in a mode, the run_command gate (plan refusal, the permission check, System One
  in the mode's environment, the approval card for ask); without a mode, the sanitiser and System
  One; then the isolated inline python rewrite.

It returns the task and the whole environment to spawn with. A shell child is judged with exactly
the environment it is started with, session `env` included, so a `$VAR` cannot mean one thing to
the check and another to the shell. `childAgentEnv()` goes last, so session env can never lower
the depth. The permission mode and provider pin that apply are the ones bound where `send()` is
called. `spawnerHarness()` is the only way to build the adapter, and it takes no gate: no caller
can swap the checks out. A refused turn ends `failed` with the refusal, word for word what
`spawn_agent` returns, and nothing runs. A parity test runs both paths on the same cases (plan
mode, a denied command, no hosted opt-in, a pinned provider, a `$VAR` set only in session env).
The child gets no stdin, so nothing it runs can wait on an answer: prompts default No,
unattended means no.

## 4. Out of scope

- Any network transport. This is an in-process TypeScript contract. The daemon and HTTP surfaces
  keep their own protocols; a bridge comes later.
- Wiring into `spawn_agent`, the TUI, the daemon or the registry. Nothing in the product calls the
  new code yet; `spawnerHarness()` returns null unless the flag is on.
- Mid-turn input (asking the person a question). `CliHarness.respond` covers that today; folding it
  in needs an `input.requested` event and a `respond` verb.
- Files and artifacts as turn input or output.
- Memory. No memory sub-protocol here. 8gent Code already has its own memory layer
  (`docs/MEMORY-SPEC.md`); a harness that wants it uses that layer through its own tools.
- Version negotiation between processes. With one in-process contract, `capabilities().protocol`
  is enough to refuse a mismatch.
- Process groups in the spawner. See known gaps.

## 5. Conformance rubric

`runConformance(adapter, fixture)` in `packages/harness/protocol/conformance.ts` runs every check
and returns `pass`, `fail` or `skip` for each, with a reason. The fixture names three turns the
adapter knows how to produce: one that completes with known text, one that writes then runs until
cancelled, and one that fails. The rubric needs no network and no model; the adapter decides what
the turns are.

| Id | Check |
| --- | --- |
| H-01 | Capabilities have every field with the right type, name this revision and the adapter id, and are the same on a second call. |
| H-02 | `start` gives distinct sessions, named for the harness, with a working directory. |
| H-03 | `send` with empty input throws `empty_input` before a turn begins. |
| H-04 | `send` to an unknown session throws `session_not_found`. |
| H-05 | The first event is `turn.started`, seq 0, naming the session and harness. |
| H-06 | `seq` is gapless and every event carries the turn id. |
| H-07 | Exactly one `turn.ended`, and it is last. |
| H-08 | `done` resolves to the same `turn.ended` the stream carried. |
| H-09 | A completed turn's `output` equals its deltas joined and the expected text; no `error`. |
| H-10 | A reader who starts after the end gets every event, identical to the live read. |
| H-11 | The session takes another turn after one ends, with a new turn id. |
| H-12 | A failing turn ends `failed` with a non-empty `error`. |
| H-13 | Events stream while the turn is still running (with `streaming`, a `text.delta` arrives before the end). |
| H-14 | With `maxConcurrentTurns: 1`, a second `send` while busy throws `session_busy`. |
| H-15 | `cancel` of a running turn returns true; the turn ends `cancelled`, no `error`, partial output kept. |
| H-16 | `cancel` of a finished or unknown turn returns false. |
| H-17 | `stop` ends a running turn as `cancelled`, forgets the session, and is safe to call twice. |

A check skips only when a capability says the behaviour does not apply (no `cancel`, or concurrent
turns allowed). The test file proves the rubric bites: five planted defects in an in-memory adapter
(unstable capabilities, a dropped event, a replay that loses deltas, no busy refusal, cancel
reported as failure) each fail the check written for them.

Results on this slice: in-memory adapter 17/17 pass; the spawner adapter on the shell, through
the real gate, 17/17 pass.

## 6. Where we agree and differ with UHP

Concept comparison with the Unified Harness Protocol published by HarnessRouter Community Edition
(Apache-2.0, revision `2026-10-19`). Read for concepts only; no code, schema or text was taken.

**Agree**

- A harness is driven by tasks, not raw model calls, behind one interface whatever runs underneath.
- Ordering is a contract: numbered events from 0 with no gaps, a start event first, exactly one
  terminal event last, and the terminal event carries the whole result so a reader who missed
  events can still render it.
- The stream must be progressive, never buffered to the end, and the rubric checks it.
- A requested stop is its own outcome, never an error. "Stopped short" (budget, timeout) is a
  fourth outcome distinct from failure.
- Capabilities are a complete set of named booleans: an unsupported feature reports false rather
  than going missing.
- A second turn on a busy session is refused, not queued silently.
- Conformance is a runnable suite with per-check ids and pass, fail and skip outcomes, so a claim
  of support can be checked rather than asserted.

**Differ**

- **Transport.** UHP is an HTTP standard whose task surface is a subset of a hosted vendor's
  Responses-style API, streamed as server-sent events. Ours is an in-process TypeScript
  interface. A local harness should cost no socket, no server and no key. An HTTP face can be added over it later.
- **Local is a capability.** UHP has no notion of whether work leaves the device. Ours does, so a
  caller can refuse every non-local harness by default.
- **Gates live in the adapter path.** UHP leaves authorisation to bearer keys on a server. Ours
  runs the same refusal chain as `spawn_agent` before any process starts, because the harness runs
  on the person's own machine with their files.
- **Smaller vocabulary.** UHP's event set mirrors a hosted API's item and content-part model
  (output items, content parts, reasoning summaries, argument deltas). Ours is six events. Item
  structure can be added when a harness actually reports it.
- **Rubric runs offline.** UHP's suite sends real tasks to a running server and spends model
  tokens. Ours runs against any adapter with fixture turns, so it runs in `bun test` with no
  network and no model.
- **Memory.** UHP has an optional memory chapter: a tree of memories holding records, grants with
  inheritance, and four touch points (prime the context at session start, tools during a turn,
  observe at the end of a turn, consolidate in the background), advertised by a `memories`
  capability. We leave memory out of this protocol: our memory layer is local and already reached
  through the loop's own tools. The four touch points are a useful frame for a later slice.
- **Not built yet, that UHP has:** files in and out, session listing, branching and sharing,
  idempotent retries, plugins and environments, harness create and delete, version negotiation,
  input requests mid-turn.

## 7. Known gaps

- Wiring the adapter into any product path is blocked until #235 (process-group children) merges.
- `spawnCLIAgent` does not start its child as a process-group leader, so `killProcessTree` can
  reach only the child itself. A grandchild (`sh -c "a; b"` where `b` is not exec'd) survives a
  cancel or timeout and can hold the output pipes open. The adapter bounds its own wait (it ends
  the turn on the child's exit plus a short drain, not on pipe close), so the turn still ends on
  time, but the grandchild runs on. The spawner's own timeout kill has the same gap today. Fix in
  the spawner: spawn `detached` on POSIX, as `adapters/cli.ts` already does.
- `spawnCLIAgent` registers every child in its global table, so turns show up in `list_agents`.
- `sessions: false` on the spawner adapter: each turn is a fresh process.

## 8. Next slices

1. **Bridge to the meta-harness registry**: serve any `HarnessAdapter` as a `Harness`, register
   `spawner:shell` behind the flag, so `/harness/*` and the registry drive both shapes.
2. **In-process loop adapter**: wrap `AgentPool` sessions (`chat`, tool callbacks, abort) as a
   `HarnessAdapter` with `sessions: true`, and pass the rubric with a scripted local engine.
3. **Spawner process groups, then `spawn_agent` behind the flag**: start spawner children as group
   leaders so cancel reaches the whole tree (#235), then route `spawn_agent` process runtimes
   through the spawner adapter when `EIGHT_HARNESS_PROTOCOL=1`, so `check_agent` reads the event log instead
   of polling buffered output.
