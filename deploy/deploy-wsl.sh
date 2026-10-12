#!/usr/bin/env bash
# Deploy Buildyboy to this WSL (Ubuntu, systemd) machine. Run as the normal user
# (sysadm), not root; sudo is used only for the system steps (systemd units and
# Caddy). Idempotent: safe to run again to redeploy.
#
#   deploy/deploy-wsl.sh              deploy
#   deploy/deploy-wsl.sh --dry-run    print every action, change nothing, need no sudo
#   deploy/deploy-wsl.sh --uninstall  remove units and the Caddy site (keeps data, app dir, import line)
#
# Environment:
#   DOMAIN        public host (default buildyboy.109-99-176-213.sslip.io)
#   BB_PORT       local port (default 7700)
#   BB_APP_DIR    install dir (default ~/apps/buildyboy)
#   BB_DATA_DIR   data dir: DB, VAPID keys, backups (default ~/.local/share/buildyboy)
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=deploy/lib.sh
. "$SRC_DIR/deploy/lib.sh"

DOMAIN="${DOMAIN:-buildyboy.109-99-176-213.sslip.io}"
PORT="${BB_PORT:-7700}"
APP_DIR="${BB_APP_DIR:-$HOME/apps/buildyboy}"
DATA_DIR="${BB_DATA_DIR:-$HOME/.local/share/buildyboy}"
RUN_USER="$(id -un)"
RUN_GROUP="$(id -gn)"

CADDYFILE=/etc/caddy/Caddyfile
CADDY_SITES_DIR=/etc/caddy/sites
CADDY_SITE="$CADDY_SITES_DIR/buildyboy.caddy"
IMPORT_LINE='import /etc/caddy/sites/*.caddy'
UNIT_DIR=/etc/systemd/system

DRY_RUN=0
UNINSTALL=0
WORK=""
NODE_BIN=""
CADDY_BACKUP=""
HAD_SITE=0

usage() {
  sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'
}

cleanup() {
  if [ -n "$WORK" ] && [ -d "$WORK" ]; then rm -rf "$WORK"; fi
}
trap cleanup EXIT

# render SRC DST: fill the __PLACEHOLDERS__ of a deploy template.
render() {
  sed \
    -e "s|__USER__|$(sed_escape "$RUN_USER")|g" \
    -e "s|__GROUP__|$(sed_escape "$RUN_GROUP")|g" \
    -e "s|__APP_DIR__|$(sed_escape "$APP_DIR")|g" \
    -e "s|__DATA_DIR__|$(sed_escape "$DATA_DIR")|g" \
    -e "s|__NODE__|$(sed_escape "$NODE_BIN")|g" \
    -e "s|__PORT__|$(sed_escape "$PORT")|g" \
    -e "s|__DOMAIN__|$(sed_escape "$DOMAIN")|g" \
    "$1" >"$2"
}

show_file() {
  printf '    --- %s ---\n' "$1"
  sed 's/^/    | /' "$1"
}

# install_root_file SRC DST MODE: install a rendered file as root (skips if identical).
install_root_file() {
  local src="$1" dst="$2" mode="$3"
  if [ -f "$dst" ] && cmp -s "$src" "$dst"; then
    info "$dst is already up to date"
    return 0
  fi
  if [ "$DRY_RUN" = 1 ]; then show_file "$src"; fi
  srun install -m "$mode" "$src" "$dst"
}

has_import() {
  grep -Eq '^[[:space:]]*import[[:space:]]+/etc/caddy/sites/' "$CADDYFILE"
}

