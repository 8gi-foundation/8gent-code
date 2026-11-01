# 8gent on macOS

macOS on Apple Silicon or Intel. Commands are for Terminal (zsh). All provider settings are listed in [providers.md](providers.md).

## 1. Install 8gent

```bash
curl -fsSL https://raw.githubusercontent.com/8gi-foundation/8gent-code/main/scripts/install.sh | sh
```

This puts `8gent` in `~/.local/bin`; add that folder to your PATH if it is not there (`export PATH="$HOME/.local/bin:$PATH"` in `~/.zshrc`). Then:

```bash
8gent --version
8gent doctor
```

From source instead: `git clone https://github.com/8gi-foundation/8gent-code.git && cd 8gent-code && bun install && bun run tui` (needs [Bun](https://bun.sh)). See [the user install guide](../user/install.md).

## 2. Pick a model server

### Ollama

Install from https://ollama.com/download, then:

```bash
ollama pull qwen3.5
curl -s http://localhost:11434/api/tags          # lists your models
8gent run "say hello in one sentence" --provider=ollama --model=qwen3.5
```

Another host or port: `export OLLAMA_BASE_URL=http://localhost:21434` (or `OLLAMA_HOST`).

### LM Studio

Install LM Studio, load a model, start its local server (port 1234).

```bash
curl -s http://localhost:1234/v1/models
8gent --provider=lmstudio
```

Another address: `export LM_STUDIO_HOST=http://localhost:1234` (no `/v1`).

### llama-server

Install llama.cpp (`brew install llama.cpp` puts `llama-server` on your PATH; releases and build steps are at https://github.com/ggml-org/llama.cpp). On Apple Silicon the Metal GPU is used by default.

```bash
llama-server -m ~/models/your-model.gguf --host 127.0.0.1 --port 8080
curl -s http://127.0.0.1:8080/health             # {"status":"ok"} when ready, 503 while loading
curl -s http://127.0.0.1:8080/v1/models
lsof -nP -iTCP:8080 -sTCP:LISTEN                 # must show 127.0.0.1:8080, not *:8080

export EIGHT_LOCAL_SERVER=llama-server
export LLAMA_SERVER_URL=http://127.0.0.1:8080    # optional, this is the default
8gent --provider=llama-server
```

Several models behind one server: write a preset `.ini` (one `[section]` per model with `model = /absolute/path.gguf`, shared keys under `[*]`; see the [Windows page](windows.md) for a full example) and start `llama-server --models-preset ~/models/recipes.ini --host 127.0.0.1 --port 8080`. The section names are the model ids.

With llama-server selected, `8gent run` needs a model: `8gent run "..." --provider=llama-server --model=<id from /v1/models>`.

### Apple on-device model (macOS 26 or newer, Apple Silicon)

Needs the bridge binary at `~/.8gent/bin/apple-foundation-bridge`. From a source clone with the Swift toolchain installed:

```bash
bun run scripts/install-apple-foundation.ts
```

Exit code 1 means the host is not supported, 2 no Swift toolchain, 3 build failed, 4 copy failed. Once the bridge is in place the provider turns on by itself and goes first in the local failover chain; select it with `--provider=apple-foundation`. The `apfel` provider is the alternative: run apfel (https://github.com/Arthur-Ficial/apfel) and select `--provider=apfel`; set `APFEL_BASE_URL` if you did not use the default port.

### OpenRouter, including the free tier

```bash
8gent keys       # opens ~/.8gent/keys.env; add OPENROUTER_API_KEY=your-key and save
export EIGHT_ALLOW_HOSTED=1
8gent
```

In the session: `/provider openrouter`, then `/model auto:free`. Other hosted providers: key variables in [providers.md](providers.md).

## 3. First prompt

```bash
8gent run "say hello in one sentence" --provider=<your provider> --model=<your model>
8gent
```

The first reply can take up to a minute while a local model loads. `/provider` and `/model` switch inside the full screen.

## 4. Troubleshooting

| You see | Cause | Fix |
|:--------|:------|:----|
| `8gent: command not found` | `~/.local/bin` not on PATH | Add it, open a new terminal |
| "no model" card on first start | No local server answering and no key | Start one above, or `8gent keys` |
| Port 8080 in use | Another program has it | `lsof -nP -iTCP:8080 -sTCP:LISTEN`; stop it or use `--port 8081` and set `LLAMA_SERVER_URL` |
| `/health` returns 503 | Model still loading | Poll until 200; check the model path |
| Ollama not found though running | Custom host | Set `OLLAMA_BASE_URL` (`doctor` may still show the default) |
| `apple-foundation` unavailable | Not macOS 26+, not Apple Silicon, or bridge missing | Check `ls ~/.8gent/bin/apple-foundation-bridge`; run the install script |
| Hosted provider refused | `EIGHT_ALLOW_HOSTED` not set | `export EIGHT_ALLOW_HOSTED=1` |
