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

APP="REFUGIO.app"
BIN=".build/release/RefugioBar"
DEST="/Applications/REFUGIO.app"
LOG="/tmp/refugio-swift-build.log"

# A failed build used to end the script with whatever `swift build` printed and
# nothing else — and because a failure never reaches the copy below, the app in
# /Applications stays exactly as it was. That combination is genuinely
# misleading: the update appears to have worked, the old binary keeps running,
# and the symptoms are cosmetic enough (a wordmark under the traffic lights, a
# window that won't drag) to look like unrelated bugs. Two rounds of this were
# spent chasing the wrong thing. So say it in as many words.
echo "▸ Building (release)…"
set +e
swift build -c release 2>&1 | tee "$LOG"
BUILD_STATUS=${PIPESTATUS[0]}
set -e
if [ "$BUILD_STATUS" -ne 0 ]; then
  echo
  echo "✗ THE MENU-BAR APP DID NOT BUILD. Nothing was installed."
  if [ -d "$DEST" ]; then
    STAMP="$(date -r "$DEST/Contents/MacOS/RefugioBar" '+%Y-%m-%d %H:%M' 2>/dev/null || echo unknown)"
    echo "  $DEST is UNCHANGED — still the build from $STAMP."
    echo "  It will keep running with the old behaviour until this compiles."
  else
    echo "  There is no app in /Applications, so there will be no menu-bar icon."
  fi
  echo
  echo "  What the compiler said:"
  grep -E "error:" "$LOG" | sed 's/^/    /' | head -20
  echo
  echo "  Full output: $LOG"
  exit 1
fi
echo "▸ Assembling $APP…"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/RefugioBar"
cp Info.plist "$APP/Contents/Info.plist"

# macOS 26 can block a menu bar icon by bundle ID, and the block survives being
# re-enabled in System Settings when another app's stale entry references this
# one. A fresh identifier is the only reliable way out, so make it overridable
# rather than something only a source edit can change:
#
#   REFUGIO_BUNDLE_ID=com.phantazein.refugio.app2 ./install.sh
if [ -n "${REFUGIO_BUNDLE_ID:-}" ]; then
  /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $REFUGIO_BUNDLE_ID" "$APP/Contents/Info.plist"
  echo "  using bundle id $REFUGIO_BUNDLE_ID"
fi

# App icon. Built here from REFUGIO's existing artwork rather than checked in,
# so there is one source of truth for the logo.
#
# This is not decoration. System Settings ▸ Control Center lists menu bar apps
# by their icon, and two menu-bar apps that work on the same machine
# (SmackMyMacUp, ItsGOATtime) both ship one where this bundle shipped none.
ICON_SRC="$(cd "$(dirname "$0")/.." && pwd)/branding/web-app-manifest-512x512.png"
if [ -f "$ICON_SRC" ] && command -v iconutil >/dev/null 2>&1; then
  echo "▸ Building app icon…"
  ICONSET="$(mktemp -d)/AppIcon.iconset"
  mkdir -p "$ICONSET"
  for sz in 16 32 64 128 256 512; do
    # `|| true` matters: this script runs under `set -e`, so one sips hiccup
    # would abort the entire menu-bar install over a missing icon size.
    sips -z $sz $sz "$ICON_SRC" --out "$ICONSET/icon_${sz}x${sz}.png" >/dev/null 2>&1 || true
    sips -z $((sz*2)) $((sz*2)) "$ICON_SRC" --out "$ICONSET/icon_${sz}x${sz}@2x.png" >/dev/null 2>&1 || true
  done
  iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns" 2>/dev/null \
    && echo "  icon built" || echo "  icon build failed — continuing without one"
  rm -rf "$(dirname "$ICONSET")"
fi

# PkgInfo — the classic four-plus-four type/creator stamp. Both working apps
# write one; this bundle did not.
printf 'APPL????' > "$APP/Contents/PkgInfo"

# Ad-hoc sign, --deep so the nested binary and resources are covered too.
# The failure was also being swallowed: `|| true` after a silenced codesign
# meant an unsigned bundle looked exactly like a signed one.
echo "▸ Signing (ad-hoc)…"
if ! codesign --force --deep --sign - "$APP" 2>/tmp/refugio-codesign.log; then
  echo "  ⚠ codesign failed — the app may not be treated as a real app:"
  sed 's/^/    /' /tmp/refugio-codesign.log
fi

# DEST is set at the top, beside the build-failure message that reports it.
echo "▸ Installing to $DEST…"
pkill -f "REFUGIO.app/Contents/MacOS/RefugioBar" 2>/dev/null || true
sleep 1
rm -rf "$DEST"
cp -R "$APP" "$DEST"
xattr -cr "$DEST" 2>/dev/null || true

echo "▸ Launching…"
open "$DEST"
echo "✓ Installed to /Applications and launched."
echo "  Menu: Open / Start / Stop REFUGIO · Launch at Login · Quit."
echo "  Re-run ./install.sh to update."
echo

# The failure this app is prone to is invisible: it runs, and nothing appears.
# Print what it decided, rather than leaving "look for the icon" as the only
# feedback when there is no icon to look for.
#
# Two seconds, not ten. Ten was sized to outlast the placement watch's own
# retries — and that watch has been deleted, because it was the bug. What
# remains is a single line logged the moment the status item is created, so
# there is nothing left to wait for. Ten seconds of silence directly under
# "Menu-bar app installed" made the installer look hung at the one step whose
# message tells you to go and look at something.
sleep 2
echo "▸ Menu bar placement:"
if [ -f "$HOME/.refugio-logs/menubar.log" ]; then
  tail -n 2 "$HOME/.refugio-logs/menubar.log" | sed 's/^/  /'
else
  echo "  (no log yet)"
fi
echo
echo "  No icon yet? REFUGIO keeps asking for a slot for a minute before falling"
echo "  back to a Dock icon — and keeps checking after that, so the icon returns"
echo "  by itself once you close another menu-bar app. 'refugio restart' and"
echo "  'refugio stop' work from a terminal either way, and 'refugio menubar'"
echo "  relaunches this app and prints that log."
