## Deploying to WSL

Buildyboy runs as a systemd service inside WSL (Ubuntu, user `sysadm`, Node 24 from nvm), behind the Caddy that is already running there. Caddy keeps serving `contzo.lol` exactly as before; Buildyboy gets its own site block.

What you need first: systemd on in WSL, Node 24 under nvm (`nvm install 24`), `rsync`, `curl` and Caddy installed, and `sudo` for the system steps (it asks for your password).

```bash
# inside WSL, from a checkout of the repo (for example /mnt/c/newme/buildyboy)
deploy/deploy-wsl.sh --dry-run     # prints every action, changes nothing, needs no sudo
deploy/deploy-wsl.sh               # the real thing
```

The script is idempotent: run it again to redeploy. It prints every command before it runs it, and does the following.

1. **Preflight.** Checks Node 24 via `~/.nvm/nvm.sh`, that port 7700 is free (or held by the running service), that Caddy is installed, and that the existing `/etc/caddy/Caddyfile` validates.
2. **Install.** Copies the app (without `node_modules`, `data`, `.git`, `web/dist`, `test-results`) to `~/apps/buildyboy`, then runs `npm ci`, `npm run build` and `npm prune --omit=dev`. The data directory is `~/.local/share/buildyboy` (database, VAPID keys, `backups/`).
3. **Service.** Installs `/etc/systemd/system/buildyboy.service`: user `sysadm`, the absolute nvm `node` path, `Restart=always`, listening on `127.0.0.1:7700`, `NODE_ENV=production`, plus `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome=read-only`, `PrivateTmp` and `ReadWritePaths=<data dir>`. Then `systemctl enable --now buildyboy`.
4. **Caddy.** Writes `/etc/caddy/sites/buildyboy.caddy` (reverse proxy to `127.0.0.1:7700`, response buffering off so SSE works) and appends `import /etc/caddy/sites/*.caddy` to the end of the main Caddyfile only if it is missing, after a timestamped backup (`Caddyfile.bak.buildyboy-<date>`). It then validates the config and reloads Caddy. If validation or the reload fails, the backup and the previous site file are restored automatically. The existing `contzo.lol` blocks are never edited or reordered.
5. **Backups.** `buildyboy-backup.timer` runs `deploy/backup.sh` nightly at about 03:30 (an online SQLite backup into `<data dir>/backups`, newest 14 kept). Run it by hand any time with `deploy/backup.sh`.
6. **Finish.** Waits up to 60 s for `https://$DOMAIN/api/health` to return 200 and prints the one-time setup link (the server logs `Open <url>/setup?token=...` on first run). If you miss it: `journalctl -u buildyboy | grep setup`, or set the password from the shell with `cd ~/apps/buildyboy && BUILDYBOY_DATA=~/.local/share/buildyboy node cli/bb.ts set-password`.

Settings (environment variables for the script): `DOMAIN` (default `buildyboy.109-99-176-213.sslip.io`), `BB_PORT` (7700), `BB_APP_DIR`, `BB_DATA_DIR`.

### DNS and the public host

The default host `buildyboy.109-99-176-213.sslip.io` works today: sslip.io resolves any name of that form to the IP inside it, here the machine's public IP `109.99.176.213`, so Caddy can get a Let's Encrypt certificate for it without any DNS work.

To use a `contzo.lol` subdomain instead, you have to create the DNS record yourself: `*.contzo.lol` does not point at this machine today (it resolves elsewhere). Add an A record, for example `buildyboy.contzo.lol` to `109.99.176.213`, wait for it to propagate, then redeploy with `DOMAIN=buildyboy.contzo.lol deploy/deploy-wsl.sh`. Ports 80 and 443 must reach the machine for certificate issuance.

### Updating

```bash
deploy/update.sh --dry-run
deploy/update.sh                   # git pull --ff-only, back up the DB, build in ~/apps/buildyboy.next, swap, restart
```

The new release is built next to the running one. After the swap and restart the script waits for `/api/health`; if it does not come back healthy, the previous release (kept as `~/apps/buildyboy.prev`) is put back and restarted. Database migrations run automatically when the server starts and are forward-only, so a rollback restores the old code, not the old schema; the pre-update backup in `<data dir>/backups` covers that case. Use `--from DIR` to deploy from a different source tree and `--no-pull` to skip `git pull`.

### Uninstalling

```bash
deploy/deploy-wsl.sh --uninstall
```

Stops and removes the service, the backup timer and `/etc/caddy/sites/buildyboy.caddy`, then reloads Caddy. It deliberately leaves the `import` line in the Caddyfile (harmless without site files), the data directory `~/.local/share/buildyboy` and the app directory `~/apps/buildyboy`; delete those by hand if you want everything gone.

## Pairing a machine (Windows and WSL)

Every machine that runs Claude Code needs the Buildyboy plugin and a token of its own. Windows and WSL have **separate** `~/.claude` folders, so install on both.

1. In the web UI open **Machines** and create a pairing code. A code is valid for 10 minutes and works once.
2. On the machine, run the installer. Linux, WSL and macOS:

   ```bash
   curl -fsSL https://buildyboy.109-99-176-213.sslip.io/install.sh | bash -s -- PAIRCODE
   ```

   Windows (PowerShell):

   ```powershell
   $env:BB_CODE='PAIRCODE'; irm https://buildyboy.109-99-176-213.sslip.io/install.ps1 | iex
   ```

   (Use your own host if you changed `DOMAIN`.)

The installer:

- downloads `/plugin.tgz` (a one-plugin marketplace) and unpacks it to `~/.buildyboy/marketplace`;
- pairs the machine and writes `~/.buildyboy/config.json` with the server URL, the machine token and the machine id (mode 600 on Linux);
- registers the plugin with `claude plugin marketplace add ~/.buildyboy/marketplace` and `claude plugin install buildyboy@buildyboy`. It never edits `~/.claude/settings.json` itself. If `claude` is not on the PATH it says so and prints the two commands to run later;
- sends a test event, so the machine appears on the Machines page right away.

Start a new Claude Code session afterwards and it shows up on the Floor. Re-running the installer without a code refreshes the plugin and keeps the existing pairing.

Optional switches: `--name NAME` / `$env:BB_NAME` sets the machine name (otherwise the name given with the pairing code, or the hostname).

### Running jobs from the phone (the runner)

The runner (`bb runner`) needs the app code, so the installer only registers it when `BB_REPO` points at a checkout of the repo (`git clone https://github.com/Narcis13/buildyboy`, then `npm ci` inside it):

```bash
curl -fsSL https://HOST/install.sh | BB_REPO=$HOME/buildyboy bash -s -- --runner     # already paired: no code needed
```

```powershell
$env:BB_RUNNER='1'; $env:BB_REPO="$HOME\buildyboy"; irm https://HOST/install.ps1 | iex
```

On Linux and WSL this creates the systemd user service `buildyboy-runner` (run `loginctl enable-linger $USER` to keep it up when you are logged out). On Windows it creates a Scheduled Task `BuildyboyRunner` that starts at logon (falling back to a Startup-folder entry if the task cannot be created without elevation).

### Removing a machine

```bash
curl -fsSL https://HOST/install.sh | bash -s -- --uninstall      # asks before deleting ~/.buildyboy (add --yes to skip)
```

```powershell
$env:BB_UNINSTALL='1'; irm https://HOST/install.ps1 | iex
```

This runs `claude plugin uninstall buildyboy@buildyboy` and `claude plugin marketplace remove buildyboy`, removes the runner service or task, and then deletes `~/.buildyboy` after confirmation. Also revoke the machine on the Machines page so its token stops working.
