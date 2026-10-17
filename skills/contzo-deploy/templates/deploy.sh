#!/usr/bin/env bash
# deploy/contzo/deploy.sh: ship this project to <SUBDOMAIN>.contzo.lol on the WSL host.
# Written by the contzo-deploy skill. Project settings live in app.conf next to
# this file; change those, not this script.
#
#   deploy.sh              sync, build, release, restart, health check   (no sudo)
#   deploy.sh --setup      one-time system steps: Caddy site, /srv dir for static
#                          sites, Postgres role + database                (sudo)
#   deploy.sh --dry-run    print every action of a deploy, change nothing
#   deploy.sh --status     units, releases, local and public health
#   deploy.sh --logs       follow the service logs (Ctrl-C to stop)
#   deploy.sh --rollback   switch back to the previous release
#   deploy.sh --uninstall  remove units, Caddy site and /srv dir
#                          (keeps ~/apps/<name>: releases, shared/.env, backups; keeps the db)
#
# --dry-run combines with --setup, --rollback and --uninstall.
# Runs inside WSL. From Windows PowerShell:
#   wsl.exe -d Ubuntu --cd <project dir> -e bash deploy/contzo/deploy.sh [option]
#
# Layout on the host (~/apps/<APP_NAME>):
#   src/                synced copy of the project; installs and builds happen here
#   releases/<stamp>/   immutable releases (newest KEEP_RELEASES kept)
#   current -> releases/<stamp>   what the units run (or what /srv/contzo/<name> mirrors)
#   shared/.env         the only env file (mode 600); never overwritten by a deploy
#   shared/<dir>        persistent dirs (SHARED_DIRS), symlinked into every release
#   shared/backups/     nightly backups when BACKUP is set
#   bin/                launchers the systemd units exec
set -euo pipefail

ENGINE_VERSION=1
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$HERE/../.." && pwd)"

# ------------------------------------------------------------------ defaults
# Everything here can be overridden in app.conf.
APP_NAME=""
SUBDOMAIN=""
BASE_DOMAIN="contzo.lol"
KIND="service"            # service: a process behind Caddy's reverse proxy | static: files served by Caddy
PORT=""                   # service only; 127.0.0.1:<PORT>
HEALTH_PATH="/"
PROCESSES=()              # service only; "name|command", the first one is the web process
STATIC_DIR="dist"         # static only; build output dir, relative to the project root
SPA=1                     # static only; unknown paths fall back to /index.html
SSE=0                     # 1: no response buffering, no compression of event streams
MAX_BODY=""               # e.g. 25MB; empty = Caddy default (unlimited)
BASIC_AUTH_USER=""        # optional password gate in Caddy
BASIC_AUTH_HASH=""        # from: caddy hash-password --plaintext '<password>'
CADDY_EXTRA=""            # raw Caddyfile lines added inside the site block
SHARED_DIRS=()            # release-relative dirs that must persist across deploys (uploads, sqlite dir)
SYNC_EXCLUDES=()          # extra rsync excludes on top of the defaults below
KEEP_RELEASES=3
NODE_VERSION="24"
DATABASE="none"           # none | postgres
DB_NAME=""                # default: APP_NAME with dashes as underscores
DB_ROLE=""                # default: DB_NAME
BACKUP="none"             # none | postgres | sqlite:<path relative to shared/>
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-60}"   # seconds

# ------------------------------------------------------------------ hooks
# app.conf may redefine these. They run with set -e, so a failing command
# stops the deploy before anything is switched.
app_build() { node_build; }   # cwd: src/  (installs + builds the project)
app_release() { :; }          # cwd: releases/<new>/  (after shared links, before the switch)
app_env() { :; }              # print extra KEY=value lines for the first shared/.env

# ------------------------------------------------------------------ helpers
DRY=0
WORK=""
say() { printf '\n==> %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
run() { printf '+'; printf ' %q' "$@"; printf '\n'; [ "$DRY" = 1 ] || "$@"; }
srun() { printf '+ sudo'; printf ' %q' "$@"; printf '\n'; [ "$DRY" = 1 ] || sudo "$@"; }
# shell CMD: print and run a shell snippet (for pipes, redirects, cd)
shell() { printf '+ %s\n' "$1"; [ "$DRY" = 1 ] || bash -c "$1"; }
show_file() { printf '    --- %s ---\n' "$1"; sed 's/^/    | /' "$2"; }
cleanup() { if [ -n "$WORK" ] && [ -d "$WORK" ]; then rm -rf "$WORK"; fi; }
trap cleanup EXIT

# systemctl --user needs the user's runtime dir, which a bare `wsl.exe -e bash` lacks.
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"

load_node() {
  local nvm_dir="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$nvm_dir/nvm.sh" ]; then
    set +u
    # shellcheck disable=SC1091
    . "$nvm_dir/nvm.sh"
    nvm use --silent "$NODE_VERSION" >/dev/null 2>&1 || warn "nvm has no Node $NODE_VERSION (nvm install $NODE_VERSION)"
    set -u
  fi
  if command -v node >/dev/null 2>&1; then
    NODE_BIN="$(dirname "$(command -v node)")"
  else
    NODE_BIN=""
  fi
}

