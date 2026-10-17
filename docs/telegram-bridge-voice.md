# Telegram bridge: voice notes and mode cards

The operator's own private chat with @eightgentcodebot takes voice notes. Each one is transcribed on this machine, the full reply arrives as text, and a short spoken version of it arrives as a voice note. `/mode` shows cards for switching how the bot works. `/help` in the bot shows the same transit statement below.

## What voice notes do and do not do

Speech-to-text runs locally on the operator's machine (ffmpeg plus whisper-cli, no cloud STT). Audio from the Telegram path reaches the machine through Telegram's servers: a voice note the operator sends is stored and relayed by Telegram, and our spoken reply travels back the same way. Bot chats are not end-to-end encrypted. That transit is the channel the operator chose, it is not our transcription, and it applies only to the operator's own private chat. Listen-mode notes, when built, are never captured from the Telegram path. No audio or transcript is sent to any rented model API.

## Rules the code keeps

- Mode commands and cards work only in the operator's own private chat, from an id named in TELEGRAM_OPERATOR_USER_IDS. An empty list turns them off.
- A forwarded note, a note from anyone else, and a note in a group are never a mode signal.
- Voice never raises the mode. A raise is a `/mode` card tap.
- Cards are single use, expire, and carry an opaque token.
- The "Heard" echo goes to the chat the note came from, and only when that chat is private.
- Voice notes are refused (not transcribed, not passed to the model) when DEFAULT_RUNTIME names a non-local runtime, so the statement above stays true.
- A spoken reply is used only for the chat whose voice note asked for it.

## Voice notes in a group (off by default)

One narrow variant, ruled by 8SO on 17 Oct 2026 (conditions C-G1 to C-G17). It is a separate path from the private chat above. The group never gets "Heard", cards, buttons, modes or the judge.

What the room is told, verbatim. The bridge posts this into each enabled group once, records it by hash in `~/.8gent/telegram-voice.json`, and shows it in `/help` inside the group:

In this group, voice notes from the operator that reply to this bot are transcribed on the operator's machine (ffmpeg plus whisper-cli, no cloud STT). Everything posted in this group, including those voice notes and our spoken replies, is visible to every member and is stored and relayed by Telegram. Group chats are not end-to-end encrypted. Voice notes from anyone else are ignored: they are not downloaded or transcribed. The transcript is never posted here. No audio or transcript is sent to any rented model API.

### Turn it on

Set `TELEGRAM_FLOW_VOICE_GROUP_IDS` in the bot's environment to a comma list of group chat ids. The default is empty, which means off. The value is never in code. For the 8GI group, James sets:

```
TELEGRAM_FLOW_VOICE_GROUP_IDS=-1003845259821
```

The bridge's environment is exported in `~/.8gent/scripts/start-eightgent-bridge.sh`, which `~/Library/LaunchAgents/com.8gent.eightgent-bridge.plist` runs (the plist itself holds only PATH and HOME; `~/.8gent/secrets/eightgent.env` holds only the bot token). Add the line there, next to TELEGRAM_AUTHORIZED_CHAT_IDS, then restart with:

```
~/.8gent/bin/svc restart eightgent
```

It prints OK or FAIL. The chat must also be on `TELEGRAM_AUTHORIZED_CHAT_IDS`; the two lists are independent and adding a chat to one never turns on the other. If the notice cannot be posted, voice stays off in that chat. A supergroup migration changes the chat id and fails closed until the list is edited.

Spoken replies in the group follow the `/voice` toggle: `/voice off` silences them, `/voice on` allows one spoken reply per admitted note.

### Rules the code keeps

- Only user 5486040131 (and only if also in TELEGRAM_OPERATOR_USER_IDS). Anyone else, anonymous-admin posts and channel posts are dropped before getFile, with no reply and no refusal. A drop is recorded as sender id, chat id and duration only.
- The note must be a reply to one of the bot's own messages. An unaddressed note is ignored: the bot never transcribes a room.
- `message.voice` only, at most 60 s and 1 MB, checked before getFile. Audio files, forwarded, via-bot, automatic-forward and external-reply notes are dropped.
- The transcript is never posted. It reaches 8gent as plain prompt text; a transcript starting with "/" is never parsed as a command.
- The reply, any status line and the spoken note go to the group and forum topic the note came from, bound per turn. The binding ends on the turn's terminal event.
- The spoken note is written from the reply text already posted in the group, nothing else. Inside a forum topic it is spoken only if the TTS bridge (`kittentts-telegram`) declares a `--thread` option; otherwise the text lands and the note is skipped, because a note in General would leak the topic.
- One group voice turn at a time. A second note while one is in flight gets a fixed "still working" line.
- One log row per admitted turn: time, chat, topic, sender, duration, outcome. No text, no file id.
- Never add a group containing children to the list without a COPPA review. Opening this to a second person is a new 8SO review.
