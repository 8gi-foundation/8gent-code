#!/usr/bin/env bash
# Deploy the 8gent-OS Next.js app to the Hetzner vessel at james.8gentos.com.
# Idempotent. Safe to re-run.
#
# Source repo (local):   ~/8gent-OS  (8gi-foundation/8gent-OS)
# Destination (server):  /opt/8gent-OS  (owned by user 'eight')
# Service:               8gent-os.service (systemd, listens on 127.0.0.1:3000)
# Public:                Caddy reverse-proxies https://james.8gentos.com -> 127.0.0.1:3000
# Secrets:               .env.local copied via scp (never echoed in chat or logs)
#
# Pre-reqs on the box: Bun installed at /usr/local/bin/bun, eight user, Caddy, UFW.

set -euo pipefail

SSH_KEY="${SSH_KEY:-$HOME/.ssh/hetzner_8gi_ed25519}"
SSH_TARGET="${SSH_TARGET:-root@78.47.98.218}"
SSH_OPTS="-i $SSH_KEY -o StrictHostKeyChecking=no"
SSH="ssh $SSH_OPTS $SSH_TARGET"
RSYNC_SRC="${RSYNC_SRC:-$HOME/8gent-OS}"
APP_DIR="/opt/8gent-OS"
HERE="$(cd "$(dirname "$0")/.." && pwd)"

if [ ! -d "$RSYNC_SRC" ]; then
  echo "[deploy] source repo not found at $RSYNC_SRC" >&2
  exit 1
fi

echo "[deploy] (1/8) ensuring Bun + dirs on host..."
$SSH 'set -e
  if [ ! -x /usr/local/bin/bun ]; then
    echo "[host] installing Bun..."
    curl -fsSL https://bun.sh/install | bash >/dev/null
    install -m 0755 /root/.bun/bin/bun /usr/local/bin/bun
  fi
  /usr/local/bin/bun --version
  id -u eight >/dev/null 2>&1 || useradd -r -m -s /bin/bash eight
  install -d -o eight -g eight -m 0755 /opt/8gent-OS /var/log/8gent
'

echo "[deploy] (2/8) rsyncing source (excluding node_modules, .next, .git)..."
rsync -az --delete \
  --exclude ".git/" \
  --exclude "node_modules/" \
  --exclude ".next/" \
  --exclude ".bun/" \
  --exclude ".env.local" \
  --exclude "dist/" \
  -e "ssh $SSH_OPTS" \
  "$RSYNC_SRC/" "$SSH_TARGET:$APP_DIR/"

echo "[deploy] (3/8) syncing .env.local + appending generated secrets..."
scp $SSH_OPTS "$RSYNC_SRC/.env.local" "$SSH_TARGET:$APP_DIR/.env.local"
$SSH 'set -e
  cd /opt/8gent-OS
  [ -f .env.local ] || touch .env.local
  if ! grep -q "^VESSEL_JWT_SECRET=" .env.local; then
    echo "" >> .env.local
    echo "VESSEL_JWT_SECRET=$(openssl rand -base64 48 | tr -d /=+ | cut -c1-48)" >> .env.local
  fi
  if ! grep -q "^OPENROUTER_API_KEY=" .env.local; then
    if [ -f /etc/8gent/daemon.env ] && grep -q "^OPENROUTER_API_KEY=" /etc/8gent/daemon.env; then
      grep "^OPENROUTER_API_KEY=" /etc/8gent/daemon.env >> .env.local
    fi
  fi
  grep -q "^NODE_ENV="  .env.local || echo "NODE_ENV=production" >> .env.local
  grep -q "^PORT="      .env.local || echo "PORT=3000" >> .env.local
  grep -q "^HOSTNAME="  .env.local || echo "HOSTNAME=127.0.0.1" >> .env.local
  chown eight:eight .env.local
  chmod 600 .env.local
  chown -R eight:eight /opt/8gent-OS
'

echo "[deploy] (4/8) bun install..."
$SSH 'cd /opt/8gent-OS && sudo -u eight /usr/local/bin/bun install 2>&1 | tail -30'

echo "[deploy] (5/8) bun run build..."
$SSH 'cd /opt/8gent-OS && sudo -u eight /usr/local/bin/bun run build 2>&1 | tail -60'

echo "[deploy] (6/8) installing systemd unit 8gent-os.service..."
$SSH 'cat > /etc/systemd/system/8gent-os.service <<UNIT
[Unit]
Description=8gent OS - Next.js production server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=eight
Group=eight
WorkingDirectory=/opt/8gent-OS
EnvironmentFile=/opt/8gent-OS/.env.local
ExecStart=/usr/local/bin/bun run start
Restart=on-failure
RestartSec=5
StandardOutput=append:/var/log/8gent/os.log
StandardError=append:/var/log/8gent/os.err.log
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable 8gent-os.service >/dev/null 2>&1
  systemctl restart 8gent-os.service
  sleep 4
  systemctl is-active 8gent-os.service
'

echo "[deploy] (7/8) writing new Caddyfile + reloading..."
scp $SSH_OPTS "$HERE/scripts/Caddyfile.vessel" "$SSH_TARGET:/etc/caddy/Caddyfile"
$SSH 'set -e
  rm -f /etc/systemd/system/caddy.service.d/override.conf /etc/caddy/caddy.env
  systemctl daemon-reload || true
  caddy validate --config /etc/caddy/Caddyfile
  systemctl reload caddy
'

echo "[deploy] (8/8) verifying..."
$SSH 'set -e
  echo "  systemd 8gent-os:     $(systemctl is-active 8gent-os.service)"
  echo "  systemd caddy:        $(systemctl is-active caddy)"
  echo "  systemd 8gent-daemon: $(systemctl is-active 8gent-daemon.service)"
  echo "  port 3000 (next):    $(ss -tlnp | grep -c :3000) listener(s)"
  echo "  port 18789 (daemon): $(ss -tlnp | grep -c :18789) listener(s)"
  echo "  HTTPS HEAD:           $(curl -ksI https://james.8gentos.com/ | head -1)"
'

echo "[deploy] done. https://james.8gentos.com"
