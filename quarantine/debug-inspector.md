# debug-inspector

## Tool Name
`debug-inspector`

## Description
Runtime value inspector with pretty-printed type information. Recursively formats any JavaScript/TypeScript value - primitives, arrays, objects, Maps, Sets, Dates, Errors, and functions - with ANSI color coding, configurable depth, string truncation, and per-type labels. Also provides a structural diff utility for comparing two values and highlighting added, removed, and changed keys.

## Status
**quarantine** - standalone, not yet wired into the agent tool registry.

## Exports
- `inspect(value, depth?, indent?)` - pretty-prints a value with ANSI colors and type labels; depth controls recursive expansion (default 2); truncates long strings and large collections
- `inspectType(value)` - returns a compact colored type string (e.g. `string[42]`, `int(7)`, `Array[3]`) without full expansion
- `inspectDiff(a, b, path?)` - compares two values structurally and returns a colored diff summary showing added (+), removed (-), and changed (~) keys with before/after values

## Integration Path
1. Register in `packages/eight/tools.ts` as a dev/debug tool under the `debugging` category.
2. Wire a `/inspect` slash command in the TUI command palette to call `inspect()` on the last tool result or a named variable.
3. Surface `inspectDiff()` in the post-session reflection flow (`packages/self-autonomy/reflection.ts`) to compare session state snapshots and detect unexpected mutations.
4. Optionally expose via the daemon WebSocket API so CLUI clients can request structured value previews for any in-flight agent variable.
