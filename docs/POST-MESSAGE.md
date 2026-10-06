# post_message (#3595)

Posts text or a voice note to Telegram through `~/.8gent/bin/tg-group` / `say-telegram`. Offered only where `tg-group` is installed.

## Who it can post to

- `postMessage.allowedChats` in `~/.8gent/settings.json`. Empty by default: nothing posts. Enforced in every mode.
- Read once at process start. Edits made during a session are ignored.
- A chat added since a person last confirmed it is unconfirmed: refused in Infinite mode; otherwise one card per process lists the unconfirmed chats. Confirmed chats are kept in `~/.8gent/post-message-confirmed.json`.
- Outside Infinite mode every post also shows a full-text approval card. Ten posts per session; every sent post is logged to `~/.8gent/post-message.log` (chat, length, time).

## What stops an agent granting itself a recipient

1. Agent file tools: `~/.8gent/settings.json` and `post-message-confirmed.json` are path-guard protected (`~` expanded, realpath compared).
2. Agent shell (`run_command`, both the ToolExecutor and native paths): a name-based refusal, and a macOS Seatbelt profile (`wrapShellCommand`, packages/permissions/seatbelt.ts) that denies writes to both files and unlink of `~/.8gent`, whatever the spelling.
3. The Seatbelt layer is skipped, and next-launch confirmation then relies on System One and the name-based refusal alone, when: not macOS; `EIGHT_SEATBELT=0`; or the host already sandboxes the process (sandbox-exec cannot nest).
