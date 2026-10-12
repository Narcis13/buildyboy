# Buildyboy

A self-hosted software factory around Claude Code. One Node 24 server and one SQLite file see everything your Claude Code
sessions do, on every machine you use. Watch, steer and approve them from your phone, and write and launch new unattended
runs from a prompt composer built on [`harness-prompt.md`](harness-prompt.md).

- **The Floor**: every machine is a bay, every session a station with a status lamp, context tank, cost meter and a conveyor
  belt of tool calls. On a phone it's a list of cards, waiting sessions first.
- **Session page**: the full timeline (prompts, Claude's text, every tool call with its own renderer, diffs, errors,
  compactions, permission decisions), side panels for todos, files, git, subagents and the run's `PROGRESS.md`, and a compose
  box to steer the session.
- **Inbox**: approve permissions, answer questions, approve plans and reply when a turn ends, all from your phone, with Web
  Push (and an optional ntfy topic).
- **Composer and jobs**: fill in `harness-prompt.md`, lint it, keep a library with versions, and launch it as a job on any
  paired machine through the runner.
- **Insights**: cost and tokens over time, most-used tools, most-failed commands, wait time, job success rates, full-text
  search and `bb import` to backfill months of history.

It complements Claude Code's built-in Remote Control (which drives one interactive session from the Claude app): Buildyboy is
the multi-machine overview, history, approvals hub, factory and analytics. See [SPEC.md](SPEC.md) for the full design and
[docs/claude-code-notes.md](docs/claude-code-notes.md) for the Claude Code behaviors it relies on.

```
 dev machine(s)                                         WSL host (public)
 claude (terminal | Desktop | -p | --bg)                Caddy :443 ──▶ buildyboy server 127.0.0.1:7700
   └─ buildyboy plugin: hooks → bb-hook.mjs ── HTTPS ──▶   Hono + SSE + node:sqlite, serves the PWA
 OTEL exporter (optional) ──────────────────── HTTPS ──▶   /v1/logs, /v1/metrics
 bb runner (optional) ◀──── SSE jobs ─────────────────    Web Push / ntfy, GitHub poller
```

## Local development

Requirements: Node 24 (uses the built-in `node:sqlite` and runs TypeScript directly, no build step for the server), git.

```bash
npm ci
npm run dev        # API server on :7700 (watch mode) + Vite on :5173 with /api proxied
```

Open <http://localhost:5173>. On the first run the server prints a one-time setup link (`/setup?token=…`) to choose the web
password; or set it from the shell:

```bash
echo 'my-long-password' | node cli/bb.ts set-password
```

Fill the floor with synthetic sessions (3 sessions on 2 machines, every tool type, a subagent, a permission request, a
compaction, a failure and a commit):

```bash
npm run simulate                 # replays fixtures into http://127.0.0.1:7700 (data dir ./data)
npm run simulate -- --live       # replays them in real time (add --speed 10 to go faster)
```

Other scripts:

| Script | What it does |
|---|---|
| `npm start` | production server on `127.0.0.1:7700`, serving `web/dist` |
| `npm run build` | builds the PWA into `web/dist` |
| `npm run check` | typecheck (server/shared/runner/cli/scripts and the web app) plus all Vitest tests |
| `npm run e2e` | builds, then runs Playwright at 1280×800 and 390×844 against a temp server with replayed fixtures |
| `npm run smoke:claude` | real `claude -p --plugin-dir ./plugin` runs (cheapest model, small budget) against a temp server: telemetry and remote approval |

Environment variables for the server: `BUILDYBOY_PORT` (7700), `BUILDYBOY_HOST` (127.0.0.1), `BUILDYBOY_DATA` (`./data`),
`BUILDYBOY_PUBLIC_URL` (used in links and installers), `BUILDYBOY_PERMISSION_WAIT_MS` (how long a remote approval waits,
default 9.5 min, just under the hook's 10 min timeout), `BUILDYBOY_STOP_WAIT_MIN` (how long a finished turn waits for your
reply in walk mode, default 5).

To try the plugin against your local server without installing anything, point one session at it:

```bash
node cli/bb.ts token my-laptop          # prints {"machineId", "token"} (server host only)
BUILDYBOY_URL=http://127.0.0.1:7700 BUILDYBOY_TOKEN=<token> claude --plugin-dir ./plugin
```

`--plugin-dir` loads the plugin for that session only. Hooks fail open: if the server is down or slow, sessions are never
blocked or changed, events spool to `~/.buildyboy/spool.jsonl` and are sent later.

### Repository layout

