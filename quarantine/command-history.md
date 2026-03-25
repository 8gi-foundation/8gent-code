# command-history

## Tool Name
`CommandHistory`

## Description
Records and searches command execution history with timestamps, results, exit codes, duration, and working directory. Supports full-text search, recent command listing, and frequency analysis across all recorded commands. Persists to a JSON file at `~/.8gent/command-history.json` with a configurable max size (default: 500 entries).

## Status
`quarantine` - implemented, not yet wired into the agent tool pipeline

## Location
`packages/tools/command-history.ts`

## Integration Path
1. Import `CommandHistory` in `packages/eight/tools.ts`
2. Wrap agent shell execution (e.g. `runBash`) to call `history.record(...)` after each command
3. Expose `search`, `recent`, and `frequency` as agent-callable tools under the `history.*` namespace
4. Surface recent commands in the TUI chat context for follow-up suggestions

## API

```ts
const history = new CommandHistory(); // uses ~/.8gent/command-history.json

// Record a command after execution
history.record({ command: "bun", args: ["run", "tui"], result: "...", exitCode: 0, durationMs: 120, cwd: "/project" });

// Search by keyword
history.search("bun run");

// Last 20 commands
history.recent(20);

// Top 10 most-used commands
history.frequency(10);
```
