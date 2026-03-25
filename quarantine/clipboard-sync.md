# Quarantine: clipboard-sync

**Package:** `packages/tools/clipboard-sync.ts`
**Status:** Quarantine - awaiting integration review

## What it does

Cross-process clipboard synchronization backed by a shared JSON file in the OS temp directory. File-based locking prevents concurrent write collisions between agent processes.

## API

```ts
import { ClipboardSync } from "./packages/tools/clipboard-sync";

const cb = new ClipboardSync();

cb.copy("hello world");   // write to shared clipboard
cb.paste();               // read current value
cb.history(5);            // last 5 entries (most recent last)
cb.clear();               // wipe clipboard + history

const unsub = cb.watch((text) => {
  console.log("clipboard changed:", text);
});
unsub(); // stop watching
```

## Design decisions

- **Shared file:** `$TMPDIR/8gent-clipboard.json` - readable by all processes on the same machine
- **Lock file:** `$TMPDIR/8gent-clipboard.lock` - spin lock with 2s timeout, keyed by PID
- **History cap:** 100 entries (oldest trimmed first)
- **Watch interval:** 300ms polling via `fs.watchFile`
- **No native clipboard dependency** - avoids pbcopy/xclip platform fragmentation

## Use cases in 8gent

- Share context between parallel worktree agents without socket setup
- Pass file paths or snippets between TUI and sub-agents
- Debugger can read clipboard history for session diagnostics

## Known limitations

- Spin lock blocks the event loop briefly per cycle - fine for short critical sections
- watchFile polling has ~300ms latency between write and callback
- Not suitable for binary data or payloads over ~1MB

## Integration path

1. Wire into packages/eight/tools.ts as optional tool (clipboard_copy, clipboard_paste)
2. Expose in CLUI via clipboard panel in the debugger
3. Consider replacing spin lock with flock via child_process for production hardening