load_conf() {
  [ -f "$HERE/app.conf" ] || die "missing $HERE/app.conf"
  # shellcheck disable=SC1091
  . "$HERE/app.conf"
  [[ "$APP_NAME" =~ ^[a-z0-9][a-z0-9-]{0,40}$ ]] || die "APP_NAME '$APP_NAME': use lowercase letters, digits and dashes"
  [[ "$SUBDOMAIN" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || die "SUBDOMAIN '$SUBDOMAIN' is not a valid DNS label"
  case "$KIND" in
    service)
      [[ "$PORT" =~ ^[0-9]+$ ]] && [ "$PORT" -ge 1024 ] && [ "$PORT" -le 65535 ] || die "PORT '$PORT' must be a number 1024-65535"
      [ "${#PROCESSES[@]}" -gt 0 ] || die "PROCESSES is empty: a service needs at least its web process"
      ;;
    static) ;;
    *) die "KIND must be service or static (got '$KIND')" ;;
  esac
  DOMAIN="$SUBDOMAIN.$BASE_DOMAIN"
  APP_ROOT="$HOME/apps/$APP_NAME"
  SRC="$APP_ROOT/src"
  RELEASES="$APP_ROOT/releases"
  CURRENT="$APP_ROOT/current"
  SHARED="$APP_ROOT/shared"
  BIN="$APP_ROOT/bin"
  UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  STATIC_ROOT="/srv/contzo/$APP_NAME"
  CADDY_SITE="/etc/caddy/sites/$APP_NAME.caddy"
  [ -n "$DB_NAME" ] || DB_NAME="${APP_NAME//-/_}"
  [ -n "$DB_ROLE" ] || DB_ROLE="$DB_NAME"
  # Apps that were set up by hand (efacturi, buildyboy) live in ~/apps too; never touch them.
  if [ -d "$APP_ROOT" ] && [ ! -f "$APP_ROOT/.contzo-deploy" ]; then
    die "$APP_ROOT exists and was not created by contzo-deploy; pick another APP_NAME"
  fi
  WORK="$(mktemp -d)"
}

# unit names: the first process is <app>, the others <app>-<name>
proc_names() { local p; for p in "${PROCESSES[@]}"; do printf '%s\n' "${p%%|*}"; done; }
proc_cmd() { local p; for p in "${PROCESSES[@]}"; do [ "${p%%|*}" = "$1" ] && { printf '%s\n' "${p#*|}"; return; }; done; }
unit_of() { if [ "$1" = "$(proc_names | head -n 1)" ]; then echo "$APP_NAME"; else echo "$APP_NAME-$1"; fi; }
all_units() {
  local n
  if [ "$KIND" = service ]; then
    while read -r n; do unit_of "$n"; done < <(proc_names)
  fi
}

current_release() { if [ -L "$CURRENT" ]; then basename "$(readlink "$CURRENT")"; fi; }
list_releases() { if [ -d "$RELEASES" ]; then find "$RELEASES" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort; fi; }

http_code() { curl -s -o /dev/null -m 8 -w '%{http_code}' "$@" 2>/dev/null || true; }
local_code() { http_code "http://127.0.0.1:$PORT$HEALTH_PATH"; }
# Through Caddy on this machine, with the real certificate. Works whether or not
# DNS is ready, and avoids the Windows host's inability to reach its own public IP.
public_code() { http_code --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN$HEALTH_PATH"; }
code_ok() { [[ "$1" =~ ^[23][0-9][0-9]$ ]] || { [ "$1" = 401 ] && [ -n "$BASIC_AUTH_USER" ]; }; }

wait_local() {
  local i code=""
  for ((i = 0; i < HEALTH_TIMEOUT; i += 2)); do
    code="$(local_code)"
    if code_ok "$code"; then info "local health: $code on http://127.0.0.1:$PORT$HEALTH_PATH"; return 0; fi
    sleep 2
  done
  warn "local health: got '${code:-no answer}' from http://127.0.0.1:$PORT$HEALTH_PATH after ${HEALTH_TIMEOUT}s"
  return 1
}

# ------------------------------------------------------------------ build helpers (usable in hooks)
pm() {
  if [ -f pnpm-lock.yaml ]; then echo pnpm
  elif [ -f yarn.lock ]; then echo yarn
  elif [ -f bun.lock ] || [ -f bun.lockb ]; then echo bun
  else echo npm; fi
}
node_install() {
  case "$(pm)" in
    pnpm) pnpm install --frozen-lockfile ;;
    yarn) yarn install --frozen-lockfile ;;
    bun) command -v bun >/dev/null || die "bun lockfile but bun is not installed in WSL"; bun install --frozen-lockfile ;;
    npm) if [ -f package-lock.json ]; then npm ci; else npm install; fi ;;
  esac
}
has_script() { node -e 'const s=require("./package.json").scripts||{};process.exit(s[process.argv[1]]?0:1)' "$1"; }
pm_run() { case "$(pm)" in pnpm) pnpm run "$@" ;; yarn) yarn run "$@" ;; bun) bun run "$@" ;; *) npm run "$@" ;; esac; }
node_build() {
  [ -f package.json ] || return 0
  node_install
  if has_script build; then pm_run build; fi
}
# Export shared/.env into the current shell (for migrations in app_release).
load_env() {
  set -a
  # shellcheck disable=SC1091
  . "$SHARED/.env"
  set +a
}
# Drop devDependencies inside a release (call from app_release).
node_prune() {
  case "$(pm)" in
    pnpm) pnpm prune --prod ;;
    npm) npm prune --omit=dev ;;
    *) info "node_prune: skipped for $(pm)" ;;
  esac
}