# ---------------------------------------------------------------- preflight
step_preflight() {
  log "1/6 Preflight"
  [ "$(id -u)" -ne 0 ] || die "run as your normal user (sysadm), not root"
  [ "$(uname -s)" = Linux ] || die "this script runs inside WSL/Linux"
  grep -qi microsoft /proc/version 2>/dev/null || warn "this does not look like WSL; continuing anyway"
  [ -d /run/systemd/system ] || die "systemd is not running (enable systemd in /etc/wsl.conf)"
  local tool
  for tool in rsync curl ss sed grep install; do
    command -v "$tool" >/dev/null 2>&1 || die "missing tool: $tool"
  done
  load_node
  command -v caddy >/dev/null 2>&1 || die "caddy is not installed"
  info "caddy: $(command -v caddy)"

  if [ -n "$(ss -ltnH "sport = :$PORT" 2>/dev/null)" ]; then
    if systemctl is-active --quiet buildyboy 2>/dev/null; then
      info "port $PORT is held by the running buildyboy service (redeploy)"
    else
      die "port $PORT is already in use by something else (see: ss -ltnp 'sport = :$PORT')"
    fi
  else
    info "port $PORT is free"
  fi

  [ -f "$CADDYFILE" ] || die "$CADDYFILE not found"
  info "validating the existing $CADDYFILE (no sudo needed; Caddy state goes to a throwaway dir)"
  printf '+ caddy validate --config %s --adapter caddyfile\n' "$CADDYFILE"
  if caddy_validate "$CADDYFILE"; then
    info "existing Caddyfile is valid"
  else
    die "the existing Caddyfile does not validate; fix it before deploying"
  fi

  if [ "$DRY_RUN" != 1 ]; then
    log "sudo (needed for the systemd and Caddy steps)"
    echo '+ sudo -v'
    sudo -v || die "sudo failed (run this from an interactive shell so it can ask for your password)"
  fi
}

