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
| `LLAMA_SERVER_URL` | Where your llama-server is. A trailing `/v1` is fine. | `http://127.0.0.1:8080` |

## What you will see

- The model list shows the model(s) your llama-server serves.
- The welcome screen does not warn that Ollama is missing.
- Automatic model routing, which picks between local models by task, is skipped: every turn goes to your llama-server model.

## System One without Ollama

System One, the local checker behind Guarded mode, can also run without Ollama. Put its GGUF file in:

```
~/.8gent/models/decide/
```

or point to a file with `EIGHT_DECIDE_GGUF=/path/to/model.gguf`. See [system-one-shared-judge.md](system-one-shared-judge.md).

## Turn it off

Unset `EIGHT_LOCAL_SERVER` (or set it to `ollama`) and switch provider back with `/provider`.
