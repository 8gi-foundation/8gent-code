# Install

## Windows (PowerShell 7 or Windows PowerShell)

On Windows, install from a source clone with Bun. This path is run on every relevant pull request by the `windows-smoke` workflow on a GitHub Windows runner.

```powershell
# Bun: the one-liner below, or download Bun from bun.sh/docs/installation and inspect it first
powershell -c "irm bun.sh/install.ps1 | iex"     # then open a NEW terminal
bun --version                                    # first check, in the new terminal
git config --global core.longpaths true
git clone --depth 1 https://github.com/8gi-foundation/8gent-code.git
cd 8gent-code
bun install
bun bin/8gent.ts --version
bun bin/8gent.ts doctor
```

`doctor` lists Ollama, mpv, yt-dlp and rg as missing on a fresh machine. Only a model server is needed (see [First run](first-run.md)).

Start the interface:

```powershell
bun run tui
```

To type `8gent` from any folder, add this to your profile (`notepad $PROFILE`). If you cloned elsewhere, change the path:

```powershell
function 8gent { bun run "$HOME\8gent-code\bin\8gent.ts" @args }
```

Run the interface in Windows Terminal or PowerShell.

Update later:

```powershell
cd 8gent-code
git fetch --depth 1 origin main
git reset --hard origin/main      # discards local edits to tracked files
bun install
```

WSL and the compiled `.exe` are covered in [docs/ARTALE-WINDOWS.md](../ARTALE-WINDOWS.md).

## WSL, macOS, Linux

Same clone steps; on WSL work under `~`, not `/mnt/c`. npm is an optional channel if you prefer it:

```bash
npm install -g @8gi-foundation/8gent-code
8gent --version
8gent doctor
```

`8gent update` updates an npm install.

## Check

```bash
8gent --version
8gent doctor
8gent status
```
