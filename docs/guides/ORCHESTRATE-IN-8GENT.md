# Orchestrate in 8gent: the daemon behind 8gent Browser

8gent Browser talks to an 8gent-code daemon over a WebSocket. No daemon, no
answers: the browser shows "The hive is offline". This guide gets a daemon
running on your own machine, on loopback only, answering with a model on that
machine, and gets 8gent Browser talking to it.

Two set-ups are covered: macOS (James) and Windows (Artale).

> **What is proven and what is not (11 Oct 2026)**
>
> - Proven by CI on Windows: the exe runs the daemon on 127.0.0.1, refuses a
>   foreign web page, and opens a browser session.
> - Proven on James's Mac: a real prompt answered by a local Ollama model
>   through the daemon.
> - Not yet proven on a real Windows machine: an Ollama answer through the
>   daemon, the logon task across a sign-out and a reboot, the browser on
>   Windows. Artale's first run is that proof: report back what you see.

## How the browser finds the daemon

- The browser connects to `ws://localhost:18789` by default.
- `EIGHT_DAEMON_URL` changes that address. Any host that is not loopback is
  upgraded to `wss://`.
- `EIGHT_DAEMON_TOKEN` is sent first when the daemon asks for a token. A
  loopback daemon does not ask for one.
- A **named** browser profile (`EIGHT_BROWSER_PROFILE` set) only connects when
  `EIGHT_DAEMON_URL` is set. The default profile always connects.
- The daemon answers `http://127.0.0.1:18789/health` with `{"status":"ok",...}`.
  If that works, the browser's dot goes live within a few seconds.

## Who can reach the daemon

- It listens on `127.0.0.1` only, so nothing on your network can reach it.
  `DAEMON_HOSTNAME=0.0.0.0` widens that, and the daemon refuses to start that
  way unless it has a token (`daemon.authToken` in `~/.8gent/config.json`).
- Web pages are refused. A request carrying an `Origin` header is only served
  when it comes from `localhost`, `127.0.0.1` or an `eight://` page; every
  other site gets 403. Native programs (8gent Browser itself, the TUI, scripts)
  send no `Origin` and are served. `EIGHT_DAEMON_ALLOWED_ORIGINS` (comma list)
  adds an origin on purpose.
- The `Host` header must be a loopback name or the bound address, which stops
  DNS rebinding. `EIGHT_DAEMON_ALLOWED_HOSTS` adds a host name on purpose.

## Which model answers

The daemon uses `DEFAULT_RUNTIME` and `DEFAULT_MODEL`. Hosted providers are off
unless `EIGHT_ALLOW_HOSTED=1`, so a local daemon stays on your machine. Pick a
model you have pulled: `ollama list` shows them.

## macOS (James)

On James's Mac the daemon already runs as a login service (`com.8gent.daemon`),
started from his own launcher script on loopback. Its model comes from
`~/.8gent/profile.json`:

```json
{ "models": { "code": { "runtime": "ollama", "model": "qwen3.5:9b", "base_url": "http://127.0.0.1:11434" } } }
```

Do not run `8gent daemon install` there: it writes a plist under the same name
and replaces his launcher.

1. Make sure only the service holds port 18789:

   ```bash
   lsof -nP -iTCP:18789 -sTCP:LISTEN
   ```

   You want one line, ending `127.0.0.1:18789 (LISTEN)`. A second line ending
   `*:18789 (LISTEN)` is a stray daemon from an older `bun run daemon`. It
   listens on every interface with no token, and on macOS it wins the
   connection. Stop it with `kill <its pid>`, only that pid, and only if it is
   not the one `svc status daemon` reports.

2. Restart the service so it picks up the model (prints OK or FAIL):

   ```bash
   ~/.8gent/bin/svc restart daemon
   ```

   Success: `OK   daemon  running (pid ...), http://127.0.0.1:18789/health ok`,
   and `~/.8gent/bin/svc logs daemon` shows `model=qwen3.5:9b runtime=ollama`.

3. Open 8gent Browser from the Dock or Applications. With the default profile
   there is nothing to type: it connects to `ws://localhost:18789` on its own.

Do not set `EIGHT_DAEMON_URL` for the whole login session (`launchctl setenv`).
8gent Computer reads the same variable and expects a path (`/store`) on it, so a
session-wide value breaks it.

On a fresh Mac with no launcher script, `8gent daemon install` sets up the same
kind of service: launchd, at login, restarted if it exits, logs in
`~/.8gent/daemon.log`.

## Windows (Artale)

The goal: 8gent Browser open, its dot live, and typing `>` in the address bar
gets an answer from a model on your own PC.

You need about 6 GB of free disk and 8 GB of free RAM for the model below. On
less, pick a smaller model in step 2.

