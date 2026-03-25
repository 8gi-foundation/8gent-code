# Quarantine: file-watcher-v2

**Status:** Quarantine - awaiting review and wire-up
**Package:** `packages/tools/file-watcher-v2.ts`
**Branch:** `quarantine/file-watcher-v2`

---

## What

Improved file watcher built on Node/Bun native `fs.watch`. Replaces or supplements the existing `file-watcher` with:

- Recursive directory watching (opt-out, default on)
- Ignore patterns (glob-style strings converted to regex)
- Debounce window to suppress rapid duplicate events (default 100ms)
- Typed events: `change`, `add`, `unlink`
- `ready` event after paths are initialized
- `close()` for clean teardown
- Zero extra dependencies

---

## API

```ts
import { watch, Watcher } from "./packages/tools/file-watcher-v2";

// Factory (recommended)
const w = watch(["src", "packages"], { ignore: ["**/node_modules/**"], debounce: 200 });
w.on("change", (file) => console.log("changed:", file));
w.on("add",    (file) => console.log("added:",   file));
w.on("unlink", (file) => console.log("removed:", file));
w.ready(() => console.log("watching..."));

// Later
w.close();

// Class (for subclassing or manual start)
const watcher = new Watcher("src", { recursive: true });
watcher.ignore(["**/*.test.ts"]).on("change", handler).start();
```

---

## Size

- 140 lines, zero deps, single file
- Constraint: native `fs.watch` recursive support requires Node 18.11+ / Bun 1+

---

## Differences from file-watcher v1

| Feature | v1 | v2 |
|---------|----|----|
| Recursive | No | Yes (default on) |
| Ignore patterns | No | Yes (glob strings) |
| Debounce | No | Yes (100ms default) |
| Event types | `change` only | `change`, `add`, `unlink` |
| Ready event | No | Yes |
| Teardown | No close() | `close()` |
| Dependencies | - | None |

---

## Integration path

1. Review and approve in this PR
2. Wire into `packages/eight/tools.ts` as `watchFiles` tool
3. Use in the hot-reload loop for the TUI dev server
4. Deprecate v1 after v2 is confirmed stable

---

## Not doing

- No FSEvents / inotify native bindings (native `fs.watch` is sufficient)
- No chokidar parity (we don't need polling fallback)
- No glob-expansion of input paths (caller's responsibility)
