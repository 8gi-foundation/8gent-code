# Headless JSON events

`8gent -p "<prompt>" --mode json` (also `8gent run --output-format stream-json`)
writes one JSON object per line to stdout. Diagnostics go to stderr, so stdout
parses line by line. The types are exported from `packages/eight/run-events.ts`
(`RunEvent`), and `validateRunEvent(parsedLine)` returns the list of problems
with a line (empty means it matches). `packages/eight/run-headless-e2e.test.ts`
runs a real headless call and validates every line it prints.

## Running

```
git diff | 8gent -p "review"                    # piped text is added ahead of the prompt
8gent -p --mode json "list the TODOs"           # JSON lines
8gent -p --tools read_file,grep "where is auth" # only these tools
8gent -p --continue "now fix the first one"     # latest session of this folder
8gent -p --no-session "one-off question"        # save nothing
8gent -p --session-dir ./.sessions "..."        # sessions live there
8gent --mode rpc                                # JSON-RPC server, same as --rpc
```

- `-p` / `--print`: one prompt, then exit. Reads stdin when it is piped.
- `--mode json|text`: `json` is the event stream below; `text` is the final answer only (default).
  `--mode rpc` starts the JSON-RPC 2.0 server (`--rpc`).
- `--continue` / `-c`: resume the latest session whose folder is the working folder (`--cwd` or the current one). With none, a new session starts.
- `--session <id>`: resume that session; an unknown id is an error.
- `--no-session`: do not read or write a session.
- `--session-dir <dir>`: read and write sessions in `<dir>`.
- `--tools a,b`: offer only those tools; a call to any other is refused.
- Exit code: 0 on success, 1 on a usage error, an agent error, or a failed project check.

## Events

A run emits `session_start`, then any number of `assistant`, `tool_use` and
`tool_result` events, then exactly one `result`. `error` events precede the
`result` when something went wrong.

| type | subtype | fields |
|---|---|---|
| `session_start` | none | `session_id`, `started_at`, `provider`, `model`, `cwd`, `resumed` (continued an earlier session), `persisted` (saved; false with `--no-session`) |
| `tool_use` | `start` | `tool_call_id`, `tool_name`, `step` (number or null), `input` (object) |
| `tool_result` | `ok` or `error` | `tool_call_id`, `tool_name`, `step`, `success`, `duration_ms`, `result_preview` |
| `assistant` | `text` | `step`, `finish_reason`, `text`, `usage` |
| `assistant` | `tool_calls` | `step`, `finish_reason`, `tool_calls` (`[{toolName, toolCallId}]`), `usage` |
| `result` | `ok` or `error` | `session_id`, `ended_at`, `final_text`, `project_check`, `error` (only on `error`) |
| `error` | `usage` or `agent` | `message` |

`usage` is `{promptTokens, completionTokens, totalTokens}`. `project_check` is
`{status, command, fix_rounds, detail, notice}` (the done gate). The last line
is always a `result`; a host that wants "is it finished" can stop on it. The
`session_id` on `session_start` and `result` is the saved session's id, so a
later `--session <id>` continues it.

Unknown extra keys may appear in later versions; read the keys you know.

## Examples

```json
{"type":"session_start","session_id":"run-1791747389678","started_at":"2026-10-11T19:36:29.678Z","provider":"ollama","model":"qwen3:14b","cwd":"/work/app","resumed":false,"persisted":true}
{"type":"tool_use","subtype":"start","tool_call_id":"tt-1-0","tool_name":"read_file","step":0,"input":{"path":"src/a.ts"}}
{"type":"tool_result","subtype":"ok","tool_call_id":"tt-1-0","tool_name":"read_file","step":0,"success":true,"duration_ms":4,"result_preview":"export const a = 1;"}
{"type":"assistant","subtype":"text","step":1,"finish_reason":"stop","text":"Looks fine.","usage":{"promptTokens":812,"completionTokens":9,"totalTokens":821}}
{"type":"result","subtype":"ok","session_id":"run-1791747389678","ended_at":"2026-10-11T19:36:31.200Z","final_text":"Looks fine."}
```
