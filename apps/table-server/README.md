# table-server

A standalone Table server for a box with no 8gent daemon. It opens `TableStore`
(`packages/table/store.ts`) with an injected ledger and serves the WebSocket
subset that `table-gate` speaks: `auth`, `channel:list`, `channel:members`,
`message:subscribe`, `message:post`. Every other frame is refused with
`TABLE_UNSUPPORTED`. `GET /healthz` returns the channel, member and message
counts.

It has no agent pool, providers, cron or model calls, and its import graph
never loads `node:child_process` (checked by `src/table-server.test.ts`).

## Identity

`TABLE_TOKENS_FILE` maps `sha256(token)` to one `human:<handle>` per line. The
identity comes from the matched token. A `participantId` the client sends must
equal it, or the connection is refused, so a token holder can never act as
anyone else. Every digest is compared with `timingSafeEqual`, with no early exit.

Consequence for `table-gate`: today it uses one daemon token for every actor
(`human:<code>`, `human:local`, `human:day8`). Against this server it needs one
token per actor it acts as. That change belongs to U5.

## Limits

| Limit | Value |
|-------|-------|
| Auth deadline | 5 s (`TABLE_AUTH_TIMEOUT_MS`), then close 4408 |
| Open connections | 64 (`TABLE_MAX_CONNECTIONS`), then HTTP 503 on upgrade |
| Frame | 32 KB, larger closes the socket |
| Post content | 16 KB (UTF-8 bytes), enforced in the server |
| Posts | 10 a second per connection, burst 20, then `TABLE_RATE_LIMITED` |

The 16 KB content cap is applied here, not in `TableStore`. A store-level cap
would also change what the daemon accepts, which is out of scope for this unit.

## Env

| Env | Meaning |
|-----|---------|
| `EIGHT_DATA_DIR` | Absolute data dir (required). Ledger: `table/ledger/`. |
| `TABLE_TOKENS_FILE` | Identity table (required): regular file, owned by the server's uid, mode 0600 |
| `TABLE_KEY_FILE` | Optional 32-byte ledger key from a secret mount (same file rules). Without it the key is `<EIGHT_DATA_DIR>/keys/state-hmac.key`, created only with `--init-key`. |
| `TABLE_DB_PATH` | SQLite file, default `<EIGHT_DATA_DIR>/table/table.db` |
| `TABLE_PORT` | Default 18789 |
| `TABLE_BIND` | Default 127.0.0.1. The image sets 0.0.0.0 inside its own network namespace. |

It refuses to start when the tokens file or key is missing or unsafe, or when
the existing ledger does not verify.

## For the 8gi-ops reconciler

- Publish on 192.168.218.1 only. Docker's iptables management is off on the
  box, so the `ports` host address is the only scope.
- Give the service its own network, never a shared one. The box's FORWARD
  policy is DROP.
- Keep `read_only: true`, `cap_drop: [ALL]`,
  `security_opt: ["no-new-privileges:true"]` and a `/tmp` tmpfs. The image
  cannot set them itself.
- Mount the tokens file and the ledger key read-only from `/run/8gi/secrets`,
  owned by uid 1000, mode 0600. Keeping the key off `/data` means a copy of the
  data volume cannot forge ledger entries.

See `compose.example.yml`.

```bash
bun test apps/table-server
docker build -f apps/table-server/Dockerfile -t 8gent-table-server .
```
