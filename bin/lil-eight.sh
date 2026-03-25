#!/bin/bash
# Launch Lil Eight - the 8gent dock companion
# Usage: lil-eight [build|open|kill|log|status]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="$SCRIPT_DIR/apps/lil-eight/build/Lil Eight.app"

case "${1:-start}" in
  build)
    if [ "$(uname -s)" = "Darwin" ]; then
      bash "$SCRIPT_DIR/apps/lil-eight/build.sh"
    else
      bash "$SCRIPT_DIR/apps/lil-eight/build-linux.sh"
    fi
    ;;
  open|start)
    if [ "$(uname -s)" = "Darwin" ]; then
      if [ ! -d "$APP_DIR" ]; then
        echo "Building Lil Eight first..."
        bash "$SCRIPT_DIR/apps/lil-eight/build.sh"
      fi
      pkill -f LilEight 2>/dev/null || true
      sleep 0.5
      open "$APP_DIR"
      echo "Lil Eight is on your Dock"
    else
      chmod +x "$SCRIPT_DIR/apps/lil-eight/run-terminal-pet.sh" 2>/dev/null || true
      bash "$SCRIPT_DIR/apps/lil-eight/run-terminal-pet.sh"
    fi
    ;;
  kill|stop)
    if [ "$(uname -s)" = "Darwin" ]; then
      pkill -f LilEight 2>/dev/null && echo "Lil Eight stopped" || echo "Not running"
    else
      pkill -f 'terminal-pet\.ts' 2>/dev/null && echo "Lil Eight stopped" || echo "Not running"
    fi
    ;;
  restart)
    if [ "$(uname -s)" = "Darwin" ]; then
      pkill -f LilEight 2>/dev/null || true
      sleep 1
      open "$APP_DIR"
      echo "Lil Eight restarted"
    else
      pkill -f 'terminal-pet\.ts' 2>/dev/null || true
      sleep 1
      bash "$SCRIPT_DIR/apps/lil-eight/run-terminal-pet.sh"
    fi
    ;;
  log|logs)
    tail -f ~/.8gent/lil-eight.log
    ;;
  status)
    if [ "$(uname -s)" = "Darwin" ]; then
      if pgrep -f LilEight > /dev/null 2>&1; then
        PID=$(pgrep -f LilEight)
        echo "Lil Eight running (pid $PID)"
        echo "Log: ~/.8gent/lil-eight.log"
        tail -3 ~/.8gent/lil-eight.log 2>/dev/null
      else
        echo "Lil Eight is not running"
      fi
    else
      if pgrep -f 'terminal-pet\.ts' > /dev/null 2>&1; then
        echo "Lil Eight (terminal) running"
      else
        echo "Lil Eight is not running"
      fi
    fi
    ;;
  *)
    echo "Usage: lil-eight [start|build|kill|restart|log|status]"
    ;;
esac
