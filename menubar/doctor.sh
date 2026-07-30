#!/bin/bash
# Is the menu-bar app that is RUNNING the one in this checkout?
#
# This exists because a failed Swift build is silent in the worst possible way.
# install.sh runs under `set -e`, so a compile error exits before the copy
# step — and the copy step is the only thing that writes to /Applications. The
# app therefore survives a failed build completely untouched and keeps running
# the old code. The symptoms are all cosmetic-looking and all separate: the
# icon doesn't change, the window won't drag by its top bar, the wordmark hides
# under the traffic lights. Three bug reports, one cause.
#
# Run: ./menubar/doctor.sh
set -u
cd "$(dirname "$0")"

APP="/Applications/REFUGIO.app"
BIN="$APP/Contents/MacOS/RefugioBar"
SRC="Sources/RefugioBar"

echo "REFUGIO menu-bar app — what is actually installed"
echo

if [ ! -d "$APP" ]; then
  echo "  ✗ $APP does not exist."
  echo "    There will be no menu-bar icon at all. Build it:"
  echo "      ./menubar/install.sh"
  exit 1
fi

if [ ! -f "$BIN" ]; then
  echo "  ✗ $APP exists but has no binary inside it."
  echo "    Rebuild: ./menubar/install.sh"
  exit 1
fi

APP_EPOCH=$(stat -f %m "$BIN" 2>/dev/null || echo 0)
APP_WHEN=$(date -r "$BIN" '+%Y-%m-%d %H:%M' 2>/dev/null || echo unknown)
echo "  installed binary   $APP_WHEN"

# Newest source file — what the binary OUGHT to contain.
NEWEST=""
NEWEST_EPOCH=0
for f in "$SRC"/*.swift; do
  [ -f "$f" ] || continue
  E=$(stat -f %m "$f" 2>/dev/null || echo 0)
  if [ "$E" -gt "$NEWEST_EPOCH" ]; then NEWEST_EPOCH=$E; NEWEST=$f; fi
done
if [ -n "$NEWEST" ]; then
  echo "  newest source      $(date -r "$NEWEST" '+%Y-%m-%d %H:%M') ($(basename "$NEWEST"))"
fi

echo
if [ "$NEWEST_EPOCH" -gt "$APP_EPOCH" ]; then
  echo "  ✗ THE INSTALLED APP IS OLDER THAN THE SOURCE."
  echo
  echo "    Whatever you last saw is the OLD build. Everything that depends on"
  echo "    the native app — the menu-bar mark, dragging the window by its top"
  echo "    bar, the reserved band under the traffic lights — is unchanged."
  echo
  echo "    Rebuild, and read the output rather than the symptoms:"
  echo "      ./menubar/install.sh"
  echo
  if [ -f /tmp/refugio-swift-build.log ] && grep -q "error:" /tmp/refugio-swift-build.log; then
    echo "    The last build attempt failed with:"
    grep -E "error:" /tmp/refugio-swift-build.log | sed 's/^/      /' | head -10
  fi
  exit 1
fi

echo "  ✓ The installed app is at least as new as the source."
RUNNING=$(pgrep -f "REFUGIO.app/Contents/MacOS/RefugioBar" | head -1)
if [ -n "$RUNNING" ]; then
  echo "  ✓ It is running (pid $RUNNING)."
else
  echo "  ✗ It is NOT running — so there is no icon regardless of the build."
  echo "    Start it: open $APP"
fi