# ------------------------------------------------------------------ preflight
check_port() {
  local lines pids p ours=0
  lines="$(ss -ltnpH "sport = :$PORT" 2>/dev/null || true)"
  if [ -z "$lines" ]; then info "port $PORT is free"; return 0; fi
  pids="$(printf '%s\n' "$lines" | grep -oP 'pid=\K[0-9]+' | sort -u || true)"
  for p in $pids; do
    if grep -qE "/($APP_NAME|$APP_NAME-[a-z0-9-]+)\.service$" "/proc/$p/cgroup" 2>/dev/null; then ours=1; fi
  done
  if [ "$ours" = 1 ]; then info "port $PORT is held by $APP_NAME itself (will restart)"; return 0; fi
  printf '%s\n' "$lines" >&2
  die "port $PORT is taken by something else; pick a free one (scripts/host-probe.sh suggests one)"
}

check_domain_free() {
  local f
  for f in /etc/caddy/Caddyfile /etc/caddy/sites/*.caddy; do
    [ -f "$f" ] || continue
    [ "$f" = "$CADDY_SITE" ] && continue
    if grep -qE "^[[:space:]]*(https?://)?$(printf '%s' "$DOMAIN" | sed 's/\./\\./g')([:, ]|\{|$)" "$f"; then
      die "$DOMAIN is already served by $f"
    fi
  done
}

check_crlf() {
  local hits
  hits="$(grep -rlI $'\r' --include='*.sh' --include='app.conf' --exclude-dir=node_modules --exclude-dir=.git "$PROJECT_DIR" 2>/dev/null | head -n 5 || true)"
  if [ -n "$hits" ]; then
    warn "CRLF line endings (they break bash on Linux):"
    printf '      %s\n' $hits >&2
    warn "fix: add '*.sh text eol=lf' and 'deploy/** text eol=lf' to .gitattributes, then: git add --renormalize ."
  fi
}

preflight() {
  say "Preflight: $APP_NAME -> https://$DOMAIN ($KIND${PORT:+, port $PORT})"
  info "project: $PROJECT_DIR"
  load_node
  if [ -f "$PROJECT_DIR/package.json" ]; then
    [ -n "$NODE_BIN" ] || die "no node in WSL; install it with nvm (nvm install $NODE_VERSION)"
    info "node: $NODE_BIN/node ($(node -v))"
    # ls of the whole brace list fails if any one is missing, so test each file.
    if ! for f in package-lock.json pnpm-lock.yaml yarn.lock bun.lock bun.lockb; do [ -f "$PROJECT_DIR/$f" ] && break; false; done; then
      warn "no lockfile: every deploy resolves dependency versions afresh (npm install). Commit one for reproducible builds."
    fi
  fi
  command -v rsync >/dev/null || die "rsync is missing (sudo apt install rsync)"
  check_crlf
  check_domain_free
  if [ "$KIND" = service ]; then check_port; fi
  if [ "$KIND" = static ] && [ ! -w "$STATIC_ROOT" ] && [ "$DRY" = 0 ]; then
    die "$STATIC_ROOT is missing or not writable; run --setup first"
  fi
  if [ "$DATABASE" = postgres ] && [ "$DRY" = 0 ] && ! grep -q '^DB_PASSWORD=.' "$SHARED/.env" 2>/dev/null; then
    die "no database credentials in $SHARED/.env; run --setup first"
  fi
  if [ ! -f "$CADDY_SITE" ]; then
    warn "no Caddy site yet ($CADDY_SITE): https://$DOMAIN won't answer until --setup"
  fi
}

# ------------------------------------------------------------------ env file
ensure_dirs() {
  run mkdir -p "$SRC" "$RELEASES" "$SHARED" "$BIN"
  run chmod 700 "$SHARED"
  [ "$DRY" = 1 ] || touch "$APP_ROOT/.contzo-deploy"
  local d
  for d in "${SHARED_DIRS[@]}"; do run mkdir -p "$SHARED/$d"; done
}

seed_env() {
  [ "$KIND" = service ] || return 0
  if [ -f "$SHARED/.env" ]; then info "keeping $SHARED/.env"; return 0; fi
  {
    echo "# $APP_NAME production env (https://$DOMAIN). Written once by deploy.sh; deploys"
    echo "# keep everything here except PORT, HOST and PUBLIC_URL, which follow app.conf."
    echo "# Edit, then: systemctl --user restart $APP_NAME"
    echo "NODE_ENV=production"
    echo "HOST=127.0.0.1"
    echo "PORT=$PORT"
    echo "PUBLIC_URL=https://$DOMAIN"
    app_env
  } >"$WORK/env"
  if [ "$DRY" = 1 ]; then
    show_file "$SHARED/.env (would be created, mode 600)" "$WORK/env"
  else
    install -m 600 "$WORK/env" "$SHARED/.env"
    info "created $SHARED/.env; add any secrets the app still needs"
  fi
}

# PORT/HOST/PUBLIC_URL in .env win over the unit's Environment= (EnvironmentFile is read
# later), and dotenv-style apps read them too, so they must follow app.conf on every deploy.
sync_env() {
  [ "$KIND" = service ] || return 0
  [ -f "$SHARED/.env" ] || return 0
  local k v
  for k in PORT HOST PUBLIC_URL; do
    case "$k" in PORT) v="$PORT" ;; HOST) v=127.0.0.1 ;; PUBLIC_URL) v="https://$DOMAIN" ;; esac
    if [ "$(sed -n "s/^$k=//p" "$SHARED/.env" | tail -n 1)" != "$v" ]; then
      upsert_env "$k" "$v"
      [ "$DRY" = 1 ] || info "shared/.env: $k=$v (follows app.conf)"
    fi
  done
}

# upsert_env KEY VALUE: set one variable in shared/.env
upsert_env() {
  local key="$1" val="$2" f="$SHARED/.env"
  if [ "$DRY" = 1 ]; then printf '+ set %s in %s\n' "$key" "$f"; return 0; fi
  if grep -q "^$key=" "$f" 2>/dev/null; then
    local tmp; tmp="$(mktemp)"
    awk -v k="$key" -v v="$val" 'BEGIN{FS=OFS="="} $1==k {print k "=" v; next} {print}' "$f" >"$tmp"
    cat "$tmp" >"$f"; rm -f "$tmp"
  else
    printf '%s=%s\n' "$key" "$val" >>"$f"
  fi
}

# ------------------------------------------------------------------ units
write_if_changed() { # write_if_changed SRC DEST MODE -> returns 0 when DEST changed
  if [ -f "$2" ] && cmp -s "$1" "$2"; then return 1; fi
  if [ "$DRY" = 1 ]; then show_file "$2" "$1"; return 0; fi
  install -m "$3" "$1" "$2"
  return 0
}

install_units() {
  [ "$KIND" = service ] || return 0
  run mkdir -p "$UNIT_DIR"
  local name unit cmd changed=0
  while read -r name; do
    unit="$(unit_of "$name")"
    cmd="$(proc_cmd "$name")"
    cat >"$WORK/run-$name" <<EOF
#!/usr/bin/env bash
# Written by deploy.sh (contzo-deploy): runs the '$name' process of $APP_NAME.
set -e
export PATH="${NODE_BIN:+$NODE_BIN:}\$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
cd "$CURRENT"
exec $cmd
EOF
    write_if_changed "$WORK/run-$name" "$BIN/run-$name" 755 || true
    cat >"$WORK/$unit.service" <<EOF
# Written by $APP_NAME/deploy/contzo/deploy.sh (contzo-deploy). Change app.conf, not this file.
[Unit]
Description=$APP_NAME $name (https://$DOMAIN)
After=network-online.target
StartLimitIntervalSec=120
StartLimitBurst=10

[Service]
Type=simple
WorkingDirectory=$CURRENT
Environment=NODE_ENV=production
Environment=HOST=127.0.0.1
Environment=PORT=$PORT
EnvironmentFile=-$SHARED/.env
ExecStart=$BIN/run-$name
Restart=always
RestartSec=3
TimeoutStopSec=20
NoNewPrivileges=yes

[Install]
WantedBy=default.target
EOF
    if write_if_changed "$WORK/$unit.service" "$UNIT_DIR/$unit.service" 644; then changed=1; fi
  done < <(proc_names)
  if [ "$changed" = 1 ]; then run systemctl --user daemon-reload; fi
  local u
  for u in $(all_units); do run systemctl --user enable "$u.service" --quiet; done
  install_backup_timer
}

install_backup_timer() {
  [ "$BACKUP" != none ] || return 0
  local what="$BACKUP" changed=0
  {
    echo '#!/usr/bin/env bash'
    echo "# Written by deploy.sh (contzo-deploy): nightly backup of $APP_NAME, newest 14 kept."
    echo 'set -euo pipefail'
    echo "OUT=\"$SHARED/backups\"; mkdir -p \"\$OUT\"; TS=\"\$(date +%Y%m%d-%H%M%S)\""
    echo "envval() { sed -n \"s/^\$1=//p\" \"$SHARED/.env\" | tail -n 1; }"
    case "$what" in
      postgres)
        echo 'PGPASSWORD="$(envval DB_PASSWORD)" pg_dump -h 127.0.0.1 -U "$(envval DB_USER)" -Fc "$(envval DB_DATABASE)" >"$OUT/'"$APP_NAME"'-$TS.dump"'
        ;;
      sqlite:*)
        echo "python3 -c 'import sqlite3,sys; s=sqlite3.connect(sys.argv[1]); d=sqlite3.connect(sys.argv[2]); s.backup(d); d.close(); s.close()' \"$SHARED/${what#sqlite:}\" \"\$OUT/$APP_NAME-\$TS.db\""
        ;;
      *) die "BACKUP must be none, postgres or sqlite:<path> (got '$what')" ;;
    esac
    echo "ls -1t \"\$OUT\"/$APP_NAME-* 2>/dev/null | tail -n +15 | xargs -r rm -f --"
    echo "echo \"backup written to \$OUT\""
  } >"$WORK/backup"
  write_if_changed "$WORK/backup" "$BIN/backup" 755 || true
  cat >"$WORK/backup.service" <<EOF
[Unit]
Description=$APP_NAME nightly backup (contzo-deploy)

[Service]
Type=oneshot
ExecStart=$BIN/backup
EOF
  cat >"$WORK/backup.timer" <<EOF
[Unit]
Description=$APP_NAME nightly backup (contzo-deploy)

[Timer]
OnCalendar=*-*-* 03:45:00
RandomizedDelaySec=15min
Persistent=true

[Install]
WantedBy=timers.target
EOF
  if write_if_changed "$WORK/backup.service" "$UNIT_DIR/$APP_NAME-backup.service" 644; then changed=1; fi
  if write_if_changed "$WORK/backup.timer" "$UNIT_DIR/$APP_NAME-backup.timer" 644; then changed=1; fi
  if [ "$changed" = 1 ]; then run systemctl --user daemon-reload; fi
  run systemctl --user enable --now "$APP_NAME-backup.timer" --quiet
}

restart_units() {
  local u
  for u in $(all_units); do
    # A crash-looping release trips systemd's start limit; without a reset the
    # next restart (the rollback's) is refused and the app stays down.
    run systemctl --user reset-failed "$u.service" 2>/dev/null || true
    run systemctl --user restart "$u.service" || warn "restart of $u failed; the health check decides"
  done
}

# ------------------------------------------------------------------ releases
switch_to() {
  run ln -sfn "releases/$1" "$APP_ROOT/current.tmp"
  run mv -Tf "$APP_ROOT/current.tmp" "$CURRENT"
}

publish_static() {
  [ "$DRY" = 1 ] || [ -f "$RELEASES/$1/index.html" ] || warn "no index.html in $STATIC_DIR (is STATIC_DIR right?)"
  run rsync -rlt --delete --chmod=D755,F644 "$RELEASES/$1/" "$STATIC_ROOT/"
}

activate() { # activate RELEASE PREVIOUS -> switch + restart/publish; rolls back on failure
  local rel="$1" prev="$2"
  switch_to "$rel"
  if [ "$KIND" = static ]; then publish_static "$rel"; return 0; fi
  install_units
  restart_units
  [ "$DRY" = 1 ] && return 0
  if wait_local; then return 0; fi
  journalctl --user -u "$APP_NAME" -n 40 --no-pager >&2 || true
  if [ -n "$prev" ] && [ -d "$RELEASES/$prev" ]; then
    warn "rolling back to $prev"
    switch_to "$prev"
    restart_units
    wait_local || warn "the previous release is not healthy either"
    die "release $rel failed its health check and was rolled back (kept in $RELEASES/$rel)"
  fi
  die "release $rel failed its health check (first release, nothing to roll back to)"
}

prune_releases() {
  local all cur n i
  mapfile -t all < <(list_releases)
  cur="$(current_release)"
  n="${#all[@]}"
  for ((i = 0; i < n - KEEP_RELEASES; i++)); do
    [ "${all[$i]}" = "$cur" ] && continue
    run rm -rf "${RELEASES:?}/${all[$i]}"
  done
}

report_public() {
  if [ ! -f "$CADDY_SITE" ]; then info "Caddy site not installed yet: run --setup"; return 0; fi
  local code i
  for ((i = 0; i < 30; i += 3)); do
    code="$(public_code)"
    code_ok "$code" && break
    sleep 3
  done
  if code_ok "$code"; then
    info "public health: $code on https://$DOMAIN$HEALTH_PATH (through Caddy, real certificate)"
  else
    warn "https://$DOMAIN$HEALTH_PATH answered '${code:-nothing}' through Caddy. A new certificate needs DNS first: check the A record, then: journalctl -u caddy -n 40"
  fi
}

# ------------------------------------------------------------------ commands
cmd_deploy() {
  preflight
  say "Directories and env"
  ensure_dirs
  seed_env
  sync_env

  say "Sync $PROJECT_DIR -> $SRC"
  local ex=(--exclude=.git/ --exclude=node_modules/ --exclude=.env --exclude='.env.*'
    --exclude=.next/ --exclude=.nuxt/ --exclude=.output/ --exclude=.svelte-kit/
    --exclude=.astro/ --exclude=.turbo/ --exclude=.cache/ --exclude=.vite/ --exclude=coverage/
    --exclude=test-results/ --exclude=playwright-report/ --exclude=.venv/ --exclude=venv/
    --exclude=__pycache__/ --exclude='*.pyc' --exclude=.pytest_cache/ --exclude=.DS_Store
    --exclude=Thumbs.db --exclude=.claude/)
  local e
  for e in "${SYNC_EXCLUDES[@]}"; do ex+=("--exclude=$e"); done
  # Persistent dirs come from shared/, never from the dev machine (a dev sqlite db or
  # local uploads must not ride along). Anchored, so only the top-level path matches.
  for e in "${SHARED_DIRS[@]}"; do ex+=("--exclude=/${e%/}/"); done
  # --include must precede the .env.* exclude to win
  run rsync -rlt --delete --include='.env.example' "${ex[@]}" "$PROJECT_DIR/" "$SRC/"

  say "Build (in $SRC)"
  if [ "$DRY" = 1 ]; then
    declare -f app_build | sed 's/^/    | /'
    if [ -f "$PROJECT_DIR/package.json" ]; then
      (cd "$PROJECT_DIR" && info "node_build would run: $(case "$(pm)" in pnpm) echo 'pnpm install --frozen-lockfile' ;; yarn) echo 'yarn install --frozen-lockfile' ;; bun) echo 'bun install --frozen-lockfile' ;; *) [ -f package-lock.json ] && echo 'npm ci' || echo 'npm install' ;; esac)$(has_script build && echo " && $(pm) run build" || echo ' (no build script)')")
    fi
  else
    (cd "$SRC" && unset NODE_ENV && app_build)
  fi

  local stamp prev new
  stamp="$(date +%Y%m%d-%H%M%S)"
  prev="$(current_release)"
  new="$RELEASES/$stamp"
  say "Release $stamp${prev:+ (previous: $prev)}"
  if [ "$KIND" = static ]; then
    [ "$DRY" = 1 ] || [ -d "$SRC/$STATIC_DIR" ] || die "build produced no $STATIC_DIR/ (set STATIC_DIR in app.conf)"
    run rsync -a --delete "$SRC/$STATIC_DIR/" "$new/"
  else
    # hard links to the previous release make unchanged files (node_modules) free
    if [ -n "$prev" ]; then
      run rsync -a --delete --link-dest="$RELEASES/$prev/" "$SRC/" "$new/"
    else
      run rsync -a --delete "$SRC/" "$new/"
    fi
    run ln -sfn "$SHARED/.env" "$new/.env"
    local d
    for d in "${SHARED_DIRS[@]}"; do
      d="${d%/}"
      run rm -rf "${new:?}/$d"
      [ "$(dirname "$d")" = . ] || run mkdir -p "$(dirname "$new/$d")"
      run ln -sfn "$SHARED/$d" "$new/$d"
    done
  fi
  if [ "$DRY" = 1 ]; then
    declare -f app_release | sed 's/^/    | /'
  else
    (cd "$new" && app_release)
  fi

  say "Activate"
  activate "$stamp" "$prev"
  prune_releases
  [ "$DRY" = 1 ] || cp "$HERE/app.conf" "$APP_ROOT/app.conf"

  say "Check"
  if [ "$DRY" = 1 ]; then
    [ "$KIND" = service ] && info "would wait up to ${HEALTH_TIMEOUT}s for http://127.0.0.1:$PORT$HEALTH_PATH (rollback if it never answers)"
    info "would check https://$DOMAIN$HEALTH_PATH through Caddy on this host"
  else
    report_public
  fi
  if [ "$DRY" = 1 ]; then
    printf '\nDRY RUN complete: nothing was changed.\n'
  else
    printf '\nDeployed %s: https://%s\n' "$stamp" "$DOMAIN"
    printf 'Logs: deploy/contzo/deploy.sh --logs   Rollback: deploy/contzo/deploy.sh --rollback\n'
  fi
}

render_site() {
  echo "# Written by $APP_NAME/deploy/contzo/deploy.sh --setup (contzo-deploy). Change app.conf, not this file."
  echo "$DOMAIN {"
  if [ -n "$BASIC_AUTH_USER" ]; then
    [ -n "$BASIC_AUTH_HASH" ] || die "BASIC_AUTH_USER is set but BASIC_AUTH_HASH is empty"
    printf '\tbasicauth {\n\t\t%s %s\n\t}\n\n' "$BASIC_AUTH_USER" "$BASIC_AUTH_HASH"
  fi
  if [ -n "$MAX_BODY" ]; then printf '\trequest_body {\n\t\tmax_size %s\n\t}\n\n' "$MAX_BODY"; fi
  if [ "$KIND" = static ]; then
    printf '\troot * %s\n' "$STATIC_ROOT"
    printf '\tencode zstd gzip\n'
    printf '\t@hashed path /assets/* /_app/immutable/* /_next/static/* /_astro/*\n'
    printf '\theader @hashed Cache-Control "public, max-age=31536000, immutable"\n'
    if [ "$SPA" = 1 ]; then printf '\ttry_files {path} {path}/ /index.html\n'; fi
    printf '\tfile_server\n'
  elif [ "$SSE" = 1 ]; then
    printf '\t# Compress only static-ish types; never text/event-stream.\n'
    printf '\tencode zstd gzip {\n\t\tmatch {\n'
    local t
    for t in 'text/html*' 'text/css*' 'application/javascript*' 'text/javascript*' 'application/json*' 'image/svg+xml*'; do
      printf '\t\t\theader Content-Type %s\n' "$t"
    done
    printf '\t\t}\n\t}\n'
    printf '\t# No buffering, so server-sent events and long polls flow.\n'
    printf '\treverse_proxy 127.0.0.1:%s {\n\t\tflush_interval -1\n\t}\n' "$PORT"
  else
    printf '\tencode zstd gzip\n'
    printf '\treverse_proxy 127.0.0.1:%s\n' "$PORT"
  fi
  if [ -n "$CADDY_EXTRA" ]; then printf '%s\n' "$CADDY_EXTRA" | sed 's/^/\t/'; fi
  echo "}"
}

caddy_validate() { # caddy_validate CONFIG -> validates as this user, Caddy state in a throwaway dir
  mkdir -p "$WORK/xdg"
  if XDG_DATA_HOME="$WORK/xdg" XDG_CONFIG_HOME="$WORK/xdg" HOME="$WORK/xdg" \
    caddy validate --config "$1" --adapter caddyfile >"$WORK/validate.log" 2>&1; then
    return 0
  fi
  sed 's/^/      /' "$WORK/validate.log" >&2
  return 1
}

# Validate the live config as it will be once $WORK/site.caddy is installed: a copy of
# the main Caddyfile importing a temp copy of the sites dir. No sudo, nothing changes.
validate_with_site() {
  local d="$WORK/combined" f
  mkdir -p "$d/sites"
  for f in /etc/caddy/sites/*.caddy; do
    if [ -f "$f" ] && [ "$f" != "$CADDY_SITE" ]; then cp "$f" "$d/sites/"; fi
  done
  cp "$WORK/site.caddy" "$d/sites/$APP_NAME.caddy"
  if grep -qxF 'import /etc/caddy/sites/*.caddy' /etc/caddy/Caddyfile; then
    sed "s#^import /etc/caddy/sites/\*\.caddy\$#import $d/sites/*.caddy#" /etc/caddy/Caddyfile >"$d/Caddyfile"
  else
    { cat /etc/caddy/Caddyfile; printf '\nimport %s/sites/*.caddy\n' "$d"; } >"$d/Caddyfile"
  fi
  caddy_validate "$d/Caddyfile"
}

setup_caddy() {
  say "Caddy: $DOMAIN -> $([ "$KIND" = static ] && echo "$STATIC_ROOT" || echo "127.0.0.1:$PORT")"
  command -v caddy >/dev/null || die "caddy is not installed"
  check_domain_free
  render_site >"$WORK/site.caddy"
  show_file "$CADDY_SITE" "$WORK/site.caddy"
  validate_with_site || die "the Caddy config would not validate with this site; nothing was changed"
  info "the full Caddy config validates with this site added"

  local import_line='import /etc/caddy/sites/*.caddy' had_old=0
  srun install -d -m 755 /etc/caddy/sites
  if ! grep -qxF "$import_line" /etc/caddy/Caddyfile; then
    srun cp -a /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bak.$APP_NAME-$(date +%Y%m%d-%H%M%S)"
    printf '+ append "%s" to /etc/caddy/Caddyfile\n' "$import_line"
    [ "$DRY" = 1 ] || printf '\n# Per-site snippets (contzo-deploy)\n%s\n' "$import_line" | sudo tee -a /etc/caddy/Caddyfile >/dev/null
  fi
  if [ -f "$CADDY_SITE" ]; then had_old=1; cp "$CADDY_SITE" "$WORK/old.caddy"; fi
  srun install -m 644 "$WORK/site.caddy" "$CADDY_SITE"
  [ "$DRY" = 1 ] && return 0

  restore_site() {
    if [ "$had_old" = 1 ]; then sudo install -m 644 "$WORK/old.caddy" "$CADDY_SITE"; else sudo rm -f "$CADDY_SITE"; fi
  }
  if ! caddy_validate /etc/caddy/Caddyfile; then
    restore_site
    die "the full Caddy config did not validate; the site file was put back as it was"
  fi
  if ! srun systemctl reload caddy; then
    restore_site
    sudo systemctl reload caddy || true
    die "caddy reload failed; the site file was put back as it was (journalctl -u caddy -n 40)"
  fi
  info "Caddy reloaded; it fetches the certificate for $DOMAIN now (needs the DNS record)"
}

setup_postgres() {
  say "Postgres: role '$DB_ROLE', database '$DB_NAME'"
  [[ "$DB_NAME" =~ ^[a-z_][a-z0-9_]*$ && "$DB_ROLE" =~ ^[a-z_][a-z0-9_]*$ ]] || die "DB_NAME/DB_ROLE must be lowercase identifiers"
  local pw=""
  [ -f "$SHARED/.env" ] && pw="$(sed -n 's/^DB_PASSWORD=//p' "$SHARED/.env" | tail -n 1)"
  [ -n "$pw" ] || pw="$(openssl rand -hex 24)"
  # as the postgres user, from / (it can't enter a /mnt/c or home working dir)
  pgsu() { (cd / && sudo -u postgres "$@"); }
  if [ "$DRY" = 1 ]; then
    info "would create/alter role $DB_ROLE (generated password) and database $DB_NAME owned by it"
  else
    # pw is hex, safe inside the SQL literal
    if pgsu psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$DB_ROLE'" | grep -q 1; then
      pgsu psql -q -v ON_ERROR_STOP=1 -c "ALTER ROLE \"$DB_ROLE\" LOGIN PASSWORD '$pw'"
    else
      pgsu psql -q -v ON_ERROR_STOP=1 -c "CREATE ROLE \"$DB_ROLE\" LOGIN PASSWORD '$pw'"
    fi
    if ! pgsu psql -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1; then
      pgsu createdb -O "$DB_ROLE" "$DB_NAME"
      info "database $DB_NAME created"
    else
      info "database $DB_NAME already exists"
    fi
    pgsu psql -q -d "$DB_NAME" -c "ALTER SCHEMA public OWNER TO \"$DB_ROLE\""
  fi
  upsert_env DB_HOST 127.0.0.1
  upsert_env DB_PORT 5432
  upsert_env DB_USER "$DB_ROLE"
  upsert_env DB_PASSWORD "$pw"
  upsert_env DB_DATABASE "$DB_NAME"
  upsert_env DATABASE_URL "postgres://$DB_ROLE:$pw@127.0.0.1:5432/$DB_NAME"
}

cmd_setup() {
  say "Setup: $APP_NAME -> https://$DOMAIN"
  if [ "$DRY" = 0 ]; then
    say "sudo (needed for the Caddy site$([ "$DATABASE" = postgres ] && echo ', Postgres')$([ "$KIND" = static ] && echo ', /srv'))"
    sudo -v
  fi
  ensure_dirs
  seed_env
  if [ "$DATABASE" = postgres ]; then setup_postgres; fi
  if [ "$KIND" = static ]; then
    say "Static root $STATIC_ROOT (readable by the caddy user)"
    srun install -d -m 755 /srv/contzo
    srun install -d -o "$(id -un)" -g "$(id -gn)" -m 755 "$STATIC_ROOT"
  fi
  if loginctl show-user "$(id -un)" -p Linger 2>/dev/null | grep -q 'Linger=no'; then
    say "Linger (user units start at boot without a login)"
    srun loginctl enable-linger "$(id -un)"
  fi
  setup_caddy
  if [ "$DRY" = 1 ]; then printf '\nDRY RUN complete: nothing was changed.\n'; else printf '\nSetup done. Next: deploy/contzo/deploy.sh\n'; fi
}

cmd_status() {
  load_node
  printf 'app       %s  (%s)\n' "$APP_NAME" "$KIND"
  printf 'url       https://%s\n' "$DOMAIN"
  printf 'root      %s\n' "$APP_ROOT"
  printf 'current   %s\n' "$(current_release || true)"
  printf 'releases  %s\n' "$(list_releases | tr '\n' ' ')"
  printf 'caddy     %s\n' "$([ -f "$CADDY_SITE" ] && echo "$CADDY_SITE" || echo 'not set up (run --setup)')"
  printf 'dns       %s\n' "$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}' || true)"
  if [ "$KIND" = service ]; then
    local u
    for u in $(all_units); do printf 'unit      %-28s %s\n' "$u" "$(systemctl --user is-active "$u.service" 2>/dev/null || true)"; done
    printf 'local     %s  http://127.0.0.1:%s%s\n' "$(local_code)" "$PORT" "$HEALTH_PATH"
  fi
  [ "$BACKUP" = none ] || printf 'backups   %s\n' "$(ls -1 "$SHARED/backups" 2>/dev/null | wc -l) in $SHARED/backups"
  printf 'public    %s  https://%s%s (via Caddy on this host)\n' "$(public_code)" "$DOMAIN" "$HEALTH_PATH"
}

cmd_logs() {
  [ "$KIND" = service ] || { journalctl -u caddy -f -n 50; return; }
  local args=() u
  for u in $(all_units); do args+=(-u "$u.service"); done
  exec journalctl --user -f -n 100 "${args[@]}"
}

cmd_rollback() {
  local cur prev
  cur="$(current_release)"
  [ -n "$cur" ] || die "nothing deployed yet"
  prev="$(list_releases | awk -v c="$cur" '$0 == c {print p; exit} {p = $0}')"
  [ -n "$prev" ] || die "no release older than $cur to roll back to"
  say "Rollback $cur -> $prev"
  load_node
  switch_to "$prev"
  if [ "$KIND" = static ]; then
    publish_static "$prev"
  else
    restart_units
    [ "$DRY" = 1 ] || wait_local || die "the previous release is not healthy either (deploy.sh --logs)"
  fi
  info "rolled back; $cur stays in $RELEASES until it is pruned"
}

cmd_uninstall() {
  say "Uninstall $APP_NAME ($DOMAIN)"
  local u
  for u in $(all_units) "$APP_NAME-backup"; do
    if [ -f "$UNIT_DIR/$u.service" ] || [ -f "$UNIT_DIR/$u.timer" ]; then
      run systemctl --user disable --now "$u.service" --quiet || true
      [ -f "$UNIT_DIR/$u.timer" ] && { run systemctl --user disable --now "$u.timer" --quiet || true; }
      run rm -f "$UNIT_DIR/$u.service" "$UNIT_DIR/$u.timer"
    fi
  done
  run systemctl --user daemon-reload
  run rm -f "$BIN"/run-* "$BIN/backup"
  if [ -f "$CADDY_SITE" ] || [ -d "$STATIC_ROOT" ]; then
    [ "$DRY" = 1 ] || sudo -v
    if [ -f "$CADDY_SITE" ]; then
      srun rm -f "$CADDY_SITE"
      if [ "$DRY" = 0 ]; then caddy_validate /etc/caddy/Caddyfile || warn "Caddy config does not validate after removal; check it before the next reload"; fi
      srun systemctl reload caddy
    fi
    [ -d "$STATIC_ROOT" ] && srun rm -rf "$STATIC_ROOT"
  fi
  if [ "$DRY" = 1 ]; then printf '\nDRY RUN complete: nothing was changed.\n'; else printf '\nUninstalled %s.\n' "$APP_NAME"; fi
  info "kept $APP_ROOT (releases, shared/.env, backups). Delete it with: rm -rf $APP_ROOT"
  [ "$DATABASE" = postgres ] && info "kept database $DB_NAME. Drop it with: sudo -u postgres dropdb $DB_NAME && sudo -u postgres dropuser $DB_ROLE"
  info "outside WSL: remove the A record for $SUBDOMAIN (Namecheap) and the '127.0.0.1 $DOMAIN' line in the Windows hosts file"
}

usage() { sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; }

# ------------------------------------------------------------------ main
MODE=deploy
for arg in "$@"; do
  case "$arg" in
    --dry-run | -n) DRY=1 ;;
    --setup) MODE=setup ;;
    --status) MODE=status ;;
    --logs) MODE=logs ;;
    --rollback) MODE=rollback ;;
    --uninstall) MODE=uninstall ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown option: $arg (see --help)" ;;
  esac
done

load_conf
case "$MODE" in
  deploy) cmd_deploy ;;
  setup) cmd_setup ;;
  status) cmd_status ;;
  logs) cmd_logs ;;
  rollback) cmd_rollback ;;
  uninstall) cmd_uninstall ;;
esac
