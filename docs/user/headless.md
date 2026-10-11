# Headless use

Three ways in, from simplest to most controlled.

## `8gent run`

One prompt, one run, no interface.

```bash
8gent run "list the TODO comments in src"
8gent run --yes --output-format stream-json "fix the failing test"
```

| Flag | Meaning |
|---|---|
| `--yes` | Approve tool calls without asking. Catastrophic commands stay blocked |
| `--output-format stream-json` | One JSON object per line on stdout |
| `--provider=<p>`, `--model=<m>` | Choose the model |
| `--cwd=<dir>` | Working directory |
| `--max-turns=<n>` | Cap the number of turns |
| `--image <path>` | Attach one png, jpg, gif or webp (max 20 MB, inside the working directory) |
| `--no-workspace-boundary` | Do not set the workspace root for this run |

Plain output is the final answer only. Exit code is 0 on success and 1 on error.

Before and after a run, 8gent runs the project's own check (a `test` script in `package.json`, `cargo test`, or `go test ./...`). A run that makes it worse is sent back to fix it and ends with exit 1 if it stays worse. This check only runs with `--yes`.

### stream-json events

Each line has a `type`:

| `type` | When |
|---|---|
| `session_start` | First line; carries `session_id`, `provider`, `model`, `cwd` |
| `tool_use` | A tool call started (`tool_name`, `input`) |
| `tool_result` | A tool call finished (`success`, `duration_ms`, `result_preview`) |
| `assistant` | Text or tool calls for a step, with `usage` |
| `error` | Something failed |
| `result` | Last line; `subtype` is `ok` or `error`, with `final_text` |

## `8gent chat`

```bash
8gent chat "Fix the auth middleware" --json
echo "Explain this code" | 8gent chat --stdin
8gent chat "Add tests" --yes --infinite
```

`--json` gives structured output. Exit codes: 0 success, 1 error, 2 sign-in required.

## JSON-RPC over stdin and stdout

```bash
8gent rpc            # same as: 8gent --rpc
```

Newline-delimited JSON-RPC 2.0. Methods:

| Method | Params |
|---|---|
| `session.create` | `model` (for example `ollama:qwen3:14b`), `cwd` |
| `session.message` | `sessionId`, `content` |
| `session.abort` | `sessionId` |
| `session.destroy` | `sessionId` |
| `tools.list` | none |

Notifications while a message runs: `stream.token`, `stream.toolCall`, `stream.toolResult`, `stream.done`, `stream.error`.

## Use 8gent's tools from another client

```bash
8gent mcp-server --tools=safe
```

Starts an MCP server on stdio. `--tools=safe` exposes read-only tools.

## Windows

All of these work in PowerShell. From a clone, replace `8gent` with `bun bin/8gent.ts`.
