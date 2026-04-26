# HyperAgent Spec - End-to-End Self-Improvement Loop

Engineering description of the metacognitive cycle wired by `packages/self-autonomy/improvement-loop.ts`.

This document is descriptive, not aspirational. Every component named here exists in the repo at the path given.

## Goal

Close the loop between benchmark execution, mutation analysis, and persistent learning so that:

1. A failing benchmark surfaces a mutation candidate.
2. Re-running the benchmark with the mutation either improves or regresses the score.
3. The outcome is recorded in the evolution database.
4. Improvements are promoted to learned skills that persist across sessions.
5. Reflection runs between iterations to extract patterns from cumulative history.

No reinforcement learning, no remote API, no new infrastructure. Just wiring of the primitives that already shipped.

## Components

| Module | Path | Role |
|--------|------|------|
| Iteration runner | `benchmarks/autoresearch/autoresearch-loop.ts` | Runs benchmarks, derives mutations from failures, accumulates `IterationResult` history. |
| Loop wiring | `packages/self-autonomy/improvement-loop.ts` | Diffs adjacent iterations, persists outcomes, triggers reflection. |
| Evolution DB | `packages/self-autonomy/evolution-db.ts` | SQLite store for `reflections`, `learned_skills`, `evolution_events`. |
| Learned skills | `packages/self-autonomy/learned-skills.ts` | `learnSkill`, `getRelevantSkills`, `reinforceSkill`. |
| Reflection | `packages/self-autonomy/reflection.ts` | `reflect(SessionData)` extracts patterns and persists a `SessionReflection`. |
| Heartbeat | `packages/self-autonomy/heartbeat.ts` | Background timers + `betweenIterations()` hook. |

## Cycle (one iteration of the loop)

```
   ┌─────────────────────────────────────────────────────────┐
   │ benchmarks/autoresearch/autoresearch-loop.ts            │
   │   1. runBenchmarkSweep(benchmark)                       │
   │   2. analyzeAndMutate(benchmark, run) → addMutation()   │
   │   3. saveState(state)                                   │
   └──────────────────────┬──────────────────────────────────┘
                          │
                          ▼
   ┌─────────────────────────────────────────────────────────┐
   │ packages/self-autonomy/improvement-loop.ts              │
   │   runImprovementCycle({ before, after, ... })           │
   │     ├── recordIterationOutcome(prev, curr, sessionId)   │
   │     │     for each benchmark in curr.scores:            │
   │     │       score < threshold  → recordEvent(           │
   │     │                            "error_encountered")   │
   │     │       score < prev       → recordEvent(           │
   │     │                            "confidence_change",   │
   │     │                            value=delta<0)         │
   │     │       score > prev       → learnSkill(...)        │
   │     │                            recordEvent(           │
   │     │                            "confidence_change",   │
   │     │                            value=delta>0)         │
   │     └── reflectOnIterations({ history, mutations })     │
   │           → reflect({ toolsUsed, errors, notes,         │
   │                       successfulCalls, totalCalls })    │
   │           → saveReflection(SessionReflection)           │
   └──────────────────────┬──────────────────────────────────┘
                          │
                          ▼
   ┌─────────────────────────────────────────────────────────┐
   │ ~/.8gent/evolution/evolution.db                         │
   │   reflections          (one row per session)            │
   │   learned_skills       (persistent across runs)         │
   │   evolution_events     (audit log)                      │
   └─────────────────────────────────────────────────────────┘
```

## Data flow

### Inputs

`IterationResultLike` is structurally identical to `IterationResult` in `autoresearch-loop.ts`:

```typescript
{
  iteration: number;
  avgScore: number;
  passing: number;
  total: number;
  scores: Record<string /*benchmarkId*/, number>;
  mutationsAdded: string[];
  timestamp: string;
}
```

The wiring module mirrors the type rather than importing from `benchmarks/` to keep the dependency direction one-way (`benchmarks` depends on `packages`, never the reverse).

### Failure path

Every benchmark with `score < passThreshold` (default 80) writes an `error_encountered` event:

