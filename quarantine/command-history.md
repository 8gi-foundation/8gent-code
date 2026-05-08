# command-history

## Tool Name
`CommandHistory`

## Description
Records and searches command execution history with timestamps, results, exit codes, duration, and working directory. Supports full-text search, recent command listing, and frequency analysis. Persists to JSON at `~/.8gent/command-history.json` with configurable max size (default: 500 entries).

## Status
`quarantine` - implemented, not yet wired into the agent tool pipeline

## Location
`packages/tools/command-history.ts`

## Integration Path
1. Import `CommandHistory` in `packages/eight/tools.ts`
2. Wrap agent shell execution to call `history.record(...)` after each command
3. Expose `search`, `recent`, and `frequency` as agent-callable tools under `history.*`
4. Surface recent commands in TUI chat context for follow-up suggestions

## API

```ts
const history = new CommandHistory();

history.record({ command: "bun", args: ["run", "tui"], result: "...", exitCode: 0, durationMs: 120, cwd: "/project" });
history.search("bun run");
history.recent(20);
history.frequency(10);
```
