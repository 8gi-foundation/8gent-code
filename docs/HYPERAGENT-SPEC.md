# HyperAgent Spec - Metacognitive Loop

Engineering reference for the self-improvement loop that runs across
benchmark iterations. This document describes what each component is,
what calls it, and what it persists. Closes #1911.

Audience: a contributor who has read the repo's package layout and
needs to extend, debug, or replace one of the moving parts.

## Goal in one paragraph

After every autoresearch iteration we want three things to happen
automatically: failures land in a queryable database with the failing
prompt and the mutation candidate that did not work; improvements get
persisted as `LearnedSkill` rows so the next session has them in
context; reflection runs between iterations so tool-use patterns are
distilled into reusable rules. None of this requires new tables - the
primitives existed independently before this issue, they just were not
wired together.

## Components and ownership

| File | Responsibility |
|---|---|
| `packages/self-autonomy/evolution-db.ts` | SQLite schema. Tables: `reflections`, `learned_skills`, `evolution_events`, `schema_meta`. All persistence flows through here. |
| `packages/self-autonomy/learned-skills.ts` | `learnSkill`, `getRelevantSkills`, `reinforceSkill`. Bayesian-ish confidence updates (delta 0.1, clamped 0..1). |
| `packages/self-autonomy/reflection.ts` | `reflect(SessionData)` distills tools-used + errors + agent notes into a `SessionReflection` row. |
| `packages/self-autonomy/improvement-loop.ts` | New. Wires iteration outcomes into `evolution-db` and `learned-skills`. The connector this issue introduces. |
| `packages/self-autonomy/heartbeat.ts` | Background timers. Now also runs reflection on `reflectionInterval` (off by default). |
| `packages/self-autonomy/persona-mutation.ts` | Soul calibration mutator. Out of scope for the loop but available for callers that want the persona to drift on user feedback. |
| `benchmarks/autoresearch/autoresearch-loop.ts` | The mutation-loop orchestrator. After it computes scores it now calls `recordIterationOutcome`. |

## Data flow per iteration

```
┌──────────────────────────────────────────────────────────────────┐
│                    autoresearch-loop.ts                           │
│                                                                   │
│   for each benchmark:                                             │
│     run model with current system prompt + accumulated mutations  │
│     grade output → score                                          │
│     if failure: analyzeAndMutate() → push mutation strings        │
│                                                                   │
│   compute iteration avg, save loop-state.json                     │
│                                                                   │
│   ▼ NEW                                                           │
│   recordIterationOutcome({ benchmarks, prevScores, mutations })   │
└────────────────────────────┬─────────────────────────────────────┘
                             │
                             ▼
        ┌────────────────────────────────────────────┐
        │      improvement-loop.ts                    │
        │                                              │
        │  for each benchmark outcome:                 │
        │    confidence_change event   (always)        │
        │    error_encountered event   (if failed)     │
        │    learnSkill(trigger, mutation)             │
        │      where:                                  │
        │       trigger = "bench:<cat>:<id>"           │
        │       action  = mutation text                │
        │      (only on improvement with mutation)     │
        │    reinforcePriorSkill(±)                    │
        │      (improvement w/o mutation, or regress)  │
        └─────────────────────┬───────────────────────┘
                              │
                              ▼
              ┌────────────────────────────────┐
              │   evolution-db.ts (SQLite)      │
              │     learned_skills              │
              │     evolution_events            │
              └────────────────────────────────┘
```

## The three branches in `recordIterationOutcome`

For each `BenchmarkOutcome` exactly one of the following actions happens
beyond the always-emitted `confidence_change` event:

1. **Failure** (score below `passThreshold`) - emit `error_encountered`
   with metadata `{ failingPrompt, mutationCandidate, mutationCount }`.
   This is what makes the DB queryable later: a future run can search
   for the same prompt and see what mutations did not move the needle.

2. **Improvement with mutation** (`score > previousScore && mutations.length > 0`)
   - call `learnSkill(trigger, action)` where the trigger is the stable
   benchmark id (`bench:<category>:<id>`) and the action is the mutation
   text. Emit `skill_learned`. Future sessions calling
   `getRelevantSkills("bench:fullstack FS001")` will find this and can
   inject it into the system prompt.

3. **Improvement without mutation** or **regression** - call
   `reinforcePriorSkill(trigger, ±)`. This bumps or decays the
   confidence of any existing skill at that trigger. Confidence movement
   is `±0.1` clamped to `[0, 1]` per `updateSkillStats` in evolution-db.

The first iteration has no `previousScore`, so only branch 1 (failure
event) or no skill action fires. This is intentional - we cannot tell
yet whether a mutation moved the score until iteration 2.

## Reflection between iterations

`heartbeat.ts` now exposes three additions:

```ts
heartbeat.reportToolCall(name, success)   // accumulator
heartbeat.reportNote(text)                 // accumulator (PATTERN:, SKILL: prefixes parsed by reflect())
heartbeat.triggerReflection()              // calls reflect() with the accumulator, persists to DB, resets counters
```

