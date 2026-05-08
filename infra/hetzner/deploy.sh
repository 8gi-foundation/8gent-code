#!/usr/bin/env bash
# Deploy the daemon + both bridges to the Hetzner box.
# Run from the repo root on your laptop.
#
#   bash infra/hetzner/deploy.sh <box-ip> [up|restart|logs|status|down]
#
# Default action is "sync" — pushes code to /opt/8gent on the box without
# touching containers. Useful for staging changes before the operator restarts.
#
# Actions:
#   sync     rsync repo -> /opt/8gent (default if action omitted)
#   up       sync + docker compose up -d --build
#   restart  docker compose restart
#   logs     docker compose logs --tail=100 -f
#   status   docker compose ps
#   down     docker compose down

set -euo pipefail

if [ $# -lt 1 ]; then
    echo "usage: $0 <box-ip> [sync|up|restart|logs|status|down]" >&2
    exit 1
fi

HOST="$1"
ACTION="${2:-sync}"
SSH_USER="${SSH_USER:-root}"
REMOTE_DIR=/opt/8gent
COMPOSE_DIR="$REMOTE_DIR/infra/hetzner"
SSH="ssh -o StrictHostKeyChecking=accept-new $SSH_USER@$HOST"

# Tarball-style rsync — exclude what we don't need on the box.
sync_repo() {
    echo "[deploy] syncing repo to $SSH_USER@$HOST:$REMOTE_DIR"
    rsync -az --delete \
        --exclude '.git' \
        --exclude 'node_modules' \
        --exclude 'dist' \
        --exclude '.next' \
        --exclude '.turbo' \
        --exclude '.8gent' \
        --exclude '.claude' \
        --exclude 'tmp' \
        --exclude '*.log' \
        -e "ssh -o StrictHostKeyChecking=accept-new" \
        ./ "$SSH_USER@$HOST:$REMOTE_DIR/"
}

case "$ACTION" in
    sync)
        sync_repo
        ;;
    up)
        sync_repo
        echo "[deploy] docker compose up -d --build"
        $SSH "cd $COMPOSE_DIR && docker compose up -d --build"
        echo "[deploy] tailing daemon logs (Ctrl+C to detach)"
        $SSH "cd $COMPOSE_DIR && docker compose logs --tail=50 -f daemon"
        ;;
    restart)
        $SSH "cd $COMPOSE_DIR && docker compose restart"
        ;;
    logs)
        $SSH "cd $COMPOSE_DIR && docker compose logs --tail=100 -f"
        ;;
    status)
        $SSH "cd $COMPOSE_DIR && docker compose ps"
        ;;
    down)
        $SSH "cd $COMPOSE_DIR && docker compose down"
        ;;
    *)
        echo "unknown action: $ACTION" >&2
        exit 1
        ;;
esac
