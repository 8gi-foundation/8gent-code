# Install

## Windows (PowerShell 7 or Windows PowerShell)

The npm package is behind (0.17.0, and `8gent run` fails there), so on Windows install from a clone. This path is run on every relevant pull request by the `windows-smoke` workflow on a GitHub Windows runner.

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

Use Windows Terminal or PowerShell. Piped into an editor pane, the interface stops with "Raw mode is not supported".

Update later:

```powershell
cd 8gent-code
git fetch --depth 1 origin main
git reset --hard origin/main      # discards local edits to tracked files
bun install
```

Known Windows notes, including WSL and the compiled `.exe`, are in [docs/ARTALE-WINDOWS.md](../ARTALE-WINDOWS.md).

Coming soon: SQLite files are released properly on Windows (#3275).

## WSL, macOS, Linux

Same clone steps; on WSL work under `~`, not `/mnt/c`. Or from npm (gets 0.17.0 until the next publish):

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