```sql
INSERT INTO evolution_events
  (id, session_id, event_type, subject, value, metadata, created_at)
VALUES
  (?, sessionId, 'error_encountered', benchmarkId, score, {iteration, prevScore, mutationsActive}, NOW)
```

### Improvement path

When `curr.scores[benchmarkId] > prev.scores[benchmarkId]`:

1. The most recent mutation tagged for that benchmark id (via the `[BENCHMARK_ID]` prefix convention used in `analyzeAndMutate`) is matched.
2. `learnSkill(trigger, mutation, source="autoresearch")` persists it. The trigger is the failure description; the action is the mutation text.
3. If the score gain is at least 10 points, `reinforceSkill(skill.id, true)` nudges confidence upward.
4. A `confidence_change` event records the delta with `direction: "improvement"`.

### Reflection

`reflectOnIterations` builds a `SessionData` from cumulative history:

- `toolsUsed` = set of distinct benchmark ids surfaced across all iterations
- `errors` = one string per below-threshold benchmark/iteration pair
- `notes` = mutations prefixed with `PATTERN:` so `reflect()` extracts them
- `successfulCalls` / `totalCalls` = above/below threshold counts

`reflect()` (unchanged) deduplicates errors, infers patterns from tool co-occurrence, and writes a `SessionReflection` row.

## Heartbeat integration

`HeartbeatAgents.betweenIterations(...)` exposes the same wiring without creating a new agent. The autoresearch loop calls `runImprovementCycle` directly; long-running interactive sessions (TUI, daemon) can call `heartbeat.betweenIterations(...)` between turns to get the same effect.

```typescript
const heartbeat = getHeartbeatAgents({ workingDirectory: cwd });
const reflection = heartbeat.betweenIterations({
  sessionId,
  before: previousIteration,
  after: currentIteration,
  history: state.history,
  mutations: state.mutations,
});
```

Errors are caught and logged; reflection failure never breaks the calling loop.

## Threshold and tuning

| Constant | Default | Where |
|----------|---------|-------|
| `passThreshold` | 80 | `improvement-loop.ts`, overridable per call |
| `reinforceSkill` trigger | score gain >= 10 | hardcoded in `recordIterationOutcome` |
| Confidence delta | +/- 0.1 per success/failure | `evolution-db.ts:updateSkillStats` |

## What this does NOT do

- Does not modify the system prompt directly. Mutations live in `system-prompt.ts` and `evolution_events`. Skills surface via `getRelevantSkills(taskHint)` for next-iteration injection but do not auto-rewrite the base prompt.
- Does not call out to any LLM. Pure data wiring.
- Does not touch `packages/kernel/`. RL fine-tuning is off by default and out of scope.
- Does not delete or roll back skills. Confidence falls toward zero for losers; the skill row stays for forensic value.

## Smoke test

`packages/self-autonomy/improvement-loop.test.ts` exercises the full cycle in memory:

1. Iter 1 - `FOO` scores 40 → `error_encountered` event recorded.
2. Iter 2 - mutation added, `FOO` scores 90 → `learned_skill` row created, `confidence_change` event recorded with positive delta.
3. `reflectOnIterations` produces a `SessionReflection` with `successRate` = 0.5 across both iterations.
4. `getEvolutionSummary(...)` reports non-zero error rate and at least one improved skill.

Run: `bun test packages/self-autonomy/improvement-loop.test.ts`

## Surface area

Public exports added in this PR:

```typescript
// packages/self-autonomy/improvement-loop.ts
export function recordIterationOutcome(...): IterationOutcome;
export function reflectOnIterations(...): SessionReflection;
export function runImprovementCycle(...): CycleOutput;
export function getSkillsForNextIteration(taskHint, limit): string;
export type IterationResultLike;
export type IterationOutcome;
export type CycleInput;
export type CycleOutput;

// packages/self-autonomy/heartbeat.ts (added method)
HeartbeatAgents.prototype.betweenIterations(...): SessionReflection | null;
```

No existing exports were renamed or removed.
