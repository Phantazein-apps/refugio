#!/bin/bash
# Build the REFUGIO menu-bar app and install it to /Applications as a normal,
# Spotlight-launchable, login-capable menu-bar agent (no Dock icon).
#
# Requires the Swift toolchain (Xcode Command Line Tools: `xcode-select --install`).
# This is a one-time build on a machine that has the toolchain; the resulting
# REFUGIO.app is a tiny native app (~few hundred KB) that just starts/stops the
# existing ~/refugio supervisor.
set -e

# Resolve both directories ONCE, to absolute paths, BEFORE changing directory.
#
# `$0` was used again further down, after this cd had already happened — so
# `dirname "$0"` no longer meant what it did on line one. Invoked as
# `cd menubar && ./install.sh` it worked ("." resolves either way); invoked as
# `./menubar/install.sh` from the repo root it resolved to
# menubar/menubar/.., which does not exist. That is the form the README and I
# have been telling people to run.
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
cd "$HERE"

# --check: build, assemble and sign, then stop. Writes nothing to
# /Applications, launches nothing.
#
# This exists so CI can run the REAL script rather than a paraphrase of it.
# Every failure this script has had was in a step BEFORE the copy — a path
# resolved against the wrong working directory, a cosmetic step aborting the
# whole run under `set -e` — and all of them are reachable in --check mode.
# A CI job that only ran `swift build` would have caught none of them.
CHECK=0
if [ "${1:-}" = "--check" ]; then CHECK=1; fi

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
# Braced. macOS ships bash 3.2, whose identifier scan is not multibyte-aware:
# in `$APP…` it swallows the first byte of the ellipsis into the NAME, leaving
# an unset variable and two orphaned continuation bytes — which is why this
# line printed "Assembling <?><?>" and hid the one thing it was there to say.
echo "▸ Assembling ${APP}…"
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
#
# The WHOLE block is `|| true`-guarded, not just the sips calls. The individual
# guards were there and were not enough: the failure was in the command
# substitution computing ICON_SRC itself, which aborted the script under
# `set -e` — after a clean build, but BEFORE the copy to /Applications. So the
# build succeeded, nothing was installed, the old binary kept running, and the
# only symptom was an icon that never changed. A cosmetic step must never be
# able to stop the app from being installed.
ICON_SRC="$ROOT/branding/web-app-manifest-512x512.png"
build_icon() {
  [ -f "$ICON_SRC" ] || return 0
  command -v iconutil >/dev/null 2>&1 || return 0
  echo "▸ Building app icon…"
  ICONSET="$(mktemp -d)/AppIcon.iconset"
  mkdir -p "$ICONSET"
  for sz in 16 32 64 128 256 512; do
    sips -z $sz $sz "$ICON_SRC" --out "$ICONSET/icon_${sz}x${sz}.png" >/dev/null 2>&1 || true
    sips -z $((sz*2)) $((sz*2)) "$ICON_SRC" --out "$ICONSET/icon_${sz}x${sz}@2x.png" >/dev/null 2>&1 || true
  done
  iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns" 2>/dev/null \
    && echo "  icon built" || echo "  icon build failed — continuing without one"
  rm -rf "$(dirname "$ICONSET")"
}
build_icon || echo "  icon step failed — continuing; the app matters, the icon doesn't"

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

if [ "$CHECK" -eq 1 ]; then
  echo
  echo "✓ Build, assembly and signing all succeeded."
  echo "  --check: nothing was installed to /Applications and nothing launched."
  exit 0
fi

# DEST is set at the top, beside the build-failure message that reports it.
echo "▸ Installing to ${DEST}…"
pkill -f "REFUGIO.app/Contents/MacOS/RefugioBar" 2>/dev/null || true
sleep 1
rm -rf "$DEST"
cp -R "$APP" "$DEST"
xattr -cr "$DEST" 2>/dev/null || true

# Prove it. Every failure this script has had ends the same way — the app in
# /Applications is not the one just built — and none of them said so. Compare
# what was installed against what was compiled, and refuse to claim success on
# a mismatch.
BUILT_AT=$(stat -f %m "$BIN" 2>/dev/null || echo 0)
DEST_AT=$(stat -f %m "$DEST/Contents/MacOS/RefugioBar" 2>/dev/null || echo 0)
if [ "$DEST_AT" -lt "$BUILT_AT" ]; then
  echo "✗ $DEST is NOT the binary just built. Nothing below is reliable."
  exit 1
fi

echo "▸ Launching…"
open "$DEST"
echo "✓ Installed to /Applications and launched."
echo "  Installed binary: $(date -r "$DEST/Contents/MacOS/RefugioBar" '+%Y-%m-%d %H:%M')"
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
# Did it actually come up? `open` returning 0 only means Launch Services
# accepted the request. The decisive facts are whether the process exists and
# whether it logged from THIS launch — an install whose log's newest line is
# hours old is an app that did not start.
sleep 2
PID="$(pgrep -f "REFUGIO.app/Contents/MacOS/RefugioBar" | head -1)"
if [ -n "$PID" ]; then
  echo "▸ Running: pid $PID"
else
  echo "✗ The app is NOT running. It was installed but did not start."
  echo "  Try: open $DEST"
  echo "  If it exits immediately, macOS may have quarantined it — check"
  echo "  Console.app for a crash report naming RefugioBar."
fi

MB_LOG="$HOME/.refugio-logs/menubar.log"
echo "▸ Menu bar placement:"
if [ -f "$MB_LOG" ]; then
  tail -n 2 "$MB_LOG" | sed 's/^/  /'
  # The log is UTC; compare against the file's own mtime rather than parsing
  # the timestamps, which is portable and enough to answer "is this line new".
  AGE=$(( $(date +%s) - $(stat -f %m "$MB_LOG" 2>/dev/null || echo 0) ))
  if [ "$AGE" -gt 60 ]; then
    echo
    echo "  ⚠ That log has not been written for $((AGE / 60)) minutes, so those"
    echo "    lines are from an EARLIER launch — this one did not reach the"
    echo "    point where it creates the status item."
  fi
else
  echo "  (no log yet)"
fi
echo
echo "  No icon? System Settings ▸ Control Center keeps a per-app list of which"
echo "  menu-bar icons may show; REFUGIO has to be enabled there. 'refugio menubar'"
echo "  relaunches this app and prints that log. 'refugio restart' and"
echo "  'refugio stop' work from a terminal regardless of the icon."
