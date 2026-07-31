#!/bin/bash
# Build (and optionally sign and notarize) REFUGIO.pkg.
#
# The package is deliberately NOT a wrapper around install-node.cjs. That
# script is a per-user interactive installer: it prompts, it clones into
# ~/refugio, and it writes ~/Library/LaunchAgents. An MDM install runs as root,
# with no terminal and quite possibly with nobody logged in — under which
# `os.homedir()` is /var/root, so a naive wrap installs REFUGIO for root and
# for no human being at all.
#
# So this replaces install-node.cjs's job and reuses everything downstream of
# it. The payload is laid down once, per machine:
#
#   /usr/local/refugio/            the repo, node_modules, and a bundled Node
#   /Applications/REFUGIO.app      the menu-bar app
#   /Library/LaunchAgents/…        per-user agent, runs at each login
#
# and the per-user half — data directory, settings, supervisor — happens at
# login, as the user, run by that agent. That split is the whole reason this
# is MDM-deployable.
#
# Usage:
#   ./packaging/macos/build-pkg.sh                      unsigned, for testing
#   INSTALLER_ID="Developer ID Installer: Acme (TEAM)" \
#   APP_ID="Developer ID Application: Acme (TEAM)" \
#   ./packaging/macos/build-pkg.sh                      signed
#   … plus NOTARY_PROFILE=refugio                       signed + notarized
#
# Signing needs an Apple Developer Program membership. The two certificates are
# NOT interchangeable: Developer ID Installer signs the .pkg, Developer ID
# Application signs the .app inside it, and using one for the other fails with
# an error that does not say so.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
BUILD="$ROOT/build/pkg"
ROOTDIR="$BUILD/root"
OUT="$ROOT/dist"

IDENTIFIER="com.phantazein.refugio"
VERSION="$(node -p "require('$ROOT/package.json').version" 2>/dev/null || echo "0.0.0")"
NODE_VERSION="${NODE_VERSION:-22.16.0}"

INSTALLER_ID="${INSTALLER_ID:-}"
APP_ID="${APP_ID:-}"
NOTARY_PROFILE="${NOTARY_PROFILE:-}"

