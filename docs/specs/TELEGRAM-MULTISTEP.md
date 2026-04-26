# Telegram Multi-Step Tasks

Status: shipped (issue #1906, #1913)
Owner: 8gent-code Telegram surface
Bot: [@eaborobot](https://t.me/eaborobot)

## Goal

Bring the Telegram surface to parity with Claude Dispatch on multi-step task
work: one anchor message per task that streams progress as the agent runs,
inline keyboards for cancel / retry, automatic file delivery for screenshots
and code, and per-chat session continuity that survives bot restarts.

## Modules

| File | Role |
|------|------|
| `packages/telegram-bot/task-runner.ts` | Pure task lifecycle. Owns the anchor message id and state transitions (planning -> running -> succeeded / failed / cancelled). |
| `packages/telegram-bot/mobile-formatter.ts` | Pure formatting. Tool-call summarization, mobile truncation, code-fence-safe chunking, file-path detection. |
| `packages/telegram-bot/file-sender.ts` | Telegram `sendDocument` / `sendPhoto` wrapper with size limits and Buffer/disk inputs. |
| `packages/telegram-bot/keyboards.ts` | Inline keyboards (running, complete, failed, approval, confirm) with safe `callback_data` encoding. |
| `packages/telegram-bot/session-store.ts` | Per-chat session memory. Optional disk persistence at `~/.8gent/telegram-sessions.json`. |
| `packages/telegram-bot/daemon-client.ts` | WebSocket client for `packages/daemon/gateway`. Auth, session create/resume, event subscriptions, ping, reconnect. |
| `packages/telegram-bot/bridge-adapter.ts` | The glue. Translates daemon events into TaskRunner state changes. |
| `packages/daemon/telegram-bridge.ts` | Production bridge - wires the adapter into the long-poll loop. |

## Lifecycle (multi-step path)

```
user: "Read auth.ts, edit it, run tests, commit, push"

bot (anchor message_id=101):
  *Planning*
  Read auth.ts, edit it, run tests, commit, push
  _0s elapsed_
  [Cancel]

  -> tool:start  read_file -> addStep + markActive
  -> tool:result read_file -> markDone "ok (50ms)"
  -> tool:start  edit_file -> ...
  ...

bot (edit message_id=101):
  *Working...*
  Read auth.ts, edit it, run tests, commit, push

  ✓ 📄 Reading .../auth.ts - ok (50ms)
  ✓ ✏️ Editing .../auth.ts - patched (120ms)
  ⠹ ⚡ Running npm test
  ○ 📦 Git commit
  ○ 📦 Git push
  _12s elapsed_
  [Cancel]

  -> agent:stream {final: true, chunk: "All five steps complete."}

bot (final edit on message_id=101):
  *Done*
  Read auth.ts, edit it, run tests, commit, push

  ✓ Reading .../auth.ts ...
  ✓ Editing .../auth.ts ...
  ✓ Running npm test - 18 passed
  ✓ Git commit - 1 file changed
  ✓ Git push - main -> origin/main

  All five steps complete.
  _done in 47.3s_
  [▶ Continue]  [🆕 New task]
```

If agent text references file paths (e.g. `/tmp/diagram.png`), they are
auto-attached and delivered as separate Telegram documents/photos after the
final summary.

## Adapter event wiring

```
DaemonEvent              -> TaskRunner action
─────────────────────────────────────────────
tool:start               -> addStep + markStepActive
tool:result              -> markStepDone (with summary + duration)
agent:stream {final:t}   -> complete (final summary + send queued files)
agent:error              -> fail (renders retry keyboard)
session:end              -> no-op (daemon evicted; recreates lazily)
```

Steps are matched to results by tool-name FIFO stack (one queue per tool).
This is robust against interleaved tool calls because the daemon emits
results in start order per tool.

## Backwards compatibility

- Multi-step is on by default. Set `EIGHT_TG_LEGACY=1` to disable.
- Legacy `agentBusy` retry path (4 strategies, simpler-prompt fallbacks)
  remains intact and is selected automatically if the multi-step adapter
  fails to attach at startup.
- Approval prompts still go through the existing `pendingApprovals` map -
  the multi-step adapter does not own them.
- `/cancel` is new. `/unstick` resets both legacy and multi-step state.

## Deployment (Hetzner)

The bridge runs alongside the Eight daemon on Hetzner host
`78.47.98.218`. Secrets live in `/etc/8gent/daemon.env`:

```
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
DAEMON_URL=ws://localhost:18789
DAEMON_AUTH_TOKEN=...
EIGHT_TG_SESSIONS=/var/lib/8gent/telegram-sessions.json
# Set to 1 only to roll back the multi-step rollout.
# EIGHT_TG_LEGACY=1
```

systemd unit example:

```
[Unit]
Description=8gent Telegram bridge
After=eight-daemon.service network-online.target
Wants=eight-daemon.service network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/8gent/daemon.env
WorkingDirectory=/opt/8gent
ExecStart=/usr/local/bin/bun run packages/daemon/telegram-bridge.ts
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

## Testing

```
bun test packages/telegram-bot/
```

Six test files, 38 cases. Notable:

- `bridge-adapter.test.ts` simulates a 5-step plan end-to-end with a fake
  WebSocket and a fetch stub - asserts a single anchor message is edited
  through to the final summary.
- `task-runner.test.ts` exercises lifecycle transitions, attachment
  delivery, and renderer output.
- `daemon-client.test.ts` swaps the WebSocket via `socketFactory` and
  verifies session creation + event dispatch.

No live Telegram or daemon I/O happens during tests.
