# Providers: every way to run 8gent

8gent talks to a model through a provider. Pick one with `--provider=<name>` on launch (and `--model=<id>`), or switch inside a session with `/provider <name>` and `/model`. `8gent run` takes the same two flags. Setup per machine: [macOS](macos.md), [Windows](windows.md), [Linux](linux.md).

Nothing leaves your machine unless you choose a hosted provider and give it a key. Hosted providers also need `EIGHT_ALLOW_HOSTED=1` before the hosted failover step or child sessions will use them.

## Local providers

| Provider | Runs on | Default address | Needs | Select |
|:---------|:--------|:----------------|:------|:-------|
| `8gent` | Ollama server | `http://localhost:11434` | the model `eight-1.0-q3:14b` installed in Ollama | on by default |
| `ollama` | Ollama | `http://localhost:11434` | any model pulled with `ollama pull` | on by default |
| `lmstudio` | LM Studio | `http://localhost:1234` | LM Studio local server started, a model loaded | on by default |
| `llama-server` | llama.cpp `llama-server` | `http://127.0.0.1:8080` | `EIGHT_LOCAL_SERVER=llama-server` | `--provider=llama-server` |
| `apple-foundation` | on-device Apple model | none (bridge process) | macOS 26+, Apple Silicon, the bridge binary | on when the host qualifies |
| `apfel` | apfel service | `http://127.0.0.1:11435/v1` | apfel running | on when the host qualifies |

## Hosted providers (your own key)

Each is off until its key is set. Put the key in `~/.8gent/keys.env` (`8gent keys` opens it) as `NAME=value`, or export it in your shell. A shell export wins over the file.

| Provider | Key variable | Default model |
|:---------|:-------------|:--------------|
| `openrouter` | `OPENROUTER_API_KEY` | `anthropic/claude-3.5-sonnet` (use `auto:free` for the free tier) |
| `anthropic` | `ANTHROPIC_API_KEY` | `claude-3-5-sonnet-20241022` |
| `openai` | `OPENAI_API_KEY` | `gpt-4-turbo` |
| `groq` | `GROQ_API_KEY` | `llama-3.1-70b-versatile` |
| `grok` | `XAI_API_KEY` | `grok-beta` |
| `mistral` | `MISTRAL_API_KEY` | `mistral-large-latest` |
| `together` | `TOGETHER_API_KEY` | `meta-llama/Llama-3-70b-chat-hf` |
| `fireworks` | `FIREWORKS_API_KEY` | `accounts/fireworks/models/llama-v3p1-70b-instruct` |
| `replicate` | `REPLICATE_API_TOKEN` | `meta/llama-2-70b-chat` |
| `deepseek` | `DEEPSEEK_API_KEY` | `deepseek-flash` |

OpenRouter free tier: set `OPENROUTER_API_KEY`, then `/provider openrouter` and `/model auto:free`. `auto:free` asks OpenRouter for its live model list and picks the free (`:free`) model with the most context. If the list cannot be read it falls back to `meta-llama/llama-3-8b-instruct:free`.

## Your own endpoint

Any server that speaks the OpenAI, Ollama or Anthropic wire format can be declared in `~/.8gent/providers.json` with just a `baseUrl`:

```json
{
  "providers": {
    "my-vllm": { "baseUrl": "http://127.0.0.1:8000/v1", "compat": "openai" }
  }
}
```

`compat` is `openai` (default), `ollama` or `anthropic`. Then `--provider=my-vllm`. Only `http` and `https` URLs are accepted. `EIGHT_PROVIDERS_SETTINGS_PATH` points to a different file; `EIGHT_DATA_DIR` moves the whole `~/.8gent` folder.

## Using a CLI you are already signed in to

`PROVIDERS_ALLOW_HOST_CLI=1` plus `PROVIDERS_HOST_CLI_PRIMARY_BINARY=<name or full path>` (and `PROVIDERS_HOST_CLI_SECONDARY_BINARY` for a second slot) enables the `host-cli-primary` and `host-cli-secondary` providers. Off unless both are set.

## Environment variables

| Variable | What it does | Default |
|:---------|:-------------|:--------|
| `EIGHT_LOCAL_SERVER` | `llama-server` uses llama-server and never contacts Ollama; `ollama` or unset uses Ollama | `ollama` |
| `LLAMA_SERVER_URL` | llama-server root. A trailing `/v1` is fine | `http://127.0.0.1:8080` |
| `OLLAMA_BASE_URL` | Ollama root. Checked first | `http://localhost:11434` |
| `OLLAMA_HOST` | Ollama host, used when `OLLAMA_BASE_URL` is unset. A bare `host` gets port 11434 | unset |
| `LM_STUDIO_HOST` | LM Studio root for chat calls, without `/v1` | `http://localhost:1234` |
| `LMSTUDIO_BASE_URL` | LM Studio address in the provider list, with `/v1` | `http://localhost:1234/v1` |
| `LM_STUDIO_MAX_TOKENS` | Reply length cap for LM Studio | client default |
| `APFEL_BASE_URL` | apfel address. A non-loopback host counts as hosted | `http://127.0.0.1:11435/v1` |
| `APPLE_FOUNDATION_BRIDGE` | Path to the bridge binary | `~/.8gent/bin/apple-foundation-bridge` |
| `EIGHT_ALLOW_HOSTED` | `1` lets failover and child sessions use hosted providers | off |
| `EIGHT_PROVIDERS_ALLOW` | Comma list of providers failover may use | all local ones |
| `FAILOVER_LOG` | `1` prints each failover step to stderr | off |
| `OPENROUTER_API_KEY` and the other key variables above | Turn on that hosted provider | unset |
| `DEEPSEEK_BASE_URL`, `DEEPSEEK_USE_PRO` | DeepSeek address; `1` selects the Pro tier | DeepSeek default; off |
| `ANTHROPIC_BASE_URL` | Anthropic address | Anthropic default |
| `PROVIDERS_ALLOW_HOST_CLI`, `PROVIDERS_HOST_CLI_PRIMARY_BINARY`, `PROVIDERS_HOST_CLI_SECONDARY_BINARY` | CLI-session providers | off |
| `EIGHT_PROVIDERS_SETTINGS_PATH`, `EIGHT_DATA_DIR` | Where `providers.json` and `~/.8gent` live | `~/.8gent` |

## Flags

| Flag | What it does |
|:-----|:-------------|
| `--provider=<name>` | Choose the provider for this launch. It wins over a saved choice |
| `--model=<id>` | Choose the model for this launch |
| `/provider <name>`, `/model` (or Ctrl+L) | The same, inside a session |
| `8gent preferences set model <id>` | Save a default model |
| `8gent keys` | Open `~/.8gent/keys.env` (also `keys status`, `keys reload`) |
| `8gent doctor` | Show what was found: Ollama and its models, optional tools |

## Failover

When a model is unreachable, 8gent moves to the next entry in a chain. The default chain for the text channel is: the Apple on-device model first when the host has it, then Ollama (`eight:latest`, then `qwen3.5:latest`), then OpenRouter's free model. Hosted entries are dropped unless `EIGHT_ALLOW_HOSTED=1`, so by default failover stays on your machine. If every entry is filtered out, 8gent stops with a message naming the variable to set instead of quietly going to the cloud. Replace the chains with your own in `~/.8gent/failover.json`; narrow them with `EIGHT_PROVIDERS_ALLOW=ollama,lmstudio`.

With `EIGHT_LOCAL_SERVER=llama-server`, Ollama is never contacted, and automatic routing between local models is skipped: every turn goes to your llama-server model.
