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
- Voice notes are refused (not transcribed, not sent to the agent) when DEFAULT_RUNTIME names a non-local runtime, so the statement above stays true.
- A spoken reply is used only for the chat whose voice note asked for it.
