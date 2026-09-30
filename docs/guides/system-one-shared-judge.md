# System One: one shared judge per machine

System One is the small local model that looks at a shell command before it runs and says allow, block, or ask you. It is on by default in every permission mode, and it is what makes [Guarded mode](permission-modes.md) work. `EIGHT_SYSTEM_ONE=0` turns it off.

Without a shared judge, every 8gent process would load its own copy of the System One model. With several tabs, agents or terminals open, that adds up. The shared judge, on by default, lets them all use one copy.

## On by default

There is nothing to set. The shared judge is served by Ollama on this machine. If Ollama is running and has System One's model installed (which models it looks for is in `packages/decide/README.md`), every process uses that one copy.

The first time a command needs the judge, 8gent says so in one line, naming the model, where it loads and its size, so a multi-GB load is never a surprise.

If no judge model is installed at all, nothing loads: 8gent says once that shell commands are checked by the safety rules and the read-only allowlist only, and carries on.

| Variable | What it does | Default |
|:---------|:-------------|:--------|
| `EIGHT_S1_SHARED_JUDGE` | `0`, `false`, `off` or `no` to give each process its own copy | on |
| `EIGHT_DECIDE_OLLAMA_HOST` | Which server holds the shared judge. It is never your chat model's `OLLAMA_HOST`, which may be another machine. | `http://localhost:11434` |

## What changes, and what does not

- **Same answers.** The shared judge is the same model with the same settings. Only where it runs changes. If the shared server does not serve that exact model, each process loads its own copy as before.
- **Less memory, faster first check.** Measured with three processes on one Mac: about 5.7 GB in total instead of about 16.9 GB, and 0 of 120 verdicts differed.

## If the shared judge goes away

If the shared server stops answering mid-session, 8gent loads a private copy of the judge in that process and carries on. It never falls back to a different server or a different model.

While the private copy loads, a command that needs a verdict waits within its time limit. If the limit runs out, that command is checked by the safety rules alone (with `EIGHT_SYSTEM_ONE=1`, and in Guarded, you are asked instead, or it is refused when nobody can be asked), and the next one uses the loaded judge. New sessions use the shared server again once it is back.

## When it does not apply

- With `EIGHT_LOCAL_SERVER=llama-server` Ollama is off, so each process uses its own copy. See [llama-server.md](llama-server.md).
- With `EIGHT_DECIDE_GGUF` set to a file, that file is used in-process.

## Turn it off

```bash
export EIGHT_S1_SHARED_JUDGE=0
```

Each process then loads its own copy. Nothing else changes. To turn System One off altogether, set `EIGHT_SYSTEM_ONE=0`.

More detail for contributors: `packages/decide/README.md`.
