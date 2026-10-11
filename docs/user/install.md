# Install and first run

## Windows

```powershell
powershell -c "irm bun.sh/install.ps1 | iex"   # or download Bun from bun.sh/docs/installation
bun --version                                  # in a new terminal
git config --global core.longpaths true
git clone --depth 1 https://github.com/8gi-foundation/8gent-code.git
cd 8gent-code
bun install
bun bin/8gent.ts doctor
bun run tui
```

On Windows from a clone, type `bun bin/8gent.ts` where these pages say `8gent`, or add this to your profile (`notepad $PROFILE`; change the path if you cloned elsewhere):

```powershell
function 8gent { bun run "$HOME\8gent-code\bin\8gent.ts" @args }
```

Update: `git fetch --depth 1 origin main`, `git reset --hard origin/main`, `bun install`.

WSL and the compiled `.exe` are covered in [ARTALE-WINDOWS.md](../ARTALE-WINDOWS.md).

## macOS and Linux

Same clone steps. npm is an optional channel:

```bash
npm install -g @8gi-foundation/8gent-code
```

## A local model

Install [Ollama](https://ollama.com/download) (on Windows, the Windows installer), then:

```bash
ollama pull qwen3.5
8gent doctor
8gent run "say hello in one sentence"
8gent
```

LM Studio on `localhost:1234` is found too. Use `OLLAMA_BASE_URL` or `LM_STUDIO_HOST` for another host.

Pick a model with `/model` (Ctrl+M) and a provider with `/provider`. Save a default: `8gent preferences set model qwen3:14b`. Provider keys: `8gent keys`.
