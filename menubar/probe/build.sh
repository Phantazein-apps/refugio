#!/bin/bash
# Build and launch the probe. Mirrors SmackMyMacUp's build.sh: swiftc directly
# (no SwiftPM), a hand-assembled bundle, PkgInfo, ad-hoc --deep signature.
set -euo pipefail
cd "$(dirname "$0")"

APP=".build/Probe.app"
rm -rf .build
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

echo "==> Compiling…"
swiftc -target "$(uname -m)-apple-macos13.0" -O -sdk "$(xcrun --show-sdk-path)" \
  -parse-as-library Probe.swift -o "$APP/Contents/MacOS/Probe"

cp Info.plist "$APP/Contents/Info.plist"
printf 'APPL????' > "$APP/Contents/PkgInfo"
codesign --force --deep -s - "$APP"

pkill -x Probe 2>/dev/null || true
rm -rf /Applications/Probe.app
cp -R "$APP" /Applications/
xattr -cr /Applications/Probe.app 2>/dev/null || true

echo "==> Launching…"
open /Applications/Probe.app
sleep 4
echo "==> $HOME/.refugio-logs/probe.log:"
cat "$HOME/.refugio-logs/probe.log" 2>/dev/null || echo "   (no log — the app may not have launched)"
echo
echo "Look for the word PROBE in your menu bar."
echo "Remove it with: pkill -x Probe; rm -rf /Applications/Probe.app"
