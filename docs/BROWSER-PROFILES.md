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
`path-guard` and the seatbelt deny list block `~/.8gent/browser-control.token`
and `~/.8gent/browser-profiles/` from `read_file`, `write_file` and
`run_command`.

## What a named profile changes in 8gent

- **Local sessions.** They get `browser_open`, `browser_state`, `browser_task` and `browser_screenshot`.
- **No tool-level card.** `browser_task` and `browser_screenshot` skip the card. The `desktop_use` policy still applies.
- **Sensitive clicks still go to the approver.** Sign in, buy, delete and send are examples. With no one to ask, the click is refused.
- **Secret fields are never typed into.** That covers password, payment, PIN, OTP and contenteditable fields. 8gent asks the page first and fails closed on any error; the browser re-checks the exact element.
- **No loopback or private hosts.** Loopback, private, link-local and CGNAT ranges, `.local`, `localhost`, `user:pass@` URLs and non-http(s) URLs are refused before the browser is called. The browser also blocks them at its network layer on every request and redirect hop.
- **Screenshots go to the workspace.** The profile dir is protected, so the agent could not read them back from there.

DNS rebinding is not covered yet.

## Launcher

```bash
~/.8gent/scripts/start-eightgent-browser.sh   # profile eightgent, port 7981
```

Then add `EIGHT_BROWSER_PROFILE=eightgent` to the bot daemon's environment.
