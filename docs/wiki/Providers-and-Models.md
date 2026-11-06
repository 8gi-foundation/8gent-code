# Providers and Models

8gent reaches a model through a provider. The registry is `PROVIDER_DEFAULTS` in `packages/providers/index.ts`. Choose with `--provider=<name>` and `--model=<id>` at launch, or `/provider <name>` and `/model` in a session. Full setup and variable list: [providers](../install/providers.md). What each choice sends off your machine: [Privacy](Privacy).

## Local providers (no key)

| Provider | Default model (in code) | Notes |
|:--|:--|:--|
| `8gent` | `eight-1.0-q3:14b` | Active by default. Served by Ollama at `http://localhost:11434`. |
| `ollama` | `qwen3.5:latest` | Enabled by default. Same address. |
| `lmstudio` | `google/gemma-4-26b-a4b` | Enabled by default. `LMSTUDIO_BASE_URL`, default `http://localhost:1234/v1`. |
| `llama-server` | `default` (the TUI uses the id the server lists) | Only enabled with `EIGHT_LOCAL_SERVER=llama-server`, which also turns Ollama off. Address from `LLAMA_SERVER_URL`. |
| `apple-foundation` | `apple-foundationmodel` | On-device bridge process. Enabled only on macOS 26+ on Apple Silicon with `~/.8gent/bin/apple-foundation-bridge` present. |
| `apfel` | `apple-foundationmodel` | Local HTTP service, default `http://127.0.0.1:11435/v1`. Enabled on the same host check. If `APFEL_BASE_URL` points to a non-loopback host, failover treats it as hosted (`packages/providers/failover.ts`). |

## Hosted providers (your own key)

Each is `enabled: false` in the registry until its key is set. Prompts go to that provider's API once you use it.

| Provider | Key variable | Default model (in code) |
|:--|:--|:--|
| `openrouter` | `OPENROUTER_API_KEY` | `anthropic/claude-3.5-sonnet` (`auto:free` picks a `:free` model) |
| `anthropic` | `ANTHROPIC_API_KEY` | `claude-3-5-sonnet-20241022` |
| `openai` | `OPENAI_API_KEY` | `gpt-4-turbo` |
| `groq` | `GROQ_API_KEY` | `llama-3.1-70b-versatile` |
| `grok` (xAI) | `XAI_API_KEY` | `grok-beta` |
| `mistral` | `MISTRAL_API_KEY` | `mistral-large-latest` |
| `together` | `TOGETHER_API_KEY` | `meta-llama/Llama-3-70b-chat-hf` |
| `fireworks` | `FIREWORKS_API_KEY` | `accounts/fireworks/models/llama-v3p1-70b-instruct` |
| `replicate` | `REPLICATE_API_TOKEN` | `meta/llama-2-70b-chat` |
| `deepseek` | `DEEPSEEK_API_KEY` | `deepseek-flash` |
| `minimax` | `MINIMAX_API_KEY` | none in code; the model list is requested from the endpoint |

### Adding a key

Per [providers](../install/providers.md): put `NAME=value` in `~/.8gent/keys.env` (`8gent keys` opens it; `keys status` and `keys reload` also exist), or export the variable in your shell. A shell export wins over the file. Never paste keys into chat.

## Other ways to connect

- **Your own endpoint:** declare it in `~/.8gent/providers.json` with a `baseUrl` and `compat` of `openai` (default), `ollama` or `anthropic` (`packages/providers/declared.ts`).
- **A CLI you are signed in to:** `host-cli-primary` and `host-cli-secondary` are off unless `PROVIDERS_ALLOW_HOST_CLI=1` and `PROVIDERS_HOST_CLI_PRIMARY_BINARY` (or `..._SECONDARY_BINARY`) name a binary.

## Failover

`ModelFailover` (`packages/providers/failover.ts`) moves to the next entry in a chain when a model is unreachable. Per [providers](../install/providers.md), the default text chain is the Apple on-device model when the host has it, then Ollama (`eight:latest`, then `qwen3.5:latest`), then OpenRouter's free model.

- Hosted entries are dropped unless `EIGHT_ALLOW_HOSTED=1`. If nothing is left, it stops with an error naming the variable instead of going to the cloud.
- `EIGHT_PROVIDERS_ALLOW=ollama,lmstudio` restricts chains to a list.
- `~/.8gent/failover.json` replaces the chains.
- `FAILOVER_LOG=1` prints each step to stderr.

## Routing policy

`routing.policy` in `~/.8gent/settings.json`, changed with `/route`: `local-only`, `local-first` (default) or `cloud-first`. See [routing policy](../ROUTING-POLICY.md).
