# Quarantine: log-rotation

**Package:** `packages/tools/log-rotation.ts`
**Status:** Quarantine - awaiting integration decision

## What it does

Rotates log files by size. When a log file exceeds `maxSize` bytes, it is renamed:

```
file.log     -> file.log.1
file.log.1   -> file.log.2
...
file.log.N   -> deleted (oldest, beyond maxFiles limit)
```

A fresh `file.log` is created after each rotation. Optionally, rotated files are compressed with gzip (`file.log.1.gz`).

## Exports

- `RotatingLogger` - class with `write(line)`, `forceRotate()`, `currentSize()`, `listFiles()`
- `rotateFile(path, options)` - standalone async rotate function

## Config options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxSize` | number (bytes) | 10MB | Rotate when file reaches this size |
| `maxFiles` | number | 5 | How many rotated files to keep |
| `compress` | boolean | false | Gzip rotated files |

## Usage example

```ts
import { RotatingLogger } from "./packages/tools/log-rotation";

const logger = new RotatingLogger(".8gent/eight.log", {
  maxSize: 5 * 1024 * 1024, // 5MB
  maxFiles: 3,
  compress: true,
});

await logger.write("agent loop started");
await logger.write("tool call: bash");
```

## Integration notes

- No dependencies beyond Node built-ins (fs, zlib, stream)
- Thread-safety: single-process only - `rotating` flag prevents concurrent rotations within one process
- Rotation happens before the triggering `write()` completes
- Empty log file is created after rotation so append always has a target

## Why quarantine

Not yet wired into the agent loop or any package's logging path. Needs a decision on which packages adopt it before promotion.
