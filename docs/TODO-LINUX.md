# Todo list (Linux workstation + repo)

**PodJamz** project; this checklist targets the Linux fork by contributor **zerwiz**: `git clone https://github.com/zerwiz/8gent-code.git && cd 8gent-code` (canonical: [PodJamz/8gent-code](https://github.com/PodJamz/8gent-code)).

Check items as you finish. See [PLANNING-LINUX-PORT.md](./PLANNING-LINUX-PORT.md) for context.

## Environment

- [ ] Install Bun and add `export PATH="$HOME/.bun/bin:$PATH"` to `~/.bashrc` (or rely on `./start.sh`)
- [ ] From repo root: `bun install` completes without native build errors
- [ ] If `better-sqlite3` fails: `sudo apt install build-essential python3` then retry

## Git

- [ ] Confirm `cwd` for daily work is `~/CodeP/8gent-code-main` (not a parent folder with empty `.git`)
- [ ] At least one commit exists: `git rev-parse HEAD` succeeds
- [ ] (Optional) Add `origin` remote and push your linux-first branch

## Run the app

- [ ] `./start.sh` or `bun run tui` works in a real interactive terminal
- [ ] `bun run bin/8gent.ts --help` prints banner
- [ ] `8gent status` (or `bun run cli -- status`) looks reasonable

## Models

- [ ] Ollama installed and one model pulled, **or** OpenRouter configured in `.8gent/config.json`
- [ ] One full chat turn works end-to-end in the TUI

**Automated:** `bun run doctor` / **`8gent doctor`** (core + Linux workspace), or **`bun run linux:check`** / **`8gent linux-check`** (add `--json`; `--workspace-only` skips Ollama/OpenRouter rows; `--full` adds typecheck + lint).

## Pet (Linux)

- [ ] `bun run pet:build:linux` (sprites + desktop stub)
- [ ] `/pet start` opens a terminal pet, or `bash apps/lil-eight/run-terminal-pet.sh` runs manually
- [ ] (Optional) Copy `apps/lil-eight/build/linux/8gent-lil-eight-term.desktop` to `~/.local/share/applications/`

`linux:check` verifies atlas, runner script, built `.desktop`, installed menu entry, and a `/pet`-compatible terminal.

## Optional polish

- [ ] `sudo apt install espeak-ng` if you want terminal pet TTS (`linux:check` reports TTS CLI)
- [x] `bun run build` uses `scripts/add-cli-shebang.ts` (no GNU vs BSD `sed`) when shipping `dist/cli.js`
- [ ] `bun run typecheck` and `bun run lint` clean on changed files (or run `bun run linux:check --full`)

---

**Last updated:** 2026-03-25 (linux:check + portable build shebang)
