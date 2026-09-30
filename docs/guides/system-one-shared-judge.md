# System One: one shared judge per machine

System One is the small local model that looks at a shell command before it runs and says allow, block, or ask you. It is what makes [Guarded mode](permission-modes.md) work. Outside Guarded it is off unless you set `EIGHT_SYSTEM_ONE=1`.

By default, every 8gent process loads its own copy of the System One model. With several tabs, agents or terminals open, that adds up. The shared judge lets them all use one copy.

## Turn it on

```bash
export EIGHT_S1_SHARED_JUDGE=1
```

The shared judge is served by Ollama on this machine. Make sure Ollama is running and has System One's model installed (which models it looks for is in `packages/decide/README.md`).

| Variable | What it does | Default |
|:---------|:-------------|:--------|
| `EIGHT_S1_SHARED_JUDGE` | `1`, `true` or `on` to share one judge | off |
| `EIGHT_DECIDE_OLLAMA_HOST` | Which server holds the shared judge. It is never your chat model's `OLLAMA_HOST`, which may be another machine. | `http://localhost:11434` |

## What changes, and what does not

- **Same answers.** The shared judge is the same model with the same settings. Only where it runs changes. If the shared server does not serve that exact model, each process loads its own copy as before.
- **Less memory, faster first check.** Measured with three processes on one Mac: about 5.7 GB in total instead of about 16.9 GB, and 0 of 120 verdicts differed.

## If the shared judge goes away

If the shared server stops answering mid-session, 8gent loads a private copy of the judge in that process and carries on. It never falls back to a different server or a different model.

While the private copy loads, a command that needs a verdict waits within its time limit. If the limit runs out, that command is blocked, not run, and the next one uses the loaded judge. New sessions use the shared server again once it is back.

## When it does not apply

- With `EIGHT_LOCAL_SERVER=llama-server` Ollama is off, so each process uses its own copy. See [llama-server.md](llama-server.md).
- With `EIGHT_DECIDE_GGUF` set to a file, that file is used in-process.

## Turn it off

Unset `EIGHT_S1_SHARED_JUDGE`. Nothing else changes.

More detail for contributors: `packages/decide/README.md`.