# ------------------------------------------------------------------ install
step_install() {
  log "2/6 Install the app into $APP_DIR (data: $DATA_DIR)"
  run mkdir -p "$APP_DIR" "$DATA_DIR" "$DATA_DIR/backups"
  run chmod 700 "$DATA_DIR"
  run rsync -rlt --delete --chmod=D755,F644 \
    --exclude=node_modules --exclude=/data --exclude=/.git --exclude=/web/dist \
    --exclude=/test-results --exclude=/playwright-report '--exclude=/.env*' \
    "$SRC_DIR/" "$APP_DIR/"
  run chmod +x "$APP_DIR"/deploy/*.sh
  run_in "$APP_DIR" npm ci
  run_in "$APP_DIR" npm run build
  run_in "$APP_DIR" npm prune --omit=dev
}

# ------------------------------------------------------------------ service
step_service() {
  log "3/6 systemd unit buildyboy.service"
  render "$SRC_DIR/deploy/buildyboy.service" "$WORK/buildyboy.service"
  install_root_file "$WORK/buildyboy.service" "$UNIT_DIR/buildyboy.service" 0644
  if [ "$DRY_RUN" = 1 ] && command -v systemd-analyze >/dev/null 2>&1; then
    local problems
    # A missing ExecStart binary is expected before the first deploy, so only report parse problems.
    problems="$(systemd-analyze verify "$WORK/buildyboy.service" 2>&1 | grep -Ei 'unknown (key|section)|invalid|failed to parse|bad (value|setting)' || true)"
    if [ -n "$problems" ]; then
      printf '%s\n' "$problems" | sed 's/^/    verify: /'
      die "the rendered unit has problems"
    fi
    info "systemd-analyze verify (read-only): unit parses cleanly"
  fi
  local was_active=0
  if systemctl is-active --quiet buildyboy 2>/dev/null; then was_active=1; fi
  srun systemctl daemon-reload
  srun systemctl enable --now buildyboy
  if [ "$was_active" = 1 ]; then srun systemctl restart buildyboy; fi
}

# -------------------------------------------------------------------- caddy
restore_caddy() {
  warn "restoring the previous Caddy configuration"
  if [ -n "$CADDY_BACKUP" ]; then srun cp -a "$CADDY_BACKUP" "$CADDYFILE"; fi
  if [ "$HAD_SITE" = 1 ]; then
    srun install -m 0644 "$WORK/site.prev" "$CADDY_SITE"
  else
    srun rm -f "$CADDY_SITE"
  fi
}

step_caddy() {
  log "4/6 Caddy: $DOMAIN -> 127.0.0.1:$PORT"
  CADDY_BACKUP=""
  HAD_SITE=0
  render "$SRC_DIR/deploy/caddy-site.caddy" "$WORK/buildyboy.caddy"
  if [ -f "$CADDY_SITE" ]; then
    HAD_SITE=1
    cp "$CADDY_SITE" "$WORK/site.prev"
  fi

  if [ "$DRY_RUN" = 1 ]; then
    # Validate the would-be configuration in the temp dir: existing Caddyfile + our rendered site.
    mkdir -p "$WORK/sites"
    cp "$WORK/buildyboy.caddy" "$WORK/sites/buildyboy.caddy"
    { cat "$CADDYFILE"; printf '\nimport %s/sites/*.caddy\n' "$WORK"; } >"$WORK/Caddyfile.sim"
    echo '+ caddy validate --config <existing Caddyfile + rendered site, in temp dir> --adapter caddyfile'
    if caddy_validate "$WORK/Caddyfile.sim"; then
      info "the combined configuration would validate"
    else
      die "the combined configuration would NOT validate"
    fi
  fi

  srun mkdir -p "$CADDY_SITES_DIR"
  install_root_file "$WORK/buildyboy.caddy" "$CADDY_SITE" 0644

  if has_import; then
    info "$CADDYFILE already imports $CADDY_SITES_DIR (left untouched)"
  else
    CADDY_BACKUP="$CADDYFILE.bak.buildyboy-$(date +%Y%m%d-%H%M%S)"
    srun cp -a "$CADDYFILE" "$CADDY_BACKUP"
    # Append only; the existing blocks stay byte-identical. Make sure we start on a fresh line.
    local lead=''
    if [ -n "$(tail -c 1 "$CADDYFILE")" ]; then lead=$'\n'; fi
    srun_append "$CADDYFILE" "${lead}"$'\n# Buildyboy: per-site snippets (appended by deploy-wsl.sh)\n'"$IMPORT_LINE"$'\n'
  fi

  echo "+ caddy validate --config $CADDYFILE --adapter caddyfile"
  if [ "$DRY_RUN" != 1 ] && ! caddy_validate "$CADDYFILE"; then
    restore_caddy
    die "Caddy validation failed; the previous configuration was restored"
  fi
  if [ "$DRY_RUN" = 1 ]; then
    srun systemctl reload caddy
  elif ! srun systemctl reload caddy; then
    restore_caddy
    srun systemctl reload caddy || true
    die "Caddy reload failed; the previous configuration was restored"
  fi
}

# ------------------------------------------------------------------ backups
step_backups() {
  log "5/6 Nightly backup timer (keeps 14)"
  render "$SRC_DIR/deploy/buildyboy-backup.service" "$WORK/buildyboy-backup.service"
  render "$SRC_DIR/deploy/buildyboy-backup.timer" "$WORK/buildyboy-backup.timer"
  install_root_file "$WORK/buildyboy-backup.service" "$UNIT_DIR/buildyboy-backup.service" 0644
  install_root_file "$WORK/buildyboy-backup.timer" "$UNIT_DIR/buildyboy-backup.timer" 0644
  srun systemctl daemon-reload
  srun systemctl enable --now buildyboy-backup.timer
}

# ------------------------------------------------------------------- finish
step_finish() {
  log "6/6 Finish"
  local local_url="http://127.0.0.1:$PORT/api/health" public_url="https://$DOMAIN/api/health"
  if [ "$DRY_RUN" = 1 ]; then
    info "would wait up to 60 s for $local_url, then for $public_url to return 200"
    info "would print the first-run setup URL (journalctl -u buildyboy | grep setup)"
    return 0
  fi
  echo "waiting for $local_url ..."
  if ! wait_health "$local_url" 60; then
    warn "the service did not become healthy; last log lines:"
    journalctl -u buildyboy -n 30 --no-pager 2>/dev/null || sudo journalctl -u buildyboy -n 30 --no-pager || true
    die "buildyboy.service is not answering on $local_url"
  fi
  echo "waiting for $public_url (Caddy may need a few seconds to get a certificate) ..."
  if ! wait_health "$public_url" 60; then
    warn "$public_url did not return 200 within 60 s"
    info "the app itself is healthy locally. Check that $DOMAIN resolves to this machine, that ports 80/443 reach it, and: sudo journalctl -u caddy -n 50"
    exit 1
  fi
  local url
  url="$(find_setup_url)"
  echo
  echo "Buildyboy is up: https://$DOMAIN"
  if [ -n "$url" ]; then
    echo "First run, set your password here (one-time link): $url"
  else
    echo "No setup link in the log (a password is probably set already). To set one from the shell:"
    echo "  cd $APP_DIR && BUILDYBOY_DATA=$DATA_DIR $NODE_BIN cli/bb.ts set-password"
  fi
  echo "Then open Machines in the web UI, create a pairing code and install the plugin on each machine."
}

# ---------------------------------------------------------------- uninstall
do_uninstall() {
  log "Uninstall the Buildyboy services"
  [ "$(id -u)" -ne 0 ] || die "run as your normal user (sysadm), not root"
  if [ "$DRY_RUN" != 1 ]; then
    echo '+ sudo -v'
    sudo -v || die "sudo failed"
  fi
  srun systemctl disable --now buildyboy-backup.timer || true
  srun systemctl disable --now buildyboy.service || true
  srun rm -f "$UNIT_DIR/buildyboy.service" "$UNIT_DIR/buildyboy-backup.service" "$UNIT_DIR/buildyboy-backup.timer"
  srun systemctl daemon-reload
  srun rm -f "$CADDY_SITE"
  if [ "$DRY_RUN" = 1 ]; then
    srun systemctl reload caddy
  elif caddy_validate "$CADDYFILE"; then
    srun systemctl reload caddy
  else
    warn "$CADDYFILE does not validate; not reloading Caddy (fix it, then: sudo systemctl reload caddy)"
  fi
  echo
  echo "Removed: buildyboy.service, buildyboy-backup.service/.timer and $CADDY_SITE."
  echo "Left in place on purpose:"
  echo "  - the '$IMPORT_LINE' line in $CADDYFILE (harmless without site files)"
  echo "  - the data directory $DATA_DIR (database, VAPID keys, backups)"
  echo "  - the app directory $APP_DIR"
  echo "Delete those by hand if you want everything gone."
}

# --------------------------------------------------------------------- main
main() {
  local arg
  for arg in "$@"; do
    case "$arg" in
      --dry-run) DRY_RUN=1 ;;
      --uninstall) UNINSTALL=1 ;;
      -h | --help)
        usage
        exit 0
        ;;
      *) die "unknown argument: $arg (try --help)" ;;
    esac
  done

  WORK="$(mktemp -d)"
  if [ "$DRY_RUN" = 1 ]; then echo "DRY RUN: nothing will be changed (scratch files live in $WORK and are removed at exit)"; fi
  echo "Buildyboy deploy: domain=$DOMAIN port=$PORT app=$APP_DIR data=$DATA_DIR user=$RUN_USER"

  if [ "$UNINSTALL" = 1 ]; then
    do_uninstall
    return 0
  fi

  step_preflight
  step_install
  step_service
  step_caddy
  step_backups
  step_finish
  if [ "$DRY_RUN" = 1 ]; then
    echo
    echo "DRY RUN complete: nothing was changed."
  fi
}

main "$@"
