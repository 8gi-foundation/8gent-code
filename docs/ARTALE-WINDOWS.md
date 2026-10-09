# Running 8gent-code on Windows (and WSL) from source

Everything here uses public URLs. No GitHub login is needed.

Why source: npm still serves 0.17.0 and the GitHub releases carry no Windows installer. A
clone is the only current way to get latest. This path is exercised on every relevant PR by
`.github/workflows/windows-smoke.yml` on a GitHub-hosted `windows-latest` runner (shallow
clone, `bun install`, `--version`, `doctor`, a headless JSON-RPC check, the TUI bundle build,
and the TUI starting up to the point where it needs a real terminal).

## A. Native Windows (PowerShell 7 or Windows PowerShell)

1. Install Bun, then open a NEW terminal so it is on PATH. Official instructions:
   https://bun.sh/docs/installation (Windows tab). The one-liner there is
   `powershell -c "irm bun.sh/install.ps1 | iex"`. Then:

   ```powershell
   bun --version
   ```

2. Install Git for Windows if `git --version` fails: https://git-scm.com/download/win

3. Clone shallow (one commit instead of the 1900-commit history, which is what stalled on the
   tailnet) and install:

   ```powershell
   git config --global core.longpaths true
   git clone --depth 1 https://github.com/8gi-foundation/8gent-code.git
   cd 8gent-code
   bun install
   ```

4. Check it:

   ```powershell
   bun bin/8gent.ts --version
   bun bin/8gent.ts doctor
   ```

   `doctor` lists Ollama, mpv, yt-dlp and rg as missing on a fresh machine. All are optional.
   "4 issue(s) found" on a clean Windows box is expected (CI shows exactly that).

5. Run it:

   ```powershell
   bun run tui
   ```

   To launch from any folder, add this to your PowerShell profile (`notepad $PROFILE`):

   ```powershell
   function 8gent { bun run "$HOME\8gent-code\bin\8gent.ts" @args }
   ```

6. A model. With no local model the first run walks you through setup. Two options: install
   Ollama for Windows (https://ollama.com/download) and run `ollama pull qwen3.5`, or run
   `8gent keys`, add `OPENROUTER_API_KEY`, then `/provider openrouter` and `/model auto:free`.
   An OpenRouter key needs an OpenRouter account, not GitHub.

7. Update later:

   ```powershell
   cd 8gent-code
   git pull
   bun install
   ```

   If `git pull` complains about the shallow history, this always works:

   ```powershell
   git fetch --depth 1 origin main
   git reset --hard origin/main
   bun install
   ```

   `reset --hard` discards local edits to tracked files. Commit or copy yours first.

## B. WSL (Ubuntu)

Work inside the Linux filesystem (`~`), not `/mnt/c/...`. Bun installs are several times slower
across the Windows mount.

```bash
sudo apt update && sudo apt install -y git unzip curl   # unzip is required by the Bun installer
# install Bun with the Linux command on https://bun.sh/docs/installation, then:
exec $SHELL                                              # pick up PATH
git clone --depth 1 https://github.com/8gi-foundation/8gent-code.git ~/8gent-code
cd ~/8gent-code && bun install
bun bin/8gent.ts doctor
bun run tui
```

Update: `cd ~/8gent-code && git pull && bun install`.

A model running in Ollama on the Windows side is reachable from WSL only if Ollama listens on
the WSL network (set `OLLAMA_HOST=0.0.0.0` on Windows and point 8gent at the Windows host IP).
The simpler route is to install Ollama inside WSL, or use the OpenRouter key above.

## C. Known gotchas

- **Fixed in this PR:** `bun scripts/build-bundles.ts` (the `npm run build` path) failed on
  Windows with `EINVAL: failed to open root directory: /D:/...` because it built a path from
  `new URL(...).pathname`. It now uses `fileURLToPath`. A test (`tests/windows`) fails if the
  pattern comes back. Running from source (steps above) never hit this.
- **The compiled `.exe` is not fully standalone.** `8gent-windows-x64.exe` runs `--version`,
  `--help`, `doctor` and `--rpc` on its own, but `tui` launches `bun run tui.js` from beside the
  exe. You still need Bun on PATH and `tui.js` in the same folder. For you, running from source
  is simpler. The CI artifact ships both files.
- **SmartScreen** may warn on the unsigned `.exe`. Source runs are not affected.
- **The TUI needs a real terminal.** Use Windows Terminal or PowerShell, not a pipe or an
  editor output pane. Piped, it stops with "Raw mode is not supported on the current
  process.stdin". That is Ink, not a bug.
- **Line endings.** `.gitattributes` pins LF, so a clone with `core.autocrlf=true` still checks
  out LF.
- **Antivirus** can slow `bun install` on the first run. Excluding the clone folder helps.
- `bun run smoke:fast` currently fails on main on every OS (a missing export in
  `apps/tui/src/lib/slash-commands.ts`). It is not a Windows problem; use `doctor` as the
  health check instead.
- The Forgejo 2FA problem does not affect any of the above. Everything here comes from public
  GitHub.