### 1. Get the 8gent exe

Downloading from GitHub Actions needs a GitHub account. **If you do not have
one, ask James for the zip** (the exe and its `.sha256`) and skip to the hash check. James downloads it and
sends it to you directly or through a Forgejo release.

- Release builds: from v0.20.0 on, `8gent-windows-x64.exe` will be on the
  [8gent-code releases](https://github.com/8gi-foundation/8gent-code/releases).
  It is not released yet.
- Today: the latest green
  [Windows Smoke run](https://github.com/8gi-foundation/8gent-code/actions/workflows/windows-smoke.yml),
  **Artifacts**, `8gent-windows-x64`. Artifacts expire after 14 days.

The zip holds two files. Keep both together in the folder the exe will live
in, for example `%USERPROFILE%\8gent` (the TUI is inside the exe):

- `8gent-windows-x64.exe`
- `8gent-windows-x64.exe.sha256`

Check the exe is the one CI built. In PowerShell, in that folder:

```powershell
$a=(Get-FileHash .\8gent-windows-x64.exe -Algorithm SHA256).Hash.ToLower(); $b=(Get-Content .\8gent-windows-x64.exe.sha256).Split(' ')[0]; if ($a -eq $b) {"MATCH - safe to use"} else {"MISMATCH - do not run it"}
```

The exe is not code-signed, so Windows SmartScreen may warn the first time.
After a MATCH, click **More info**, then **Run anyway**.

### 2. Give the daemon a model

Install [Ollama for Windows](https://ollama.com/download/windows) and leave it
running (its tray icon shows). Then:

```powershell
ollama pull qwen3:8b
ollama list
```

Success: `ollama list` shows `qwen3:8b`. Then save the choice for your account:

```powershell
setx DEFAULT_RUNTIME ollama
setx DEFAULT_MODEL qwen3:8b
```

Open a **new** PowerShell window. Success: `echo $env:DEFAULT_MODEL` prints
`qwen3:8b`. `setx` only reaches programs started after it, and the logon task
in step 4 only after your next sign-in.

### 3. Run the daemon once, in the foreground

In the new window:

```powershell
cd $env:USERPROFILE\8gent
.\8gent-windows-x64.exe daemon run
```

Success: `[daemon] ready - ws://127.0.0.1:18789`. In a second window:

```powershell
Invoke-RestMethod http://127.0.0.1:18789/health
```

Success: `status : ok`. Windows does not ask about the firewall, because the
daemon only listens on loopback. Press Ctrl+C in the first window to stop it.

### 4. Start it at every logon

1. Make sure the exe is in its final folder. The task runs the exe from where
   it is when you install, so move it first.
2. Install and check:

   ```powershell
   .\8gent-windows-x64.exe daemon install
   .\8gent-windows-x64.exe daemon status
   ```

   Success: `daemon status` says `running`.
3. Sign out and back in once, then:

   ```powershell
   Invoke-RestMethod http://127.0.0.1:18789/health
   ```

   Success: `status : ok`.

This registers a Scheduled Task called `com.8gent.daemon` for your account, no
admin rights needed. It restarts the daemon five seconds after it exits. Its
output goes to `%USERPROFILE%\.8gent\daemon-console.log`.
`daemon uninstall` removes it.

### 5. Point 8gent Browser at it

```powershell
setx EIGHT_DAEMON_URL ws://127.0.0.1:18789
```

This is needed for a named browser profile, and harmless for the default one.
Using `127.0.0.1` rather than `localhost` avoids Windows trying IPv6 first.

Install 8gent Browser (the NSIS installer, `8gent-browser-0.2.0-x64.exe`). It
is on the [8gent Browser releases](https://github.com/8gi-foundation/8gent-browser/releases)
under `desktop-v0.2.0`; without a GitHub account, ask James for it with the exe
zip. Open it from the Start menu.

What `desktop-v0.2.0` does: the dot goes live, and typing `>` followed by a
question in the address bar sends it to the daemon and shows the answer. It
predates the docked 8gent-code panel; that needs a newer Windows build.

### If something is wrong

| What you see | What to do |
|--------------|------------|
| Browser says the hive is offline | `Invoke-RestMethod http://127.0.0.1:18789/health`. No answer: `.\8gent-windows-x64.exe daemon status`, then read `%USERPROFILE%\.8gent\daemon-console.log`. |
| Health is ok, browser still offline | The browser was opened before `setx`. Quit it fully and open it again. |
| Answers fail with a model error | `ollama list` must show the model in `DEFAULT_MODEL`, and Ollama must be running. |
| `daemon install` fails | Run it from a normal (not admin) PowerShell, then `daemon status`. |
