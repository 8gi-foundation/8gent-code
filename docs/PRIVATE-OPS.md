# Private operations files

Some files describe how one operator runs their own machines. They have no place in the public kernel, so they are kept outside the tree. No hostnames, handles, ids or addresses are recorded here.

| Path (relative to the repo root) | What it was | Where it lives now |
| --- | --- | --- |
| `infra/hetzner/` (Dockerfile, README, bootstrap and deploy scripts, docker-compose, env examples, three systemd units) | Deployment of the Telegram bridges and the daemon on one operator's rented server | `~/.8gent/private-ops/8gent-code/infra/hetzner/` |
| `scripts/table-night-loop.ts` | Overnight loop for the operator's own Table channels | `~/.8gent/private-ops/8gent-code/scripts/table-night-loop.ts` |
| `scripts/table-live-mesh.ts` | Live mesh runner for the operator's own Table channels | `~/.8gent/private-ops/8gent-code/scripts/table-live-mesh.ts` |
| `README.pdf` | A rendered copy of the README that embedded local paths | `~/.8gent/private-ops/8gent-code/README.pdf` |

## What to use instead

- Deploy the daemon from the repository `Dockerfile` and `fly.toml`, or run it locally with `bun run tui`.
- Configuration that used to be written into scripts and docs is read from the environment. The names are listed in the files that read them, for example `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_GROUP_VOICE_OPERATOR_ID`, `TELEGRAM_REFUSED_BOT_USERNAMES`, `OPERATOR_BOT_TOKEN_SHA256`, `MODEL_PROXY_URL`, `CONTROL_PLANE_URL`, `VESSEL_URL` and `DAEMON_URL`.
- Test fixtures use documentation values only: `example.com` addresses, `192.0.2.x`, chat ids in the `100000001` and `-200000001` ranges, and role names such as `Person-A`.

## Checking the tree

```bash
git ls-files | grep -v 'node_modules/\|\.lock$\|\.png$\|\.jpg$\|\.mp4$\|\.gif$\|\.woff' \
  | ~/.8gent/bin/public-cleanse --files-from-stdin
```

The scan exits 0 when nothing in the tree names a private operation.
