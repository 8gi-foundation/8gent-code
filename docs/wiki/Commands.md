# Commands

Two kinds of commands: shell subcommands you type after `8gent`, and slash commands you type inside the TUI. See [Permission Modes](Permission-Modes) for what `/mode` switches between.

## Shell subcommands

Source: `bin/8gent.ts` (dispatcher), `bin/8gent-run.js` (launcher), and the known-name list in `packages/eight/subcommand-match.ts`. The first word is matched case-insensitively. A near-miss typo gets a suggestion. Run `8gent --help` for the full text.

With no arguments, `8gent` opens the TUI.

### Start and run

- `8gent tui [--name=<n>] [--resume=<n>]` - open the TUI, optionally naming the session or restoring one.
- `8gent run <prompt>` - one-shot run. `--output-format stream-json` prints one JSON event per line. `--image <path>` attaches one png, jpg, gif or webp image.
- `8gent chat <message>` - send a message non-interactively (pipe-friendly; `--stdin` reads the message from stdin).
- `8gent infinite <task>` - run a task in autonomous infinite mode.
- `8gent pipeline <task>` - adaptive three-model build pipeline using local models.
- `8gent pet` - start the optional Lil Eight dock companion (off unless you run this).
- `8gent review` - review the current git diff. `--pr <number>` reviews a specific PR diff.
- `8gent demo` - source checkout only.
- `8gent benchmark` - source checkout only.

### Sessions, memory and preferences

- `8gent session list [--limit=N]` - list recent sessions.
- `8gent session resume <name-or-id>` - resume a session.
- `8gent session checkpoint` - save a checkpoint.
- `8gent session compact` - compress session history.
- `8gent export <session-id|--last>` - export a session as self-contained HTML.
- `8gent memory recall <query>` - search memory.
- `8gent memory remember <fact>` - store a memory.
- `8gent memory forget <id>` - delete a memory.
- `8gent memory stats` - memory statistics.
- `8gent memory serve` - serve memory read-only over stdio for other tools.
- `8gent preferences get` - show all preferences.
- `8gent preferences set <key> <val>` - set a preference.
- `8gent preferences sync` - sync with the cloud (needs auth).
- `8gent preferences reset` - reset to defaults.
- `8gent me import <dir>` - copy a memory folder into `~/.8gent/me/`.
- `8gent onboard` - run onboarding (auto-detect and configure).
- `8gent passport export | import | show | delete` - your skills and plugs in one file you hold. Local only; keys are left out.

### Assistants and scheduling

- `8gent agent list | spawn <persona> <task> | kill <id> | message <id> <msg> | auto [on|off] | status` - manage child assistants.
- `8gent cron list | add <name> <schedule> <command> | remove <id> | enable <id> | disable <id>` - scheduled jobs.
- `8gent scout add | list | run | enable | disable | remove` - scheduled scout routines. Adding or enabling asks once, and the default answer is no.
- `8gent prepared` - list, pass, approve, reject and mark landed or blocked the work prepared while idle.
- `8gent blueprint` - trial; needs `EIGHT_BLUEPRINTS=1`. Lists blueprints and saves a routine from one.
- `8gent selfimprove` - one self-improvement round on a vessel cell; refuses outside a cell.
- `8gent daemon run | install | uninstall | start | stop | status` - the always-on daemon (login service on macOS, Linux and Windows).

### Setup, health and keys

- `8gent init` - initialize 8gent in the current directory.
- `8gent doctor` - check system health (local runtimes, models, tools, config).
- `8gent status` - show full system status.
- `8gent auth login | logout | status` - authentication. Also `whoami`.
- `8gent keys set <provider>` - save an API key from a hidden prompt.
- `8gent keys [reload|status|open]` - open `~/.8gent/keys.env`, re-read it, or list which provider keys are present (no values shown). Alias: `8gent env`.
- `8gent update [--check]` - update through the channel 8gent was installed from; never installs a lower version. Alias: `8gent upgrade`.
- `8gent permissions [--open]` - diagnose macOS Accessibility and Screen Recording grants. Alias: `8gent perms`.
- `8gent model-pin [model]` - accept the current digest and quantisation of a pinned local model.
- `8gent stack` - show what the next turn would send, per source (no network, no model call).
- `8gent bug "<description>"` - save one secret-free bug report folder locally; uploads nothing.
- `8gent voice build-whisper` - build whisper.cpp on a phone when the prebuilt binary is missing.
- `8gent flow` - pair this terminal with the 8gent Flow app on Android.

