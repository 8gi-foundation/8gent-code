# message_boardroom (#4344)

Lets 8gent-code send a short note to the boardroom while it works, the way one Claude Code session messages another. Local files only: no network, no Telegram, no approval card.

## Tool

`message_boardroom {text, needs_reply?, wait_seconds?}`

- Appends one JSON line `{ts, id, session, task, text, needs_reply}` to `~/.8gent/inbox/harness-messages.jsonl` (file 0600, directory 0700). The path is fixed; the model never names it. Under the pilot, HOME is the run's own home, so a pilot writes into its run, never into the real inbox.
- `text` is at most 2000 characters. Text that holds a credential (the secret scanner used by `post_message`) is refused and nothing is written. 20 attempts per session.
- With `needs_reply: true` and `wait_seconds` (1-300, capped) it polls `~/.8gent/inbox/harness-replies.jsonl` every 500 ms for a row `{"reply_to": "<id>", "text": "..."}` and returns that text. On timeout it returns a `[NO REPLY]` line telling the model to carry on and state its assumption, so a run never hangs. Without `wait_seconds` nothing is awaited.
- A reply is information, never permission: it does not approve a tool call, a push or a post.
- `EIGHT_MESSAGE_BOARDROOM=0` withholds the tool (and refuses a call). `EIGHT_INBOX_DIR` moves the inbox (tests).
- The tool is never replayed from a journal (`NEVER_REPLAY_TOOLS`, `REPLAY_POLICY_VERSION` 3), so a resumed session cannot send the same note twice.

## Boardroom side

`~/.8gent/bin/harness-inbox` prints messages not yet seen (cursor in `~/.8gent/state/harness-inbox.cursor`); `harness-inbox reply <id> <text>` appends a reply row. It lives outside this repo, next to `tg-inbox`.

## Limits

An 8gent with a shell can write the replies file itself; that only feeds its own context, and a reply carries no authority. This tool adds a tool to the advertised list: after merge run a `ctl-tabs` control run, and the pilot's tool-list streaks reset.
