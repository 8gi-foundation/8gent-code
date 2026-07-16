# Meta-Harness Foundation (packages/harness)

Part of #2797. First slice of the meta-harness: the pluggable `Harness`
abstraction, the `8gent-local` default backend, and the daemon HTTP surface.
Clean-room build - concepts observed in herdr (AGPL) are re-derived here from
scratch; zero code copied.

## Problem

8gent can only run work through its own hardwired agent path. There is no
pluggable seam where other harnesses (Claude Code, Codex, herdr, remote
vessels) could register as agent backends, and no uniform status stream a
single orchestrator pane could watch.

## Constraint

Safety. The registry WRAPS the existing daemon + Agent path; it must not
replace or destabilise them. `8gent-local` is the only backend in this slice
(zero external deps). No fabricated status data - every number in a
StatusEvent traces to a real signal from the agent loop.

## Not doing

- External harness adapters (Claude Code, Codex, herdr). Later slice.
- The orchestrator-pane UI. Later slice.
- Replacing the daemon dispatch/Workflow spine. The registry sits beside it.
- Auth changes on the daemon. Harness routes ride the existing gateway.
- Persistence of task history across daemon restarts.

## Success metric

A task dispatched through the `Harness` interface via `8gent-local` executes
on the real local Agent and its StatusEvents stream out of
`GET /harness/tasks` (SSE), with the existing daemon paths untouched.
Verified by `bun test packages/harness/` (all green) + `bun run typecheck`.

## Estimated size

7 new files in `packages/harness/` (+1 route wire-up in
`packages/daemon/gateway.ts`, ~10 lines). Roughly 700 lines including tests.
One session.

---

## The contract (exact exported API)

Everything below is exported from `packages/harness/index.ts` unless noted.

### StatusEvent

```ts
type HarnessState = "queued" | "working" | "blocked" | "needs_input" | "done" | "error";

interface StatusEvent {
	agentId: string;    // the task id this event belongs to
	harness: string;    // registered harness name, e.g. "8gent-local"
	state: HarnessState;
	tool?: string;      // tool name, present on real tool-call activity
	tokens?: number;    // cumulative REAL token usage (from step usage), never estimated here
	elapsedMs?: number; // wall-clock ms since run start
	output?: string;    // final response text (done) or error message (error)
	ts: number;         // Date.now() when the event was created
}
```

Honesty rules: `tool`, `tokens`, `elapsedMs` are only set when the underlying
agent loop actually reported them. No placeholder numbers, ever.

### Harness

```ts
interface HarnessTask {
	id: string;
	prompt: string;
	cwd?: string;
}

interface Harness {
	name: string;
	run(task: HarnessTask): AsyncIterable<StatusEvent>;
}
```

`run` is a streaming call: it yields `queued` first, then `working` events
(with tool/token/elapsed detail as it becomes available), and terminates with
exactly one `done` or `error` event.

