# Clipboard Utility

**Status:** Quarantine - awaiting review and integration testing
**Package:** `packages/tools/clipboard.ts`

## What it does

Cross-platform clipboard utility that lets any 8gent agent copy text to and read text from the system clipboard, with an in-process history ring buffer (last 10 items).

## Platform support

| Platform | Copy | Paste |
|----------|------|-------|
| macOS | `pbcopy` | `pbpaste` |
| Linux | `xclip -selection clipboard` | `xclip -selection clipboard -o` |
| Windows | PowerShell `Set-Clipboard` | PowerShell `Get-Clipboard` |

## API

```ts
import { copy, paste, history } from "@8gent/tools/clipboard";

await copy("hello world");       // writes to system clipboard
const text = await paste();      // reads from system clipboard
const items = history(5);        // last 5 copied items (in-process only)
```

## Limitations

- History is in-process only - resets when the process exits.
- Linux requires `xclip` installed (`apt install xclip`).
- No Wayland support yet (wl-copy/wl-paste) - xclip works under XWayland.

## Graduation criteria

- [ ] Integration test on macOS
- [ ] Integration test on Linux (CI)
- [ ] Wire into `packages/tools/index.ts` exports
- [ ] Add as an agent tool definition in `packages/eight/tools.ts`
