# @8gent/hands

macOS desktop driver for the **8gent Computer** agent. Real, working
screenshot + click + type + scroll + drag against the live display.

Pattern adapted from [`trycua/cua`](https://github.com/trycua/cua) (MIT) -
concept only, not a code fork. Roughly 450 lines of TypeScript, no native
modules, no Swift bridge.

## Status

Driver online (#1908). Used by `packages/computer/bridge.ts` which is the
single place every consumer goes through (NemoClaw policy gate first).

## Backends

| Capability      | Primary                | Fallback                    |
|-----------------|------------------------|-----------------------------|
| screenshot      | `screencapture` (built-in) | -                       |
| click           | `cliclick`             | `osascript` (left only)     |
| type            | `cliclick`             | `osascript` keystroke       |
| press combo     | `cliclick`             | `osascript` key code        |
| scroll          | `osascript` arrow keys | -                           |
| drag            | `cliclick`             | error (install cliclick)    |
| hover           | `cliclick`             | error (install cliclick)    |
| clipboard       | `pbpaste` / `pbcopy`   | -                           |
| window list     | `osascript`            | -                           |

If `cliclick` is missing the driver continues to work for screenshot, type,
press, scroll, and clipboard. Drag and hover return a clean error string.
Install with `brew install cliclick` to unlock the full surface.

## TCC permissions

`screencapture` requires Screen Recording entitlement. `cliclick` and
`osascript` keystroke / mouse events require Accessibility. The first call
will prompt the user; if denied the driver returns `{ ok: false, error }`
instead of crashing the agent loop.

Security review: #1748 (Karen).

## Public API

```ts
import { getDriver } from "@8gent/hands";

const d = getDriver();
const shot = d.screenshot();             // -> { ok, path, buffer, width, height }
d.click({ x: 100, y: 200 });
d.type("hello world");
d.press("cmd+s");
d.scroll("down", 5);
d.drag({ x: 0, y: 0 }, { x: 100, y: 100 });
```

The `HandsDriver` interface is the contract `packages/computer/bridge.ts`
talks to. Swap implementations (Linux, Windows, daemon-over-socket) by
exporting a different `getDriver()` later.

## Non-goals (this PR)

- Linux / Windows support.
- Native wheel events (current `scroll` uses arrow keys; tracked as a
  follow-up - real CGEventCreateScrollWheelEvent needs a tiny ObjC helper).
- TCC entitlement setup automation - manual one-time prompt for now.
- Generic browser automation (lives elsewhere).
