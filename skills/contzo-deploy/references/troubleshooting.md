# Troubleshooting

Symptom first, then the check, then the fix. Run checks inside WSL unless noted.

## The site times out in the browser on the Windows PC, works elsewhere
This PC cannot reach its own public IP. Check the hosts file:
`check-dns.ps1 -Name <sub>` (Windows) reports the hosts entry. Fix: `add-hosts-entry.ps1 -Name <sub>`
(UAC), then reopen the tab. Not a server problem: confirm with `deploy.sh --status` (`public 200`).

## `public` is not 200 in `--status`, `local` is
- `000`/no answer: Caddy has no site for the domain. `ls /etc/caddy/sites/`; run `--setup`.
- Certificate errors: Caddy has no certificate yet. `journalctl -u caddy -n 60 --no-pager | grep -i -E 'acme|error|<domain>'`.
  Usually DNS: `check-dns.ps1 -Name <sub>`. Once DNS is live Caddy retries on its own (backoff can
  reach minutes); `sudo systemctl reload caddy` retries right away. Don't loop reloads: Let's Encrypt
  allows 5 failed validations per hostname per hour.
- `502`: Caddy is up, the app isn't answering on 127.0.0.1:PORT. See the next section.
- `401` with `BASIC_AUTH_USER` set: expected.

## `local` is not 200, or the deploy rolled back
- `deploy.sh --logs` (or `journalctl --user -u <app> -n 80 --no-pager`).
- `systemctl --user status <app>`: `activating (auto-restart)` means it crashes on start.
- Typical causes: missing env var (add it to `~/apps/<app>/shared/.env`, then
  `systemctl --user restart <app>`); the app listens on another port or host (see stacks.md, "how
  does it pick its port"); `HEALTH_PATH` returns 404 (pick a route that exists); a build artifact
  is missing because the start command points at the wrong path (`ls ~/apps/<app>/current`).
- Run the start command by hand inside the release to see the error directly:
  `cd ~/apps/<app>/current && set -a && . ./.env && set +a && <command>`.

## "port N is taken by something else"
Another process listens there. `ss -ltnp 'sport = :N'` shows it if it's sysadm's; otherwise it's
a system service. Pick a new port with `host-probe.sh`, update `PORT` in app.conf, re-run
`--setup` (the Caddy site embeds the port), then deploy.

## "Failed to connect to bus" from systemctl --user
`XDG_RUNTIME_DIR` is unset; the engine sets it, but hand-run commands need
`export XDG_RUNTIME_DIR=/run/user/$(id -u)`. If `/run/user/1000` doesn't exist, the user manager
isn't running: check `loginctl show-user sysadm -p Linger` (must be `yes`).

## `$'\r': command not found` or `bad interpreter: /bin/bash^M`
CRLF line endings. Add to the project's `.gitattributes`:
```
*.sh text eol=lf
deploy/** text eol=lf
```
then `git add --renormalize . && git checkout -- .` (or re-save the files with LF).

## Commands from PowerShell do the wrong thing or hang
- `wsl.exe -e bash -c "..."` with nested quotes: PowerShell 5.1 strips the inner quotes. Put the
  commands in a `.sh` file and run `wsl.exe -d Ubuntu -e bash /mnt/c/.../file.sh`.
- Git Bash turns `/mnt/c/x` into `C:/Program Files/Git/mnt/c/x`: call `wsl.exe` from PowerShell.
- A hang with no output is usually a password prompt (sudo, psql). Kill it; run the command in a
  Terminal tab (`run_in_terminal`) where the user can type.

## `caddy validate` fails during --setup
The engine validates the site alone first, then the full config, and restores the previous site
file on failure. Read the printed error: usually a typo in `CADDY_EXTRA`, or a directive newer
than Caddy 2.6.2 (`basic_auth` -> `basicauth`).

## The build fails in WSL but works on Windows
- Native modules or postinstall scripts: they now build for Linux; read the error.
- Lockfile mismatch: `npm ci`/`--frozen-lockfile` refuses an out-of-date lockfile. Update the
  lockfile on the dev side and commit it.
- Missing build-time env: export it in `app_build` (stacks.md, static sites).
- Out-of-date `src/`: delete `~/apps/<app>/src/node_modules` and redeploy.

## Rolling back by hand
`deploy.sh --rollback` switches `current` to the previous release and restarts. Manual version:
`ln -sfn releases/<stamp> ~/apps/<app>/current && systemctl --user restart <app>`.
Database migrations are not rolled back.
