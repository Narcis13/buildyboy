#!/usr/bin/env bash
# Online SQLite backup into <data dir>/backups, keeping the newest 14.
# Used by buildyboy-backup.service; safe to run by hand:  deploy/backup.sh
#
# Env: BUILDYBOY_DATA (default ~/.local/share/buildyboy), BB_NODE (node binary,
# default: node on PATH, else the newest nvm node), BB_KEEP (default 14).
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export BUILDYBOY_DATA="${BUILDYBOY_DATA:-$HOME/.local/share/buildyboy}"
KEEP="${BB_KEEP:-14}"
BACKUP_DIR="$BUILDYBOY_DATA/backups"

resolve_node() {
  if [ -n "${BB_NODE:-}" ]; then
    printf '%s\n' "$BB_NODE"
  elif command -v node >/dev/null 2>&1; then
    command -v node
  else
    # shellcheck disable=SC2012
    ls -1d "$HOME"/.nvm/versions/node/v*/bin/node 2>/dev/null | sort -V | tail -n 1
  fi
}

NODE="$(resolve_node)"
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  echo "backup: node not found (set BB_NODE)" >&2
  exit 1
fi
if [ ! -f "$BUILDYBOY_DATA/buildyboy.db" ]; then
  echo "backup: no database at $BUILDYBOY_DATA/buildyboy.db yet, nothing to do"
  exit 0
fi

mkdir -p "$BACKUP_DIR"
cd "$APP_DIR"
out="$("$NODE" cli/bb.ts backup)"
echo "backup written: $out"

# Keep the newest $KEEP (names carry an ISO timestamp, so lexical order is age order).
mapfile -t files < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'buildyboy-*.db' | sort)
if [ "${#files[@]}" -gt "$KEEP" ]; then
  for f in "${files[@]:0:${#files[@]}-KEEP}"; do
    echo "backup: pruning $f"
    rm -f -- "$f"
  done
fi
