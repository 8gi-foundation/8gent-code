
<p align="center">
  <strong>An open source coding assistant for the terminal that runs local models by default.</strong>
</p>

<p align="center">
  <a href="https://www.apache.org/licenses/LICENSE-2.0"><img src="https://img.shields.io/badge/License-Apache_2.0-E8610A?style=for-the-badge&labelColor=1A1612" alt="Apache 2.0 License" /></a>
  <a href="https://8gent.dev"><img src="https://img.shields.io/badge/version-0.20.43-2D8A56?style=for-the-badge&labelColor=1A1612" alt="v0.20.43" /></a>
</p>

8gent Code reads your project, edits files, runs commands and works through multi-step tasks from a chat interface in your terminal. It is built to be free, local first and private: it starts on a model running on your own machine, needs no account or API key, and your prompts and code go only to a model on your machine unless you turn on a hosted provider. Web search and page fetches go to the web.

## Install

```bash
npm install -g @8gi-foundation/8gent-code
8gent
```

The package runs on Bun, or on Node 22.5 or newer when Bun is not installed. One-line installers that need neither Bun nor Node, plus per-OS notes, are in [docs/user/install.md](docs/user/install.md). New to the tool? Start with the [user guide](docs/user/README.md).

To run from source:

```bash
git clone https://github.com/8gi-foundation/8gent-code.git
cd 8gent-code
bun install
bun run tui
```

Check what 8gent found on your machine (models, optional tools) with `8gent doctor`.

## Models and providers

On first run 8gent picks a model you already have: LM Studio, then Ollama, then Apple's on-device server on Apple Silicon. The built-in `8gent` provider uses `eight-1.0-q3:14b` through Ollama. The `ollama` provider (any model you have pulled) and `lmstudio` (LM Studio's local server at `http://localhost:1234`) are also on by default. `llama-server` is available with `EIGHT_LOCAL_SERVER=llama-server`. If no model is reachable, the chat area shows how to connect one.

Hosted providers are opt-in and each needs your own key:

`openrouter`, `anthropic`, `openai`, `groq`, `grok`, `mistral`, `together`, `fireworks`, `replicate`, `deepseek`

To add one, run `8gent keys` (opens `~/.8gent/keys.env`) and add `NAME=value`, for example `OPENROUTER_API_KEY=...`, or use `/apikeys` inside a session. Then pick it with `/provider <name>` or `--provider=<name>` at launch. For OpenRouter's free tier use `/provider openrouter` and `/model auto:free`.

Hosted fallback is off by default. When a local model is unreachable, failover stays on your machine unless you set `EIGHT_ALLOW_HOSTED=1`. Every provider, key variable and flag is listed in [docs/install/providers.md](docs/install/providers.md).

## Everyday use

From the shell:

| Command | What it does |
|:--------|:-------------|
| `8gent` | Open the chat interface |
| `8gent --resume` | Resume the last session |
| `8gent run <prompt>` | One-shot run without the interface, see [headless use](docs/user/headless.md) |
| `8gent review` | Review the current git diff |
| `8gent keys` | Open your provider keys file |
| `8gent doctor` | Check models and tools |

Inside the interface:

| Command | What it does |
|:--------|:-------------|
| `/help` | List the core commands (`/help all` lists every command) |
| `/model`, `/provider` | Choose the model or the provider |
| `/plan`, `/status` | Show the current plan, or the session status |
| `/goal <goal>` | Run a goal to completion |
| `/compact` | Summarize older messages to free context |
| `/resume`, `/history` | Pick up an earlier session, or browse all of them |
| `/fork`, `/rewind` | Branch the conversation, or go back to a checkpoint |
| `/export` | Save the session as HTML |
| `/skills` | List and manage skills |
| `/boardroom` | Get a structured review of a proposed change from a set of role-based viewpoints before you build it. It returns a decision and, on go, a requirements doc, and writes no code |
| `/privacy` | Show how much stayed on this machine and each cloud call |
| `/hotkeys` | List every keyboard shortcut |
| `/quit` | Exit |

Type `/` to see the core commands, or start typing a name to find any other. In a message, `@` picks a project file, `!cmd` runs a shell command and sends its output with your next message, and `!!cmd` runs it without sending the output.

`Shift+Tab` changes how much 8gent may do without asking: Plan (changes nothing), Ask (the default), Guarded (safe steps run, risky ones ask) or Infinite (runs without asking, except pushes to the default branch and commands that send data; returns to Ask after 30 minutes). See [docs/guides/permission-modes.md](docs/guides/permission-modes.md). All keys are in [docs/user/keys.md](docs/user/keys.md).

## Configuration and files

Settings, keys and data live in `~/.8gent/`. Set `EIGHT_DATA_DIR` to move the folder.

| Path | What it holds |
|:-----|:--------------|
| `~/.8gent/keys.env` | Provider API keys |
| `~/.8gent/providers.json` | Your own endpoints (any server that speaks the OpenAI, Ollama or Anthropic format) |
| `~/.8gent/settings.json` | Preferences, such as `thinking.level` |
| `~/.8gent/failover.json` | Your own failover chains |
| `~/.8gent/skills/` | Skills, one markdown file each, each becomes a `/<name>` command |
| `~/.8gent/extensions/` | Extensions |
| `~/.8gent/mcp.json`, `~/.8gent/hooks.json` | MCP servers and hooks |

Set `NO_COLOR=1` to turn colour off.

## Privacy

With the defaults, prompts and code go only to a model on your own machine. Nothing is sent to a hosted provider until you add a key for it. If no local model is running and exactly one hosted provider has a key, 8gent uses it. Keys stay on your machine, in ~/.8gent/keys.env or the OS keychain. Web search and fetch requests also leave the machine; /privacy lists every off-machine request. Security reports: see [SECURITY.md](SECURITY.md).

## Help and contributing

- Questions and bugs: [open an issue](https://github.com/8gi-foundation/8gent-code/issues). Inside a session, `/bug <description>` saves a secret-free bug report folder on your machine to share.
- Contributing: read [CONTRIBUTING.md](CONTRIBUTING.md). Run `bun run test` and `bun run typecheck` before you open a pull request.
- Project site: [8gent.dev](https://8gent.dev)

## License

Apache 2.0. See [LICENSE](LICENSE).
