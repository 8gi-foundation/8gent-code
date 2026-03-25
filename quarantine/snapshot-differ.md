# snapshot-differ

## Description

Deep-compares two object snapshots and reports state changes between agent turns. Walks nested objects and arrays recursively, classifying each difference as added, removed, or changed. Returns structured `DiffEntry[]` and a human-readable summary string suitable for logging or displaying in the TUI.

## Status

**quarantine** - self-contained utility, not yet wired into the agent loop or any UI.

## Location

`packages/tools/snapshot-differ.ts`

## API

```ts
import { diffSnapshots } from "./packages/tools/snapshot-differ.ts";

const diff = diffSnapshots(beforeState, afterState);
console.log(diff.summary);  // human-readable
diff.entries;               // structured DiffEntry[]
```

## Integration Path

1. Import `diffSnapshots` in `packages/eight/agent.ts`
2. Capture state snapshot before and after each tool call in the agent loop
3. Attach `diff.entries` to the turn record for memory/reflection
4. Optionally surface changed paths in the TUI activity feed (see `project_activity_monitor_ux.md`)
