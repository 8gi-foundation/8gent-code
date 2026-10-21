# Routing policy and the locality meter

Setting: `routing.policy` in `~/.8gent/settings.json`. Change it with `/route`.

| Policy | Meaning |
|---|---|
| `local-only` | Nothing other than a read (GET or HEAD) is sent to a host that is not this machine. |
| `local-first` (default) | Local providers first. A cloud provider is used when you picked it for this tab or no local provider can serve the call, and one line on screen says so. |
| `cloud-first` | The chain runs as written. Cloud calls are still counted and announced. |

## When the file is missing, empty or wrong

- A `settings.json` that does not exist gives the default, `local-first`.
- A file that exists but cannot be read, is empty, is truncated, is not a JSON object, has `routing` that is not an object, or names an unknown policy gives `local-only`, with one plain notice saying why. It fails closed.
- A leading byte-order mark is ignored. Case and spaces in the value are ignored (`Local-Only` is `local-only`).
- `/route` will not overwrite a settings file it cannot parse.

## What local-only covers

Model and network requests sent through 8gent's own HTTP client (the process `fetch`).

- Any request other than GET or HEAD to a host that is not on the local list is refused before it is sent, whatever the path.
- Redirects are followed by hand under local-only. A redirect to a host that is not local is refused.
- The local list is loopback (127.0.0.0/8, `::1`, IPv4-mapped loopback, `localhost`, `*.localhost`, a trailing dot ignored) plus `routing.localHosts`, for a box on your LAN. An entry is `host` or `host:port`.
- Failover never offers a hosted provider under local-only.

## What it does not yet cover

`run_command` tools such as curl, clients that do not use that HTTP client, and child processes that do not load the guard. OS-level enforcement is tracked in a follow-up issue.

## The ledger

`~/.8gent/locality.jsonl` (mode 0600, directory 0700). One line per model call and per off-box write, written when the request is sent, with a short update line when the reply ends. Fields: time, provider, local or cloud, tokens in and out, bytes sent. Never prompt or reply text. `est` marks counts worked out from sizes because the endpoint reported none.

The status chip shows the share of model tokens on this machine today. `/privacy` shows today and this session, each cloud call with provider and size, and the policy.
