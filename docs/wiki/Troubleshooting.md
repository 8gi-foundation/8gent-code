# Troubleshooting

Each item below points to the repo doc it comes from. Start with `8gent doctor`, which shows what was found: Ollama and its models, and optional tools.

## No model, or the local endpoint is not reachable

- The "no model" card on first start means no local server answered and no key is set. Start a local server (Ollama, LM Studio or llama-server) or add a key with `8gent keys`. See [docs/install/linux.md](../install/linux.md) and [docs/install/windows.md](../install/windows.md).
- `The local model endpoint ... is not reachable` means no model server is running. Start Ollama (or LM Studio), pull a model, and try again. See [docs/guides/install-and-first-prompt.md](../guides/install-and-first-prompt.md).
- Ollama on another host or port: set `OLLAMA_BASE_URL` (checked first) or `OLLAMA_HOST`. Table of variables: [docs/install/providers.md](../install/providers.md).
- `8gent doctor` is documented as ignoring a custom `OLLAMA_HOST`, so it can say Ollama is down when it is not. Check the host and port yourself ([install guide](../guides/install-and-first-prompt.md)).
- The first reply can take up to a minute while a local model loads ([Linux guide](../install/linux.md)).
- With `EIGHT_LOCAL_SERVER=llama-server`, 8gent never contacts Ollama. If it still reports Ollama missing on Windows, the variable is not set in that shell window ([Windows guide](../install/windows.md)). No models listed: check `LLAMA_SERVER_URL` and that the server is up; port 8080 busy and `/health` returning 503 (model still loading) are covered in the same guides.

## Provider key missing, or a hosted provider refused

- Run `8gent keys` to add a key; keys go in `~/.8gent/keys.env`. Nothing is sent to a hosted model unless you add a key.
- "Hosted provider refused": set `EIGHT_ALLOW_HOSTED=1`. By default failover stays on your machine, and if every entry is filtered out 8gent stops with a message naming the variable ([providers](../install/providers.md)).
- `Provider ... is not available on this host`: Apple providers are macOS only ([Windows guide](../install/windows.md)).
- `FAILOVER_LOG=1` prints each failover step to stderr.
- More: [Configuration](Configuration) and [Providers and Models](Providers-and-Models).

## Install problems

- `8gent requires Bun to run`: install Bun with the line it prints and open a new terminal.
- `8gent: command not found` on Linux: `~/.local/bin` is not on `PATH`. Add it and open a new terminal ([Linux guide](../install/linux.md)).
- `ENOENT ... 001-traces.sql` on `run` or `chat`: you have npm 0.17.0, a known bad release; see the options in [the install guide](../guides/install-and-first-prompt.md).

## Colors look wrong, or you want none

`NO_COLOR=1 8gent` draws without color. `FORCE_COLOR=0` turns color off and `1` to `3` turns it on even over `NO_COLOR`; `TERM=dumb` also turns it off. Order of precedence: [docs/guides/no-color.md](../guides/no-color.md).

## Windows and WSL

- The TUI needs a real terminal such as Windows Terminal or PowerShell. Piped, it stops with "Raw mode is not supported on the current process.stdin" (that comes from Ink).
- The compiled `8gent-windows-x64.exe` is not fully standalone: `tui` launches `bun run tui.js` from beside the exe, so Bun must be on `PATH` and `tui.js` must sit next to it. Running from source is simpler.
- SmartScreen may warn on the unsigned `.exe`; antivirus can slow the first `bun install`.
- WSL networking to a Windows-side model server is covered in [docs/WINDOWS-FROM-SOURCE.md](../WINDOWS-FROM-SOURCE.md), along with other known gotchas. Install steps: [docs/install/windows.md](../install/windows.md).

## Android (Termux, proot)

If 8gent exits with no output, the program it starts was probably killed by a signal (SIGILL in a proot is one example); 8gent prints the signal and exits 1. Run `EIGHT_RUNTIME=node 8gent` to use the Node build instead, and add `export EIGHT_RUNTIME=node` to `~/.bashrc` to keep it. See [docs/install/android-termux.md](../install/android-termux.md).

## Commands the model runs cannot see your variables

Model-run commands get a limited environment. If a command fails because a variable is missing, the first failure in a session points to `EIGHT_SHELL_ENV_PASS`. See [docs/SHELL-ENVIRONMENT.md](../SHELL-ENVIRONMENT.md).

## Daemon

- Status and control: `8gent daemon status`, `8gent daemon run` (foreground), `install`, `start`, `stop`, `uninstall`.
- Health check: `http://localhost:18789/health`.
- Logs: `~/.8gent/daemon.log`. On Windows, console output and errors go to `~/.8gent/daemon-console.log`.
- Where systemd user services are unavailable (WSL1, most containers), the service commands say so; use `8gent daemon run` under your own supervisor.
- Listening on `0.0.0.0` via `DAEMON_HOSTNAME` is refused without a token.

Full details: [docs/guides/daemon-service.md](../guides/daemon-service.md).

## Data location

`~/.8gent` holds settings, keys and logs. `EIGHT_DATA_DIR` moves the whole folder ([providers](../install/providers.md)).
