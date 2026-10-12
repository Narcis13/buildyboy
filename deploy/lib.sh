# shellcheck shell=bash
# Shared helpers for deploy-wsl.sh and update.sh. Sourced, not executed.
# Callers set DRY_RUN=0|1 before calling run/srun.

DRY_RUN="${DRY_RUN:-0}"

log() { printf '\n==> %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# Print a command (shell-quoted) as it will be executed.
show_cmd() {
  local prefix="$1"
  shift
  printf '%s' "$prefix"
  printf ' %q' "$@"
  printf '\n'
}

# run CMD...: print, then execute (dry-run: only print).
run() {
  show_cmd '+' "$@"
  if [ "$DRY_RUN" = 1 ]; then return 0; fi
  "$@"
}

# run_in DIR CMD...: like run, inside DIR.
run_in() {
  local dir="$1"
  shift
  printf '+ (cd %q &&' "$dir"
  printf ' %q' "$@"
  printf ')\n'
  if [ "$DRY_RUN" = 1 ]; then return 0; fi
  (cd "$dir" && "$@")
}

# srun CMD...: like run, with sudo. Dry-run never calls sudo.
srun() {
  show_cmd '+ sudo' "$@"
  if [ "$DRY_RUN" = 1 ]; then return 0; fi
  sudo "$@"
}

# srun_append FILE TEXT: append TEXT to a root-owned FILE.
srun_append() {
  local file="$1" text="$2"
  printf '+ printf %q | sudo tee -a %q >/dev/null\n' "$text" "$file"
  if [ "$DRY_RUN" = 1 ]; then return 0; fi
  printf '%s' "$text" | sudo tee -a "$file" >/dev/null
}

# Escape a value for the replacement side of sed s|..|..|.
sed_escape() { printf '%s' "$1" | sed -e 's/[\&|]/\&/g'; }

# Resolve Node 24 through nvm. Sets NODE_BIN and puts it first on PATH.
load_node() {
  local nvm_dir="${NVM_DIR:-$HOME/.nvm}" major
  [ -s "$nvm_dir/nvm.sh" ] || die "nvm not found ($nvm_dir/nvm.sh). Install nvm and run: nvm install 24"
  # nvm.sh is not safe under set -eu
  set +eu
  # shellcheck disable=SC1091
  . "$nvm_dir/nvm.sh" --no-use
  NODE_BIN="$(nvm which 24 2>/dev/null)"
  set -eu
  [ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ] || die "Node 24 is not installed under nvm. Run: nvm install 24"
  major="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
  [ "$major" = 24 ] || die "expected Node 24 from nvm, got $("$NODE_BIN" -v) at $NODE_BIN"
  PATH="$(dirname "$NODE_BIN"):$PATH"
  export PATH
  info "node: $NODE_BIN ($("$NODE_BIN" -v)), npm $(npm -v)"
}

# wait_health URL [SECONDS] -> 0 once URL answers 200.
wait_health() {
  local url="$1" timeout="${2:-60}" waited=0 code
  while [ "$waited" -lt "$timeout" ]; do
    code="$(curl -sS -o /dev/null -m 5 -w '%{http_code}' "$url" 2>/dev/null || true)"
    if [ "$code" = 200 ]; then return 0; fi
    sleep 2
    waited=$((waited + 2))
  done
  return 1
}

# caddy_validate FILE: validate a Caddyfile without touching the live Caddy or
# the invoking user's Caddy dirs (storage/config go to a throwaway dir).
caddy_validate() {
  local file="$1" tmp rc=0
  tmp="$(mktemp -d)"
  XDG_DATA_HOME="$tmp" XDG_CONFIG_HOME="$tmp" caddy validate --config "$file" --adapter caddyfile >"$tmp/out" 2>&1 || rc=$?
  if [ "$rc" -ne 0 ]; then sed 's/^/    caddy: /' "$tmp/out" >&2; fi
  rm -rf "$tmp"
  return "$rc"
}

# Extract the "Open <url>/setup?token=..." line the server logs on first run.
find_setup_url() {
  local line=""
  line="$(journalctl -u buildyboy -n 200 --no-pager 2>/dev/null | grep -o 'Open [^ ]*/setup?token=[^ ]*' | tail -n 1 || true)"
  if [ -z "$line" ]; then
    line="$(sudo -n journalctl -u buildyboy -n 200 --no-pager 2>/dev/null | grep -o 'Open [^ ]*/setup?token=[^ ]*' | tail -n 1 || true)"
  fi
  printf '%s' "${line#Open }"
}
