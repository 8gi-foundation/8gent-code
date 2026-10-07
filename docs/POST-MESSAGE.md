# post_message (#3595)

Posts text or a voice note to Telegram through `~/.8gent/bin/tg-group` / `say-telegram`. Offered only where `tg-group` is installed.

## Who it can post to

A chat is postable only if BOTH hold:

1. It is in `postMessage.allowedChats` in `~/.8gent/settings.json` (empty by default: nothing posts). The list is read once at process start; edits during a session are ignored.
2. A person approved it on a card in THIS process. The approval lives in memory only; nothing on disk can authorise a post. Every launch starts with none approved, so an edited settings file posts nothing until a person approves the chat again.

Infinite mode has no person, so it can post only to chats a person approved earlier in the same process; otherwise it is refused.

Outside Infinite mode each post also shows a full-text approval card. Ten posts per session (attempts count); each sent post is logged to `~/.8gent/post-message.log` (chat, length, time; never the text or a token).

## What keeps an agent from granting itself a recipient

- Agent file tools: `~/.8gent/settings.json` is path-guard protected (`~` expanded, realpath compared).
- Agent shell: a name-based refusal for commands naming the settings file. A shell can still write it by an obfuscated path; the process-start snapshot plus the per-process approval above mean that edit cannot authorise a post. An OS-level write deny is a separate change (#3612).
