# Orchestrate in 8gent: the daemon behind 8gent Browser

8gent Browser has an 8gent-code panel. That panel talks to an 8gent-code daemon
over a WebSocket. No daemon, no answers: the browser shows "The hive is offline".
This guide gets a daemon running on your own machine, on loopback only, and gets
8gent Browser talking to it.

Two set-ups are covered: macOS (James) and Windows (Artale).

## How the browser finds the daemon

- The browser connects to `ws://localhost:18789` by default.
- `EIGHT_DAEMON_URL` changes that address. Any host that is not loopback is
  upgraded to `wss://`.
- `EIGHT_DAEMON_TOKEN` is sent first when the daemon asks for a token. A
  loopback daemon started with `8gent daemon run` does not ask for one.
- A **named** browser profile (`EIGHT_BROWSER_PROFILE` set) only connects when
  `EIGHT_DAEMON_URL` is set. The default profile always connects.
- The daemon answers `http://127.0.0.1:18789/health` with `{"status":"ok",...}`.
  If that works, the browser's dot goes live within a few seconds.

`8gent daemon run`, and the login service that runs it, listens on
`127.0.0.1` only. Nothing on your network can reach it. To listen on every
interface on purpose, set `DAEMON_HOSTNAME=0.0.0.0`, and only do that on a
machine where the daemon has a token.

## macOS (James)

On James's Mac the daemon already runs as a login service (`com.8gent.daemon`),
started from his own launcher script on loopback. Do not run
`8gent daemon install` there: it writes a plist under the same name and
replaces his launcher.

1. Check it:

   ```bash
   ~/.8gent/bin/svc status daemon
   ```

   `OK   daemon  running (pid ...), http://127.0.0.1:18789/health ok` means it is up.

2. If it says FAIL, restart it (prints OK or FAIL when done):

   ```bash
   ~/.8gent/bin/svc restart daemon
   ```

3. Make sure only one process holds port 18789:

   ```bash
   lsof -nP -iTCP:18789 -sTCP:LISTEN
   ```

   You want one line, ending `127.0.0.1:18789 (LISTEN)`. A second line ending
   `*:18789 (LISTEN)` is a stray daemon from an older `bun run daemon`. It
   listens on every interface with no token, and on macOS it wins the
   connection, so the browser talks to it instead of your service. Stop it
   with `kill <its pid>`.

4. Open 8gent Browser from the Dock or Applications. With the default profile
   there is nothing to type: it connects to `ws://localhost:18789` on its own.

Do not set `EIGHT_DAEMON_URL` for the whole login session (`launchctl setenv`).
8gent Computer reads the same variable and expects a path (`/store`) on it, so a
session-wide value breaks it.

On a fresh Mac with no launcher script, `8gent daemon install` sets up the same
kind of service: launchd, at login, restarted if it exits, logs in
`~/.8gent/daemon.log`.

## Windows (Artale)

### 1. Get the 8gent exe

- **From v0.20.0 on:** download `8gent-windows-x64.exe` from the
  [8gent-code releases](https://github.com/8gi-foundation/8gent-code/releases).
- **Until then:** open the latest green
  [Windows Smoke run](https://github.com/8gi-foundation/8gent-code/actions/workflows/windows-smoke.yml),
  scroll to **Artifacts** and download `8gent-windows-x64`. Unzip it into the
  folder it will live in, for example `%USERPROFILE%\8gent`. Artifacts expire
  after 14 days.

Check the file is the one CI built. The hash must match the `.sha256` file
next to it:

```powershell
cd $env:USERPROFILE\8gent
(Get-FileHash .\8gent-windows-x64.exe -Algorithm SHA256).Hash.ToLower()
Get-Content .\8gent-windows-x64.exe.sha256
```

### 2. Give the daemon a model

The daemon needs a model to answer with. The free, local way is
[Ollama for Windows](https://ollama.com/download/windows):

```powershell
ollama pull qwen3:8b
setx DEFAULT_RUNTIME ollama
setx DEFAULT_MODEL qwen3:8b
```

`setx` saves the values for your account. Open a **new** PowerShell window
afterwards so it sees them.

### 3. Run the daemon once, in the foreground

```powershell
cd $env:USERPROFILE\8gent
.\8gent-windows-x64.exe daemon run
```

You should see `[daemon] ready - ws://127.0.0.1:18789`. In a second window:

```powershell
Invoke-RestMethod http://127.0.0.1:18789/health
```

`status : ok` means it works. Windows does not ask about the firewall, because
the daemon only listens on loopback. Press Ctrl+C in the first window to stop it.

### 4. Start it at every logon

```powershell
.\8gent-windows-x64.exe daemon install
.\8gent-windows-x64.exe daemon status
```

This registers a Scheduled Task called `com.8gent.daemon` for your account, no
admin rights needed. It starts at logon and restarts the daemon five seconds
after it exits. Its output goes to `%USERPROFILE%\.8gent\daemon-console.log`.
The task runs the exe from the folder you ran `install` in, so move the exe
first, then install. `daemon uninstall` removes it.

### 5. Point 8gent Browser at it

```powershell
setx EIGHT_DAEMON_URL ws://127.0.0.1:18789
```

This is needed for a named browser profile, and harmless for the default one.
Using `127.0.0.1` rather than `localhost` avoids Windows trying IPv6 first.

Then install 8gent Browser for Windows (the NSIS installer,
`8gent-browser-<version>-x64.exe`) and open it from the Start menu. The dot
goes live and the panel answers.

Where the installer comes from: the newest Windows installer on the
[8gent Browser releases](https://github.com/8gi-foundation/8gent-browser/releases)
is `desktop-v0.2.0`. It already joins the daemon (type `>` in the address bar),
but it predates the docked panel. A current installer comes from the browser's
Release workflow, or from `bun run dist` on a Windows machine.

### If something is wrong

| What you see | What to do |
|--------------|------------|
| Browser says the hive is offline | `Invoke-RestMethod http://127.0.0.1:18789/health`. No answer: `.\8gent-windows-x64.exe daemon status`, then read `%USERPROFILE%\.8gent\daemon-console.log`. |
| Health is ok, browser still offline | The browser was opened before `setx`. Quit it fully and open it again. |
| Answers fail with a model error | `ollama list` must show the model in `DEFAULT_MODEL`. |
| `daemon install` fails | Run it from a normal (not admin) PowerShell, then `daemon status`. |
