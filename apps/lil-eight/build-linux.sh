#!/usr/bin/env bash
# Build Lil Eight assets for Linux (terminal + dock entry). Native dock app stays macOS-only (Swift).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "Building Lil Eight (Linux) v0.2.0..."

if ! command -v bun >/dev/null 2>&1 && [[ ! -x "${HOME}/.bun/bin/bun" ]]; then
  echo "Bun is required. Install: https://bun.sh" >&2
  exit 1
fi

if command -v bun >/dev/null 2>&1; then
  export PATH="$(cd "$(dirname "$(command -v bun)")" && pwd):${PATH}"
elif [[ -x "${HOME}/.bun/bin/bun" ]]; then
  export PATH="${HOME}/.bun/bin:${PATH}"
fi

if [[ ! -f "$SCRIPT_DIR/sprites/atlas.png" ]]; then
  echo "Generating sprites..."
  (cd "$REPO" && bun run apps/lil-eight/generate-sprites.ts)
fi

RUNNER="$SCRIPT_DIR/run-terminal-pet.sh"
chmod +x "$RUNNER"

LINUX_OUT="$SCRIPT_DIR/build/linux"
mkdir -p "$LINUX_OUT"

DESKTOP="$LINUX_OUT/8gent-lil-eight-term.desktop"
{
  echo "[Desktop Entry]"
  echo "Version=1.0"
  echo "Type=Application"
  echo "Name=Lil Eight"
  echo "Comment=8gent terminal pet companion"
  echo "Exec=${RUNNER}"
  echo "Terminal=true"
  echo "Categories=Utility;Development;"
  echo "Keywords=8gent;pet;terminal;"
} > "$DESKTOP"
chmod +x "$DESKTOP"

echo ""
echo "Linux build ready."
echo "  Runner:  $RUNNER"
echo "  Desktop: $DESKTOP  (copy to ~/.local/share/applications/ if you want an app menu entry)"
echo "  From TUI: /pet start opens a new terminal when gnome-terminal, kitty, konsole, xfce4-terminal, alacritty, or xterm is available."
echo ""