### Code navigation

- `8gent outline <file>` - symbol outline of a file.
- `8gent symbol <file>::<name>` - source of one symbol.
- `8gent search <query>` - search for symbols across files.

### Packages and publishing

- `8gent install <preset>` - interactively install a `/spawn` preset CLI (claude, codex, hermes, openclaw, pi, 8gent).
- `8gent install npm:<name>@<ver>` - install a pinned npm package into `~/.8gent/packages` (no scripts run).
- `8gent packages [list|remove|verify]` - list, remove or re-check installed packages.
- `8gent publish <app-dir>` - build a `.8gent-app.tar.gz` archive. Flags: `--out`, `--max-size`, `--allow-dangerous`, `--strict-lint`, `--json`.
- `8gent deck render <spec.json> [out.mp4]` - render a JSON deck spec into an mp4.
- `8gent airdrop <file|text>` (alias `drop`) - macOS only.

### Machine interfaces

- `8gent rpc` - JSON-RPC 2.0 server over stdin/stdout.
- `8gent mcp-server [--tools=safe]` - expose 8gent tools to external MCP clients.
- `8gent durable-run <dir>` - experimental; needs `EIGHT_DURABLE_RUN=1`.

### Global flags

`-h/--help`, `-v/--version`, `--json`, `--yes`, `--model=<m>`, `--provider=<p>`, `--cwd=<dir>`, `--fast`, `--resume[=<name>]`, `--continue [id]`, `--no-durable`, `--durable-retry`, `--durable-skip`, `-p/--print`, `--mode <json|text|rpc>`, `--tools a,b`, `--no-session`, `--session-dir <dir>`, `--infinite`, `--pet`, `--rpc`, `--text-tools`, `--output-format <fmt>`. A command that starts with a flag opens the TUI with that flag.

## Slash commands

Registry: `apps/tui/src/lib/slash-commands.ts` (the built-in table, `BUILT_IN_SLASH_COMMANDS`) and `apps/tui/src/lib/slash-registry.ts` (merges built-ins with skills and prompt templates). Handlers live in `apps/tui/src/app.tsx`.

`/help` shows the core set; `/help all` shows everything. A bare `/` opens a menu with the core commands first. Names are shown with their aliases in parentheses.

Beyond the table, any loaded skill with a slash trigger is a command, and any Markdown file in `~/.8gent/prompts` is a command named after the file. A built-in always wins a name clash: the skill is then reachable as `/skill:<name>`.

### Core

- `/help` (`/h`, `/?`) - show available commands.
- `/hotkeys` (`/keys`, `/shortcuts`) - list every keyboard shortcut.
- `/model [name]` (`/m`) - choose the model.
- `/provider [name]` (`/pr`) - choose the provider.
- `/clear` (`/cls`, `/c`) - clear the screen.
- `/compact [show|undo]` (`/compress`, `/summarize`) - summarize older messages to free context.
- `/resume [id|name]` (`/res`) - pick up an earlier session.
- `/fork [name]` (`/f`) - branch this conversation into a new session.
- `/rewind [n|list]` (`/rw`) - go back to an earlier checkpoint.
- `/export [file.jsonl]` (`/save`) - save the session as HTML, or `.jsonl` if named so.
- `/skills [list|search|info] [name]` (`/sk`) - list and manage skills.
- `/settings` - open the settings view (voice, performance, models).
- `/copy` - copy the last answer to the clipboard.
- `/quit` (`/q`, `/exit`) - exit.

### Models, providers and privacy

