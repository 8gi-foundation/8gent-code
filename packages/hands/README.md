# @8gent/hands

macOS desktop driver for the 8gent Computer agent. Pattern adapted from
[`trycua/cua`](https://github.com/trycua/cua) (MIT) and re-implemented in
idiomatic 8gent-code style. No code is vendored from cua.

## Status

v0 macOS driver. Screenshot, click, type, press, scroll, drag, hover,
clipboard get/set, mouse position. AppKit-backed window-list and
display-list are not yet implemented and return empty results with a
clear error message; they will land with a Swift helper in a follow-up.

## Runtime dependencies

This package shells out to native macOS tools rather than binding via FFI.

| Tool | Where | Why |
|------|-------|-----|
| `screencapture` | `/usr/sbin/screencapture` (built-in) | Screenshots |
| `osascript` | `/usr/bin/osascript` (built-in) | Scroll fallback |
| `pbpaste`, `pbcopy` | `/usr/bin/{pbpaste,pbcopy}` (built-in) | Clipboard |
| `cliclick` | `/opt/homebrew/bin/cliclick` (Homebrew) | Mouse and keyboard |

### Install cliclick

```sh
brew install cliclick
```

If `cliclick` is missing, every input call returns
`{ ok: false, error: "cliclick is not installed..." }` so the agent loop
can degrade gracefully. The agent should call `driver.capabilities()` at
startup and surface a setup hint when `input: false`.

## Permissions

macOS will prompt for **Screen Recording** the first time `screencapture`
is invoked from a new parent process, and for **Accessibility** the first
time `cliclick` posts an event. Grant both for the terminal or app that
runs 8gent. These prompts are unavoidable per Apple's TCC policy.

## Usage

```ts
import { createDriver } from "@8gent/hands";

const driver = createDriver();
const caps = driver.capabilities();
if (!caps.screenshot || !caps.input) {
  console.error("hands driver missing capabilities", caps);
}

const shot = driver.screenshot({ includeBuffer: true });
if (shot.ok) {
  // shot.path is the on-disk PNG, shot.buffer is the raw bytes
}

driver.click({ x: 400, y: 300 });
driver.type({ text: "Hello, world." });
driver.scroll({ direction: "down", amount: 5 });
```

## Non-goals

- Linux and Windows drivers (v0 is macOS only; `createDriver()` returns a
  safe stub on other platforms).
- Generic browser automation. That belongs in the browser-tools package.
- Screen Recording permission prompting UX. The agent surfaces the TCC
  prompt; this package only invokes the underlying tools.

## Attribution

Patterns inspired by [`trycua/cua`](https://github.com/trycua/cua), MIT.
No code copied. If we later import any cua source, attribution will be
preserved in `LICENSE-cua` and a NOTICE block here.

## Related

- Parent PRD: [#1746](https://github.com/8gi-foundation/8gent-code/issues/1746)
- Architecture spike: PR [#1747](https://github.com/8gi-foundation/8gent-code/pull/1747)
- AppKit window/display follow-up: [#1882](https://github.com/8gi-foundation/8gent-code/issues/1882)
