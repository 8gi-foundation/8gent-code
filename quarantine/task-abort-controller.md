# task-abort-controller

## Tool Name
`TaskAbortController`

## Description
Hierarchical abort controller for nested async agent tasks. Extends the native
`AbortController` with:

- **child()** - spawn a child controller that auto-aborts when the parent aborts
- **reason tracking** - structured `AbortReason` union (user | timeout | parent | error)
- **onAbort callback** - synchronous hook fired on abort
- **isAborted** - boolean shorthand for `signal.aborted`
- **timeout auto-abort** - pass `timeoutMs` to abort automatically after N ms
- **dispose()** - release resources without aborting (normal task completion)
- **withAbortController()** - scoped helper that disposes the controller when the task settles

## Status
`quarantine`

The implementation is self-contained and has no external dependencies beyond the
runtime `AbortController` API (available in Bun, Node 18+, browsers). It has not
yet been wired into the agent loop or tool executor.

## Source
`packages/tools/task-abort-controller.ts`

## Integration Path
1. Import `TaskAbortController` in `packages/eight/agent.ts` to replace the current
   bare `AbortController` used for stream cancellation.
2. Pass a child controller to each tool invocation so individual tool calls can be
   cancelled without aborting the entire agent session.
3. Wire `timeoutMs` to the per-tool timeout config in the policy engine
   (`packages/permissions/policy-engine.ts`) so YAML rules can cap tool execution time.
4. Expose `reason` to the reflection layer (`packages/self-autonomy/reflection.ts`)
   so aborted tasks are logged with structured context rather than a bare signal.

## Example Usage
```typescript
import { TaskAbortController, withAbortController } from "../packages/tools/task-abort-controller";

// Top-level session controller with a 30s timeout
const session = new TaskAbortController({ timeoutMs: 30_000 });

// Per-tool child - aborts if session aborts OR after 5s
const toolCtrl = session.child({ timeoutMs: 5_000 });

await fetch("https://api.example.com/data", { signal: toolCtrl.signal });

toolCtrl.dispose(); // clean up after normal completion

// Or use the scoped helper
await withAbortController(async (ctrl) => {
  await runTool(ctrl.signal);
}, { timeoutMs: 10_000 });
```
