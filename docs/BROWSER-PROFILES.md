# Named browser profiles (the bot's own browser)

8gent's `browser_*` tools drive 8gent Browser over its loopback control channel.
By default that is the person's own, logged-in browser, so `browser_task` and
`browser_screenshot` ask first and local-model sessions get no browser at all.

A **named profile** is a separate, login-free 8gent Browser instance that an
agent (for example @eightgentcodebot) may drive without a card. The browser
side is 8gent-browser #82; this repo's side is #3622.

## Settings

| Variable | Rule |
|---|---|
| `EIGHT_BROWSER_PROFILE` | `^[a-z][a-z0-9-]{1,31}$`. Unset, empty or `default` means the person's default profile, unchanged. Any other value is an error: no browser tools, one warning when a local session starts, and never a fallback to the default profile. |
| `EIGHT_BROWSER_CONTROL_PORT` | Required by the browser for a named profile, and never `7980` (the default profile's port). 8gent does not read it for a named profile; it reads the port file. |
| `EIGHT_DAEMON_URL` | The browser of a named profile joins a daemon only when this is set. It never falls back to `ws://localhost:18789`. |
| `EIGHT_BROWSER_PROFILE_RELAY=1` | Lets a named profile post to the local relay (brain, Create pane, research). Off by default. |
| `EIGHT_BROWSER_BACKEND=browser-use` | Turns every named-profile exemption off: browser-use is not the isolated instance. |

## Layout

Everything for profile `<name>` lives under `~/.8gent/browser-profiles/<name>/`
(mode 700):

- `browser-control.token`: the profile's own control token (mode 600).
- `browser-control.port`: the port the instance listens on (mode 600). It is written on start and deleted on quit. 8gent reads it, refuses `7980` or junk, and fails closed ("profile is not running") when it or the token is missing.
- `electron/`: userData, which holds cookies, cache and storage.
- `downloads/` and the `browser-*` stores (recall, kg, study, files, research, shots, clips, courses, media).

A symlink at the profile dir, token, port file or userData is refused.

## Keeping the agent away from the tokens

- **File tools.** `path-guard` blocks `~/.8gent/browser-control.token` and `~/.8gent/browser-profiles/` from `read_file`, `write_file` and the other file tools. The seatbelt deny list carries both paths for tools that run under seatbelt.
- **`run_command` is neither path-guarded nor seatbelted today.** It has only a backstop, `touchesBrowserSecrets`. That refuses commands naming the token or profile dirs, `.8gent` with globs or variables, glob forms such as `browser-c*` or `b?owser`, and base64, hex or char-code encoded paths. **This is a speed bump, not a boundary:** a determined shell one-liner can still get past it. The real fix is seatbelting `run_command` (#3612).
- **Until #3612 merges, the bot's launcher does not set `EIGHT_BROWSER_PROFILE`.** The bot has no browser until then. Shipping the profile with only the speed bump would hand a prompt-injected local model a path to the person's logged-in browser.
- **Defence in depth.** With a named profile configured, 8gent's client refuses port 7980, and any control token other than the profile's own, whatever a caller passes.

## What a named profile changes in 8gent

- **Local sessions.** They get `browser_open`, `browser_state`, `browser_task` and `browser_screenshot`.
- **No tool-level card.** `browser_task` and `browser_screenshot` skip the card. The `desktop_use` policy still applies.
- **Sensitive clicks still go to the approver.** Sign in, buy, delete and send are examples. With no one to ask, the click is refused.
- **Secret fields are never typed into.** That covers password, payment, PIN, OTP and contenteditable fields. 8gent asks the page first and fails closed on any error; the browser re-checks the exact element.
- **Every profile checks destinations.** Browser opens (browser_open and an open step in browser_task) go through the same net-guard classification as web_fetch, DNS answers included, before the browser is called: private ranges, link-local and metadata addresses and internal names are refused. Loopback is refused unless its host:port is listed in `EIGHT_BROWSER_ALLOW_LOOPBACK` (comma separated, for example `127.0.0.1:5173`); a named profile ignores that list.
- **No loopback or private hosts.** Loopback, private, link-local and CGNAT ranges, `.local`, `localhost` (including a trailing dot), IPv4 embedded in IPv6, `user:pass@` URLs and non-http(s) URLs are refused before the browser is called. The browser also blocks them at its network layer on every request and redirect hop.
- **Screenshots go to the workspace.** The profile dir is protected, so the agent could not read them back from there.

DNS rebinding is not covered yet.

## Launcher

```bash
~/.8gent/scripts/start-eightgent-browser.sh   # profile eightgent, port 7981
```

Then, **after #3612 has merged**, add `EIGHT_BROWSER_PROFILE=eightgent` to the
bot daemon's environment.
