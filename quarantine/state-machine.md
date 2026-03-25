# Quarantine: Typed Finite State Machine

**Package:** `packages/tools/state-machine.ts`
**Status:** Quarantine review
**Branch:** `quarantine/state-machine`

---

## What it does

Typed finite state machine (FSM) for managing agent lifecycle states. Zero external dependencies.

## API

```ts
import { StateMachine } from './packages/tools/state-machine.ts';

type States = 'idle' | 'running' | 'paused' | 'done';
type Events = 'START' | 'PAUSE' | 'RESUME' | 'FINISH' | 'RESET';

const machine = new StateMachine<States, Events, { retries: number }>({
  initial: 'idle',
  context: { retries: 0 },
  states: {
    idle: {
      onEnter: (ctx) => console.log('Entered idle', ctx),
    },
    running: {
      onEnter: (ctx, event) => console.log('Started', event),
      onExit: (ctx, event) => console.log('Leaving running', event),
    },
    paused: {},
    done: {},
  },
  transitions: {
    idle: {
      START: { target: 'running' },
    },
    running: {
      PAUSE: { target: 'paused' },
      FINISH: {
        target: 'done',
        guard: (ctx) => ctx.retries < 3,
        action: (ctx, e) => ({ ...ctx, retries: ctx.retries + 1 }),
      },
    },
    paused: {
      RESUME: { target: 'running' },
      RESET: { target: 'idle' },
    },
  },
  historyLimit: 50,
});

await machine.send({ type: 'START' });
console.log(machine.current);   // 'running'
console.log(machine.can('PAUSE'));  // true
console.log(machine.history);   // transition log
```

## Exports

| Export | Type | Purpose |
|--------|------|---------|
| `StateMachine` | class | Core FSM |
| `StateMachineError` | class | Thrown on invalid target state |
| `MachineConfig` | interface | Full config shape |
| `StateDefinition` | interface | onEnter/onExit hooks |
| `TransitionDefinition` | interface | target, guard, action |
| `MachineEvent` | interface | Typed event with payload |
| `HistoryEntry` | interface | Transition log entry |

## Key features

- Fully typed via generics: state IDs, event types, context shape
- `guard` - predicate to block a transition
- `onEnter` / `onExit` - async lifecycle hooks per state
- `action` - pure function to derive new context on transition
- Event history with configurable limit (default 100)
- `can(event)` - query whether a transition is eligible
- `snapshot()` - serializable state dump
- `reset()` - restore to initial state + context

## Integration candidates

- `packages/eight/agent.ts` - agent lifecycle (idle, planning, executing, waiting, done, error)
- `packages/permissions/policy-engine.ts` - approval gate state
- `packages/validation/` - checkpoint-verify-revert loop transitions
- `packages/orchestration/` - worktree pool job lifecycle

## Constraints

- Zero dependencies
- No circular state validation (consumer responsibility)
- Async hooks run serially - no timeout enforcement
- History stores full context snapshots - large contexts increase memory usage
