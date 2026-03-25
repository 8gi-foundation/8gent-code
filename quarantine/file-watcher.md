# Quarantine: File Watcher

## Status: Quarantined

Not wired into any agent loop or CLI command yet. Needs review and integration testing before promotion.

## What it does

`packages/tools/file-watcher.ts` exports `FileWatcher` which:

1. Watches a file or directory path using Node/Bun built-in `fs.watch`
2. Filters events by glob patterns matched against the filename (supports `*` and `?`)
3. Debounces rapid events within a configurable window (default 100ms)
4. Distinguishes `add`, `unlink`, `change`, and `rename` event types
5. Emits typed events via `EventEmitter` - no external dependencies

## API

```ts
import { FileWatcher } from "packages/tools/file-watcher";

const watcher = new FileWatcher({
  patterns: ["*.ts", "*.json"], // default: ["*"]
  debounceMs: 150,              // default: 100ms
  recursive: true,              // default: true
});

watcher.on("add",    (e) => console.log("added",   e.filePath));
watcher.on("change", (e) => console.log("changed", e.filePath));
watcher.on("unlink", (e) => console.log("removed", e.filePath));
watcher.on("rename", (e) => console.log("renamed", e.filePath));
watcher.on("error",  (err) => console.error(err));

watcher.watch("./src");
// later...
watcher.stop();
```

## Event shape

```ts
interface FileEvent {
  type: "change" | "rename" | "add" | "unlink";
  filePath: string;  // absolute path
  timestamp: number; // Date.now()
}
```

## Integration path

- Wire into `packages/tools/index.ts` exports
- Use in agent hot-reload: re-run tool on source file change
- Use in `packages/self-autonomy/` to trigger reflection on session file writes
- Potential TUI integration: live file tree with change indicators
- Could power a `watch` sub-command: `8gent watch ./src --on-change "bun test"`

## Notes

- Uses `fs.watch` - OS-level quirks on macOS (FSEvents) vs Linux (inotify)
- Recursive watching on Linux requires kernel 5.x+; falls back gracefully
- Glob matching is filename-only (not full path) - sufficient for most agent use cases
- No chokidar dependency - self-contained and lightweight
