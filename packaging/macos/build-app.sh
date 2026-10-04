#!/bin/bash
# Build a self-contained REFUGIO.app, and a .dmg to install it from.
#
# Self-contained means the app needs nothing else on the Mac to run REFUGIO:
#
#   REFUGIO.app/Contents/MacOS/RefugioBar          the menu-bar app
#   REFUGIO.app/Contents/Resources/refugio/        REFUGIO's code + node_modules
#   REFUGIO.app/Contents/Resources/runtime/        a Node for this architecture
#
# The app finds the code and the Node inside itself first (Stack.swift), and
# tells the supervisor it is packaged, so conversations and settings go to
# ~/.refugio-data — never into the app, which the next version replaces whole.
# Install is: open the .dmg, drag REFUGIO to Applications, open it.
#
# What it does NOT bring, same as the .pkg: Ollama (the window says how to get
# it, and notices when it is running), WhatsApp (Hermeneia), email (Epistole)
# and MemPalace, which the terminal installer sets up. Nor update notices: the
# update check compares git commits, and there is no git inside an app.
#
# One .dmg per architecture rather than one universal app: a universal Node is
# ~110 MB of the other machine's code in every download, and the Swift binary
# and node_modules (pure JavaScript, no native addons) are the same either way.
#
# Usage:
#   ./packaging/macos/build-app.sh                     this Mac's architecture
#   ARCHES="arm64 x64" ./packaging/macos/build-app.sh  both
#   APP_ID="Developer ID Application: Acme (TEAM)" … signed
#   … plus NOTARY_PROFILE=refugio                      signed + notarized
#
# Unsigned (the default — there is no Developer ID yet) means ad-hoc signed,
# which Apple silicon requires to run at all. Gatekeeper still refuses a
# DOWNLOADED ad-hoc app: the person has to allow it once in System Settings ▸
# Privacy & Security ▸ "Open Anyway". A .dmg built and opened on the same Mac
# is not quarantined and opens normally.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
BUILD="$ROOT/build/app"
OUT="$ROOT/dist"
VERSION="$(node -p "require('$ROOT/package.json').version" 2>/dev/null || echo "0.0.0")"
# The same runtime the .pkg ships. node:sqlite, which the chat store uses,
# needs 22.5 or later.
NODE_VERSION="${NODE_VERSION:-22.16.0}"
APP_ID="${APP_ID:-}"
NOTARY_PROFILE="${NOTARY_PROFILE:-}"
case "$(uname -m)" in arm64) DEFAULT_ARCH=arm64 ;; *) DEFAULT_ARCH=x64 ;; esac
ARCHES="${ARCHES:-$DEFAULT_ARCH}"

