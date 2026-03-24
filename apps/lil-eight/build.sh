#!/bin/bash
# Build Lil Eight - the 8gent dock companion
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD_DIR="$SCRIPT_DIR/build"
APP_NAME="Lil Eight.app"
APP_DIR="$BUILD_DIR/$APP_NAME"

echo "Building Lil Eight v0.2.0..."

# 1. Generate sprites if missing
if [ ! -f "$SCRIPT_DIR/sprites/atlas.png" ]; then
  echo "Generating sprites..."
  cd "$SCRIPT_DIR/../.." && bun run apps/lil-eight/generate-sprites.ts
fi

# 2. Create .app bundle structure
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/Contents/MacOS"
mkdir -p "$APP_DIR/Contents/Resources/sprites"
mkdir -p "$APP_DIR/Contents/Resources/sounds"

# 3. Copy Info.plist
cp "$SCRIPT_DIR/LilEight/Info.plist" "$APP_DIR/Contents/"

# 4. Copy sprites into Resources
cp "$SCRIPT_DIR/sprites/"*.png "$APP_DIR/Contents/Resources/sprites/"
cp "$SCRIPT_DIR/sprites/manifest.json" "$APP_DIR/Contents/Resources/sprites/"

# 5. Copy sounds into Resources (if they exist)
if [ -d "$SCRIPT_DIR/sounds" ] && ls "$SCRIPT_DIR/sounds/"*.mp3 &>/dev/null; then
  cp "$SCRIPT_DIR/sounds/"*.mp3 "$APP_DIR/Contents/Resources/sounds/" 2>/dev/null || true
  cp "$SCRIPT_DIR/sounds/"*.m4a "$APP_DIR/Contents/Resources/sounds/" 2>/dev/null || true
  cp "$SCRIPT_DIR/sounds/"*.wav "$APP_DIR/Contents/Resources/sounds/" 2>/dev/null || true
  echo "Bundled sounds"
else
  echo "No sounds found (optional - will run silently)"
fi

# 6. Compile Swift
echo "Compiling Swift..."
swiftc \
  -o "$APP_DIR/Contents/MacOS/LilEight" \
  -framework Cocoa \
  -framework AVFoundation \
  -framework UserNotifications \
  -framework Speech \
  -framework ScreenCaptureKit \
  -O \
  "$SCRIPT_DIR/LilEight/main.swift"

# 7. Write PkgInfo
echo -n "APPL????" > "$APP_DIR/Contents/PkgInfo"

# 8. Ad-hoc code sign (stable identity so macOS remembers permissions)
echo "Signing..."
codesign --force --deep --sign - "$APP_DIR" 2>/dev/null || echo "Note: codesign skipped"

echo ""
echo "Built: $APP_DIR"
echo "Run:   open \"$APP_DIR\""
echo ""
echo "Dev mode (sprites + sounds from source):"
echo "  LIL_EIGHT_SPRITES=$SCRIPT_DIR/sprites LIL_EIGHT_SOUNDS=$SCRIPT_DIR/sounds open \"$APP_DIR\""
