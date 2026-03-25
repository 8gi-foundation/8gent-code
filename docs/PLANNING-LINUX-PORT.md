# Linux port and workstation setup plan

**Project:** [PodJamz](https://github.com/PodJamz/) (8gent Code). **This document** applies when you work from the Linux fork by contributor **zerwiz**: [https://github.com/zerwiz/8gent-code](https://github.com/zerwiz/8gent-code)

```bash
git clone https://github.com/zerwiz/8gent-code.git && cd 8gent-code
```

Canonical repo for the main project (contributions, issues that belong upstream): [PodJamz/8gent-code](https://github.com/PodJamz/8gent-code).

Planning document for running and maintaining **8gent Code** on your Linux machine, and for treating this tree as the **Linux-first** clone of the project.

**Last updated:** 2026-03-25 (section 9 investigation + heartbeat git stderr fix)

---

## 1. Target system (your baseline)

| Area | Your environment |
|------|------------------|
| Hardware | Dell Precision 7560, 128 GiB RAM, i9-11950H (16 threads), 1 TB disk |
| GPU | Intel UHD (Tiger Lake) + NVIDIA RTX A5000 Mobile |
| OS | Ubuntu 24.04.4 LTS, 64-bit, kernel 6.17.0-19-generic |
| Desktop | GNOME 46, **X11** |
| Repo path (example) | `~/CodeP/8gent-code-main` |

**Implications**

- **X11 + GNOME:** `/pet start` in the TUI can use `gnome-terminal`; no Wayland-specific work required for your current session.
- **RAM / CPU:** Local LLMs (Ollama) and the monorepo are comfortable; optional CUDA for Ollama is independent of this repo.
- **Linux repo:** Keep this directory as a normal git working tree with a remote (see section 5). Avoid using a parent folder that is a git repo with no commits if tools assume `HEAD` exists.

---

## 2. Goals and non-goals

**Goals**

- Reliable launch: Bun on `PATH`, `./start.sh` or `bun run tui`, nested scripts resolve `bun`.
- Terminal pet and assets on Linux: `pet:build:linux`, `run-terminal-pet.sh`, TUI `/pet start`.
- Local inference path: Ollama (or OpenRouter) configured and documented for this machine.
- Clean git state so features that call `git rev-parse HEAD` do not spam errors (see section 5).

**Non-goals (for this port)**

- **Swift dock pet** (`apps/lil-eight/build.sh`, `.app` bundle): remains **macOS-only**. Linux uses the terminal pet only unless you later add a separate GTK/Qt/Electron app.
- Parity with every macOS-only integration (e.g. some voice/installer paths): document gaps, do not block Linux usage.

---

## 3. NOW (do first)

1. **Bun**
   - Install from [bun.sh](https://bun.sh) and put `~/.bun/bin` in `PATH` in `~/.bashrc` (or use `start.sh`, which prepends Bun’s bin for nested `bun run`).

2. **Dependencies**
   - From repo root: `bun install`
   - If `better-sqlite3` or other native modules fail, install build essentials: `sudo apt install build-essential python3` (and retry).

3. **Smoke tests**
   - `bun run bin/8gent.ts --help`
   - `./start.sh` or `bun run tui` in an interactive terminal (Ink needs a real TTY).

4. **Pet on Linux**
   - `bun run pet:build:linux` (sprites + desktop stub)
   - In TUI: `/pet start` (prefers `gnome-terminal` on your stack)

5. **Git baseline (fixes repeated `fatal: ambiguous argument 'HEAD'`)**
   - Work **inside this repo’s** `.git`, not only under a parent `~/` repo with zero commits.
   - From `8gent-code-main`: `git status` → if this is the real project root, run `git add -A && git commit -m "chore: initial linux workspace snapshot"` (or clone from upstream and discard the broken parent git layout).
   - After at least one commit, `git rev-parse HEAD` succeeds and TUI/planning widgets that read git should quiet down.

6. **Ollama (local default)**
   - Install Ollama for Linux, pull a recommended model (e.g. Qwen family per project docs), confirm `ollama list` and that the app can reach `http://127.0.0.1:11434`.

7. **Verify with `doctor` or `linux:check`**
   - **`8gent doctor`** (or `bun run doctor`): harness health (Ollama / LM Studio / OpenRouter / agent) plus on Linux the pet/terminal/TTS/shebang checks. **`8gent linux-check`** is the full Linux TODO list including models; use **`--workspace-only`** to skip provider rows if you already ran `doctor`.

---

## 4. NEXT (soon after stable run)

| Item | Notes |
|------|------|
| **Remote** | Add `origin` pointing to your fork or the canonical GitHub repo; branch strategy for “linux repo” (e.g. `linux/main` or topic branches). |
| **NVIDIA + ML** | Optional: use GPU for Ollama; install proprietary driver + CUDA stack per Ubuntu docs; not required for the TypeScript/Bun core. |
| **Desktop entry** | Copy `apps/lil-eight/build/linux/8gent-lil-eight-term.desktop` to `~/.local/share/applications/` if you want a menu launcher for the terminal pet. |
| **TTS** | Terminal pet uses `espeak` / `spd-say` on Linux; install if you want spoken lines: `sudo apt install espeak-ng` (optional). |
| **CI / lint** | Run `bun run typecheck`, `bun run lint`, `bun test` when you change shared packages. |

---

## 5. LATER (backlog)

- **Empty-repo guard** in code paths that call `git rev-parse` (TUI session logger, CLI helpers): detect no commits and show a single muted warning instead of repeated `fatal` stderr.
- **Wayland** session testing if you switch from X11: verify `/pet start` terminal spawning (`gnome-terminal` vs `kgx`, etc.).
- **Optional native Linux “dock” pet** (GTK layer shell or Electron): import concepts only; keep scope small if pursued (see CLAUDE.md No-BS mode).

---

## 6. Already aligned with Linux (reference)

These landed to support your setup; no duplicate work unless regressions appear.

- Root **`chalk` ^5** hoisting so Ink 6 works under Bun.
- **`start.sh`** prepends Bun’s directory to `PATH` so `package.json` `tui` script’s nested `bun run` resolves.
- **`apps/lil-eight/build-linux.sh`**, **`run-terminal-pet.sh`**, TUI **`/pet start`** terminal detection, **`sessionId`** in `active-companion.json` for pet identity match.
- **`bin/lil-eight.sh`** and **`8gent pet`** subcommands branch on macOS vs Linux where relevant.
- **`bun run linux:check`** / **`8gent linux-check`** and portable **`bun run build`** (shebang via `scripts/add-cli-shebang.ts`).

---

## 7. Success criteria

You can check these off when the port is “done enough” for daily use:

- [ ] `bun --version` and `./start.sh` work from login shell after `.bashrc` update.
- [ ] TUI loads without `chalk.dim` or `bun: command not found` in nested scripts.
- [ ] `git rev-parse HEAD` works in **this** repo (no unbounded `HEAD` errors in the TUI).
- [ ] `/pet start` opens a terminal pet on GNOME (or you can run `bash apps/lil-eight/run-terminal-pet.sh` manually).
- [ ] At least one local or cloud model path works end-to-end for a single chat turn.

---

## 8. Risk register (short)

| Risk | Mitigation |
|------|------------|
| Parent directory is git root with no commits | Initialize or use repo only under `8gent-code-main`; make first commit. |
| Bun not on PATH for child processes | Use `start.sh` or export `PATH` globally. |
| Native module build fails | `build-essential`, correct Node/Bun arch; check distro packages. |
| No terminal emulator detected for pet | Install `gnome-terminal` or run `run-terminal-pet.sh` in an existing terminal. |

---

## 9. Investigation: what actually blocks the plan

This section ties **PLANNING goals** to **concrete causes** and **changes** (ops vs code).

### 9.1 Root cause of repeated `fatal: ambiguous argument 'HEAD'`

On a git repo with **zero commits**, commands like `git rev-parse HEAD` / `git rev-parse --abbrev-ref HEAD` **fail**. Under **Bun**, `execSync` **still prints git’s stderr to the terminal** before throwing unless `stdio` pipes stderr.

The **self-autonomy git heartbeat** (`packages/self-autonomy/heartbeat.ts`) calls `AutoGit.getState()` on an interval whenever `isGitRepo()` is true. `isGitRepo()` only checks `git rev-parse --git-dir`, which **succeeds** on an empty repo. So the heartbeat keeps calling `getState()` → repeated `rev-parse` → **stderr spam** while the agent runs.

**What we changed in repo:** `AutoGit.exec()` in `packages/self-autonomy/index.ts` now uses `stdio: ["ignore", "pipe", "pipe"]` so failed git calls do not flood the TUI.

**What you should still do:** Make **at least one commit** in the directory you use as the project git root (`8gent-code-main` recommended), and run the TUI with **`cwd` = that repo**. If your **home directory** is accidentally a git repo with no commits, either fix that repo or always start 8gent from `~/CodeP/8gent-code-main`.

### 9.2 Ops checklist (no feature code)

| Item | Why |
|------|-----|
| Bun on `PATH` or `./start.sh` | Nested `bun run` in npm scripts needs `PATH` (see `start.sh`). |
| `bun install` from repo root | Native modules (`better-sqlite3`, etc.) may need `build-essential` on Ubuntu. |
| Ollama or OpenRouter | Local default is Ollama; verify `127.0.0.1:11434` if using local models. |
| First git commit in **this** repo | Unlocks tools and status that assume a real `HEAD`; avoids edge cases outside heartbeat. |

### 9.3 Packaging / scripts (Linux contributors)

| Item | Issue | Mitigation |
|------|--------|------------|
| `package.json` **`build`** script | Previously used BSD-only `sed -i ''`. | Now uses **`scripts/add-cli-shebang.ts`** so **`bun run build`** is portable on Linux. |

### 9.4 Platform gaps (acceptable for “Linux port” per goals)

| Area | macOS | Linux |
|------|-------|-------|
| Dock pet | Swift `.app` | Terminal pet + `run-terminal-pet.sh` (done). |
| TUI DJ `afplay` | Used for audio | Stubs / alternatives; stopping DJ uses `pkill afplay` (harmless on Linux if nothing matches). |
| Installer UX | May assume macOS paths | Use `bun install` + docs; run TUI directly. |
| Keychain / `token-store` | Often darwin-specific | Use file-based or env auth where supported. |

### 9.5 Optional follow-ups (LATER backlog)

- **`isGitRepo()` semantics:** Treat “has `.git`” vs “has at least one commit” separately if you want heartbeats to skip until the first commit without calling `getState()` at all.
- **`8gent status` git block:** Already wrapped in `try/catch`; `exec` from `child_process` may still surface stderr depending on runtime; quieten with explicit `stdio` if it becomes noisy.
- **Wayland:** Add `kgx` or other defaults to `/pet start` if you move off X11.

### 9.6 Summary

| Layer | Need |
|------|------|
| **Your machine** | Ubuntu stack from section 1; Bun; optional Ollama; real TTY for Ink. |
| **Git layout** | Real repo root + ≥1 commit; avoid “empty git” in parent `cwd`. |
| **Already in tree** | `start.sh`, chalk, Linux pet, `PLANNING.md` index. |
| **Code** | Heartbeat stderr: fixed via piped `stdio` in `AutoGit.exec`. |
| **Contributor papercuts** | `bun run build` is portable; use `linux:check` before release. |

---

*This file is the living plan for the Linux workstation and the linux-focused repo. Update the date at the top when you change phases or baseline hardware.*