```
server/   main.ts, app.ts, db.ts, migrations/, routes/, ingest/, control/, push/, github/, jobs/, watchers.ts
web/      Vite + React 19 + Tailwind v4 + TanStack Query + React Flow (src/pages, src/components/…)
shared/   types.ts (events + API), harness.ts (template parser/renderer/linter), redact.ts, diff.ts
plugin/   .claude-plugin/plugin.json, hooks/hooks.json, hooks/bb-hook.mjs, hooks/bb-cli.mjs, commands/, statusline/
runner/   bb runner daemon (spawns claude -p in allow-listed directories)
cli/      bb.ts — bb server | runner | pair | set-password | token | import | backup | doctor
deploy/   deploy-wsl.sh, update.sh, backup.sh, systemd + Caddy templates, install.sh, install.ps1
fixtures/ synthetic scenario, fake claude + stream-json (never copied from real sessions)
scripts/  simulate.ts, smoke-claude.ts, dev.ts
```

## Deploying to WSL

Buildyboy runs as a systemd service inside WSL (Ubuntu, user `sysadm`, Node 24 from nvm), behind the Caddy that is already
running there. Caddy keeps serving `contzo.lol` exactly as before; Buildyboy gets its own site block.

What you need first: systemd on in WSL, Node 24 under nvm (`nvm install 24`), `rsync`, `curl` and Caddy installed, and
`sudo` for the system steps (it asks for your password).

```bash
# inside WSL, from a checkout of the repo (for example /mnt/c/newme/buildyboy)
deploy/deploy-wsl.sh --dry-run     # prints every action, changes nothing, needs no sudo
deploy/deploy-wsl.sh               # the real thing
```

The script is idempotent (run it again to redeploy) and prints every command before it runs it:

1. **Preflight.** Node 24 via `~/.nvm/nvm.sh`, port 7700 free (or held by the running service), Caddy installed, and the
   existing `/etc/caddy/Caddyfile` validates.
2. **Install.** Copies the app to `~/apps/buildyboy`, runs `npm ci`, `npm run build` and `npm prune --omit=dev`. The data
   directory is `~/.local/share/buildyboy` (database, VAPID keys, `backups/`).
3. **Service.** Installs `/etc/systemd/system/buildyboy.service` (user `sysadm`, the absolute nvm `node` path,
   `Restart=always`, `127.0.0.1:7700`, `NODE_ENV=production`, `NoNewPrivileges`, `ProtectSystem=strict`,
   `ProtectHome=read-only`, `PrivateTmp`, `ReadWritePaths=<data dir>`) and enables it.
4. **Caddy.** Writes `/etc/caddy/sites/buildyboy.caddy` (reverse proxy to `127.0.0.1:7700`, buffering off for SSE) and
   appends `import /etc/caddy/sites/*.caddy` to the end of the main Caddyfile **only if it is missing**, after a timestamped
   backup. It validates, then reloads Caddy; if validation or the reload fails, the backup is restored automatically. The
   existing `contzo.lol` blocks are never edited or reordered.
5. **Backups.** `buildyboy-backup.timer` runs `deploy/backup.sh` nightly (online SQLite backup, newest 14 kept).
6. **Finish.** Waits for `https://$DOMAIN/api/health` to return 200 and prints the one-time setup link. If you miss it:
   `journalctl -u buildyboy | grep setup`, or `cd ~/apps/buildyboy && BUILDYBOY_DATA=~/.local/share/buildyboy node cli/bb.ts set-password`.

Script settings (environment variables): `DOMAIN` (default `buildyboy.109-99-176-213.sslip.io`), `BB_PORT` (7700),
`BB_APP_DIR`, `BB_DATA_DIR`.

