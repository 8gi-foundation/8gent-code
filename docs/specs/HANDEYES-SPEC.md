# 8gent Handeyes - Sensorimotor Coordination Spec

Status: DRAFT (RFC). Issue: 8gi-foundation/8gent-code#2526.

## 1. Why handeyes exists

The body-parts taxonomy already has motor (`@8gent/hands`) and perception (`@8gent/eyes`) as two independent capabilities. They compose well in the cheap case: `eyes.find(...)` returns a Locator, the agent passes the point to `hands.click(...)`, the action lands. Two calls, no coordinator.

The cheap case stops working when the screen and the action go out of sync. Examples we have already seen in trace logs:

- The find call returns zero hits because the AX tree has not finished updating after the previous action.
- The click lands but no visible change follows, because the click hit the wrong element or an overlay swallowed it.
- The agent enters a period-N loop (find -> click -> find -> click) on the same query because nothing is checking that progress is being made.

Each of these is a coordination failure, not a motor failure or a perception failure. Hands does its job. Eyes does its job. What is missing is the loop that watches the two together and intervenes when they fall out of step.

`handeyes` is that loop. It is biology-accurate naming: the cerebellum has dedicated circuits for hand-eye coordination distinct from motor cortex and visual cortex. It is brand-clean: "hands, eyes, handeyes" mirrors the body-parts spine the public docs already lead with.

Importantly, `handeyes` is not always-on. The default path stays the cheap sequential one. Coordination engages only when the agent is observably stuck. This spec defines the contract, the engagement model, and the architectural shape; it does not define the engagement-loop implementation, which lands in a follow-up after the perceptual-diff work in #2525.

## 2. Scope of this spec

In scope:

- The Handeyes interface (compound actions plus explicit struggle-mode entry / exit).
- Engagement-model rules: the four trigger heuristics, transient lifecycle, exit conditions.
- Architectural shape using the existing multi-agent primitives (`spawn_agent` / `check_agent` / `message_agent` / `merge_agent_work` in `packages/orchestration/` and `packages/ai/tools.ts`).
- Tool surface that the agent loop calls compound actions through.
- Race conditions inherent to coordinating motor and perception against a live screen.

Out of scope (explicit non-goals for this spec):

- The actual engagement-loop implementation. This spec describes the contract a coordinator must satisfy; the orchestrator-backed coordinator is a follow-up PR.
- The real perceptual-diff backend. Trigger heuristic 3 ("click + no observable change") requires region-aware diff events. The current `eyes.diff()` is byte-equality v0; #2525 ships the real diff. Handeyes contract does not depend on #2525 landing first.
- AX-tree mutability handling under concurrent action. Acknowledged below in §7 as a known race; the v0 mitigation is "hands queue serialises motor calls", which removes the concurrency at the source.
- Tool registration in `packages/ai/tools.ts` under a `coordination` category. Acceptance criterion 2 in #2526 lists this; it is deferred to the engagement-loop PR so the contract scaffold has zero downstream blast radius.
- Headless `--intent` parity. Inherits the dispatch-everywhere rule when the engagement loop ships; the contract scaffold has nothing meaningful to expose at the CLI layer yet.

## 3. The contract

```ts
export interface Handeyes {
	readonly id: string;
	readonly available: boolean;

	// Compound actions: the agent's primary surface.
	locateAndClick(
		query: LocatorQuery,
		opts?: ClickOpts,
	): Promise<LocateClickResult>;

	clickAndVerify(
		point: Point,
		expected: Predicate,
		opts?: VerifyOpts,
	): Promise<VerifyResult>;

	typeAndConfirm(
		text: string,
		expectedField?: LocatorQuery,
		opts?: ConfirmOpts,
	): Promise<VerifyResult>;

	// Self-rescue: explicit engagement when the agent self-diagnoses it is
	// stuck. The auto-triggers in §4 cover the common cases; this is the
	// escape hatch.
	engageStruggleMode(reason: string, ttlSteps?: number): Promise<StruggleHandle>;
	exitStruggleMode(handle: StruggleHandle): Promise<void>;
}
```

### 3.1 Why these four operations

