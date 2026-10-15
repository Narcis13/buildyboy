# The contzo.lol host

What the deploy scripts assume, and why. These facts were checked on 2026-10-15. Run
`scripts/host-probe.sh` for the live picture before trusting a detail that matters.

## Contents
- Machine and network
- WSL instance
- What already runs there
- Caddy
- DNS (Namecheap)
- Running commands from Windows
- Lessons from real deploys

## Machine and network

- A physical Windows 11 Pro PC with the static public IP **109.99.176.213** directly on its
  Ethernet adapter (no router NAT in front of it).
- **This PC cannot connect to its own public IP.** From Windows, `https://contzo.lol` and every
  subdomain time out, even though the sites work from everywhere else. The fix is a hosts-file
  line per name mapping it to `127.0.0.1`: requests then go through WSL's mirrored networking
  straight to Caddy, which serves the same site and certificate. `scripts/add-hosts-entry.ps1`
  does it (UAC prompt). WSL itself *can* reach the public IP, so checks run inside WSL are fine.
- Windows Firewall and the Hyper-V firewall are off; ports 80 and 443 are open to the internet
  (Let's Encrypt validates from outside without trouble).
- `.wslconfig`: `networkingMode=mirrored`, `firewall=true`, `vmIdleTimeout=-1` (the VM never idles
  out). WSL listeners on `0.0.0.0`/`*` are reachable on the PC's own addresses.
- WSL starts at boot through scheduled tasks (`WSL Ubuntu Autostart` on boot, plus logon tasks),
  so services come back after a Windows restart without anyone logging in.

## WSL instance

- Distro `Ubuntu` (26.04 LTS), WSL 2, systemd 259 (`/etc/wsl.conf`: `systemd=true`, default user
  `sysadm`).
- User **sysadm** (uid 1000), in the `sudo` group. **sudo asks for a password**: Claude cannot
  type it, so anything needing sudo runs in a Terminal tab the user types into.
- **Linger is on** for sysadm, so `systemctl --user` units start at boot and survive logout.
  That is why apps run as user units: deploys and restarts need no sudo at all.
- A bare `wsl.exe -e bash` has no `XDG_RUNTIME_DIR`; `systemctl --user` then fails with "Failed to
  connect to bus". The engine exports `XDG_RUNTIME_DIR=/run/user/1000` itself.
- Runtimes: Node 24 via nvm (`~/.nvm`, default 24), with pnpm and yarn in the nvm bin. Python 3.14
  with **no pip, no venv module, no uv**. No bun, deno, go, java, php, docker. Installing one is a
  real change on a shared host: ask first.
- Disk: ~950 GB free on `/`. 31 GB RAM.
- Journald keeps ~1.3 GB of logs; `journalctl --user -u <app>` reads an app's logs.

## What already runs there

| Site | App | How it runs | Port |
|---|---|---|---|
| contzo.lol (+ www redirect) | `~/apps/efacturi` (AdonisJS, the accounting app) | user units `efacturi`, `efacturi-scheduler`; layout current/previous/shared | 3333 |
| buildyboy.contzo.lol | `~/apps/buildyboy` (this repo) | **system** unit `buildyboy` (hardened, needs sudo to restart) | 7700 |

Both were set up by hand with their own scripts (`efacturi/infra/wsl-deploy.sh` over ssh,
`buildyboy/deploy/deploy-wsl.sh`). contzo-deploy never touches them: it refuses an `APP_NAME`
whose `~/apps/<name>` dir lacks its `.contzo-deploy` marker, and refuses a domain another Caddy file
already serves.

Shared services, loopback only:
- **PostgreSQL 18** on 127.0.0.1:5432. Password auth for TCP; admin work goes through
  `sudo -u postgres` (the engine's `--setup` does it). One role + one database per app.
- **Redis** on 127.0.0.1:6379, no password, shared by everything. Give each app its own key
  prefix or db index (`REDIS_DB=2`, etc.).
- **chrony**, **sshd** (port 22; Windows also forwards 2222 to it), **cron**, unattended upgrades.

Ports: 22, 53 (resolver), 2019 (Caddy admin), 3333, 5432, 6379, 7700 are taken. New apps get
**7710-7799**; the probe suggests the first free one.

## Caddy

- Caddy **2.6.2** from the Ubuntu repo, runs as user `caddy`, config `/etc/caddy/Caddyfile`,
  reload with `sudo systemctl reload caddy`. It obtains Let's Encrypt certificates on its own
  (HTTP-01 on port 80), within seconds once DNS points here.
- The main Caddyfile holds the `contzo.lol` and `www.contzo.lol` blocks and ends with
  `import /etc/caddy/sites/*.caddy`. Every other site is one file in `/etc/caddy/sites/`.
  Never edit the contzo blocks.
- 2.6-era syntax: `basicauth` (not `basic_auth`), `request_body { max_size 25MB }`.
- The `caddy` user cannot read `/home/sysadm` (mode 750). Static sites are therefore published to
  `/srv/contzo/<app>` (owned by sysadm, world-readable), not served from `~/apps`.
- Validation without sudo works if Caddy's state goes to a throwaway dir
  (`XDG_DATA_HOME`/`XDG_CONFIG_HOME`/`HOME` set to a temp dir); the engine does that.
- Server-sent events and long polls need `flush_interval -1` on `reverse_proxy` and no
  compression of `text/event-stream` (`SSE=1` in app.conf).

## DNS (Namecheap)

- `contzo.lol` is registered at Namecheap and uses **Namecheap BasicDNS**
  (`dns1.registrar-servers.com`, `dns2.registrar-servers.com`).
- Records today: `@` and `www` point to 109.99.176.213, plus `buildyboy`. **There is no wildcard**
  (`*`), so each new subdomain needs an A record. A one-time `*` A record to 109.99.176.213 would
  make every future subdomain resolve with no DNS step; suggest it, don't assume it.
- Adding a record: Domain List > contzo.lol > Manage > **Advanced DNS** > Add New Record >
  Type `A Record`, Host `<sub>`, Value `109.99.176.213`, TTL Automatic > **green checkmark**.
- **The Host field takes the label only.** Typing `edgy.contzo.lol` there creates
  `edgy.contzo.lol.contzo.lol`. This exact mistake happened once; `check-dns.ps1` detects it.
- Records go live on Namecheap's nameservers within a minute or two. Trust the authoritative
  answer (`check-dns.ps1` asks `dns1.registrar-servers.com` first).
- The ISP's resolver on this PC answers names that don't exist with `86.35.3.192`/`86.35.3.193`
  (an NXDOMAIN redirect). That is not your record; ignore it.
- Let's Encrypt limits failed validations (5 per hostname per hour), so add DNS **before**
  `--setup`, which is the moment Caddy asks for the certificate.

## Running commands from Windows

Claude usually runs in Windows (PowerShell + Git Bash tools). Reaching into WSL:

- Use the **PowerShell** tool for `wsl.exe`. Git Bash rewrites `/mnt/c/...` and `/home/...`
  arguments into Windows paths (MSYS path conversion) and breaks them.
- Never inline real bash in `wsl.exe -e bash -c '...'` from PowerShell 5.1: it strips embedded
  double quotes and the script silently does something else. Write the commands to a `.sh` file
  (the scratchpad works) and run `wsl.exe -d Ubuntu -e bash /mnt/c/.../file.sh`.
- Project commands: `wsl.exe -d Ubuntu --cd C:\path\to\project -e bash deploy/contzo/deploy.sh <opt>`.
  `--cd` accepts the Windows path.
- Windows paths map to `/mnt/c/...` inside WSL (`C:\newme\edgy` -> `/mnt/c/newme/edgy`).
- Anything that prompts (sudo) goes to a Terminal tab via `run_in_terminal` with that same
  `wsl.exe ... --cd ... -e bash ...` line. Poll it with `read_terminal`.
- A command that asks for a password in a non-interactive tool call hangs until timeout
  (`psql -U postgres` did this once). Use `psql -w`, `sudo -n`, or a terminal tab.

## Lessons from real deploys

- `git config --global core.autocrlf` is `true` on this PC: shell scripts checked out on Windows get
  CRLF and fail in bash (`$'\r': command not found`). Every project needs
  `*.sh text eol=lf` and `deploy/** text eol=lf` in `.gitattributes`. Files written by Claude's
  Write tool are LF already; the risk is git checkouts.
- Never copy a Windows `node_modules` into WSL: native modules are built for the wrong OS. The
  engine excludes it and installs inside WSL.
- `npm ci` with `NODE_ENV=production` skips devDependencies and the build fails; the engine
  unsets `NODE_ENV` for the build and only production runs get it.
- Apps must listen on `127.0.0.1:$PORT`. Binding `0.0.0.0` would publish the port to the internet
  past Caddy (the firewall is off).
