# Quarantine: fs-utils

**Status:** Quarantine - not yet wired into the main agent loop.

**File:** `packages/tools/fs-utils.ts`

## What it does

Simplified filesystem operations that wrap Node's `fs/promises` API with sensible defaults, parent-directory creation, and cross-device move support.

## Exported functions

| Function | Signature | Description |
|----------|-----------|-------------|
| `ensureDir` | `(path: string) => Promise<void>` | Creates directory and all parents if missing. |
| `ensureFile` | `(path: string) => Promise<void>` | Creates file (and parents) if missing. No-op if it exists. |
| `readJSON` | `<T>(path: string) => Promise<T>` | Reads and parses a JSON file. |
| `writeJSON` | `(path: string, data: unknown, indent?: number) => Promise<void>` | Serialises data as JSON and writes to file. |
| `copyDir` | `(src: string, dest: string) => Promise<void>` | Recursively copies a directory. |
| `moveFile` | `(src: string, dest: string) => Promise<void>` | Moves a file; falls back to copy+delete across devices. |
| `tempFile` | `(prefix?: string) => Promise<string>` | Creates a temp file, returns path. |
| `tempDir` | `(prefix?: string) => Promise<string>` | Creates a temp directory, returns path. |
| `fileSize` | `(path: string) => Promise<number>` | Returns file size in bytes. |
| `dirSize` | `(path: string) => Promise<number>` | Returns total recursive directory size in bytes. |

## Usage

```ts
import { ensureDir, readJSON, writeJSON, tempDir } from "../packages/tools/fs-utils";

await ensureDir(".8gent/sessions");
await writeJSON(".8gent/sessions/ctx.json", { model: "qwen" });
const ctx = await readJSON(".8gent/sessions/ctx.json");

const tmp = await tempDir("eight-test-");
console.log(tmp); // /tmp/eight-test-abc123
```

## Integration candidates

- `packages/eight/agent.ts` - checkpoint save/restore via `writeJSON`/`readJSON`
- `packages/memory/store.ts` - ensureDir for DB path setup
- `packages/kernel/training.ts` - tempDir for training data staging
- `packages/validation/` - fileSize checks before diffing

## Notes

- No external dependencies. Uses only Node built-ins.
- `tempFile` and `tempDir` do not auto-clean - callers own cleanup.
- `dirSize` is recursive and parallel; large trees may be slow on spinning disks.
- Default JSON indent is 2 spaces, configurable per call.