- `locateAndClick` is the single most common pattern in the trace store. Promoting it to a compound call removes the manual chain at the call site and lets the coordinator decide whether to retry on no_match before bothering the agent loop.
- `clickAndVerify` is the building block for "did anything actually happen?" loops. Hands today returns success when the click was dispatched, not when the click had effect. That is correct for hands. Verification belongs at this layer.
- `typeAndConfirm` catches the IME / focus-stolen / wrong-field-focused failure modes that look identical to success at the hands layer. Without confirmation, a typing failure is invisible until the agent reads the screen back hundreds of tokens later.
- `engageStruggleMode` / `exitStruggleMode` are the explicit lever. The auto-triggers in §4 are deliberately conservative; an agent that knows it is stuck (e.g. it has read its own previous tool output and seen no progress) should not have to wait for them to fire.

### 3.2 Result shape

All compound calls return a discriminated `ok` boolean plus a structured reason. Throwing is reserved for programmer errors (bad arg shape). User-driven and environment-driven failure modes are values. This is the same convention `@8gent/eyes` uses, kept consistent so the agent loop has one error model across all body-parts.

The `LocateClickResult.escalatedTo` and `VerifyResult.escalatedTo` fields surface the StruggleHandle when a compound call auto-escalates into struggle mode (e.g. `clickAndVerify` exhausts its retries and `escalateOnFail` is set). The agent then has a handle it can use to pump the struggle session forward and exit it explicitly.

## 4. Engagement model

The default path is `eyes.find` -> `hands.click`, sequential, cheap. Handeyes engages only when ANY of the four triggers fire:

