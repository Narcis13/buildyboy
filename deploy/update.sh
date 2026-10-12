#!/usr/bin/env bash
# Update a deployed Buildyboy (see deploy-wsl.sh) from a source checkout:
# pull, install, build, swap, restart, health check. If the new release is not
# healthy the previous release directory is put back and restarted.
#
#   deploy/update.sh [--from DIR] [--no-pull] [--dry-run]
#
#   --from DIR   source tree to deploy (default: the checkout this script lives in)
#   --no-pull    skip `git pull --ff-only` in the source tree
#   --dry-run    print every action, change nothing, need no sudo
#
# Environment: BB_PORT (7700), BB_APP_DIR (~/apps/buildyboy), BB_DATA_DIR (~/.local/share/buildyboy).
# The previous release stays in <app dir>.prev until the next update.
# Migrations run when the server starts; they are forward-only, so a rollback restores the old
# code but not the old schema. A database backup is taken first (<data dir>/backups).
set -euo pipefail

SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=deploy/lib.sh
. "$SCRIPT_ROOT/deploy/lib.sh"

PORT="${BB_PORT:-7700}"
APP_DIR="${BB_APP_DIR:-$HOME/apps/buildyboy}"
DATA_DIR="${BB_DATA_DIR:-$HOME/.local/share/buildyboy}"
NEXT_DIR="$APP_DIR.next"
PREV_DIR="$APP_DIR.prev"
FAILED_DIR="$APP_DIR.failed"
HEALTH_URL="http://127.0.0.1:$PORT/api/health"

DRY_RUN=0
DO_PULL=1
SRC_DIR="${BB_SRC:-}"
NODE_BIN=""

usage() {
  sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'
}

sync_tree() {
  run rsync -rlt --delete --chmod=D755,F644 \
    --exclude=node_modules --exclude=/data --exclude=/.git --exclude=/web/dist \
    --exclude=/test-results --exclude=/playwright-report '--exclude=/.env*' \
    "$SRC_DIR/" "$NEXT_DIR/"
  run chmod +x "$NEXT_DIR"/deploy/*.sh
}

rollback() {
  warn "rolling back to the previous release"
  srun systemctl stop buildyboy || true
  run rm -rf "$FAILED_DIR"
  run mv "$APP_DIR" "$FAILED_DIR"
  run mv "$PREV_DIR" "$APP_DIR"
  srun systemctl restart buildyboy
  if wait_health "$HEALTH_URL" 45; then
    warn "rolled back; the previous release is running again. The failed build is kept in $FAILED_DIR"
    warn "migrations are not reversed; backups are in $DATA_DIR/backups if the schema needs restoring"
  else
    die "rollback did not become healthy either: check 'journalctl -u buildyboy -n 80'"
  fi
}

main() {
  local arg
  while [ "$#" -gt 0 ]; do
    arg="$1"
    shift
    case "$arg" in
      --dry-run) DRY_RUN=1 ;;
      --no-pull) DO_PULL=0 ;;
      --from)
        [ "$#" -gt 0 ] || die "--from needs a directory"
        SRC_DIR="$1"
        shift
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      *) die "unknown argument: $arg (try --help)" ;;
    esac
  done

  log "Preflight"
  [ "$(id -u)" -ne 0 ] || die "run as your normal user (sysadm), not root"
  for tool in rsync curl sed; do
    command -v "$tool" >/dev/null 2>&1 || die "missing tool: $tool"
  done
  load_node
  if [ -z "$SRC_DIR" ]; then SRC_DIR="$SCRIPT_ROOT"; fi
  SRC_DIR="$(cd "$SRC_DIR" && pwd)"
  APP_REAL="$(cd "$APP_DIR" 2>/dev/null && pwd || true)"
  if [ -z "$APP_REAL" ]; then
    if [ "$DRY_RUN" = 1 ]; then
      warn "$APP_DIR does not exist yet (a real update would stop here: run deploy/deploy-wsl.sh first)"
    else
      die "$APP_DIR does not exist: run deploy/deploy-wsl.sh first"
    fi
  fi
  [ "$SRC_DIR" != "$APP_REAL" ] || die "source and install directory are the same ($SRC_DIR). Run update.sh from your checkout, or pass --from DIR"
  [ -f "$SRC_DIR/package.json" ] || die "$SRC_DIR is not a Buildyboy source tree"
  info "source: $SRC_DIR  ->  install: $APP_DIR"
  if [ -f /etc/systemd/system/buildyboy.service ] && ! grep -qF "$NODE_BIN" /etc/systemd/system/buildyboy.service; then
    warn "the unit uses a different node than $NODE_BIN; re-run deploy/deploy-wsl.sh to refresh the unit"
  fi
  if [ "$DRY_RUN" != 1 ]; then
    echo '+ sudo -v'
    sudo -v || die "sudo failed (needed once for 'systemctl restart')"
  fi

  if [ "$DO_PULL" = 1 ] && [ -d "$SRC_DIR/.git" ]; then
    log "Pull"
    run git -C "$SRC_DIR" pull --ff-only
  else
    info "not pulling (--no-pull given or $SRC_DIR is not a git checkout)"
  fi

  log "Backup the database before migrating"
  run bash "$APP_DIR/deploy/backup.sh"

  log "Build the new release in $NEXT_DIR"
  run rm -rf "$NEXT_DIR"
  run mkdir -p "$NEXT_DIR"
  sync_tree
  run_in "$NEXT_DIR" npm ci
  run_in "$NEXT_DIR" npm run build
  run_in "$NEXT_DIR" npm prune --omit=dev

  log "Swap and restart (migrations run on server start)"
  run rm -rf "$PREV_DIR"
  run mv "$APP_DIR" "$PREV_DIR"
  run mv "$NEXT_DIR" "$APP_DIR"
  srun systemctl restart buildyboy

  log "Health check"
  if [ "$DRY_RUN" = 1 ]; then
    info "would wait up to 45 s for $HEALTH_URL; on failure: roll back to $PREV_DIR and restart"
    echo
    echo "DRY RUN complete: nothing was changed."
    return 0
  fi
  if wait_health "$HEALTH_URL" 45; then
    echo "update OK: $HEALTH_URL answers 200. Previous release kept in $PREV_DIR"
    return 0
  fi
  warn "the new release did not become healthy; last log lines:"
  journalctl -u buildyboy -n 30 --no-pager 2>/dev/null || sudo journalctl -u buildyboy -n 30 --no-pager || true
  rollback
  exit 1
}

main "$@"
