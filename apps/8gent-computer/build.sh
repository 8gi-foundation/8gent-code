#!/bin/bash
# Build 8gent Computer .app bundle.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD_DIR="$SCRIPT_DIR/build"
APP_NAME="8gent Computer.app"
APP_DIR="$BUILD_DIR/$APP_NAME"

echo "Building 8gent Computer v0.1.0..."

# 1. SPM build
cd "$SCRIPT_DIR"
swift build -c release

BIN_PATH="$SCRIPT_DIR/.build/release/8gent-computer"
if [ ! -f "$BIN_PATH" ]; then
  echo "Build failed: $BIN_PATH not found"
  exit 1
fi

# 2. Create .app bundle
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/Contents/MacOS"
mkdir -p "$APP_DIR/Contents/Resources"

# 3. Copy Info.plist
cp "$SCRIPT_DIR/Info.plist" "$APP_DIR/Contents/"

# 4. Copy executable
cp "$BIN_PATH" "$APP_DIR/Contents/MacOS/8gent-computer"

# 5. PkgInfo
echo -n "APPL????" > "$APP_DIR/Contents/PkgInfo"

# 6. Ad-hoc sign
codesign --force --deep --sign - "$APP_DIR" 2>/dev/null || echo "Note: codesign skipped"

echo ""
echo "Built: $APP_DIR"
echo "Run:   open \"$APP_DIR\""
echo "Headless: $BIN_PATH --headless --intent \"hello\""