say()  { printf "\n\033[1m▸ %s\033[0m\n" "$1"; }
ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; }
warn() { printf "  \033[33m!\033[0m %s\n" "$1"; }
die()  { printf "  \033[31m✗\033[0m %s\n" "$1"; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "pkgbuild only exists on macOS — this must run on a Mac (or a macos-latest runner)."

rm -rf "$BUILD"
mkdir -p "$ROOTDIR/usr/local/refugio" "$ROOTDIR/Library/LaunchAgents" "$OUT"

# ── Payload: the application code ───────────────────────────
#
# Copied from the working tree rather than cloned, so what ships is exactly
# what was tested. .git is excluded on purpose: it is 80% of the tree, and the
# update check degrades to "not a git checkout" rather than breaking — which is
# correct for a managed machine, where updates arrive through MDM and a user
# running `git pull` in /usr/local would be the surprise.
say "Copying application payload"
rsync -a --delete \
  --exclude ".git" --exclude "build" --exclude "dist" \
  --exclude "node_modules" --exclude "*.log" \
  "$ROOT/" "$ROOTDIR/usr/local/refugio/"
ok "source tree"

say "Installing production dependencies"
( cd "$ROOTDIR/usr/local/refugio" && npm ci --omit=dev --ignore-scripts >/dev/null 2>&1 ) \
  || ( cd "$ROOTDIR/usr/local/refugio" && npm install --omit=dev --ignore-scripts >/dev/null 2>&1 ) \
  || die "npm install failed — the payload would ship without its dependencies"
ok "node_modules ($(du -sh "$ROOTDIR/usr/local/refugio/node_modules" | cut -f1))"

# ── Payload: a Node runtime ─────────────────────────────────
#
# Bundled rather than required. A fleet Mac may have no Node, an old Node, or a
# Homebrew Node owned by one user and invisible to another — and "install
# Node.js 18+ first" is not an instruction you can give an MDM. This is the
# single biggest cause of install-time failure removed.
# BOTH architectures, not the build machine's. macos-latest is Apple silicon,
# and a package built there with only an arm64 runtime installs perfectly
# cleanly on every Intel Mac in the fleet and then does nothing — which is
# precisely the failure this whole design exists to avoid. The distribution
# declares hostArchitectures="arm64,x86_64"; the payload has to mean it.
#
# ~55 MB for the second copy. Cheap against half a fleet silently not working.
say "Bundling Node $NODE_VERSION (both architectures)"
CACHE="$ROOT/build/cache"; mkdir -p "$CACHE"
for arch in arm64 x64; do
  TARBALL="node-v${NODE_VERSION}-darwin-${arch}.tar.gz"
  if [ ! -f "$CACHE/$TARBALL" ]; then
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/${TARBALL}" -o "$CACHE/$TARBALL" \
      || die "could not download Node $NODE_VERSION for $arch"
  fi
  mkdir -p "$ROOTDIR/usr/local/refugio/runtime/darwin-${arch}"
  tar -xzf "$CACHE/$TARBALL" -C "$ROOTDIR/usr/local/refugio/runtime/darwin-${arch}" --strip-components=1
  ok "runtime/darwin-${arch}/bin/node"
done

# ── Payload: the menu-bar app ───────────────────────────────
say "Building the menu-bar app"
if [ -d "$ROOT/menubar" ]; then
  ( cd "$ROOT/menubar" && swift build -c release ) || die "the menu-bar app did not compile"
  APP="$ROOTDIR/Applications/REFUGIO.app"
  mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
  cp "$ROOT/menubar/.build/release/RefugioBar" "$APP/Contents/MacOS/REFUGIO"
  [ -f "$ROOT/menubar/Info.plist" ] && cp "$ROOT/menubar/Info.plist" "$APP/Contents/Info.plist"
  [ -f "$ROOT/menubar/Resources/AppIcon.icns" ] && cp "$ROOT/menubar/Resources/AppIcon.icns" "$APP/Contents/Resources/"

  # The .app needs Developer ID APPLICATION, with a hardened runtime and a
  # timestamp — notarization rejects a bundle missing any of the three, and the
  # PPPC profile that grants Automation is keyed to this signature, so an
  # ad-hoc signed build cannot be granted anything by MDM.
  if [ -n "$APP_ID" ]; then
    codesign --force --options runtime --timestamp --sign "$APP_ID" "$APP" \
      || die "could not sign REFUGIO.app with '$APP_ID'"
    ok "REFUGIO.app signed"
  else
    codesign --force --deep --sign - "$APP" 2>/dev/null || true
    warn "REFUGIO.app is ad-hoc signed — it cannot be notarized, and MDM cannot grant it Automation access"
  fi
else
  warn "no menubar/ directory — packaging without the menu-bar app"
fi

# ── Payload: the per-user agent ─────────────────────────────
say "Adding the login agent"
cp "$HERE/com.phantazein.refugio.agent.plist" "$ROOTDIR/Library/LaunchAgents/"
chmod 644 "$ROOTDIR/Library/LaunchAgents/com.phantazein.refugio.agent.plist"
mkdir -p "$ROOTDIR/usr/local/refugio/bin"
cp "$HERE/refugio-user-setup" "$ROOTDIR/usr/local/refugio/bin/"
cp "$HERE/refugio-cli" "$ROOTDIR/usr/local/refugio/bin/"
chmod 755 "$ROOTDIR/usr/local/refugio/bin/"*
ok "com.phantazein.refugio.agent"

# ── Build ───────────────────────────────────────────────────
say "Building the component package"
mkdir -p "$BUILD/scripts"
cp "$HERE/scripts/preinstall" "$HERE/scripts/postinstall" "$BUILD/scripts/"
chmod 755 "$BUILD/scripts/"*

pkgbuild \
  --root "$ROOTDIR" \
  --scripts "$BUILD/scripts" \
  --identifier "$IDENTIFIER" \
  --version "$VERSION" \
  --install-location "/" \
  --ownership recommended \
  "$BUILD/component.pkg" >/dev/null
ok "component.pkg"

say "Building the distribution package"
PKG="$OUT/REFUGIO-${VERSION}.pkg"
productbuild \
  --distribution "$HERE/distribution.xml" \
  --package-path "$BUILD" \
  --resources "$HERE/resources" \
  "$BUILD/REFUGIO-unsigned.pkg" >/dev/null
ok "assembled"

if [ -n "$INSTALLER_ID" ]; then
  productsign --sign "$INSTALLER_ID" "$BUILD/REFUGIO-unsigned.pkg" "$PKG" \
    || die "could not sign the package with '$INSTALLER_ID'"
  pkgutil --check-signature "$PKG" >/dev/null || die "the signed package does not verify"
  ok "signed with $INSTALLER_ID"
else
  cp "$BUILD/REFUGIO-unsigned.pkg" "$PKG"
  warn "UNSIGNED — Gatekeeper will refuse this on any Mac that did not build it."
  warn "It is fine for testing and useless for distribution. Set INSTALLER_ID to sign."
fi

# ── Notarize ────────────────────────────────────────────────
#
# Separate from signing and required in addition to it: a signed but
# un-notarized package still shows "cannot be opened because Apple cannot check
# it for malicious software" on any Mac since Catalina. Stapling is what makes
# it work on a machine that is offline at install time — which, for a laptop
# being provisioned, is common.
if [ -n "$NOTARY_PROFILE" ]; then
  say "Notarizing"
  xcrun notarytool submit "$PKG" --keychain-profile "$NOTARY_PROFILE" --wait \
    || die "notarization failed — run 'xcrun notarytool log' with the submission id for the reason"
  xcrun stapler staple "$PKG" || die "could not staple the notarization ticket"
  ok "notarized and stapled"
elif [ -n "$INSTALLER_ID" ]; then
  warn "signed but NOT notarized — macOS will still refuse it. Set NOTARY_PROFILE."
fi

say "Done"
echo "  $PKG"
echo "  $(du -h "$PKG" | cut -f1)"
echo ""
echo "  Install:   sudo installer -pkg \"$PKG\" -target /"
echo "  Inspect:   pkgutil --payload-files \"$PKG\" | head"
echo ""
