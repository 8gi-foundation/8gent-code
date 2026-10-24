# Daily use

## Command line

| Command | What it does |
|---|---|
| `8gent` | Open the chat interface |
| `8gent --resume` | Resume the last session |
| `8gent --continue <id>` | Resume one session |
| `8gent session list` | List recent sessions |
| `8gent export --last` | Export a session as HTML |
| `8gent run <prompt>` | One-shot run, see [Headless](headless.md) |
| `8gent review` | Review the current git diff |
| `8gent doctor` | Check models and tools |
| `8gent deck render <spec.json> [out.mp4]` | Render a slide video from a JSON spec, see [Slide videos](#slide-videos) |

## In the interface

| Command | What it does |
|---|---|
| `/help` | List the core commands; `/help all` lists every command |
| `/hotkeys` | List every keyboard shortcut |
| `/copy` | Copy the last answer to the clipboard |
| `/model [name]` | Pick the model |
| `/provider [name]` | Pick the provider |
| `/status` | Session status |
| `/plan` | Current plan |
| `/compact` | Summarize to free context |
| `/goal <goal>` | Run a goal to completion |
| `/resume` | Pick from the last 5 sessions |
| `/history` | Browse all sessions |
| `/fork [label]` | Branch the conversation |
| `/rewind [n\|list]` | Go back to a checkpoint |
| `/export` | Export as HTML |
| `/sessions share` | Make the session joinable |
| `/skills` | List skills |
| `/quit` | Exit |

Typing `/` alone shows only the core commands. Every other command still runs when you type its name, and shows up as soon as you type its first letters. Every key is listed in [Keys](keys.md), or type `/hotkeys`.

**A `/` line that is not a command.** A line that starts with `/` and matches no command is answered on the spot (`Unknown command /name. Type /help.`) and is never sent to the model. Before answering, the TUI checks the registry, the built-ins, an explicit `/skill:<name>`, the skills on disk and your prompt templates, all read when you press Enter, so a skill or template added a moment ago still works. A path such as `/Users/me/file` matches none of those and gets the same local answer. To send a path, put text in front of it or use `@` to mention a file (`apps/tui/src/lib/slash-registry.ts`, `unknownSlashAnswer`).

## Files and shell lines

**`@` file mention.** Type `@` and part of a file name. The project's files that match are listed, best match first (tracked and untracked files, not ignored ones; outside a git repository it walks the folder instead). Up and Down pick one, Tab puts `@path/to/file` into your message. A line that starts with `!` is a shell line, so `@` there is left to the shell.

**`!command`.** Runs the command in your project folder, shows the output in the chat, and sends that output to the model with your next message.

**`!!command`.** Runs the command and shows the output, but does not send it.

```text
!git status
!!ls src
```

You typed the command, so it runs like a line in your own terminal, with no approval card. Plan mode runs nothing, shell lines included. A command stops after 120 seconds, or when you press Esc. Output is cleaned of terminal control bytes and known secrets are hidden. Output from commands that read credential files or 8gent's own settings, audit files or session records is shown to you but never sent to the model. Shell lines are not saved into the session.

**`/copy`.** Puts the last answer on your clipboard. It works over SSH and in Windows Terminal, iTerm2, kitty and WezTerm, and inside tmux or screen. If your terminal ignores the clipboard sequence, select the text instead.

Sessions are saved in `~/.8gent/sessions`.

## When a turn stops on its own

8gent watches each turn for loops (`packages/eight/tool-loop-detector.ts`). One of them is a rewrite loop: the same file written again and again with `write_file`. Paths are resolved against the project folder, so `a.js`, `./a.js` and the absolute path count as one file.

- With nothing in between, the fourth write to one file gets a nudge in the tool result telling the model to run its checks or finish, and the turn stops two writes later. A write, run, fix, run cadence with checks between the writes is left alone until twice that many writes. A write with identical content to the last one is nudged at once and stops the turn once it has happened four times.
- An `edit_file` or patch of a file resets that file's count.
- When the turn stops you see: `I rewrote <path> <n> times without finishing, so I stopped to avoid a loop.`
- `EIGHT_WRITE_LOOP_MAX` sets the number of writes before the nudge (default 4). A value that is not a whole number of 2 or more is ignored and the default is used.

## Slide videos

Ask for a narrated slide video and 8gent writes a small JSON spec, then calls the `render_video_deck` tool. Code draws each slide, speaks each narration line with the local voice, holds each slide for as long as its line takes, and joins them into one mp4. No model touches the pixels, nothing goes to the network, and the same spec gives the same video.

```json
{
  "title": "Tide Library",
  "size": "1280x720",
  "slides": [
    { "title": "Tide Library", "text": "A tool-lending library", "narration": "Meet Tide Library." },
    { "kicker": "How to borrow", "title": "Get a free card", "bullets": ["Proof of address", "Three items a week"], "narration": "Get a free card at the desk." }
  ]
}
```

Each slide needs a `title`, `text`, `bullets` or `image` (a png or jpg inside the project). `seconds` sets a minimum hold (default 4); narration stretches a slide to fit its voice plus half a second either side. Up to 40 slides and 10 minutes. The result is read back from the file with ffprobe: `durationSec`, `videoSec`, `audioSec`, `width`, `height` and `slides`. A video whose size does not match the spec, or that lost its sound, is refused and never written.

The same renderer runs from the shell:

```text
8gent deck render deck.json video/brief.mp4
```

Both paths must be inside the current folder. It needs `ffmpeg` and `ffprobe` on your PATH, and a local voice (Supertonic or KittenTTS) for narration; without one, a narrated spec fails and says so rather than falling back to another voice.

## Approvals

Shift+Tab steps through the permission modes for the tab: Plan, Ask, Guarded, Infinite.

| Mode | Behaviour |
|---|---|
| Plan | Reads and plans, changes nothing |
| Ask | Shows an approval card for commands not already allowed |
| Guarded | Safe commands run, risky ones show the card |
| Infinite | Runs without asking, apart from the always-blocked list and pushes |

On a card: `y` approve, `n` deny, `e` edit, `s` skip. Allow and deny patterns live in `~/.8gent/permissions.json`. More: [permission-modes](../guides/permission-modes.md), [permissions](../guides/permissions.md).

## Reading outside the working folder

8gent reads inside the folder it was started in. A file tool asked for a path outside it, or through a link that leads outside it, refuses. A shell command that names a path outside it (`cat ../other/file`, an absolute path, `~/...`, or a quoted path in inline `python3 -c` or `node -e` code) shows a card first. With nobody to ask (headless, CI) it is refused. In every mode, Infinite included.

Allowed without a card: system folders such as /usr/bin, /bin and /opt/homebrew, /dev/null and the random devices, the temp folders (/tmp and `$TMPDIR`), and 8gent's own `~/.8gent` folder apart from keys, tokens and sessions. Git reading `~/.gitconfig` itself is fine: only paths a command names are checked, and only ones that exist.

To widen it:

| Setting | Effect |
|---|---|
| `/allow-read <dir>` or `--allow-read <dir>` | Read that folder too, this session |
| `EIGHT_WORKSPACE_ROOT=<dir>` | Use a wider folder as the root |
| `EIGHT_WORKSPACE_BOUNDARY=off` | Turn the shell check off |

This checks what a command says. Code that builds a path while it runs is not seen by it.

On macOS, `EIGHT_OS_READ_BOUNDARY=1` adds the kernel's own rule behind that check: every shell command runs under a Seatbelt profile that refuses to read files outside the working folder and the allowances above, and never reads `~/.ssh`, `~/.aws`, the other credential folders, or the private parts of `~/.8gent` (memory, browser profiles, keys, logs), however the path was built. Off by default. A path you approve on the card is opened for that one command. Git over SSH from a shell command cannot read `~/.ssh` while it is on; the built-in git tool is not affected. Linux and Termux come later.