say()  { printf "\n\033[1m▸ %s\033[0m\n" "$1"; }
ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; }
warn() { printf "  \033[33m!\033[0m %s\n" "$1"; }
die()  { printf "  \033[31m✗\033[0m %s\n" "$1"; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "this builds a macOS app — run it on a Mac (or a macos-latest runner)."
command -v swift >/dev/null 2>&1 || die "Swift toolchain not found. Install it with: xcode-select --install"
command -v git >/dev/null 2>&1 || die "git is needed to list the files that ship"

rm -rf "$BUILD"
mkdir -p "$BUILD" "$OUT"
CACHE="$ROOT/build/cache"; mkdir -p "$CACHE"

# ── The code, once for every architecture ───────────────────
#
# Tracked files only, from git — not the working tree wholesale. A checkout
# that has been RUN holds data/ (someone's conversations), mcpo-config.json,
# Start REFUGIO.command and logs, none of which git tracks, and none of which
# may ever ship. Copying the tree with an exclude list is one forgotten
# pattern away from publishing a chat database.
#
# Then only what runs: tests, evals, docs, packaging and the Swift sources are
# for building REFUGIO, not for running it.
say "Collecting REFUGIO's code"
CODE="$BUILD/refugio"
mkdir -p "$CODE"
( cd "$ROOT" && git ls-files -z -- . \
    ':!:test/' ':!:eval/' ':!:docs/' ':!:packaging/' ':!:menubar/' \
    ':!:.github/' ':!:assets/' ':!:branding/' ':!:*.md' \
  | rsync -a --from0 --files-from=- ./ "$CODE/" )
for must in start-refugio.cjs chat/server.js editions.cjs package.json package-lock.json; do
  [ -f "$CODE/$must" ] || die "$must is missing from the collected code"
done
for never in data mcpo-config.json "Start REFUGIO.command"; do
  [ ! -e "$CODE/$never" ] || die "$never was collected — it must never ship"
done
ok "$(cd "$CODE" && find . -type f | wc -l | tr -d ' ') files"

# Production dependencies, without the optional ones: the pi-ai spike
# (chat/engine.js, REFUGIO_ENGINE_LIB=pi) is ~90 MB that nothing on the default
# path loads, and it is imported lazily, so its absence only matters to someone
# who switches that experiment on.
say "Installing production dependencies"
( cd "$CODE" && npm ci --omit=dev --omit=optional --ignore-scripts >/dev/null 2>&1 ) \
  || die "npm ci failed — the app would ship without its dependencies"
if find "$CODE/node_modules" -name "*.node" -type f | grep -q .; then
  die "a dependency ships a native addon — one node_modules no longer serves both architectures"
fi
ok "node_modules ($(du -sh "$CODE/node_modules" | cut -f1))"

# ── The icon, once ──────────────────────────────────────────
ICNS="$BUILD/AppIcon.icns"
ICON_SRC="$ROOT/branding/web-app-manifest-512x512.png"
if [ -f "$ICON_SRC" ] && command -v iconutil >/dev/null 2>&1; then
  ICONSET="$BUILD/AppIcon.iconset"; mkdir -p "$ICONSET"
  for sz in 16 32 64 128 256 512; do
    sips -z $sz $sz "$ICON_SRC" --out "$ICONSET/icon_${sz}x${sz}.png" >/dev/null 2>&1 || true
    sips -z $((sz*2)) $((sz*2)) "$ICON_SRC" --out "$ICONSET/icon_${sz}x${sz}@2x.png" >/dev/null 2>&1 || true
  done
  iconutil -c icns "$ICONSET" -o "$ICNS" 2>/dev/null || warn "icon build failed — continuing without one"
fi

# ── One app and one .dmg per architecture ───────────────────
for arch in $ARCHES; do
  case "$arch" in
    arm64) SWIFT_ARCH=arm64 ;;
    x64)   SWIFT_ARCH=x86_64 ;;
    *)     die "unknown architecture '$arch' — use arm64 or x64" ;;
  esac
  say "REFUGIO.app for $arch"
  STAGE="$BUILD/$arch"
  APP="$STAGE/REFUGIO.app"
  mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

  ( cd "$ROOT/menubar" && swift build -c release --arch "$SWIFT_ARCH" >/dev/null ) \
    || die "the menu-bar app did not compile for $arch"
  BIN_DIR="$(cd "$ROOT/menubar" && swift build -c release --arch "$SWIFT_ARCH" --show-bin-path)"
  # Named as Info.plist's CFBundleExecutable says, or macOS will not launch it.
  cp "$BIN_DIR/RefugioBar" "$APP/Contents/MacOS/RefugioBar"
  cp "$ROOT/menubar/Info.plist" "$APP/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" "$APP/Contents/Info.plist" 2>/dev/null \
    || /usr/libexec/PlistBuddy -c "Add :CFBundleShortVersionString string $VERSION" "$APP/Contents/Info.plist"
  [ -f "$ICNS" ] && cp "$ICNS" "$APP/Contents/Resources/AppIcon.icns"
  printf 'APPL????' > "$APP/Contents/PkgInfo"
  ok "menu-bar app"

  cp -R "$CODE" "$APP/Contents/Resources/refugio"
  ok "code"

  TARBALL="node-v${NODE_VERSION}-darwin-${arch}.tar.gz"
  if [ ! -f "$CACHE/$TARBALL" ]; then
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/${TARBALL}" -o "$CACHE/$TARBALL" \
      || die "could not download Node $NODE_VERSION for $arch"
  fi
  # Checked against nodejs.org's published sums, so a corrupted or substituted
  # download cannot become the runtime of every copy of this build.
  SUMS="$CACHE/SHASUMS256-${NODE_VERSION}.txt"
  [ -f "$SUMS" ] || curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" -o "$SUMS" \
    || die "could not download Node's checksums"
  ( cd "$CACHE" && grep " $TARBALL\$" "$SUMS" | shasum -a 256 -c - >/dev/null ) \
    || die "$TARBALL does not match nodejs.org's SHA-256 — not shipping it"
  RUNTIME="$APP/Contents/Resources/runtime"
  mkdir -p "$RUNTIME"
  tar -xzf "$CACHE/$TARBALL" -C "$RUNTIME" --strip-components=1
  # Only `node` runs. Headers and man pages are for building against Node, and
  # npm, npx and corepack (lib/, ~19 MB) for installing packages — nothing in
  # REFUGIO launches any of them; every connector is started as `node <file>`.
  # Node's LICENSE stays.
  rm -rf "$RUNTIME/include" "$RUNTIME/share" "$RUNTIME/lib" "$RUNTIME/CHANGELOG.md" "$RUNTIME/README.md" \
         "$RUNTIME/bin/npm" "$RUNTIME/bin/npx" "$RUNTIME/bin/corepack"
  [ "$("$RUNTIME/bin/node" -p process.arch 2>/dev/null || echo cross)" = "$arch" ] \
    || [ "$arch" != "$DEFAULT_ARCH" ] \
    || die "the bundled Node does not run as $arch"
  ok "Node $NODE_VERSION"

  if [ -n "$APP_ID" ]; then
    codesign --force --deep --options runtime --timestamp --sign "$APP_ID" "$APP" \
      || die "could not sign REFUGIO.app with '$APP_ID'"
    ok "signed ($APP_ID)"
  else
    # Ad-hoc. Apple silicon will not run unsigned code at all; --deep covers the
    # bundled node, whose own signature would not survive being copied in.
    codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || die "ad-hoc signing failed"
    warn "ad-hoc signed — a downloaded copy needs “Open Anyway” once (see the README)"
  fi

  # The .dmg: the app beside a shortcut to /Applications, which is the whole
  # of the instructions.
  DMG_STAGE="$STAGE/dmg"
  mkdir -p "$DMG_STAGE"
  cp -R "$APP" "$DMG_STAGE/"
  ln -s /Applications "$DMG_STAGE/Applications"
  DMG="$OUT/REFUGIO-${VERSION}-${arch}.dmg"
  rm -f "$DMG"
  hdiutil create -volname "REFUGIO" -srcfolder "$DMG_STAGE" -ov -format UDZO "$DMG" >/dev/null \
    || die "hdiutil could not create $DMG"
  if [ -n "$APP_ID" ] && [ -n "$NOTARY_PROFILE" ]; then
    codesign --sign "$APP_ID" --timestamp "$DMG" || die "could not sign the .dmg"
    xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait || die "notarization failed"
    xcrun stapler staple "$DMG" || die "could not staple the notarization ticket"
    ok "notarized"
  fi
  ok "$(basename "$DMG") — app $(du -sh "$APP" | cut -f1), download $(du -sh "$DMG" | cut -f1)"
done

say "Done"
ls -1 "$OUT"/REFUGIO-"$VERSION"-*.dmg
