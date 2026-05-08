# Hetzner deployment: daemon + two Telegram bridges

Runs the Eight daemon and two Telegram bridges (`[REDACTED-BOT]` and
`@eightgentcodebot`) on the Hetzner cax21 box at `[REDACTED-IP]`. Each bridge
opens its own daemon session over `ws://daemon:18789`; sessions are isolated
so the two bots don't collide.

## Layout on the box

```
/opt/8gent/                              # repo checkout (rsync target)
/etc/8gent/daemon.env                    # shared infra env (mode 600)
/etc/8gent/bots.env                      # both bot tokens + chat IDs (mode 600)
/var/lib/8gent/                          # docker volume / data dir
  memory.db
  telegram-sessions-aijames.json
  telegram-sessions-eightgent.json
```

## Token mapping

The bridge picks credentials by `BOT_NAME`. This matches the
`8gi-governance/src/app/api/telegram/webhook/route.ts` convention.

| `BOT_NAME` | Token var | Chat var | Telegram bot |
|------------|-----------|----------|--------------|
| `aijames` (default) | `TELEGRAM_BOT_TOKEN` | `TELEGRAM_CHAT_ID` | `[REDACTED-BOT]` |
| `eightgent` | `EIGHT_BOT_TOKEN` | `EIGHT_CHAT_ID` | `@eightgentcodebot` |

A single `bots.env` holds both pairs. Each compose service / systemd unit
sets `BOT_NAME` to pick its own.

## Bootstrap (one-time, fresh box)

```bash
# 1. Get SSH access (operator step — out of scope here).
ssh root@[REDACTED-IP] 'echo ok'

# 2. From your laptop, push the repo:
bash infra/hetzner/deploy.sh [REDACTED-IP] sync

# 3. From your laptop, run bootstrap on the box:
ssh root@[REDACTED-IP] 'bash /opt/8gent/infra/hetzner/bootstrap.sh'

# 4. On the box, fill in real secrets:
ssh root@[REDACTED-IP]
$EDITOR /etc/8gent/daemon.env     # OPENROUTER_API_KEY, DAEMON_AUTH_TOKEN
$EDITOR /etc/8gent/bots.env       # both bot tokens + chat IDs

# 5. From your laptop, start everything:
bash infra/hetzner/deploy.sh [REDACTED-IP] up
```

## Day-to-day

```bash
bash infra/hetzner/deploy.sh [REDACTED-IP] sync     # push code, no restart
bash infra/hetzner/deploy.sh [REDACTED-IP] up       # push + rebuild + start
bash infra/hetzner/deploy.sh [REDACTED-IP] restart
bash infra/hetzner/deploy.sh [REDACTED-IP] logs
bash infra/hetzner/deploy.sh [REDACTED-IP] status
bash infra/hetzner/deploy.sh [REDACTED-IP] down
```

## Smoke test

After `up`, both bots should respond to a ping in their own chat.

```bash
# Daemon health (over the SSH tunnel — daemon is bound to 127.0.0.1):
ssh root@[REDACTED-IP] 'curl -fsS http://127.0.0.1:18789/health'

# Bridge logs:
ssh root@[REDACTED-IP] 'docker logs --tail=50 eight-bridge-aijames'
ssh root@[REDACTED-IP] 'docker logs --tail=50 eight-bridge-eightgent'
```

Each bridge prints `[telegram-bridge] BOT_NAME=<name> (reading <var>)` at
startup, so you can confirm both picked up the right credentials. Then send
`/help` to each bot in Telegram — you should get the multi-step task surface.

## systemd alternative

Compose is the default. If you'd rather run native systemd units (no docker),
use the files in `systemd/`:

```bash
cp infra/hetzner/systemd/*.service /etc/systemd/system/
mkdir -p /var/log/8gent
systemctl daemon-reload
systemctl enable --now eight-daemon eight-bridge-aijames eight-bridge-eightgent
```

Bun must be installed on the box at `/usr/local/bin/bun` for the units to
launch.

## Troubleshooting

- **Both bots silent**: check `daemon.env` has `OPENROUTER_API_KEY` set.
  `auto:free` model resolution needs it.
- **One bot silent, the other works**: the silent bridge has wrong/empty
  credentials in `bots.env`. The startup line in its logs tells you which
  variable it tried to read.
- **Bridge keeps reconnecting**: daemon healthcheck is failing. Check
  `docker logs eight-daemon`.
- **`session not found` in bridge logs**: normal after a daemon restart —
  the bridge recreates silently within a few seconds.

## Out of scope (intentional)

- Per-bot system prompts. The governance webhook has `SYSTEM_AIJAMES` and
  `SYSTEM_EIGHT`; the daemon-bridge path currently shares one persona via
  `EIGHT_VESSEL_CONTEXT`. Adding per-bot persona injection is a follow-up.
- Caddy / reverse proxy. The daemon is bound to `127.0.0.1:18789` — exposing
  it externally for vessel-to-vessel federation is a separate task.
- Secret vault. Phase 0 uses env files. Vault work is tracked in #1807.
