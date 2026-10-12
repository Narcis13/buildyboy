#!/usr/bin/env bash
# Buildyboy client installer for Linux, WSL and macOS.
#
#   curl -fsSL __BB_URL__/install.sh | bash -s -- <PAIRCODE> [--runner]
#   curl -fsSL __BB_URL__/install.sh | bash -s -- --uninstall
#
# What it does:
#   1. downloads the plugin marketplace tarball (__BB_URL__/plugin.tgz) to ~/.buildyboy/marketplace
#   2. pairs this machine with the one-time code and writes ~/.buildyboy/config.json (mode 600)
#   3. registers the plugin with `claude plugin marketplace add` + `claude plugin install`
#      (~/.claude/settings.json is never edited directly)
#   4. with --runner (and BB_REPO pointing at a checkout of the repo): installs `bb runner`
#      as a systemd --user service
#   5. sends a test event to the server
#
# Options / environment:
#   <PAIRCODE> | BB_CODE   pairing code from the web UI (Machines page)
#   --runner   | BB_RUNNER=1   install the runner service (needs BB_REPO=<path to a buildyboy checkout>)
#   --name N   | BB_NAME       machine name (default: the pairing code's name, else the hostname)
#   --uninstall | BB_UNINSTALL=1   reverse everything (asks before deleting ~/.buildyboy; --yes skips)
#   BB_URL           server URL (default: the server that served this script)
#   BUILDYBOY_HOME   config/marketplace dir (default ~/.buildyboy)
#   BB_SKIP_CLAUDE=1 do not call the `claude` CLI (tests)
set -euo pipefail

BB_URL="${BB_URL:-__BB_URL__}"
BB_URL="${BB_URL%/}"
BB_HOME="${BUILDYBOY_HOME:-$HOME/.buildyboy}"
CODE="${BB_CODE:-}"
RUNNER="${BB_RUNNER:-0}"
UNINSTALL="${BB_UNINSTALL:-0}"
ASSUME_YES="${BB_YES:-0}"
NAME="${BB_NAME:-}"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_NAME=buildyboy-runner.service

say() { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

TMP=""
cleanup() { if [ -n "$TMP" ] && [ -d "$TMP" ]; then rm -rf "$TMP"; fi; }
trap cleanup EXIT

while [ "$#" -gt 0 ]; do
  case "$1" in
    --runner) RUNNER=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --yes | -y) ASSUME_YES=1 ;;
    --name)
      [ "$#" -gt 1 ] || die "--name needs a value"
      NAME="$2"
      shift
      ;;
    -h | --help)
      say "usage: curl -fsSL $BB_URL/install.sh | bash -s -- <PAIRCODE> [--runner] [--name NAME]"
      say "       curl -fsSL $BB_URL/install.sh | bash -s -- --uninstall [--yes]"
      exit 0
      ;;
    -*) die "unknown option: $1" ;;
    *) CODE="$1" ;;
  esac
  shift
done

have() { command -v "$1" >/dev/null 2>&1; }
claude_enabled() { [ "${BB_SKIP_CLAUDE:-0}" != 1 ] && have claude; }

json_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr -d '\n\r'; }
# json_get KEY < json : value of a top-level string field (flat JSON as the server returns it).
json_get() { sed -n 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1; }

detect_platform() {
  case "$(uname -s)" in
    Linux)
      if grep -qi microsoft /proc/version 2>/dev/null; then echo wsl; else echo linux; fi
      ;;
    Darwin) echo darwin ;;
    MINGW* | MSYS* | CYGWIN*) echo win32 ;;
    *) uname -s | tr '[:upper:]' '[:lower:]' ;;
  esac
}

detect_arch() {
  case "$(uname -m)" in
    x86_64 | amd64) echo x64 ;;
    aarch64 | arm64) echo arm64 ;;
    *) uname -m ;;
  esac
}

confirm() {
  local prompt="$1" reply=""
  if [ "$ASSUME_YES" = 1 ]; then return 0; fi
  if [ -r /dev/tty ]; then
    printf '%s [y/N] ' "$prompt" >/dev/tty
    read -r reply </dev/tty || reply=""
    case "$reply" in y | Y | yes | YES) return 0 ;; esac
  fi
  return 1
}

