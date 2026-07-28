#!/usr/bin/env bash
# REFUGIO tray icon for Linux.
#
# Linux has no single tray API — GNOME dropped legacy StatusNotifier support
# (it needs the AppIndicator extension), while KDE/XFCE/Cinnamon/MATE work out
# of the box. Rather than pull in a GUI toolkit, this drives `yad`, a small
# dialog utility packaged for every mainstream distro.
#
# If yad isn't installed we say so and exit cleanly instead of failing loudly —
# `refugio` / `refugio stop` on the command line still work, and the tray is a
# convenience, not the product.
#
# Usage: refugio-tray.sh [--status|--memory]   (introspection, used by tests)

set -uo pipefail

REFUGIO_DIR="${REFUGIO_DIR:-$HOME/refugio}"
CHAT_PORT="${REFUGIO_CHAT_PORT:-8090}"
OWUI_PORT=8080
ICON="$REFUGIO_DIR/branding/favicon.png"

# ── Status helpers (no GUI — safe to call anywhere) ─────────

port_open() {
  # bash's /dev/tcp needs no external tools; timeout keeps a dead port cheap.
  timeout 0.4 bash -c "exec 3<>/dev/tcp/127.0.0.1/$1" 2>/dev/null && return 0 || return 1
}

refugio_url() {
  if port_open "$CHAT_PORT"; then echo "http://127.0.0.1:$CHAT_PORT"; return 0; fi
  if port_open "$OWUI_PORT"; then echo "http://127.0.0.1:$OWUI_PORT"; return 0; fi
  return 1
}

# Resident memory of the whole stack in MB (supervisor, chat, Ollama, OWUI).
stack_memory_mb() {
  ps -eo rss,args 2>/dev/null \
    | grep -E 'start-refugio|chat/server\.js|open-webui|ollama|mcpo' \
    | grep -v grep \
    | awk '{s+=$1} END {print int(s/1024)}'
}

status_line() {
  if refugio_url >/dev/null; then
    local mb; mb=$(stack_memory_mb)
    if [ "${mb:-0}" -gt 0 ]; then
      printf 'REFUGIO — running · %.1f GB RAM\n' "$(awk "BEGIN{print $mb/1024}")"
    else
      echo "REFUGIO — running"
    fi
  else
    echo "REFUGIO — stopped"
  fi
}

# ── Actions ─────────────────────────────────────────────────

start_refugio() {
  command -v node >/dev/null || { echo "node not found" >&2; return 1; }
  ( cd "$REFUGIO_DIR" && setsid node "$REFUGIO_DIR/start-refugio.cjs" >/dev/null 2>&1 & )
}

stop_refugio() {
  # The supervisor stops its own children; match on the script path so we don't
  # kill unrelated node processes.
  pkill -f "start-refugio" 2>/dev/null || true
}

open_refugio() {
  local url; url=$(refugio_url) || { start_refugio; return; }
  ( xdg-open "$url" >/dev/null 2>&1 & )
}

stop_and_quit() { stop_refugio; sleep 1.5; pkill -f "refugio-tray.sh" 2>/dev/null; }

# Introspection hooks — let the installer and tests check the logic without a
# display or yad present.
case "${1:-}" in
  --status)    status_line; exit 0 ;;
  --memory)    stack_memory_mb; exit 0 ;;
  --url)       refugio_url || echo "(not running)"; exit 0 ;;
  --start)     start_refugio; exit 0 ;;
  --stop)      stop_refugio; exit 0 ;;
  --open)      open_refugio; exit 0 ;;
  --stop-quit) stop_and_quit; exit 0 ;;
esac

# ── Tray ────────────────────────────────────────────────────

if ! command -v yad >/dev/null 2>&1; then
  cat >&2 <<EOF
REFUGIO tray needs 'yad' (a small dialog tool).

  Debian/Ubuntu   sudo apt install yad
  Fedora          sudo dnf install yad
  Arch            sudo pacman -S yad

REFUGIO itself works without it:
  refugio        start
  refugio stop   stop and free the RAM

On GNOME a tray icon also needs the AppIndicator extension:
  https://extensions.gnome.org/extension/615/appindicator-support/
EOF
  exit 1
fi

[ -f "$ICON" ] || ICON="dialog-information"

# yad's notification menu calls back into this script, so each item is just a
# flag invocation above.
SELF="$(readlink -f "$0")"
yad --notification \
    --listen \
    --image="$ICON" \
    --text="REFUGIO" \
    --command="bash $SELF --open" \
    --menu="Open REFUGIO!bash $SELF --open|\
Start REFUGIO!bash $SELF --start|\
Stop REFUGIO!bash $SELF --stop|\
Stop REFUGIO & Quit!bash $SELF --stop-quit|\
Quit tray only (keeps running)!quit" &
YAD_PID=$!

# Refresh the tooltip so hovering shows live status + RAM.
while kill -0 "$YAD_PID" 2>/dev/null; do
  echo "tooltip:$(status_line)"
  sleep 5
done > >(cat >/proc/$YAD_PID/fd/0 2>/dev/null) 2>/dev/null

wait "$YAD_PID" 2>/dev/null
