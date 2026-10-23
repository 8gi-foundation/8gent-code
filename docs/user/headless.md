# Headless use

```bash
8gent run "list the TODO comments in src"
8gent run --yes --output-format stream-json "fix the failing test"
echo "Explain this code" | 8gent chat --stdin
8gent rpc
8gent mcp-server --tools=safe
```

| Flag | Meaning |
|---|---|
| `--yes` | Approve ordinary commands without asking |
| `--output-format stream-json` | One JSON event per line |
| `--provider=<p>`, `--model=<m>` | Choose the model |
| `--cwd=<dir>` | Working directory |
| `--max-turns=<n>` | Cap the turns |
| `--image <path>` | Attach one image |
| `--no-workspace-boundary` | No workspace root, and no read boundary for shell commands |
| `--allow-read <dir>` | Also read that folder |

Exit code is 0 on success, 1 on error.

`stream-json` event types: `session_start`, `tool_use`, `tool_result`, `assistant`, `error`, `result`.

`8gent rpc` speaks JSON-RPC 2.0 over stdin and stdout. Methods: `session.create`, `session.message`, `session.abort`, `session.destroy`, `tools.list`.

`8gent mcp-server` serves 8gent's tools to any MCP client; `--tools=safe` is read-only.
