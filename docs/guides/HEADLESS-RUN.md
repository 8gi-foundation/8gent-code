# Headless one-shot run (`8gent run`)

`8gent run` is the one-shot agent runner. It runs a single prompt to
completion and exits, so terminal hosts such as Orchestra, cmux, and other
wrappers can spawn 8gent as a headless agent:

```
8gent run --yes --output-format stream-json "<prompt>"
```

Source of truth: `packages/eight/run.ts`.

## Flags

| Flag | Description |
|------|-------------|
| `--yes` / `-y` | Auto-approve tool calls for the duration of the run. Commands the permission layer marks dangerous are not auto-approved: with no TTY they are denied; under a TTY they fall back to an interactive prompt. Policy hard blocks (for example `rm -rf /`, destructive `sudo`, force-push to main) still apply. |
| `--output-format <fmt>` | Output format. `text` (default) prints the final assistant message to stdout. `stream-json` emits one NDJSON event per line to stdout. Accepts `--output-format stream-json` or `--output-format=stream-json`. An unrecognised value falls back to `text`. |
| `--provider <name>` | Override the provider (e.g. `ollama`). Accepts `--provider <name>` or `--provider=<name>`. |
| `--model <name>` | Override the model (e.g. `qwen3:14b`). Accepts `--model <name>` or `--model=<name>`. |
| `--cwd <dir>` | Override the working directory for the run. Accepts `--cwd <dir>` or `--cwd=<dir>`. When omitted, the agent uses the current working directory. |
| `--max-turns <n>` | Maximum number of agent turns. Default is `30`. Accepts `--max-turns <n>` or `--max-turns=<n>`. |

The prompt is everything left over as positional tokens, joined with spaces.
`8gent run` with no prompt is a usage error and exits `1`. Unknown flags
(any other token starting with `-`) are silently ignored.

Note: the `8gent --help` text does not list `--max-turns`; `run` accepts it and
it is covered here.

## Provider and model resolution

- If `--provider` is not set, `run` probes Ollama once on
  `http://localhost:11434`. If it answers, the provider is `ollama`; otherwise
  it falls through to `openrouter` (the free cloud tier).
- If `--model` is not set:
  - For `ollama`, the model is auto-detected from the running Ollama instance
    (preferring a model name starting with `eight`, otherwise any non-embedding
    model), falling back to the provider default `qwen3:14b`.
  - `8gent`: `eight-1.0-q3:14b`; `lmstudio`: `local-model`; `openrouter` and
    any other provider: `auto:free` (the OpenRouter free-tier alias).

## stream-json event types

When `--output-format stream-json` is set, events are written to stdout as NDJSON
(one JSON object per line). Agent internals are redirected to stderr so stdout
stays clean NDJSON. The shape is a best-effort match for the Claude Code
stream-json format: a `{type, subtype?, ...fields}` object.

Event types:

1. `session_start` - emitted first. Fields: `session_id`, `started_at`,
   `provider`, `model`, `cwd`.
2. `assistant` - one per finished step. `subtype` is `text` (carries `text`,
   `step`, `finish_reason`, `usage`) or `tool_calls` (carries `tool_calls`,
   `step`, `finish_reason`, `usage`).
3. `tool_use` - `subtype` `start`. Fields: `tool_call_id`, `tool_name`, `step`
   (may be `null`), `input`.
4. `tool_result` - `subtype` is `ok` or `error`. Fields: `tool_call_id`,
   `tool_name`, `step` (may be `null`), `success`, `duration_ms`,
   `result_preview`.
5. `result` - terminator. `subtype` `ok` on success (carries `session_id`,
   `ended_at`, `final_text`), or `subtype` `error` on failure (carries
   `session_id`, `ended_at`, `error`).
6. `error` - emitted on a usage error (no prompt, `subtype` `usage`) or an agent
   error (`subtype` `agent`, carries `message`).

`assistant`, `tool_use` and `tool_result` interleave per step. On an agent
error, `error` (subtype `agent`) is emitted, then `result` (subtype `error`). A
usage error emits only `error` (subtype `usage`), with no `session_start` or
`result`.

The same `session_id` appears on both `session_start` and `result` so
PTY-mode host parsers can detect completion.

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Success. |
| `1` | Error, including a missing prompt (usage error) or an agent error. |

On a usage error with `--output-format stream-json` an `error` event with
`subtype` `usage` is emitted before exiting `1`. On an agent error a `result`
event with `subtype` `error` is emitted before exiting `1`.

## Example (local-only, Ollama)

A local-only run that auto-approves tool calls, streams events, and pins the
provider to Ollama:

```
8gent run --yes --output-format stream-json --provider ollama --model qwen3:14b \
  "Refactor the auth middleware and add a test"
```

This requires a running Ollama at `http://localhost:11434` with a model such as
`qwen3:14b` available. No cloud API keys are needed.
