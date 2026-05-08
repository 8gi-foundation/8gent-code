#!/usr/bin/env bash
# Run ONCE on a fresh Hetzner box (cax21, Ubuntu/Debian) as root.
# Idempotent. Safe to re-run.
#
#   ssh root@<box-ip> "bash -s" < infra/hetzner/bootstrap.sh
#
# What this does:
#   1. Installs docker + compose-plugin via the official convenience script
#   2. Creates /opt/8gent (code), /etc/8gent (secrets), /var/lib/8gent (data)
#   3. Drops env templates into /etc/8gent for the operator to fill in
#   4. Locks down secret file permissions
#
# What this does NOT do:
#   - Pull the repo (deploy.sh does that via rsync)
#   - Start containers (deploy.sh does that)
#   - Write any real secrets (operator fills /etc/8gent/*.env manually)

set -euo pipefail

CODE_DIR=/opt/8gent
ETC_DIR=/etc/8gent
DATA_DIR=/var/lib/8gent

echo "[bootstrap] installing docker + compose plugin"
if ! command -v docker >/dev/null 2>&1; then
    curl -fsSL https://get.docker.com | sh
fi
if ! docker compose version >/dev/null 2>&1; then
    apt-get update
    apt-get install -y docker-compose-plugin
fi

echo "[bootstrap] preparing directories"
mkdir -p "$CODE_DIR" "$ETC_DIR" "$DATA_DIR"
chmod 700 "$ETC_DIR"
chmod 755 "$DATA_DIR"

echo "[bootstrap] dropping env templates if missing"
for f in daemon.env bots.env; do
    if [ ! -f "$ETC_DIR/$f" ]; then
        if [ -f "$CODE_DIR/infra/hetzner/env/$f.example" ]; then
            cp "$CODE_DIR/infra/hetzner/env/$f.example" "$ETC_DIR/$f"
            chmod 600 "$ETC_DIR/$f"
            echo "[bootstrap] created $ETC_DIR/$f from template (FILL THIS IN)"
        else
            echo "[bootstrap] WARN: $CODE_DIR/infra/hetzner/env/$f.example missing - run deploy.sh first"
        fi
    else
        echo "[bootstrap] $ETC_DIR/$f already exists, leaving it alone"
    fi
done

echo "[bootstrap] done"
echo
echo "Next steps:"
echo "  1. From your laptop:  bash infra/hetzner/deploy.sh <box-ip>"
echo "  2. On the box:        \$EDITOR /etc/8gent/daemon.env  /etc/8gent/bots.env"
echo "  3. From your laptop:  bash infra/hetzner/deploy.sh <box-ip> up"
echo "  4. Smoke test:        send a Telegram message to each bot"
