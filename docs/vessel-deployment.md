# James's Hetzner Vessel - Deployment Notes

The Hetzner dedicated server at `78.47.98.218` is the first production vessel in the 8GI fleet, hosting `james.8gentos.com`.

## What runs on it

| Service | User | Port | Public? | Source |
|---|---|---|---|---|
| `8gent-os.service` | `eight` | `127.0.0.1:3000` | yes (via Caddy) | `/opt/8gent-OS` (8gi-foundation/8gent-OS) |
| `8gent-daemon.service` | `eight` | `0.0.0.0:18789` | no (UFW-blocked) | `/opt/8gent-code` (this repo) |
| `caddy.service` | `caddy` | `:80`, `:443` | yes | `/etc/caddy/Caddyfile` |
| `fail2ban.service` | `root` | n/a | n/a | `/etc/fail2ban/jail.d/sshd.local` |

Caddy reverse-proxies `james.8gentos.com` straight to the Next.js app on `127.0.0.1:3000`. The eight-vessel daemon stays internal-only; UFW only opens 22/80/443.

## SSH access

After hardening, only the `james` user can log in (key-only). Root SSH is denied.

```bash
ssh -i ~/.ssh/hetzner_8gi_ed25519 james@78.47.98.218
```

Sudo is `NOPASSWD` for `james` (the user has a locked password, key auth only).

## Deploy

From a Mac with `~/8gent-OS` cloned:

```bash
bash scripts/deploy-james-os.sh        # ship app changes
bash scripts/harden-james-vessel.sh    # one-time security hardening
```

The deploy script is idempotent. Re-run it after every push to `8gi-foundation/8gent-OS` `master`.

## Environment

`.env.local` lives at `/opt/8gent-OS/.env.local`, owned by `eight`, mode `0600`. The deploy script copies it from the local machine and appends:

- `VESSEL_JWT_SECRET` (auto-generated with `openssl rand`)
- `OPENROUTER_API_KEY` (mirrored from `/etc/8gent/daemon.env` if present)
- `NODE_ENV=production`, `PORT=3000`, `HOSTNAME=127.0.0.1`

Currently populated locally: Clerk (publishable + secret), Convex (URL + deployment), OpenRouter.
Currently empty (degraded features): Stripe (billing), LiveKit (voice), other model provider keys.

## Verifying

```bash
ssh james@78.47.98.218 systemctl status 8gent-os.service
curl -sI https://james.8gentos.com/
journalctl -u 8gent-os.service -n 100 --no-pager
```

## Recovery

If the deploy breaks the app, roll back the systemd unit and restart Caddy:

```bash
ssh james@78.47.98.218 sudo systemctl stop 8gent-os.service
# fix the issue in /opt/8gent-OS, then:
ssh james@78.47.98.218 sudo systemctl start 8gent-os.service
```

If SSH gets locked out (it shouldn't - the harden script verifies in-line), use Hetzner Console (KVM) on the customer dashboard to re-add an authorized key for `james`.
