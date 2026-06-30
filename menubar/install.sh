#!/bin/bash
# Build the REFUGIO menu-bar app and install it to /Applications as a normal,
# Spotlight-launchable, login-capable menu-bar agent (no Dock icon).
#
# Requires the Swift toolchain (Xcode Command Line Tools: `xcode-select --install`).
# This is a one-time build on a machine that has the toolchain; the resulting
# REFUGIO.app is a tiny native app (~few hundred KB) that just starts/stops the
# existing ~/refugio supervisor.
set -e
cd "$(dirname "$0")"

if ! command -v swift >/dev/null 2>&1; then
  echo "✗ Swift toolchain not found. Install it with: xcode-select --install" >&2
  exit 1
fi

echo "▸ Building (release)…"
swift build -c release

APP="REFUGIO.app"
BIN=".build/release/RefugioBar"
echo "▸ Assembling $APP…"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/RefugioBar"
cp Info.plist "$APP/Contents/Info.plist"

# Ad-hoc sign: enough for a local menu-bar agent + SMAppService login item.
echo "▸ Signing (ad-hoc)…"
codesign --force --sign - "$APP" >/dev/null 2>&1 || true

DEST="/Applications/REFUGIO.app"
echo "▸ Installing to $DEST…"
pkill -f "REFUGIO.app/Contents/MacOS/RefugioBar" 2>/dev/null || true
sleep 1
rm -rf "$DEST"
cp -R "$APP" "$DEST"
xattr -cr "$DEST" 2>/dev/null || true

echo "▸ Launching…"
open "$DEST"
echo "✓ Installed to /Applications and launched — look for the mountain in your menu bar."
echo "  Menu: Open / Start / Stop REFUGIO · Launch at Login · Quit."
echo "  Re-run ./install.sh to update."
