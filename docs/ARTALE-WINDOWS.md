# Running 8gent-code on Windows (and WSL) from source

Everything here uses public URLs. No GitHub login is needed.

Why source: npm still serves 0.17.0 and the GitHub releases carry no Windows installer. A
clone is the only current way to get latest. This path is exercised on every relevant PR by
`.github/workflows/windows-smoke.yml` on a GitHub-hosted `windows-latest` runner (shallow
clone, `bun install`, `--version`, `doctor`, a headless JSON-RPC check, the TUI bundle build,
and the TUI starting up to the point where it needs a real terminal).

## A. Native Windows (PowerShell 7 or Windows PowerShell)

1. Install Bun, then open a NEW terminal so it is on PATH. Official instructions:
   https://bun.sh/docs/installation (Windows tab). The one-liner there is
   `powershell -c "irm bun.sh/install.ps1 | iex"`. Then:

   ```powershell
   bun --version
   ```

2. Install Git for Windows if `git --version` fails: https://git-scm.com/download/win

3. Clone shallow (one commit instead of the 1900-commit history, which is what stalled on the
   tailnet) and install:

   ```powershell
   git config --global core.longpaths true
   git clone --depth 1 https://github.com/8gi-foundation/8gent-code.git
   cd 8gent-code
   bun install
   ```

4. Check it:

   ```powershell
   bun bin/8gent.ts --version
   bun bin/8gent.ts doctor
   ```

   `doctor` lists Ollama, mpv, yt-dlp and rg as missing on a fresh machine. All are optional.
   On the GitHub Windows runner the real output ends with `4 issue(s) found.` (Ollama, mpv,
   yt-dlp, rg). Yours will differ if you have installed any of them.

5. Run it:

   ```powershell
   bun run tui
   ```

   To launch from any folder, add this to your PowerShell profile (`notepad $PROFILE`):

   ```powershell
   function 8gent { bun run "$HOME\8gent-code\bin\8gent.ts" @args }
   ```

