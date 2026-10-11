# First run with a local model

8gent needs a model to answer. It finds Ollama at `http://localhost:11434` on its own and LM Studio at `http://localhost:1234`.

On Windows from a clone, type `bun bin/8gent.ts` where these pages say `8gent`, or add the profile function from [Install](install.md).

## 1. Get a model

Ollama (https://ollama.com/download; on Windows, use the Windows installer):

```bash
ollama pull qwen3.5
```

LM Studio works too: load a model and start its local server.

Pointing at a different host: set `OLLAMA_BASE_URL` (or `OLLAMA_HOST`) for Ollama, `LM_STUDIO_HOST` for LM Studio.

## 2. Check

```bash
8gent doctor
```

## 3. One answer

```bash
8gent run "say hello in one sentence"
```

The first run can print nothing for up to a minute while the model loads.

Choose the model for a run:

```bash
8gent run --provider=ollama --model=qwen3:14b "say hello"
```

## 4. The interface

```bash
8gent
```

(`bun run tui` from a clone.) Type a request and press Enter.

| Do this | With |
|---|---|
| Pick a model | `/model` or Ctrl+M |
| Pick a provider | `/provider` or Ctrl+Shift+M |
| Open the full list of commands | `/help` |
| Quit | `/quit` |

No model running: the screen shows a card saying so. Start Ollama or LM Studio and ask again.

## Cloud keys (optional)

Local is the default. To add a provider key, run `8gent keys` (opens `~/.8gent/keys.env`), then `8gent keys reload`. `8gent keys status` lists which keys are present without showing them.

## Save a default

```bash
8gent preferences set model qwen3:14b
8gent preferences get
```
