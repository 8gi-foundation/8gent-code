# Running without Ollama (llama-server)

8gent Code can run on [llama.cpp](https://github.com/ggml-org/llama.cpp)'s `llama-server` instead of Ollama. With this switched on, 8gent never contacts Ollama at all, so you do not need it installed.

If you do nothing, 8gent uses Ollama exactly as before.

## Turn it on

1. Start `llama-server` with a chat model, for example:

   ```bash
   llama-server -m ./your-model.gguf --port 8080
   ```

2. Tell 8gent to use it:

   ```bash
   export EIGHT_LOCAL_SERVER=llama-server
   8gent --provider=llama-server
   ```

   You can also switch inside a session with `/provider llama-server`.

On a machine with no saved provider, 8gent picks llama-server on its own once `EIGHT_LOCAL_SERVER=llama-server` is set and the server is answering. If you have used another provider before, pass `--provider=llama-server` once so it is chosen over your saved one.

## Settings

| Variable | What it does | Default |
|:---------|:-------------|:--------|
| `EIGHT_LOCAL_SERVER` | `llama-server` to use llama-server, `ollama` (or unset) for Ollama | `ollama` |
| `LLAMA_SERVER_URL` | Where your llama-server is. A trailing `/v1` is fine. Loopback only unless the next line is set. | `http://127.0.0.1:8080` |
| `EIGHT_ALLOW_REMOTE_LLAMA` | `1` allows a non-loopback `LLAMA_SERVER_URL` | unset |

## What you will see

- The model list shows the model(s) your llama-server serves.
- The welcome screen does not warn that Ollama is missing.
- Automatic model routing, which picks between local models by task, is skipped: every turn goes to your llama-server model.

## Pi-style llama.cpp router (several models, one server)

llama-server's router mode serves every model in a preset file from one loopback port and loads each GGUF on demand. 8gent reads that list, switches model per request, and drives the router from inside a session. The preset file is llama-server's own `.ini` format (one `[section]` per model id, keys are the command-line flags without dashes, for example `ctx-size = 65536`, `jinja = true`, `n-gpu-layers = 99`); 8gent never parses or writes it.

Windows PowerShell, with an NVIDIA recipe saved as a preset file:

```powershell
.\llama-server.exe --models-preset C:\path\to\your.ini --host 127.0.0.1 --port 8080 --metrics
$env:EIGHT_LOCAL_SERVER = "llama-server"
8gent --provider=llama-server
```

`--metrics` is optional; it turns on the throughput line in `/llama status`. For the CUDA build, the preset example and the netstat loopback check, see "Run with llama-server on Windows" in [ARTALE-WINDOWS.md](../ARTALE-WINDOWS.md).

Inside the session:

| Command | What it does |
|:--------|:-------------|
| `/llama status` | Health, router or single mode, loaded models, context size, sleep state, and Prometheus throughput when `--metrics` is on |
| `/models` | Every model id the server lists, its state (loaded, unloaded, loading, sleeping), `*` on the current one |
| `/models use <id>` | Loads the model if the router has it unloaded, then switches to it. The conversation stays: only the model changes. If the server cannot load it, you see its reason and stay on the current model |
| `/llama load <id>`, `/llama unload <id>` | The router's own load and unload calls, for warming or freeing VRAM |

llama-server does not report GPU memory over HTTP, so `/llama status` points you to `nvidia-smi` for that. Every call has a short timeout (3 s; 120 s for a load), so a stopped server never freezes the session.

### Loopback only, unless you say otherwise

8gent refuses a `LLAMA_SERVER_URL` that is not `127.0.0.1`, `localhost` or `::1`: it prints one warning and uses `http://127.0.0.1:8080` instead, so a stale variable never sends your prompts over the network. To use a llama-server on another machine on purpose, set `EIGHT_ALLOW_REMOTE_LLAMA=1`. Start llama-server with `--host 127.0.0.1` so it is not reachable from the network either.

## System One without Ollama

System One, the local checker behind Guarded mode, can also run without Ollama. Put its GGUF file in:

```
~/.8gent/models/decide/
```

or point to a file with `EIGHT_DECIDE_GGUF=/path/to/model.gguf`. See [system-one-shared-judge.md](system-one-shared-judge.md).

## Turn it off

Unset `EIGHT_LOCAL_SERVER` (or set it to `ollama`) and switch provider back with `/provider`.
