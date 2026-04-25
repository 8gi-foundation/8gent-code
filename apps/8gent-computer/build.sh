#!/bin/bash
# Build 8gent Computer - the on-device Mac agent that drives cua-driver.
#
# Mirrors apps/lil-eight/build.sh: swiftc directly, ad-hoc codesign so macOS
# remembers TCC permissions across runs. No Xcode required.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD_DIR="$SCRIPT_DIR/build"
APP_NAME="8gentComputer.app"
APP_DIR="$BUILD_DIR/$APP_NAME"

echo "Building 8gent Computer v0.1.0..."

# 1. Clean + scaffold
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/Contents/MacOS"
mkdir -p "$APP_DIR/Contents/Resources"

# 2. Info.plist
cp "$SCRIPT_DIR/Info.plist" "$APP_DIR/Contents/"

# 3. Compile Swift
echo "Compiling Swift..."
swiftc \
  -o "$APP_DIR/Contents/MacOS/8gentComputer" \
  -framework Cocoa \
  -framework SwiftUI \
  -framework Combine \
  -O \
  -parse-as-library \
  "$SCRIPT_DIR/8gentComputer/8gentComputerApp.swift" \
  "$SCRIPT_DIR/8gentComputer/MainWindow.swift" \
  "$SCRIPT_DIR/8gentComputer/HandsBridge.swift" \
  "$SCRIPT_DIR/8gentComputer/Plan.swift"

# 4. PkgInfo
echo -n "APPL????" > "$APP_DIR/Contents/PkgInfo"

# 5. Ad-hoc codesign so macOS remembers permissions for this stable identity.
echo "Signing..."
codesign --force --deep --sign - "$APP_DIR" 2>/dev/null || echo "Note: codesign skipped"

echo ""
echo "Built: $APP_DIR"
echo "Run:   open \"$APP_DIR\""
echo ""
echo "First run: Mac will warn it is unsigned. Right-click -> Open to accept."
echo "Set EIGHT_REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd) when launching from outside the repo."
