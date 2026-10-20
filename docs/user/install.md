# Install and first run

## One-line install

These install the newest published release of the standalone `8gent` binary. They do not install the code on `main`, so a feature merged today may not be in it until the next release. If no release carries a binary for your machine yet, the script says so and stops with nothing changed.

Windows (PowerShell 5.1 or 7, no admin rights, no Bun or Node needed):

```powershell
irm https://raw.githubusercontent.com/8gi-foundation/8gent-code/main/scripts/install.ps1 | iex
```

It puts `8gent.exe` in `%LOCALAPPDATA%\Programs\8gent\bin` and adds that folder to your user PATH. Open a new terminal afterwards.

macOS and Linux (x64 and arm64):

```bash
curl -fsSL https://raw.githubusercontent.com/8gi-foundation/8gent-code/main/scripts/install.sh | sh
```

It puts `8gent` in `~/.local/bin`; make sure that folder is on your PATH.

Both scripts check the download against the release's `SHA256SUMS`, check that the new binary reports the release version, and only then replace anything. Settings, all optional: `EIGHT_VERSION` (install that version instead of the newest), `EIGHT_INSTALL_DIR`, and on Windows `EIGHT_NO_MODIFY_PATH=1`. Neither script replaces a newer 8gent with an older one unless you name the older version in `EIGHT_VERSION`. To update a binary install, run the same line again.

## From source on Windows

```powershell
powershell -c "irm bun.sh/install.ps1 | iex"   # or download Bun from bun.sh/docs/installation
bun --version                                  # in a new terminal
git config --global core.longpaths true
git clone --depth 1 https://github.com/8gi-foundation/8gent-code.git
cd 8gent-code
bun install
bun bin/8gent.ts doctor
bun run tui
```

On Windows from a clone, type `bun bin/8gent.ts` where these pages say `8gent`, or add this to your profile (`notepad $PROFILE`; change the path if you cloned elsewhere):

```powershell
function 8gent { bun run "$HOME\8gent-code\bin\8gent.ts" @args }
```

Update: `git fetch --depth 1 origin main`, `git reset --hard origin/main`, `bun install`.

WSL and the compiled `.exe` are covered in [ARTALE-WINDOWS.md](../ARTALE-WINDOWS.md).

## From source on macOS and Linux

Same clone steps. npm is an optional channel:

```bash
npm install -g @8gi-foundation/8gent-code
```

## A local model

Install [Ollama](https://ollama.com/download) (on Windows, the Windows installer), then:

```bash
ollama pull qwen3.5
8gent doctor
8gent run "say hello in one sentence"
8gent
```

LM Studio on `localhost:1234` is found too. Use `OLLAMA_BASE_URL` or `LM_STUDIO_HOST` for another host.

Pick a model with `/model` (or Ctrl+L) and a provider with `/provider`. Save a default: `8gent preferences set model qwen3:14b`. Provider keys: `8gent keys`.

Per-platform setup for every model option (Ollama, LM Studio, llama-server, OpenRouter, Apple on-device): [macOS](../install/macos.md), [Windows](../install/windows.md), [Linux](../install/linux.md). Every provider and setting: [providers](../install/providers.md).

## If the TUI does not start

Run `8gent doctor` first. Besides checking models and tools, it prints the last 30 lines of the boot trace under "Boot trace".

The TUI writes one line per startup stage to `~/.8gent/logs/tui-boot.log` (on Windows, `%USERPROFILE%\.8gent\logs\tui-boot.log`). Each line has a timestamp, a millisecond offset from process start, the process id and the stage name, for example `intro-mount` or `first-prompt-render`. The first lines of a boot also record the platform, architecture, Bun version, the names and set/unset state of `TERM`, `WT_SESSION` and `TERM_PROGRAM`, whether stdin and stdout are a TTY, whether raw mode is supported, and the terminal size. It never records prompt text. The file is capped at 256 KB; when it grows past that, the oldest half is dropped.

The last stage in the file is the last one the TUI reached. If the TUI does not get past its first moment, paste the output of `8gent doctor` (or the last 30 lines of `tui-boot.log`) into your report, along with the terminal you used (Windows Terminal, PowerShell, cmd or WSL).

To turn the trace off, set `EIGHT_BOOT_TRACE=0`.
