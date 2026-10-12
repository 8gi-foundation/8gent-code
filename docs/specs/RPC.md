# JSON-RPC 2.0 server

Headless mode for scripts and IDEs. Start it with `8gent --rpc` (or `8gent rpc`). One JSON object per line on stdin (requests) and stdout (responses and notifications). Logs go to stderr. Requests are handled concurrently, so you can send `session.steer` while `session.message` is still running.

Source: `packages/eight/rpc-server.ts`. It is built on the SDK (`packages/eight/sdk.ts`), so the TUI, the SDK and RPC run the same Agent.

## Errors

| Code | Meaning |
|---|---|
| -32700 | Invalid JSON |
| -32600 | Not a JSON-RPC 2.0 request with an id |
| -32601 | Unknown method |
| -32602 | Missing or invalid params, unknown `sessionId` |
| -32603 | Internal error (the turn failed) |
| -32000 | Busy: a turn is already running on this session |
| -32001 | Unsupported in this build |

## Methods

All session methods take `sessionId` (from `session.create` or `session.fork`).

| Method | Params | Result |
|---|---|---|
| `session.create` | `model?`, `runtime?`, `cwd?`, `systemPrompt?`, `persist?` (false = no session file) | `{ sessionId }`. A `runtime:` model prefix (`openrouter:auto`) selects the runtime; default runtime is `ollama`. |
| `session.message` | `content` | `{ response, usage }` when the turn ends. One turn only. -32000 if a turn is running. |
| `session.prompt` | `content` | `{ response, usage }`. Like `message`, then runs late steers and queued follow-ups until the queue is empty; `response` is the last text. |
| `session.steer` | `content` | `{ queued, busy, queueLength }`. Joins the running turn after the tool calls running now finish, before the next model call. `queued:false` when blank, too large or the queue is full. With no turn running it stays queued and `session.prompt` sends it next. |
| `session.followUp` | `content` | `{ queued, busy, queueLength }`. Runs after the current `session.prompt` turn ends. |
| `session.clearQueue` | - | `{ steers: [], followUps: [] }` (what was dropped) |
| `session.abort` | - | `{ ok: true }`. Stops the turn and drops follow-ups. |
| `session.getState` | - | `{ sessionId, model, provider, cwd, busy, queueLength, steerQueue, followUpQueue, messageCount, persisted }` |
| `session.setModel` | `model` | `{ model, provider }`. Same runtime only; changing runtime is -32602. |
| `session.compact` | - | -32001 today: the agent exposes no compaction call on main. |
| `session.getMessages` | - | `{ messages: [{ role, content }] }` (system prompt excluded) |
| `session.getLastAssistantText` | - | `{ text }` (null before the first reply) |
| `session.list` | `cwd?`, `limit?` | `{ sessions: [...] }` from the session store, newest first (`id`, `cwd`, `model`, `messageCount`, `parentSession`, `file`, ...) |
| `session.fork` | `entryId?`, `name?` | `{ sessionId, parentSessionId, messageCount }`. Copies the stored conversation into a new live session with its own file. |
| `session.destroy` | - | `{ ok: true }` |
| `tools.list` | - | `{ tools: [{ name, category }] }` |

Session files go to `~/.8gent/sessions/tree` (or `$EIGHT_DATA_DIR/sessions/tree`).

## Notifications (server to client, no id)

All carry `sessionId`.

| Method | Params |
|---|---|
| `stream.toolCall` | `tool`, `args` |
| `stream.toolResult` | `tool`, `result` (short preview) |
| `stream.token` | `token` (text of a finished model step) |
| `stream.steer` | `text` (a steer was delivered into the turn) |
| `stream.followUp` | `text` (a queued follow-up is starting) |
| `stream.done` | - (a turn ended) |
| `stream.error` | `error` |

## Example

```
> {"jsonrpc":"2.0","id":1,"method":"session.create","params":{"model":"qwen3:14b","cwd":"/tmp/work"}}
< {"jsonrpc":"2.0","id":1,"result":{"sessionId":"rpc_1760000000000_ab12cd"}}
> {"jsonrpc":"2.0","id":2,"method":"session.message","params":{"sessionId":"rpc_1760000000000_ab12cd","content":"Create hello.txt"}}
> {"jsonrpc":"2.0","id":3,"method":"session.steer","params":{"sessionId":"rpc_1760000000000_ab12cd","content":"use two spaces"}}
< {"jsonrpc":"2.0","id":3,"result":{"queued":true,"busy":true,"queueLength":1}}
```
(then `stream.toolCall`, `stream.steer`, `stream.done`, and the response to id 2.)

## SDK

```ts
import { createSession } from "@8gi-foundation/8gent-code";
const s = createSession({ model: "qwen3:14b", cwd: process.cwd() });
s.subscribe((e) => e.type === "tool_start" && console.log(e.tool));
console.log(await s.prompt("Create hello.txt"));
await s.dispose();
```
