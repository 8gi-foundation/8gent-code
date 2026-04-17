# Quarantine: Log Rotation

## Status: Quarantined

Not wired into any agent loop or CLI command yet. Needs review and integration testing before promotion.

## What it does

`packages/tools/log-rotation.ts` exports `rotateLogs()` which:

1. Scans `~/.8gent/` (or a custom dir) for `.log` files
2. Rotates any file exceeding a size threshold (default 5MB)
3. Keeps the last N rotated copies (default 5)
4. Compresses rotated files at index >= 2 with gzip
5. Prunes excess rotated files beyond the keep count

## API

```ts
import { rotateLogs } from "packages/tools/log-rotation";

const result = await rotateLogs({
  logDir: "~/.8gent/",     // default
  maxSizeBytes: 5_000_000, // default 5MB
  keepCount: 5,            // default
  extension: ".log",       // default
});
// result: { scanned: number, rotated: string[], errors: string[] }
```

## Rotation scheme

For a file `agent.log` exceeding the limit:

```
agent.log        -> agent.1.log          (recent, uncompressed)
agent.1.log      -> agent.2.log.gz       (compressed)
agent.2.log.gz   -> agent.3.log.gz       (compressed)
...
agent.N.log.gz   -> deleted (if N > keepCount)
```

## Integration path

- Wire into daemon startup or session-end hook
- Add CLI command: `8gent logs rotate`
- Add to cron/interval in long-running daemon mode

## Files

- `packages/tools/log-rotation.ts` - implementation (~80 lines)
- `quarantine/log-rotation.md` - this file
