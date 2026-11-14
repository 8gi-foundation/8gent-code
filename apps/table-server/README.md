# table-server

A standalone Table server for a box with no 8gent daemon. It opens `TableStore`
(`packages/table/store.ts`) with an injected ledger and serves the WebSocket
subset that `table-gate` speaks: `auth`, `channel:list`, `channel:members`,
`message:subscribe`, `message:post`. Every other frame is refused with
`TABLE_UNSUPPORTED`. `GET /healthz` returns the channel, member and message
counts.

It has no agent pool, providers, cron or model calls, and its import graph
never loads `node:child_process` (checked by `src/table-server.test.ts`).

| Env | Meaning |
|-----|---------|
| `EIGHT_DATA_DIR` | Absolute data dir (required). Key: `keys/state-hmac.key`. Ledger: `table/ledger/`. |
| `TABLE_DB_PATH` | SQLite file, default `<EIGHT_DATA_DIR>/table/table.db` |
| `TABLE_TOKEN_FILE` | Bearer token file (required): regular file, mode 0600, at least 32 chars |
| `TABLE_PORT` | Default 18789 |
| `TABLE_BIND` | Default 127.0.0.1. The image sets 0.0.0.0 inside its own network namespace. |

It refuses to start when the token file is missing or unsafe, when the ledger
key is absent (pass `--init-key` once for a brand new store), or when the
existing ledger does not verify.

```bash
bun test apps/table-server
docker build -f apps/table-server/Dockerfile -t 8gent-table-server .
```

`compose.example.yml` publishes only on the box's wg0 address, 192.168.218.1.