# ------------------------------------------------------------------ uninstall
do_uninstall() {
  step "Uninstalling Buildyboy from this machine"
  if claude_enabled; then
    claude plugin uninstall buildyboy@buildyboy || warn "claude plugin uninstall failed (already removed?)"
    claude plugin marketplace remove buildyboy || warn "claude plugin marketplace remove failed (already removed?)"
  else
    note "claude CLI skipped; to finish by hand run:"
    note "  claude plugin uninstall buildyboy@buildyboy && claude plugin marketplace remove buildyboy"
  fi
  if have systemctl && [ -f "$UNIT_DIR/$UNIT_NAME" ]; then
    systemctl --user disable --now "$UNIT_NAME" 2>/dev/null || true
    rm -f "$UNIT_DIR/$UNIT_NAME"
    systemctl --user daemon-reload 2>/dev/null || true
    note "removed the runner service"
  fi
  if [ -d "$BB_HOME" ]; then
    if confirm "Delete $BB_HOME (config, token, marketplace, spool)?"; then
      rm -rf "$BB_HOME"
      note "removed $BB_HOME"
    else
      note "kept $BB_HOME (delete it with: rm -rf \"$BB_HOME\")"
    fi
  fi
  say ""
  say "Done. Revoke this machine on the server (Machines page) so its token stops working."
}

# -------------------------------------------------------------------- install
fetch_marketplace() {
  step "Downloading the plugin from $BB_URL/plugin.tgz"
  TMP="$(mktemp -d)"
  curl -fsSL "$BB_URL/plugin.tgz" -o "$TMP/plugin.tgz" || die "could not download $BB_URL/plugin.tgz"
  mkdir -p "$TMP/mp"
  tar -xzf "$TMP/plugin.tgz" -C "$TMP/mp" || die "the plugin tarball is not a valid archive"
  [ -f "$TMP/mp/.claude-plugin/marketplace.json" ] || die "the tarball has no .claude-plugin/marketplace.json"
  mkdir -p "$BB_HOME"
  rm -rf "$BB_HOME/marketplace"
  mv "$TMP/mp" "$BB_HOME/marketplace"
  note "marketplace extracted to $BB_HOME/marketplace"
}

pair_machine() {
  local cfg="$BB_HOME/config.json"
  if [ -z "$CODE" ]; then
    if [ -f "$cfg" ]; then
      step "Pairing"
      note "already paired ($cfg exists); pass a new code to pair again"
      return 0
    fi
    die "no pairing code. Create one on the Machines page, then: curl -fsSL $BB_URL/install.sh | bash -s -- <PAIRCODE>"
  fi
  step "Pairing this machine"
  local host user platform arch body resp status token machine_id url
  host="$(hostname 2>/dev/null || echo unknown)"
  user="$(id -un 2>/dev/null || echo unknown)"
  platform="$(detect_platform)"
  arch="$(detect_arch)"
  body="{\"code\":\"$(json_escape "$CODE")\""
  if [ -n "$NAME" ]; then body="$body,\"name\":\"$(json_escape "$NAME")\""; fi
  body="$body,\"hostname\":\"$(json_escape "$host")\",\"platform\":\"$platform\",\"arch\":\"$arch\",\"user\":\"$(json_escape "$user")\"}"
  resp="$TMP/pair.json"
  status="$(curl -sS -o "$resp" -w '%{http_code}' -X POST -H 'content-type: application/json' --data "$body" "$BB_URL/api/pair" || true)"
  if [ "$status" != 200 ]; then
    die "pairing failed (HTTP $status): $(json_get error <"$resp" 2>/dev/null || true). Codes are single use and expire after 10 minutes."
  fi
  token="$(json_get token <"$resp")"
  machine_id="$(json_get machineId <"$resp")"
  url="$(json_get url <"$resp")"
  [ -n "$token" ] && [ -n "$machine_id" ] || die "unexpected pairing response"
  url="${url:-$BB_URL}"
  (
    umask 077
    printf '{\n  "url": "%s",\n  "token": "%s",\n  "machineId": "%s"\n}\n' "$(json_escape "$url")" "$token" "$machine_id" >"$cfg"
  )
  chmod 600 "$cfg"
  note "paired as machine $machine_id; wrote $cfg (mode 600)"
}