- `/apikeys` (`/apikey`) - enter or remove provider API keys (masked, kept in the OS keychain).
- `/llama [status|load <id>|unload <id>]` - local llama-server health, loaded models, metrics.
- `/models [list|use <id>]` - list llama-server models or switch while keeping the conversation.
- `/router [on|off|set|test|stats|status]` (`/routing`, and `/route`) - task router that assigns models to task categories.
- `/route [local-only|local-first|cloud-first]` - where model calls may go. In the table, `/route` is also an alias of `/router`, and the alias is registered later, so typing `/route` currently reaches `/router`.
- `/consult <question>` - one stateless question to your cloud model, with secrets and personal data masked first.
- `/privacy` - how much stayed on this machine today and this session, and each cloud call.
- `/vision [status|model|ocr|pull]` (`/vis`, `/ocr`, `/eye`) - vision and OCR model settings.
- `/thinking [auto|off|low|medium|high|max|show|hide]` (`/think`) - thinking level, or show or hide thinking.
- `/scoped-models [model|clear]` (`/scoped`, `/scope`) - the few models Alt+M cycles between.
- `/judge [install]` - install the safety judge that checks risky commands before they run.
- `/local stop` - stop the local model server 8gent started in the background.
- `/auth [login|logout|status]` (`/login`, `/account`) - authentication.

### Sessions and context

- `/session [name|list|resume]` (`/sess`) - named session management.
- `/sessions [share|attach <id>|stop|detach]` (`/shared`) - live and past shared sessions.
- `/history` (`/hist`) - browse all past sessions.
- `/continue` (`/cont`, `/last`) - continue the most recent session.
- `/tree` - pick any earlier message and continue from it.
- `/branch [list|switch <id>]` (`/branches`, `/br`) - list or switch branches.
- `/import <file.jsonl>` - import a session file written by `/export`.
- `/durable [on|off|continue|retry|skip]` - durable turns: a cut-off turn continues where it stopped.
- `/context` (`/ctx`) - what fills the context window, by kind.
- `/stack` - what each turn sends and its token cost.
- `/status` (`/s`, `/st`) - session status.
- `/evidence` (`/ev`, `/proof`) - evidence breakdown for this session.
- `/rename <new name>` (`/ren`) - rename the current tab.
- `/out [n]` - open or close the output of a tool call (same as Ctrl+O).
- `/allow-read <dir>` - let 8gent read files in a folder this session (writes stay in the working folder).
- `/bug <description>` - save a secret-free bug report folder on this machine.
- `/debug [sessions|health|tools|errors|inspect <id>|export <id>]` (`/inspect`, `/logs`) - session debugger. Hidden from `/help` in installed builds that have no debug script.

### Work modes and goals

- `/mode <plan|ask|guarded|infinite|yolo [off]>` - set this tab's permission mode, same as Shift+Tab. See [Permission Modes](Permission-Modes).
- `/infinite [task]` (`/inf`) - autonomous until done.
- `/plan` (`/pl`) - current execution plan.
- `/predict` (`/p`, `/next`) - predicted next steps.
- `/avenues` (`/a`, `/paths`) - all planned avenues.
- `/kanban` (`/k`, `/board`) - toggle the kanban board view.
- `/goal <goal>` (`/go`) - run a goal to completion. Also `/goal status | stop | resume | clear | ?`.
- `/subgoal <text>` - inject a sub-goal into the running `/goal` loop.
- `/build <task>` (`/b`) - run the adaptive three-model pipeline on a build task.
- `/chat` (`/talk`) - toggle chat mode (background work continues).
- `/agent [list|spawn|kill|auto|settings]` (`/agents`, `/ag`) - manage child 8gents.
- `/spawn <claude|codex|hermes|openclaw|pi|8gent>` - spawn an external CLI as a new tab.
- `/control` (`/loops`) - open the Control tab: every loop, what it is doing and what it waits on.
- `/cron [list|add|remove|enable|disable]` (`/jobs`, `/schedule`) - scheduled cron jobs.
- `/design [task]` (`/d`, `/ui`, `/style`) - suggest design systems for the task.
- `/create-app <name> [-- description] [--caps read,write,bash]` (`/new-app`, `/scaffold-app`) - scaffold a personal mini-app at `~/.8gent/apps/<name>/`.
- `/toolshed [list|search|stats]` (`/shed`, `/tools`) - query available tools.
- `/quarantine [add|scan|list|release|reject]` (`/quar`, `/sandbox`) - manage skill quarantine.
- `/bring-it-home` (`/bringithome`) - bring skills, instructions and memory from other tools into 8gent, with your yes.
- `/update [--force]` (`/upgrade`) - update 8gent, then reopen the session on the new version.

### Tabs and terminals

