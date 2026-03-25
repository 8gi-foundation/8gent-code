# quarantine: key-value-store

**Status:** quarantine - review before wiring into agent loop

## What it does

`KVStore<V>` is a persistent key-value store backed by a JSON file on disk.
All writes are atomic via a temp-file + rename pattern, so a crash mid-write
will never corrupt the store. Reads load eagerly at construction time and
subsequent gets are in-memory fast.

## API

```ts
import { KVStore } from "../packages/tools/key-value-store.ts";

const store = new KVStore(".8gent/my-store.json");

store.set("model", "qwen3");
store.setMany({ theme: "dark", version: 2 });

store.get("model");              // "qwen3"
store.get("missing", "default"); // "default"
store.has("model");              // true

store.keys();    // ["model", "theme", "version"]
store.values();  // ["qwen3", "dark", 2]
store.entries(); // [["model", "qwen3"], ...]
store.size;      // 3

store.delete("model");
store.deleteMany(["theme", "version"]);
store.clear();
store.reload();
```

## Features

- Generic `V extends JSONValue` - type-safe for any JSON-serializable value
- Atomic writes via temp-file + `renameSync` (POSIX atomic on same filesystem)
- Auto-creates parent directories on first write
- Batch API (`setMany`, `deleteMany`) for single-write bulk mutations
- Corrupted/missing file starts fresh rather than crashing
- `toJSON()` returns a plain object snapshot

## Constraints

- Values must be JSON-serializable (no `undefined`, `Date`, `Map`, `Set`, etc.)
- One file per store instance - no namespacing within a file
- Not safe for concurrent writes from multiple processes (no file lock)

## Files

- `packages/tools/key-value-store.ts` - implementation (~90 lines)

## Not doing

- No file locking (use `packages/tools/file-lock.ts` externally if needed)
- No TTL / expiry
- No schema validation
- No encryption
