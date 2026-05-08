# Quarantine: notification dispatcher

**Status:** Under review - not yet wired into core agent loop.

## What this is

`packages/tools/notification.ts` - cross-platform notification dispatcher.

Exports a single `notify()` function. Auto-detects platform at runtime. No
external dependencies beyond the built-in `fetch` and Node `child_process`.

## Channels

| Channel    | Platform   | Mechanism                        | Required env vars |
|------------|------------|----------------------------------|-------------------|
| `native`   | macOS      | `osascript display notification` | none              |
| `native`   | Linux      | `notify-send`                    | none (notify-send must be installed) |
| `terminal` | all        | BEL character `\x07` via stdout  | none              |
| `telegram` | all        | Telegram Bot API via `fetch`     | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` |

## Usage

```ts
import { notify } from "../packages/tools/notification";

// Minimal - native + terminal bell (defaults)
await notify({ message: "Build complete" });

// All channels
await notify({
  title: "8gent",
  subtitle: "Benchmark run",
  message: "Score: 87/100",
  channels: ["native", "terminal", "telegram"],
});

// Telegram only, with inline credentials
await notify({
  message: "Deploy finished",
  channels: ["telegram"],
  telegramToken: "...",
  telegramChatId: "...",
});
```

## Return value

Array of `NotifyResult`:
```ts
{ channel: "native" | "terminal" | "telegram"; ok: boolean; error?: string }
```

## Why quarantine

- Not wired into any existing flow yet.
- Telegram credentials come from env vars - confirm before enabling in CI.
- Native notification permission may prompt on macOS Ventura+ on first use.

## Integration points (when ready)

- `packages/eight/agent.ts` - fire after long-running task completes
- `packages/self-autonomy/reflection.ts` - alert after post-session reflection
- Benchmark harness - alert when autoresearch loop finishes overnight