- `/notes` - Notes tab (Ctrl+N).
- `/ideas` - Ideas tab.
- `/btw` - BTW tab (park a side quest).
- `/questions` - Questions tab.
- `/projects` - Projects tab (switch working directory).
- `/terminal [label]` - terminal tab in the current project.
- `/term [shell|<preset>|<command...>]` - new PTY terminal tab; a preset launches that CLI.
- `/herdr [pane] [lines]` - inside herdr, list neighbouring panes or show a pane's recent output (read-only).

### Look, voice and sound

- `/theme [name|default|status|light|dark|auto]` (`/t`) - pick a theme.
- `/reload` - re-read theme files from `~/.8gent/themes`.
- `/animations [matrix|fire|dna|stars|dots|glitch|confetti|wave|all]` (`/anim`, `/fx`) - preview ASCII animations.
- `/voice [on|off|test]` (`/v`) - voice TTS settings.
- `/adhd [on|off|lofi|rainsound|whitenoise|ambient|classical|stop]` (`/focus`) - ADHD mode text and audio toolkit.
- `/music [lofi|rain|white|ambient|piano|gen <prompt>|stop|config]` (`/audio`, `/soundscape`) - generate and play focus music.
- `/dj [play|radio|produce|pause|stop|skip|np|vol|loop|queue|dl|bpm|mix]` (`/play`, `/radio`) - YouTube, radio, produce, mix.
- `/quiet` (`/mute`, `/shut`, `/silence`) - stop the launch instrumental.
- `/pet [start|stop|deck|card]` (`/companion`, `/lileight`) - Lil Eight dock companion and card.
- `/hands`, `/eyes`, `/handeyes` - toggle the hands, eyes and combined indicators.

### Preferences, profile and integrations

- `/preferences [category]` (`/prefs`) - view or edit preferences.
- `/onboarding` (`/onboard`, `/setup`, `/intro`) - start or restart personalization setup.
- `/skip [all]` (`/later`) - skip the current onboarding question.
- `/me [add <text> | forget <name>]` - show, add to or forget what 8gent knows about you. Needs `EIGHT_ME=1`.
- `/github [issues|pr|repos|status]` (`/gh`) - GitHub integration.
- `/telegram [status|setup]` (`/tg`) - Telegram integration and setup.
- `/deploy` (`/redeploy`) - trigger a Vercel deploy of the current project.
- `/vercel [status|env|logs|projects|domains]` (`/vc`) - Vercel deployment management.

### Skill commands

Bundled skills with a slash trigger (from `packages/skills/*/SKILL.md`):

- `/boardroom` (`/convene`) - convenes a panel of eight parallel perspectives on a topic before a non-trivial change. They research separately, brief a table of positions, resolve or record disagreements, then commit a decision (go, no-go, defer or needs more info) with scope, constraints, success metric and a check on what the change retires. If the decision is go, it hands off a PRD. No code is written in the session, and minutes are saved under `docs/boardroom-minutes/`. Variants: `/boardroom spar <topic>` (two opposing positions, then a judge) and `/boardroom align <topic>` (coherence check across the product surfaces). The alias `/board` loses to the built-in `/kanban` alias, so use `/boardroom`, `/convene` or `/skill:board`.
- `/billiondollarboardroom` (`/bdb`, `/billionboard`) - advisors deliberate on a business, marketing, sales or growth problem.
- `/brief-to-film` - turn a written brief into a narrated video and post it to a chat.
- `/retro` (`/retrospective`, `/post-mortem`) - retrospective over the session that just happened.
- `/create-skill` (`/createskill`, `/teach-yourself`, `/learn-how-to`, `/skill-create`) - author a new skill from a task description and examples.
- `/tdd` (`/test-first`, `/red-green-refactor`) - failing test first, then the smallest code that passes.
- `/verify` (`/vbc`, `/confirm-done`) - run a verification command and read its output before claiming done.
- `/touchdesigner` - drive TouchDesigner from outside the editor.
- `/youtube-transcript` (`/yt`, `/transcript`) - fetch a YouTube transcript.
- `/no-bs` - validator that forces crisp problem statements, constraints and tradeoffs.
- `/debug` and `/voice` also exist as skills (`/debug` has aliases `/systematic-debug`, `/sdbg`) but the built-ins win those two names; reach the skills as `/skill:debug` and `/skill:voice`.

Other bundled skills have no slash trigger and load by matching the task.
