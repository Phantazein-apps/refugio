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
echo

# The failure this app is prone to is invisible: it runs, and nothing appears.
# Print what it decided, rather than leaving "look for the mountain" as the only
# feedback when there is no mountain to look for.
sleep 3
echo "▸ Menu bar placement:"
if [ -f "$HOME/.refugio-logs/menubar.log" ]; then
  tail -n 2 "$HOME/.refugio-logs/menubar.log" | sed 's/^/  /'
else
  echo "  (no log yet)"
fi
echo
echo "  No icon? Your menu bar may be full — REFUGIO falls back to a Dock icon and"
echo "  says so. Either way 'refugio restart' and 'refugio stop' work from a"
echo "  terminal, and 'refugio menubar' relaunches this app and prints that log."
echo "  Re-run ./install.sh to update."