Two ways to trigger reflection:

- **Manual** - caller invokes `heartbeat.triggerReflection()` between
  benchmark iterations. The autoresearch loop is single-threaded and
  does this synchronously.
- **Timed** - pass `reflectionInterval: 30000` to `HeartbeatAgents`
  constructor and `start()` will set an interval. Default is 0 (off)
  so existing tests are not affected.

Reflection produces a `SessionReflection` row in the DB. The row records
which tools were used, normalized error patterns, observed patterns
(both note-extracted and inferred from tool co-occurrence), and a
success rate. This is the input that future sessions can scan with
`getRecentReflections(limit)`.

## What is persisted vs what is ephemeral

| Persisted (SQLite, survives restart) | Ephemeral (in-memory only) |
|---|---|
| `evolution_events` (iteration history per benchmark) | `HeartbeatAgents` accumulator (resets after each `triggerReflection`) |
| `learned_skills` (mutations that improved a score) | `pendingModifications` queue |
| `reflections` (tool-use distillations) | `loop-state.json` - kept on disk but in the autoresearch dir, not the evolution DB |
| `schema_meta` (schema version) | autoresearch session id - derived per-run from `state.startedAt` |

## Failure modes and what we do about them

- **Evolution DB write fails**: the autoresearch loop wraps the call in
  try/catch and logs `Evolution DB write failed: <message>`. The
  benchmark loop continues. Skills are not persisted for that
  iteration; the next iteration will try again.
- **Reflection throws**: `triggerReflection` swallows the exception and
  returns null. Heartbeat ticks must never crash the host.
- **Skill collision** (same trigger learned twice): `learnSkill` calls
  `reinforceSkill(existing.id, true)` instead of inserting a duplicate.
  Confidence drifts up; action text is not overwritten.
- **No `previousScore`** (first iteration): the `improved` and
  `regressed` checks evaluate false. Only the failure branch can fire.
- **Score regresses but a mutation exists**: counted as `regressedCount`
  and `failedCount` (if below threshold). The mutation is NOT
  persisted as a skill - it did not earn it.

## Schema versioning

`evolution-db.ts` exposes `getSchemaVersion()` and `setSchemaVersion(n)`.
Current version is 1 (seeded on first DB open). When you add a column
or table, write a migration that bumps the version and call it from
`getDb()` before returning the handle. The wiring in this issue does
not require a migration - it only writes new rows to existing tables.

## Worked example

Iteration 1, benchmark `FS001` "Build an auth system":
- score = 40
- mutations: `["Always include the auth middleware in the request pipeline."]`

Recorded:
- `confidence_change` event, subject `bench:fullstack:FS001`, value 0.4
- `error_encountered` event, same subject, with metadata
  `{ failingPrompt: "Build an auth system", mutationCandidate: "Always include..." }`

Iteration 2, same benchmark, same mutation now in the prompt:
- score = 85 (improved from 40)

Recorded:
- `confidence_change`, value 0.85, metadata `{ delta: 0.45, passed: true }`
- `learnSkill(trigger="bench:fullstack:FS001", action="Always include...")`
  inserts a new row with confidence 0.5
- `skill_learned` event

Future session loads relevant skills for a fullstack auth task. The
mutation that worked is now in the system prompt automatically.

## Test coverage

- `packages/self-autonomy/improvement-loop.test.ts` - three scenarios:
  failure-only, improvement-after-failure, regression-with-prior-skill.
  The third scenario (`full autonomous improvement cycle`) demonstrates
  one complete cycle end to end with reflection in between.
- `packages/self-autonomy/heartbeat-reflection.test.ts` - verifies
  `reportToolCall` + `triggerReflection` persist a reflection row and
  emit the `reflection:complete` event.

Run with: `bun test packages/self-autonomy/`

## What this loop deliberately is NOT

- It is NOT RL fine-tuning. That lives in `packages/kernel/` and is off
  by default. The loop here only adjusts a textual system prompt and a
  database of skill rows. No weights are touched.
- It is NOT a planner. There is no goal-decomposition. The autoresearch
  loop is a fixed-point iteration: run benchmarks, mutate, re-run.
- It is NOT online during normal `8gent` interactive sessions. It is a
  research loop run via `bun run benchmarks/autoresearch/autoresearch-loop.ts`.
  The skills it learns ARE consumed by interactive sessions through
  `getRelevantSkills()` / `buildSkillsContext()`.

## Extending the loop

To add a new persisted signal:
1. Add an `EventType` literal in `evolution-db.ts`.
2. Emit it from `improvement-loop.ts` at the right branch.
3. Add a query helper in `evolution-db.ts` if needed.
4. Bump the schema version if you added a column.

To replace the mutation generator:
1. The current generator is `analyzeAndMutate` in `autoresearch-loop.ts`.
2. It is per-benchmark string heuristics. Swap it for an LLM call,
   a structured grammar, anything - the only contract is that it
   returns `string[]`. The improvement loop is agnostic.