| # | Trigger | Source | Why this trigger |
|---|---|---|---|
| 1 | `eyes.find` returns zero hits twice in a row for the same query | eyes call site | Most common stuck signal in trace logs. Fires before the agent has burned tokens reasoning about the empty response. |
| 2 | `wait_for` times out | eyes call site | The agent asked for a screen state that never arrived. Either the screen changed in a way the predicate did not anticipate, or no change is coming. Either way, coordination needed. |
| 3 | A click is followed by no observe()-detected screen change within 1.5s | hands + eyes correlation | The action did not land, OR the screen update is happening off-screen, OR the diff threshold is wrong. Requires the perceptual-diff work in #2525 to fire reliably; degrades gracefully (false negatives) on byte-equality v0 diff. |
| 4 | DoomLoopDetector catches a period-N cycle in the tool stream | `packages/eight/tool-loop-detector.ts` (shipped #2461) | The cleanest hook; the detector is already watching the tool stream for cycles of period 1 to 4 on a sliding 12-call window. We tap it directly rather than re-deriving the cycle signal. |

### 4.1 Lifecycle

Engagement is transient by design. A struggle session has four phases:

1. **Trigger fires.** The source emits a `StruggleTriggerInput` with a `StruggleReason`. The coordinator opens a session and returns a `StruggleHandle` with `ttlSteps` set to the backend default (v0 target: 8 steps).
2. **Engaged.** The eyes-worker sub-agent is spawned (running `eyes.observe()` in a loop and publishing diff events). The hands-queue sub-agent is spawned (serialising motor calls). The parent coordinator receives both streams and dispatches actions accordingly.
3. **Forward progress detection.** After every step, the coordinator checks: did the last action produce a material screen change AND did the agent's stated objective advance? If yes, the engagement decrements an internal "stable" counter; if the counter hits zero before `ttlSteps` runs out, the session exits early.
4. **Exit.** The session exits on any of: explicit `exitStruggleMode(handle)` call, `ttlSteps` exhaustion, three consecutive forward-progress steps, or a hard error in either sub-agent. The eyes-worker and hands-queue are torn down. The coordinator returns control to the cheap sequential path.

### 4.2 Trigger arming and disarming

Triggers 1, 2, and 3 are armed at the call site of the body-part operation that produced them. They MUST be cheap to evaluate (single comparison, single counter increment); the cost of arming triggers everywhere is the cost of paying for engagement nowhere.

Trigger 4 is armed once per agent process by subscribing to DoomLoopDetector events. The handeyes coordinator MUST NOT re-instantiate the detector; it consumes the existing one. This is non-negotiable: two detectors would double-count cycles and engage struggle mode unnecessarily.

Disarming is handled at session exit. The coordinator clears any per-trigger counters that fired the engagement so the same trigger cannot immediately re-fire on the first post-exit call.

## 5. Architectural shape

Handeyes is multi-agent orchestration applied to body-parts. It introduces no new orchestration substrate. It uses what is already there:

- `spawn_agent` (`packages/ai/tools.ts:1111`) - spawns a background sub-agent in the agent pool.
- `check_agent` (`packages/ai/tools.ts:1175`) - polls a sub-agent for status and result.
- `message_agent` (`packages/ai/tools.ts:1372`) - sends a message into a running sub-agent.
- `merge_agent_work` (`packages/ai/tools.ts:1413`) - integrates a sub-agent's work back into the parent context.
- `getAgentPool()` and `spawnCLIAgent()` (`packages/orchestration/`) - the underlying pool implementations.

A struggle session is three sub-agents:

```
                        +-----------------------+
                        |  Parent coordinator   |
                        |  (handeyes)           |
                        +-----------+-----------+
                                    |
                +-------------------+-------------------+
                |                                       |
       +--------v---------+                  +----------v----------+
       |   eyes worker    |                  |    hands queue      |
       |  (sub-agent)     |                  |   (sub-agent)       |
       |                  |                  |                     |
       |  while engaged:  |                  |  serialised motor   |
       |    eyes.observe()|                  |  call queue. one    |
       |    publish diff  |                  |  pointer constraint |
       |    events to bus |                  |  enforced by single |
       +------------------+                  |  consumer.          |
                                             +---------------------+
```

The eyes worker publishes `ObservationEvent`s to the orchestrator bus (`packages/orchestration/orchestrator-bus.ts`). The hands queue consumes commands the coordinator dispatches to it via `message_agent`, processes them in FIFO order, and publishes outcomes back to the bus. The coordinator is the only entity reading both streams; it pairs each motor outcome with the diff event it expects to see, and routes retries / escalates based on the pairing.

This is the same pattern the agent uses today to spawn parallel sub-agents for unrelated tasks. The only difference is that handeyes pre-defines the two roles (eyes-worker, hands-queue) and the routing logic between them. Nothing about the substrate is novel.

### 5.1 Why one hands queue, not parallel hands

There is exactly one mouse pointer on the system. Two hands sub-agents could not click in parallel without one stomping on the other's pre-click hover state. The hands-queue sub-agent makes the serialisation explicit: the queue is the "I am the only motor caller during a struggle session" guarantee. Outside a struggle session, the agent calls `hands.*` directly and bears its own serialisation responsibility (which has not been a problem because the agent loop is itself sequential).

### 5.2 Why eyes worker is one sub-agent, not many

`eyes.observe()` is already a continuous stream. Spawning multiple eyes workers would produce duplicate diff events and burn CPU on redundant capture. The single worker captures once per interval and fans out diff events to any number of listeners on the bus.

### 5.3 Adapter shape

```ts
export interface HandeyesAdapter {
	readonly id: string;
	readonly available: () => Promise<boolean>;
	readonly create: (opts?: HandeyesAdapterOpts) => Handeyes;
}
```

V0 ships with a single adapter id `orchestrator` that uses the substrate above. Future adapters (e.g. one that runs the coordinator inline rather than as a sub-agent for low-step engagements) register with the same registry. The default preference order is currently `["orchestrator"]` and is overridable per call site.

## 6. Tool surface

The agent calls compound actions through tools registered in a new `coordination` category in `packages/ai/tools.ts` (deferred to the engagement-loop PR; not in this scaffold). Names mirror the contract operations:

| Tool name | Maps to |
|---|---|
| `handeyes_locate_and_click` | `Handeyes.locateAndClick` |
| `handeyes_click_and_verify` | `Handeyes.clickAndVerify` |
| `handeyes_type_and_confirm` | `Handeyes.typeAndConfirm` |
| `handeyes_engage_struggle_mode` | `Handeyes.engageStruggleMode` |
| `handeyes_exit_struggle_mode` | `Handeyes.exitStruggleMode` |

Per the AgentCLIDesign rules, tool inputs MUST be JSON-serialisable (no functions in option bags), tool outputs MUST be JSON-serialisable, and there is no telemetry side effect beyond the audit trace.

The system-prompt edits that introduce these tools to the agent are deferred to the engagement-loop PR. Until then, an agent that imports `@8gent/handeyes` and instantiates an adapter directly can use the contract; agents that go through the standard tool surface see no change.

## 7. Race conditions

Coordination races between motor and perception are the entire reason handeyes exists. The contract acknowledges three classes:

### 7.1 Mid-click animation

The screen state at click-dispatch time is not the screen state at click-land time. A button moving under the cursor (e.g. layout shift, scroll, animated reveal) will receive the click at its post-shift position, not the position eyes located. The hands queue MUST capture a fresh frame at dispatch time and compare against the frame the locate ran on; if they diverge above a threshold, the click is held and the locate is re-run.

The threshold and the hold timeout are backend-tunable. V0 target: 0.95 similarity threshold, 300ms hold, single re-locate before either dispatching with the new point or escalating.

### 7.2 AX-tree mutability under concurrent action

If hands opens a new window while eyes is in the middle of an `annotate` call, the AX tree the annotate walker sees is partially the old window and partially the new one. The hands-queue serialisation in §5.1 removes most of this concurrency at the source: during a struggle session, hands calls are serialised through the queue and eyes annotates between them.

For the residual case (system-driven UI changes, e.g. a notification animating in), the annotation cache (`packages/eyes/cache.ts`, 2s TTL, observe-invalidated) is the safety net; any observe event with sub-threshold similarity invalidates the cache, so the next annotate runs against the new tree.

### 7.3 Cache coherence between eyes worker and ad-hoc eyes calls

If an agent makes an ad-hoc `eyes.find` call from outside the coordinator while a struggle session is running, the agent's call hits the same singleton Eyes instance the eyes-worker is hitting. The annotation cache is per-Eyes-instance, so both calls share it. This is correct: the agent reading the screen and the worker reading the screen should see the same thing.

What is NOT correct is two parallel `annotate` calls hitting the cache miss path simultaneously. The cache MUST de-dupe in-flight annotations on `(frame.id, displayId, region)`; a second concurrent call gets a Promise on the in-flight resolution, not a second AX walk. This is a small change to `packages/eyes/cache.ts` that lands with the engagement loop, NOT with this contract scaffold.

## 8. Open questions

These need an RFC pass before the engagement-loop PR opens:

1. **Default ttlSteps.** §4.1 proposes 8. Trace data from the eyes capability rollout will tell us whether 8 is too short (sessions getting auto-killed mid-recovery) or too long (sessions burning tokens after they should have given up). Decision deferred until we have engagement traces.
2. **Forward-progress signal source.** §4.1 phase 3 says "did the agent's stated objective advance?". The agent's stated objective is currently implicit. Options: (a) require the agent to declare an objective string when engaging struggle mode, (b) infer from sub-agent task descriptions, (c) just use "did the screen change materially" and ignore objective. (a) is cleanest but requires prompt-side cooperation; (c) is the cheapest. Likely v0: (c), with (a) as an opt-in via `engageStruggleMode(reason, ttlSteps, objective?)`.
3. ~~**DoomLoopDetector hook contract.**~~ **DECIDED 2026-05-10 (RFC #2527, James: Option A).** `DoomLoopDetector` extends `EventEmitter` and emits `"stuck"` with payload `{ period, reps, windowSize, detectedAt, signatures }` when a cycle is detected. The synchronous `check(): boolean` API is preserved unchanged for existing callers. Handeyes subscribes once at startup via `detector.on("stuck", ...)`. Polling rejected: defeats the point of fast escalation. Shipped in this PR series.
4. **Failure surface to the agent loop.** When struggle mode exits with no recovery, what does the agent see? Options: (a) a tool-call result with `ok: false, reason: "engagement_exhausted"`, (b) a system message injected into the next prompt cycle, (c) both. Likely (a) for the call site that triggered it plus (c) for visibility.
5. **Trace-store schema.** Each struggle session is multi-event. The current trace store stores per-tool-call rows. Either we add a `session_id` column (cleanest) or we fold session events into the tool-call rows (less invasive). Decision lands with the engagement-loop PR.

## 9. References

- `docs/specs/EYES-SPEC.md` - sibling perception spec; mirrors this structure.
- `packages/eyes/index.ts` - eyes contract this builds on.
- `packages/hands/index.ts` - hands contract this builds on.
- `packages/orchestration/` - the multi-agent substrate handeyes is a thin coordinator over. Specifically `agent-pool`, `orchestrator-bus`, `subagent`, and `task-dispatcher`.
- `packages/ai/tools.ts:1108-1490` - `spawn_agent`, `check_agent`, `message_agent`, `merge_agent_work` tool definitions handeyes reuses.
- `packages/eight/tool-loop-detector.ts` - DoomLoopDetector (#2461). Trigger heuristic 4.
- 8gi-foundation/8gent-code#2525 - perceptual diff. Trigger heuristic 3 needs region-aware diff events from this work to fire usefully. Contract here does NOT block on it.
- 8gi-foundation/8gent-code#2526 - this issue.