6. A model. Local only: install Ollama for Windows (https://ollama.com/download), then
   `ollama pull qwen3.5`. 8gent finds Ollama at `http://localhost:11434` by itself. With no
   model running, the first run shows a card saying so.

7. Update later:

   ```powershell
   cd 8gent-code
   git pull
   bun install
   ```

   If `git pull` complains about the shallow history, this always works:

   ```powershell
   git fetch --depth 1 origin main
   git reset --hard origin/main
   bun install
   ```

   `reset --hard` discards local edits to tracked files. Commit or copy yours first.

## A2. Run with llama-server on Windows (NVIDIA RTX)

Use this instead of Ollama (step 6 above). With it on, 8gent never contacts Ollama. Everything
below stays on your machine.

**Status.** The 8gent side (provider, env vars, `/v1/models`, `/health`) is read from the code
and the llama.cpp server docs. Nobody has run this on Windows yet. Whether two preset models
switch inside one 8gent session is not verified on Windows; that is what the smoke test in
issue #4206 checks. Lines marked UNVERIFIED are the ones to watch.

1. **Get a CUDA build of `llama-server.exe`.** Download the Windows CUDA zip from the
   llama.cpp releases page (https://github.com/ggml-org/llama.cpp/releases), unzip it, and
   keep the CUDA runtime DLL zip from the same release beside it if the release lists one.
   A CPU-only build also starts but ignores your GPU (see troubleshooting). Exact asset
   names change per release, so pick by the "cuda" and "win" words. UNVERIFIED on your card.

2. **Single model, simplest start** (bound to this machine only):

   ```powershell
   .\llama-server.exe -m C:\models\your-model.gguf --host 127.0.0.1 --port 8080 -ngl 99
   ```

   `--host 127.0.0.1` keeps it off your network. `--port 8080` is passed on purpose: 8gent
   defaults to 8080, and newer llama.cpp docs list a different default port.
   `-ngl` (`--n-gpu-layers`) puts layers on the GPU; the docs accept a number, `auto` or `all`.

3. **Router mode with a preset file** (several models, one server). Save this as
   `C:\models\recipes.ini`. It is llama-server's own format: each `[section]` is a model, keys
   are command-line flags without the dashes, and `[*]` is shared by all. Use absolute paths.
   If you have an NVIDIA recipe preset file from the team, use it as is instead of this one.

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

   Start the router with no `-m`:

   ```powershell
   .\llama-server.exe --models-preset C:\models\recipes.ini --host 127.0.0.1 --port 8080
   ```

   The section names (`model-a`, `model-b`) are the model ids. `--models-max N` caps how many
   stay loaded at once (default 4 per the docs); on a small card set it to 1. Command-line
   flags beat the preset file, and the router overrides `host`, `port` and the API key per
   model, so keep those on the command line.

4. **Check it is up** (new PowerShell window). `/health` returns HTTP 200 `{"status":"ok"}`
   when ready and 503 while a model loads. 8gent reads this same endpoint.

   ```powershell
   curl.exe -s http://127.0.0.1:8080/health
   curl.exe -s http://127.0.0.1:8080/v1/models
   ```

   `/v1/models` is how 8gent lists models (`data[].id`). In router mode the ids should be your
   section names. UNVERIFIED in router mode on Windows.

5. **Prove it is loopback only.** The local address must be `127.0.0.1:8080`, never `0.0.0.0`
   or `[::]`:

   ```powershell
   netstat -ano | findstr ":8080" | findstr LISTENING
   ```

   Expected: `TCP    127.0.0.1:8080    0.0.0.0:0    LISTENING    <pid>`. Router mode may also
   show short-lived loopback ports for the model processes it spawns; those should be
   `127.0.0.1` too.

6. **Point 8gent at it** (same PowerShell window you start 8gent from):

   ```powershell
   $env:EIGHT_LOCAL_SERVER = "llama-server"
   $env:LLAMA_SERVER_URL   = "http://127.0.0.1:8080"
   bun run tui --provider=llama-server
   ```

   Or, with the `8gent` function from step 5: `8gent --provider=llama-server`.
   `LLAMA_SERVER_URL` already defaults to `http://127.0.0.1:8080` and a trailing `/v1` is
   accepted, so that line is optional. `EIGHT_LOCAL_SERVER=llama-server` is what turns Ollama
   off. To keep it across windows: `[Environment]::SetEnvironmentVariable("EIGHT_LOCAL_SERVER","llama-server","User")`
   and open a new window. Inside a session, `/provider llama-server` also works. Passing
   `--provider=llama-server` once matters if you used another provider before, because a saved
   provider otherwise wins.

   Keep `LLAMA_SERVER_URL` on a loopback address. 8gent accepts any URL, so a LAN address
   would send your prompts over the network.

7. **Pick a model.** Run `/model` in the TUI and choose one of the ids from `/v1/models`.
   The client sends the chosen id in each request's `model` field, which is the field the
   router uses to route. Switching between `model-a` and `model-b` in one session is the
   unverified part: **not yet verified on Windows, and the subject of the #4206 smoke test.**
   Expect the first reply after a switch to be slower while the router loads the model.

**Troubleshooting**

- **Port in use** (`couldn't bind HTTP server socket`, or the netstat line shows another pid):
  find the owner with `netstat -ano | findstr ":8080"`, then `tasklist /FI "PID eq <pid>"`.
  Stop it, or start llama-server with `--port 8081` and set
  `$env:LLAMA_SERVER_URL = "http://127.0.0.1:8081"`.
- **Model not loaded** (`/health` returns 503, or 8gent shows no models): a large model takes
  a while to load; poll `/health` until it returns 200. In router mode the model loads on the
  first request, so the first reply is slow. Confirm the `model =` path is absolute and the
  file exists, and read the llama-server window for the error.
- **CUDA build missing** (it runs but slowly, and the startup log shows no CUDA device): you
  have the CPU build or the CUDA runtime DLLs are missing. Install the current NVIDIA driver,
  use the CUDA zip from the releases page, and check `nvidia-smi` shows your card while a
  reply is generating.
- **8gent still says Ollama is missing:** `EIGHT_LOCAL_SERVER` is not set in the window that
  launched 8gent. Run `echo $env:EIGHT_LOCAL_SERVER`.
- **Other bound-address or port questions:** `.\llama-server.exe --help` on your build is the
  source of truth for flags.

Reference: `docs/guides/llama-server.md`, `packages/local-model-server/select.ts`,
`packages/local-model-server/llama-server.ts`, and the llama.cpp server README
(https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md).

## B. WSL (Ubuntu)

Work inside the Linux filesystem (`~`), not `/mnt/c/...`. Bun installs are several times slower
across the Windows mount.

```bash
sudo apt update && sudo apt install -y git unzip curl   # unzip is required by the Bun installer
# install Bun with the Linux command on https://bun.sh/docs/installation, then:
exec $SHELL                                              # pick up PATH
git clone --depth 1 https://github.com/8gi-foundation/8gent-code.git ~/8gent-code
cd ~/8gent-code && bun install
bun bin/8gent.ts doctor
bun run tui
```

Update: `cd ~/8gent-code && git pull && bun install`.

Model: use Ollama, local only. Either install it inside WSL (`ollama pull qwen3.5` there; 8gent
finds `localhost:11434`), or reuse the Ollama already running on Windows. For the second, on
Windows set the user environment variable `OLLAMA_HOST=0.0.0.0` and restart Ollama, then in WSL
point 8gent at the Windows host. 8gent reads `OLLAMA_BASE_URL`, then `OLLAMA_HOST`
(`packages/eight/clients/ollama.ts`):

```bash
# default WSL2 (NAT): the Windows host is the default gateway
export OLLAMA_BASE_URL="http://$(ip route show default | awk '{print $3}'):11434"
curl "$OLLAMA_BASE_URL/api/tags"     # must list your models before you start 8gent
```

With WSL2 mirrored networking (`networkingMode=mirrored` in `.wslconfig`) `localhost:11434`
already reaches Windows and no variable is needed. This was not run on a WSL machine; if the
`curl` fails, fall back to Ollama inside WSL.

## C. Known gotchas

- **Fixed in this PR:** `bun scripts/build-bundles.ts` (the `npm run build` path) failed on
  Windows with `EINVAL: failed to open root directory: /D:/...` because it built a path from
  `new URL(...).pathname`. It now uses `fileURLToPath`. A test (`tests/windows`) fails if the
  pattern comes back. Running from source (steps above) never hit this.
- **The compiled `.exe` is not fully standalone.** `8gent-windows-x64.exe` runs `--version`,
  `--help`, `doctor` and `--rpc` on its own, but `tui` launches `bun run tui.js` from beside the
  exe. You still need Bun on PATH and `tui.js` in the same folder. For you, running from source
  is simpler. The CI artifact ships both files.
- **SmartScreen** may warn on the unsigned `.exe`. Source runs are not affected.
- **The TUI needs a real terminal.** Use Windows Terminal or PowerShell, not a pipe or an
  editor output pane. Piped, it stops with "Raw mode is not supported on the current
  process.stdin". That is Ink, not a bug.
- **Line endings.** `.gitattributes` pins LF, so a clone with `core.autocrlf=true` still checks
  out LF.
- **Antivirus** can slow `bun install` on the first run. Excluding the clone folder helps.
- `bun run smoke:fast` currently fails on main on every OS (a missing export in
  `apps/tui/src/lib/slash-commands.ts`). It is not a Windows problem; use `doctor` as the
  health check instead.
- The Forgejo 2FA problem does not affect any of the above. Everything here comes from public
  GitHub.
