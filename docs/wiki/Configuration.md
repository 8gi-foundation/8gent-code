# Configuration

Where 8gent reads its settings and which environment variables change its behaviour. Only names are listed here, never values. Keep API keys in your shell environment or a secret manager, not in a repo.

## The data directory

Most files live in `~/.8gent/`. Two variables move it:

- `EIGHT_HOME` replaces the home directory 8gent resolves (settings, MCP config and similar read `<home>/.8gent`).
- `EIGHT_DATA_DIR` relocates the data directory itself (permissions, provider settings, the daemon and the data layer).

For a full tour of what ends up in the directory, see the [`~/.8gent` dossier](../guides/dot-8gent-dossier.md). It is a dated snapshot, so trust the table below where they differ.

## Files

| File | What it controls |
|:-----|:-----------------|
| `~/.8gent/settings.json` | User settings: voice, performance, per-tab models, retry limits, UI. Defaults are in `packages/settings/defaults.ts`. Also holds `postMessage.allowedChats`. |
| `<project>/.8gent/settings.json` | Per-project overrides, merged over the user file. Only a short allowlist of keys is honoured (UI look, per-tab model among local providers, retry limits); anything else is dropped. See `packages/settings/project.ts`. |
| `~/.8gent/config.json` | Daemon and misc config: `daemon.port`, `daemon.authToken`, `runtime`/`model` for the daemon pool, `vision.videoIngestion`, `wake`. |
| `<project>/.8gent/config.json` | Project config. The `training_proxy` section (off by default) is read by the kernel package; the vision router also reads this file. |
| `~/.8gent/providers.json` | Provider settings and keys for the registry. Moves with `EIGHT_DATA_DIR`. `EIGHT_PROVIDERS_SETTINGS_PATH` points at a different file. |
| `~/.8gent/roles.json` | Role to provider and model assignment (`packages/orchestration/role-config.ts`). `EIGHT_ROLE_CONFIG_DIR` moves it. |
| `~/.8gent/mcp.json` | MCP servers. Accepts `servers` (stdio via `command`/`args`/`env`, or SSE via `url`/`headers`) and the older `mcpServers` form. Example: [mcp-config.example.json](../guides/mcp-config.example.json). |
| `~/.8gent/permissions.json` | Allow and deny patterns and the log path. See [Permission-Modes](Permission-Modes) and [permissions.md](../guides/permissions.md). |
| `~/.8gent/yolo.json` | The remembered yes or no for holding Infinite mode. |
| `~/.8gent/hooks.json` and `~/.8gent/hooks.yaml` | Lifecycle hooks. `EIGHT_HOOKS_YAML` names a different YAML file. See [hooks.md](../guides/hooks.md). |

Settings, MCP, hooks, provider and yolo files are protected: shell commands run by 8gent are not allowed to edit them.

## Environment variables

Names only. Set them in your shell; the meaning is one line each.

### Locations and run style

| Name | Meaning |
|:-----|:--------|
| `EIGHT_HOME` | Home directory 8gent resolves, ahead of `HOME`. |
| `EIGHT_DATA_DIR` | Relocates the `~/.8gent` data directory. |
| `EIGHT_WORKSPACE_ROOT` | Base directory for workspace checks when the current directory is not right. |
| `EIGHT_HEADLESS` | Treat the run as having no terminal (see [Permission-Modes](Permission-Modes)). |
| `EIGHT_AUTO_APPROVE` | Auto-approve for this run only. |
| `EIGHT_NO_OPEN` | Set to `1` to stop 8gent opening files it writes. |
| `EIGHT_ASCII` | Set to `1` to draw with plain ASCII. |
| `NO_COLOR`, `FORCE_COLOR` | Turn colour off or on. See [no-color.md](../guides/no-color.md). |

### Models and providers

| Name | Meaning |
|:-----|:--------|
| `EIGHT_MODEL` | Pins a specific model. |
| `EIGHT_PROVIDERS_ALLOW` | Comma list restricting which providers may be used. |
| `EIGHT_ALLOW_HOSTED` | Set to `1` to let hosted (non-local) providers be used. They are opt-in. |
| `EIGHT_PROVIDERS_SETTINGS_PATH` | Use a different `providers.json`. |
| `OLLAMA_HOST`, `OLLAMA_BASE_URL` | Where to reach Ollama. |
| `LM_STUDIO_HOST` | Where to reach LM Studio. |
| `APFEL_BASE_URL` | Where to reach the apfel local server. Set before start. |
| `OPENROUTER_API_KEY` | Key for OpenRouter, opt-in. |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`, `MINIMAX_API_KEY` | Keys for those hosted providers, opt-in. |
| `EIGHT_STREAM_IDLE_MS` | Idle timeout for streaming model requests. |

### Safety

| Name | Meaning |
|:-----|:--------|
| `EIGHT_SYSTEM_ONE` | System One shell checker. Unset is the default (on, rules plus a calibrated judge if present); `1` or `true` is strict; `0`, `false`, `off` or `no` turns it off. |
| `EIGHT_SYSTEM_ONE_TIMEOUT_MS` | How long System One waits for its judge. |
| `EIGHT_WORKSPACE_BOUNDARY` | Set to `off` to turn the read boundary off. |
| `EIGHT_SEATBELT` | macOS command sandbox: `0` turns it off, `require` refuses to run a command unwrapped. |

### Daemon

| Name | Meaning |
|:-----|:--------|
| `EIGHT_DAEMON_LOCAL` | Set to `1` to run the daemon locked to loopback (same as `--local`). |
| `EIGHT_DAEMON_URL` | Daemon the terminal UI should try first. |
| `EIGHT_DAEMON_TOKEN` | Auth token for the daemon. |
| `DAEMON_HOSTNAME` | Host the daemon binds; without a token it refuses non-loopback hosts. |
| `DEFAULT_RUNTIME`, `DEFAULT_MODEL` | Runtime and model for daemon sessions, ahead of `config.json`. |

Many more `EIGHT_*` names exist as test or experiment switches; they are not listed because they are not stable user settings.