**DNS.** The default host `buildyboy.109-99-176-213.sslip.io` works today: sslip.io resolves names of that form to the IP
inside them (the machine's public IP), so Caddy can get a certificate without DNS work. A `contzo.lol` subdomain needs a DNS
record you create (`*.contzo.lol` does not point at this machine): add an A record such as `buildyboy.contzo.lol →
109.99.176.213`, then redeploy with `DOMAIN=buildyboy.contzo.lol deploy/deploy-wsl.sh`.

**Updating.** `deploy/update.sh` (`--dry-run` first) pulls, backs up the DB, builds the new release next to the running one,
swaps, restarts and waits for `/api/health`; if it isn't healthy it puts the previous release (`~/apps/buildyboy.prev`) back.
Migrations run on start and are forward-only; the pre-update DB backup covers a rollback.

**Uninstalling.** `deploy/deploy-wsl.sh --uninstall` removes the service, the backup timer and the Caddy site file, then
reloads Caddy. It leaves the `import` line, the data directory and the app directory.

## Pairing a machine (Windows and WSL)

Every machine that runs Claude Code needs the plugin and a token of its own. **Windows and WSL have separate `~/.claude`
folders, so pair both.**

1. In the web UI open **Machines → Pair a machine**. You get a code that is valid for 10 minutes and works once, plus the
   commands below with your host filled in.
2. On the machine, run the installer.

   Linux, WSL, macOS:

   ```bash
   curl -fsSL https://buildyboy.109-99-176-213.sslip.io/install.sh | bash -s -- PAIRCODE
   ```

   Windows (PowerShell):

   ```powershell
   $env:BB_CODE='PAIRCODE'; irm https://buildyboy.109-99-176-213.sslip.io/install.ps1 | iex
   ```

The installer downloads `/plugin.tgz` (a one-plugin marketplace) to `~/.buildyboy/marketplace`, pairs the machine and writes
`~/.buildyboy/config.json` (`{url, token, machineId}`), registers the plugin with
`claude plugin marketplace add ~/.buildyboy/marketplace` and `claude plugin install buildyboy@buildyboy`, and sends a test
event so the machine shows up right away. **Nothing edits `~/.claude/settings.json`.** Start a new Claude Code session and
it appears on the Floor. Check a machine any time with `/bb-status` inside Claude Code or `node cli/bb.ts doctor`.

Without the installer: `node cli/bb.ts pair https://<host> PAIRCODE` writes the config, then run the two `claude plugin`
commands yourself.

**Runner (start jobs from the phone).** The runner needs a checkout of this repo (`git clone … && npm ci`). Add `--runner`
(`$env:BB_RUNNER='1'` on Windows) and `BB_REPO=<checkout>` to the installer to register it as a user service (systemd
`--user` on Linux/WSL, a Scheduled Task at logon on Windows), or run it by hand with `node cli/bb.ts runner`. Its config,
`~/.buildyboy/runner.json`, lists the **allowed root directories**; jobs can only run inside them, and the server cannot
change that file:

```json
{ "allowedRoots": ["C:\\work", "/home/sysadm/apps"], "concurrency": 2 }
```

**Optional extras** (Settings page has copyable snippets): the OpenTelemetry env block for authoritative cost/token metrics
(`OTEL_EXPORTER_OTLP_ENDPOINT=https://<host>` with your machine token), and the statusline bridge
(`plugin/statusline/bb-statusline.mjs`, which adds context % and rate limits and passes your previous statusline through via
`BUILDYBOY_STATUSLINE_NEXT`). Neither is installed automatically.

**Removing a machine.** Run the installer with `--uninstall` (`$env:BB_UNINSTALL='1'`), then revoke the machine on the
Machines page.

## Go for a walk in 10 minutes

1. **Deploy** (2 min): in WSL, `deploy/deploy-wsl.sh --dry-run`, read it, then `deploy/deploy-wsl.sh`. Open the printed setup
   link on your phone, choose a password, and **Add to Home Screen** (it's a PWA).
2. **Turn on notifications** (1 min): on the phone, **Settings → Notifications → Enable on this device**, then **Send test
   notification**. On iOS, push only works from the installed home-screen app; set an ntfy topic as a fallback.
3. **Pair your machines** (3 min): **Machines → Pair a machine**, run the command on Windows, then again (new code) inside WSL.
4. **Check it** (1 min): start `claude` in a repo and type `/bb-status`. Within a second the session appears on the Floor. Try
   the Desktop app too: if its sessions don't show up live, they still arrive through `bb import`.
5. **Start the work** (2 min): kick off a session by hand, or open **Composer**, fill in the harness prompt (Goal, Done when,
   Limit…), fix the lint warnings, and **Launch** it on a machine with a budget.
6. **Walk mode on**: tap **Walk mode** in the Inbox (or type `/bb-walk on` in the session; `/bb-walk 5m` also makes Claude
   wait 5 minutes for your reply at the end of each turn). Now permission prompts, questions and plans come to your phone
   instead of waiting at the desk.
7. **Go for a walk.** The Attention bar says "1 waiting for you" when something needs you; tap it. Allow or deny with one
   thumb, answer questions, approve the plan, or reply to a finished turn ("run the tests", "commit and push"). From a session
   page you can queue a message for the next turn, pause it, or hit **Stop session**. Harness runs show their `PROGRESS.md`
   Done / Decisions / Next.
8. **Back at the desk**: turn walk mode off. With it off, the hooks are pure telemetry and never slow you down. Resume any
   session with the copy buttons (`claude --resume <id>`).

If the server is unreachable, nothing breaks: hooks print nothing and exit within a second, and events spool locally until
the server is back.

## Security notes

- The web UI uses one password (scrypt), an HttpOnly SameSite=Strict session cookie (Secure over HTTPS), CSRF tokens on
  every state-changing request, login rate limiting and an audit log.
- Machines use their own bearer tokens (stored hashed), get them through single-use pairing codes, and can only ingest and
  answer their own sessions' hooks. Rotate or revoke them on the Machines page.
- Secrets are masked before anything is stored (API keys, GitHub tokens, AWS keys, JWTs, `Bearer …`, `password=…`, and the
  content of `.env*` files read by Claude). Add your own rules in Settings.
- The server never runs Claude or shell commands. The runner only runs `claude` with a validated argument list inside its
  allowed roots, plus a job's Done-when verify commands after you confirm them in the UI.