Input validation (#2803): an empty or whitespace-only `prompt` is rejected by
`LocalHarness.run` itself with a single `error` event (no `queued`, no engine
ever constructed) - a degenerate prompt must never reach the underlying model,
which can otherwise hallucinate "facts" and persist them via memory tools.
`HarnessRunner.start` throws on an empty prompt before minting a taskId, and
the HTTP layer keeps its 400. All three layers guard independently.

Store isolation (#2803): the default engine factory refuses to construct the
real Agent under a test or dogfood environment (`NODE_ENV=test`, `BUN_TEST`,
or `EIGHT_HARNESS_DOGFOOD=1`) unless `EIGHT_DATA_DIR` points at an isolated
directory outside the real global store (`~/.8gent`). Production runs are
unaffected. See `assertIsolatedDataDir` in `packages/harness/local.ts`.

### HarnessRegistry

```ts
const DEFAULT_HARNESS = "8gent-local";

class HarnessRegistry {
	register(h: Harness): void;              // throws on duplicate name
	get(name?: string): Harness;             // no arg = DEFAULT_HARNESS; throws if unknown
	list(): string[];                        // registered names, registration order
}

function createDefaultRegistry(): HarnessRegistry; // registry with 8gent-local pre-registered
```

### LocalHarness (packages/harness/local.ts)

```ts
class LocalHarness implements Harness {
	name = "8gent-local";
	constructor(options?: LocalHarnessOptions);
	run(task: HarnessTask): AsyncIterable<StatusEvent>;
}

interface LocalEngine {
	chat(prompt: string): Promise<string>;
}

interface LocalHarnessOptions {
	// Test seam / future reuse. Default factory lazily constructs the REAL
	// packages/eight Agent (model = EIGHGENT_MODEL || "eight:latest",
	// runtime = "ollama") wired so AgentEventCallbacks feed StatusEvents.
	createEngine?: (opts: { cwd?: string; events: AgentEventCallbacks }) => LocalEngine;
}
```

Event mapping (real signals only):

| Agent signal | StatusEvent |
| --- | --- |
| empty/whitespace prompt | single `error`, engine never constructed (#2803) |
| run accepted | `queued` |
| chat begins | `working` (elapsedMs) |
| onToolStart | `working` + `tool` |
| onStepFinish | `working` + cumulative `tokens` (usage.totalTokens) + elapsedMs |
| chat resolves with an answer | `done` + `output` (+ tokens/elapsedMs) |
| chat resolves with only unexecuted tool_call protocol | `error` (#2804) |
| chat throws | `error` + `output` = error message |

Output hygiene (#2804): before a `done` is emitted, the final chat output is
run through `sanitizeFinalOutput` (`packages/harness/sanitize.ts`). Unexecuted
`tool_call` protocol blocks (canonical ```` ```tool_call ```` fences, the
leaked bare-fence + `tool_call`-body-line variant, or a bare whole-answer
`tool_call` line + JSON object) are stripped; when nothing remains, the turn
ends in `error` instead of `done`. Raw protocol syntax never surfaces as a
successful answer.

Token availability (#2805): on the default local runtime (ollama / LM Studio
via the text-tool path), `tokens` is populated from the REAL `usage` object
the provider's OpenAI-compatible `/v1/chat/completions` response reports on
each model round (`buildTextToolCall`'s `onUsage` ->
`AgentEventCallbacks.onStepFinish`). When a runtime omits `usage`, `tokens`
stays absent - it is optional and never estimated or fabricated. Native
tool-calling providers keep reporting through the AI-SDK `onStepFinish` path
as before.

### HarnessRunner (packages/harness/runner.ts)

Task manager behind the HTTP surface.

```ts
class HarnessRunner {
	constructor(registry?: HarnessRegistry);   // default: createDefaultRegistry()
	readonly registry: HarnessRegistry;
	start(input: { prompt: string; harness?: string; cwd?: string }): string; // -> taskId, run detached
	getEvents(taskId: string): StatusEvent[];  // buffered history, [] if unknown
	subscribe(listener: (e: StatusEvent) => void): () => void; // live feed, returns unsubscribe
}
```

### HTTP surface (packages/harness/http.ts, wired in packages/daemon/gateway.ts)

```ts
function handleHarnessRoute(req: Request, url: URL, runner?: HarnessRunner): Promise<Response> | Response | null;
function getHarnessRunner(): HarnessRunner; // daemon-wide singleton
```

Returns `null` for non-harness paths so the gateway falls through.

| Route | Behaviour |
| --- | --- |
| `GET /harnesses` | `{ harnesses: string[], default: "8gent-local" }` |
| `POST /harness/run` | body `{ prompt, harness?, cwd? }` -> `202 { taskId, harness }`. 400 on missing/empty prompt or unknown harness. |
| `GET /harness/tasks` | SSE (`text/event-stream`). Replays buffered StatusEvents, then streams live ones. Each frame: `data: <StatusEvent JSON>\n\n`. |

Local-first: omitting `harness` runs `8gent-local`.

## Checkpoint (fill at PR close)

- [x] `bun test packages/harness/` green (28 pass, 0 fail)
- [x] `bun run typecheck` green
- [x] Daemon routes wired without touching existing routes (gateway +8 lines, daemon suite 164 pass)
- [x] Live transport smoke: real Bun server, GET /harnesses + POST /harness/run (202) + SSE queued -> working -> done
