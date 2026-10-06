#!/bin/bash
# Stands in for Anthropic's installer (claude.ai/install.sh) in tests: puts a
# `claude` at $FAKE_INSTALL_TARGET that runs fake-claude.mjs. With
# FAKE_INSTALL_FAIL set it fails the way a real install can — a message and a
# non-zero exit.
set -euo pipefail
if [ -n "${FAKE_INSTALL_FAIL:-}" ]; then
  echo "Downloading Claude Code…"
  echo "error: could not reach downloads.claude.ai" >&2
  exit 3
fi
mkdir -p "$(dirname "$FAKE_INSTALL_TARGET")"
printf '#!/bin/sh\nexec "%s" "%s" "$@"\n' "$(command -v node)" "$FAKE_CLAUDE_SCRIPT" > "$FAKE_INSTALL_TARGET"
chmod +x "$FAKE_INSTALL_TARGET"
echo "Claude Code successfully installed!"
