# post_message (#3595)

Posts text or a voice note to Telegram through `~/.8gent/bin/tg-group` / `say-telegram`, or, for text, straight to the Bot API with a key from an env file the person names (see Direct send). Offered where `tg-group` is installed or a bot env file is configured.

## Who it can post to

A chat is postable only if BOTH hold:

1. It is in `postMessage.allowedChats` in `~/.8gent/settings.json` (empty by default: nothing posts). The list is read once at process start; edits during a session are ignored.
2. A person approved it on a card in THIS process. The approval lives in memory only; nothing on disk can authorise a post. Every launch starts with none approved, so an edited settings file posts nothing until a person approves the chat again.

Infinite mode has no person, so it can post only to chats a person approved earlier in the same process; otherwise it is refused.

Outside Infinite mode each post also shows a full-text approval card. Ten posts per session (attempts count); each sent post is logged to `~/.8gent/post-message.log` (chat, length, time; never the text or a token).

## What keeps an agent from granting itself a recipient

- Agent file tools: `~/.8gent/settings.json` is path-guard protected (`~` expanded, realpath compared).
- Agent shell: a name-based refusal for commands naming the settings file. A shell can still write it by an obfuscated path; the process-start snapshot plus the per-process approval above mean that edit cannot authorise a post. An OS-level write deny is a separate change (#3612).

## Direct send with a bot env file (#3838)

For a machine without `tg-group`, name the env file that holds the bot key:

```json
{
  "postMessage": {
    "allowedChats": ["-1004417730052"],
    "botEnvFile": "~/.config/tg-notify/bot.env",
    "botTokenVar": "TELEGRAM_BOT_TOKEN"
  }
}
```

- `botEnvFile` must be absolute or start with `~/`. `botTokenVar` is the variable inside it (default `TELEGRAM_BOT_TOKEN`; `export` and quotes are fine). Both are read once at process start, like `allowedChats`.
- Text posts then go to `https://api.telegram.org/bot<key>/sendMessage` with `fetch`. The key is read from the file at send time inside the process. It is never on a command line, in the tool arguments or result, in the model's context, or in a log.
- Text that contains the key, or anything shaped like a bot token, is refused before the card. Error text has the key redacted. Redirects are not followed.
- The `network_request` policy gate judges the base URL the post will call. Only the process environment `EIGHT_TG_API_BASE` changes that base (used for local stubs); it is not a settings key, so nothing written during a session can move the key to another host.
- Allowlist, recipient approval, the full-text card, the session limit and the send log work exactly as above.
- Voice notes still need `say-telegram`.

## text_file

`text_file` is a path inside the project whose contents are the message, read without a shell (no `$(cat ...)`). It is used when `text` is empty, must stay inside the working directory (path-guard applies), and is capped at 64 KB before the 4096-character message cap.
