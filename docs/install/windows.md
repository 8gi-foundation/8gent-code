# 8gent on Windows

Windows 10 or 11, PowerShell 5.1 or 7. Every command below is for PowerShell. Use `curl.exe` (not `curl`, which is a PowerShell alias). All provider settings are listed in [providers.md](providers.md).

## 1. Install 8gent

```powershell
irm https://raw.githubusercontent.com/8gi-foundation/8gent-code/main/scripts/install.ps1 | iex
```

This puts `8gent.exe` in `%LOCALAPPDATA%\Programs\8gent\bin` and adds it to your user PATH. Open a new terminal, then:

```powershell
8gent --version
8gent doctor
```

To run from source instead (Bun, git clone, `bun run tui`, WSL, gotchas) see [ARTALE-WINDOWS.md](../ARTALE-WINDOWS.md) and [the user install guide](../user/install.md).

## 2. Pick a model server

Choose one. 8gent finds Ollama and LM Studio by itself; llama-server needs two settings.

### Ollama

Install Ollama for Windows from https://ollama.com/download, then:

```powershell
ollama pull qwen3.5
curl.exe -s http://localhost:11434/api/tags     # lists your models
8gent run "say hello in one sentence" --provider=ollama --model=qwen3.5
```

Another host or port: `$env:OLLAMA_BASE_URL = "http://localhost:21434"` (or `OLLAMA_HOST`).

### LM Studio

Install LM Studio, load a model, and start its local server (default port 1234).

```powershell
curl.exe -s http://localhost:1234/v1/models      # lists the loaded model
8gent --provider=lmstudio
```

Another address: `$env:LM_STUDIO_HOST = "http://localhost:1234"` (no `/v1`).

### llama-server on an NVIDIA RTX card

With this on, 8gent never contacts Ollama. Everything stays on your machine.

1. Download the Windows CUDA build of `llama-server.exe` from https://github.com/ggml-org/llama.cpp/releases (pick the asset with `win` and `cuda` in its name; keep the CUDA runtime DLL zip from the same release beside it if one is listed). Install the current NVIDIA driver.

2. Start one model, bound to this machine only:

   ```powershell
   .\llama-server.exe -m C:\models\your-model.gguf --host 127.0.0.1 --port 8080 -ngl 99
   ```

   `--host 127.0.0.1` keeps it off your network. `--port 8080` is passed on purpose because 8gent defaults to 8080 and newer llama.cpp lists a different default. `-ngl` (`--n-gpu-layers`) takes a number, `auto` or `all`.

3. Or start several models behind one server (router mode) from a preset file. A preset is llama-server's own `.ini` format: each `[section]` is a model, keys are command-line flags without the dashes, `[*]` is shared. Use absolute paths. Save as `C:\models\recipes.ini`:

   ```ini
   version = 1

   [*]
   c = 8192
   n-gpu-layers = 99

   [model-a]
   model = C:\models\model-a-Q4_K_M.gguf

   [model-b]
   model = C:\models\model-b-Q4_K_M.gguf
   ```

   ```powershell
   .\llama-server.exe --models-preset C:\models\recipes.ini --host 127.0.0.1 --port 8080
   ```

   The section names are the model ids. `--models-max 1` keeps one model loaded at a time on a small card (default 4). Keep `--host` and `--port` on the command line; the router sets them per model. A team-supplied NVIDIA recipe preset file works the same way: point `--models-preset` at it.

4. Check it, from a second window:

   ```powershell
   curl.exe -s http://127.0.0.1:8080/health       # {"status":"ok"} with HTTP 200 when ready, 503 while loading
   curl.exe -s http://127.0.0.1:8080/v1/models    # the model ids 8gent will list
   ```

5. Prove it listens on loopback only:

   ```powershell
   netstat -ano | findstr ":8080" | findstr LISTENING
   ```

   Expect `TCP    127.0.0.1:8080    0.0.0.0:0    LISTENING    <pid>`. A line starting `0.0.0.0:8080` or `[::]:8080` means it is open to your network; restart with `--host 127.0.0.1`.

6. Point 8gent at it, in the window you launch from:

   ```powershell
   $env:EIGHT_LOCAL_SERVER = "llama-server"
   $env:LLAMA_SERVER_URL   = "http://127.0.0.1:8080"
   8gent --provider=llama-server
   ```

   `LLAMA_SERVER_URL` defaults to that address, so the second line is optional; a trailing `/v1` is accepted. Keep it on a loopback address, because 8gent will send prompts to whatever URL you give it. Keep the setting for new windows with `[Environment]::SetEnvironmentVariable("EIGHT_LOCAL_SERVER","llama-server","User")`.

7. Choose a model with `/model`; it lists the ids from `/v1/models`. For a one-shot run name the model yourself:

   ```powershell
   8gent run "say hello in one sentence" --provider=llama-server --model=model-a
   ```

   In router mode the first reply after choosing another model is slower while the router loads it.

### OpenRouter, including the free tier

```powershell
8gent keys        # opens %USERPROFILE%\.8gent\keys.env; add the line OPENROUTER_API_KEY=your-key and save
$env:EIGHT_ALLOW_HOSTED = "1"
8gent
```

In the session: `/provider openrouter`, then `/model auto:free`. Other hosted providers use the same steps with their key variable from [providers.md](providers.md).

## 3. First prompt

```powershell
8gent run "say hello in one sentence" --provider=<your provider> --model=<your model>
8gent
```

The first reply can take up to a minute while a local model loads. Then `/provider` and `/model` switch inside the full screen. Use Windows Terminal or PowerShell, not an editor pane: [keys and Windows Terminal notes](../user/keys.md).

## 4. Troubleshooting

| You see | Cause | Fix |
|:--------|:------|:----|
| `couldn't bind HTTP server socket`, or another pid on the netstat line | Port 8080 is taken | `netstat -ano \| findstr ":8080"`, `tasklist /FI "PID eq <pid>"`; stop it, or use `--port 8081` and set `LLAMA_SERVER_URL` to match |
| `/health` returns 503 | Model still loading (router mode loads on first request) | Poll `/health` until 200; check the `model =` path is absolute and the file exists |
| No models listed in 8gent | Wrong `LLAMA_SERVER_URL`, or server not up | `curl.exe -s http://127.0.0.1:8080/v1/models` |
| Slow replies and no CUDA device in the llama-server startup log | CPU build, or CUDA runtime DLLs missing | Use the CUDA zip, install the NVIDIA driver, confirm `nvidia-smi` shows load while a reply runs |
| 8gent still reports Ollama missing | `EIGHT_LOCAL_SERVER` not set in that window | `echo $env:EIGHT_LOCAL_SERVER` |
| "no model" card on first start | No local server answering and no key | Start a server above, or add a key with `8gent keys` |
| `Provider ... is not available on this host` | Provider needs another OS (Apple providers are macOS only) | Pick a provider from this page |
| Hosted provider refused | `EIGHT_ALLOW_HOSTED` not set | `$env:EIGHT_ALLOW_HOSTED = "1"` |