register_plugin() {
  step "Registering the Claude Code plugin"
  if ! claude_enabled; then
    note "the claude CLI was not found (or BB_SKIP_CLAUDE=1). Install Claude Code, then run:"
    note "  claude plugin marketplace add \"$BB_HOME/marketplace\""
    note "  claude plugin install buildyboy@buildyboy"
    return 0
  fi
  if ! claude plugin marketplace add "$BB_HOME/marketplace"; then
    warn "marketplace add failed (already added?); refreshing it instead"
    claude plugin marketplace update buildyboy || true
  fi
  if ! claude plugin install buildyboy@buildyboy; then
    warn "plugin install failed (already installed?); trying an update"
    claude plugin update buildyboy@buildyboy || warn "could not install or update the plugin; run the commands above by hand"
  fi
  have node || warn "node was not found on PATH: the plugin's hook script needs Node to run"
}

install_runner() {
  [ "$RUNNER" = 1 ] || return 0
  step "Installing the runner service"
  local repo="${BB_REPO:-}"
  if [ -z "$repo" ] || [ ! -f "$repo/cli/bb.ts" ]; then
    note "the runner needs the app code. Clone the repo and point BB_REPO at it, then re-run:"
    note "  git clone https://github.com/Narcis13/buildyboy && (cd buildyboy && npm ci)"
    note "  BB_REPO=\$PWD/buildyboy bash install.sh --runner   (pairing is skipped: this machine is already paired)"
    return 0
  fi
  if [ "$(uname -s)" != Linux ] || ! have systemctl; then
    note "systemd --user is not available here. Start the runner by hand: node \"$repo/cli/bb.ts\" runner"
    return 0
  fi
  have node || die "node is required for the runner"
  local node_bin
  node_bin="$(command -v node)"
  mkdir -p "$UNIT_DIR"
  cat >"$UNIT_DIR/$UNIT_NAME" <<UNIT
[Unit]
Description=Buildyboy runner (starts Claude Code jobs sent from the server)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$repo
Environment=BUILDYBOY_HOME=$BB_HOME
Environment=PATH=$(dirname "$node_bin"):$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=$node_bin $repo/cli/bb.ts runner
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
UNIT
  if systemctl --user daemon-reload 2>/dev/null && systemctl --user enable --now "$UNIT_NAME" 2>/dev/null; then
    note "runner service enabled: systemctl --user status $UNIT_NAME"
    note "to keep it running when you are logged out: loginctl enable-linger $(id -un)"
  else
    warn "could not enable the user service (is a systemd user session running?). Unit written to $UNIT_DIR/$UNIT_NAME"
  fi
}

send_test_event() {
  step "Sending a test event"
  local cfg="$BB_HOME/config.json" token machine_id url ts body status
  [ -f "$cfg" ] || { warn "no config, skipping the test event"; return 0; }
  token="$(json_get token <"$cfg")"
  machine_id="$(json_get machineId <"$cfg")"
  url="$(json_get url <"$cfg")"
  url="${url:-$BB_URL}"
  ts="$(date +%s)000"
  body="{\"envelopes\":[{\"v\":1,\"ts\":$ts,\"env\":{},\"hostname\":\"$(json_escape "$(hostname 2>/dev/null || echo unknown)")\",\"platform\":\"$(detect_platform)\",\"user\":\"$(json_escape "$(id -un 2>/dev/null || echo unknown)")\",\"pid\":$$,\"ppid\":$PPID,\"hookVersion\":\"install\",\"event\":{\"session_id\":\"install-test-$machine_id\",\"hook_event_name\":\"BuildyboyInstallTest\"}}]}"
  status="$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -H "authorization: Bearer $token" --data "$body" "$url/api/ingest" || true)"
  if [ "$status" = 200 ]; then
    note "test event accepted by $url"
  else
    warn "the server answered HTTP $status to the test event; check the token with: curl -H 'authorization: Bearer ...' $url/api/ingest"
  fi
}

main() {
  if [ "$UNINSTALL" = 1 ]; then
    do_uninstall
    return 0
  fi
  have curl || die "curl is required"
  have tar || die "tar is required"
  if [ -z "$CODE" ] && [ ! -f "$BB_HOME/config.json" ]; then
    die "no pairing code. Create one on the Machines page, then: curl -fsSL $BB_URL/install.sh | bash -s -- <PAIRCODE>"
  fi
  fetch_marketplace
  pair_machine
  register_plugin
  install_runner
  send_test_event
  say ""
  say "Buildyboy is installed on $(hostname 2>/dev/null || echo this machine). Start a new Claude Code session; it should appear on $BB_URL."
}

main
