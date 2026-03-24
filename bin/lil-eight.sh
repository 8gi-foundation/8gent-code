#!/bin/bash
# Launch Lil Eight - the 8gent dock companion
# Usage: lil-eight [build|open|kill|log|status]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="$SCRIPT_DIR/apps/lil-eight/build/Lil Eight.app"

case "${1:-start}" in
  build)
    bash "$SCRIPT_DIR/apps/lil-eight/build.sh"
    ;;
  open|start)
    # Build if not built
    if [ ! -d "$APP_DIR" ]; then
      echo "Building Lil Eight first..."
      bash "$SCRIPT_DIR/apps/lil-eight/build.sh"
    fi
    # Kill existing if running
    pkill -f LilEight 2>/dev/null || true
    sleep 0.5
    open "$APP_DIR"
    echo "Lil Eight is on your Dock"
    ;;
  kill|stop)
    pkill -f LilEight 2>/dev/null && echo "Lil Eight stopped" || echo "Not running"
    ;;
  restart)
    pkill -f LilEight 2>/dev/null || true
    sleep 1
    open "$APP_DIR"
    echo "Lil Eight restarted"
    ;;
  log|logs)
    tail -f ~/.8gent/lil-eight.log
    ;;
  status)
    if pgrep -f LilEight > /dev/null 2>&1; then
      PID=$(pgrep -f LilEight)
      echo "Lil Eight running (pid $PID)"
      echo "Log: ~/.8gent/lil-eight.log"
      tail -3 ~/.8gent/lil-eight.log 2>/dev/null
    else
      echo "Lil Eight is not running"
    fi
    ;;
  *)
    echo "Usage: lil-eight [start|build|kill|restart|log|status]"
    ;;
esac
