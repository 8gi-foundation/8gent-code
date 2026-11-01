# 8gent on Linux

x64 or arm64. Commands are for bash. All provider settings are listed in [providers.md](providers.md).

On an Android phone (Termux, or a kali or arch proot), follow [android-termux.md](android-termux.md) instead: it covers the Node 22.5 requirement and the exact install lines.

## 1. Install 8gent

```bash
curl -fsSL https://raw.githubusercontent.com/8gi-foundation/8gent-code/main/scripts/install.sh | sh
```

This puts `8gent` in `~/.local/bin`; add it to your PATH if needed (`export PATH="$HOME/.local/bin:$PATH"` in `~/.bashrc`). Then:

```bash
8gent --version
8gent doctor
```

From source instead: `git clone https://github.com/8gi-foundation/8gent-code.git && cd 8gent-code && bun install && bun run tui` (needs [Bun](https://bun.sh); install `git`, `unzip` and `curl` first). See [the user install guide](../user/install.md).

## 2. Pick a model server

### Ollama

```bash
curl -fsSL https://ollama.com/install.sh | sh
ollama pull qwen3.5
curl -s http://localhost:11434/api/tags
8gent run "say hello in one sentence" --provider=ollama --model=qwen3.5
```

Another host or port: `export OLLAMA_BASE_URL=http://localhost:21434` (or `OLLAMA_HOST`).

### LM Studio

Run the LM Studio local server (port 1234) with a model loaded.

```bash
curl -s http://localhost:1234/v1/models
8gent --provider=lmstudio
```

Another address: `export LM_STUDIO_HOST=http://localhost:1234` (no `/v1`).

### llama-server

Get `llama-server` from the llama.cpp releases (https://github.com/ggml-org/llama.cpp/releases) or build it. For an NVIDIA GPU build with CUDA:

```bash
git clone https://github.com/ggml-org/llama.cpp && cd llama.cpp
cmake -B build -DGGML_CUDA=ON
cmake --build build --config Release -j
```

Run it, bound to this machine only:

```bash
./build/bin/llama-server -m ~/models/your-model.gguf --host 127.0.0.1 --port 8080 -ngl 99
curl -s http://127.0.0.1:8080/health            # {"status":"ok"} when ready, 503 while loading
curl -s http://127.0.0.1:8080/v1/models
ss -ltnp | grep ':8080'                          # must show 127.0.0.1:8080, not 0.0.0.0 or [::]

export EIGHT_LOCAL_SERVER=llama-server
export LLAMA_SERVER_URL=http://127.0.0.1:8080   # optional, this is the default
8gent --provider=llama-server
```

Several models behind one server: a preset `.ini` (one `[section]` per model with `model = /absolute/path.gguf`, shared keys under `[*]`; full example on the [Windows page](windows.md)) and `llama-server --models-preset ~/models/recipes.ini --host 127.0.0.1 --port 8080`. Section names are the model ids. With llama-server selected, `8gent run` needs `--model=<id from /v1/models>`.

### OpenRouter, including the free tier

```bash
8gent keys       # opens ~/.8gent/keys.env in your editor; add OPENROUTER_API_KEY=your-key and save
export EIGHT_ALLOW_HOSTED=1
8gent
```

In the session: `/provider openrouter`, then `/model auto:free`. Other hosted providers: key variables in [providers.md](providers.md). The Apple providers are macOS only.

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
| Port 8080 in use | Another program has it | `ss -ltnp \| grep ':8080'`; stop it or use `--port 8081` and set `LLAMA_SERVER_URL` |
| `/health` returns 503 | Model still loading | Poll until 200; check the model path |
| llama-server is slow, no CUDA device in its log | Built without CUDA, or driver missing | Rebuild with `-DGGML_CUDA=ON`; `nvidia-smi` must work |
| `keys` does not open an editor | No `xdg-open` handler | Edit `~/.8gent/keys.env` by hand |
| Hosted provider refused | `EIGHT_ALLOW_HOSTED` not set | `export EIGHT_ALLOW_HOSTED=1` |
