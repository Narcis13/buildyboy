---
name: contzo-deploy
description: Deploy any project from this Windows PC to its own subdomain of contzo.lol (for example edgy.contzo.lol), hosted in the Ubuntu WSL instance on this machine next to the contzo accounting app and buildyboy. Generates the project's deploy/contzo/ scripts (a no-sudo deploy engine plus a tailored app.conf), picks a free port, sets up the Caddy site with HTTPS, Postgres and backups, walks the user through the Namecheap DNS record and the local hosts entry, then deploys and verifies. Use it whenever the user wants to deploy, host, publish, ship, put online, "make live" or get a URL for a project on their own server, WSL box or contzo.lol, and also to redeploy, roll back, check, or remove an app deployed this way, even if they don't name contzo.
---

# contzo-deploy

Ship a project to `https://<sub>.contzo.lol`, running inside the WSL instance on this PC.
The result is a `deploy/contzo/` folder in the project that the user (or you) can re-run
any time: `deploy.sh` redeploys with **no sudo**, and with rollback and health checks.

The host has real constraints (sudo needs the user's password, this PC can't reach its own
public IP, PowerShell mangles inline bash, CRLF breaks scripts). They are written down in
`references/host.md`; read it on first use in a session, because every step below leans on it.

## How the pieces fit

```
<project>/deploy/contzo/deploy.sh   copy of templates/deploy.sh, unchanged (the engine)
<project>/deploy/contzo/app.conf    written for this project from templates/app.conf
          |
          v  (runs inside WSL as sysadm)
~/apps/<app>/src -> releases/<stamp> <- current     user systemd units  <app>[-<proc>].service
~/apps/<app>/shared/.env (secrets, mode 600)        Caddy site  /etc/caddy/sites/<app>.caddy
```

- `--setup` (sudo, once per app): Caddy site + certificate, Postgres role/db, `/srv` dir for static.
- `deploy.sh` (no sudo, every release): sync, build in WSL, new release, restart, health check,
  automatic rollback if the new release doesn't answer.

Keep the engine identical to `templates/deploy.sh` in every project, so fixes travel and the
behaviour is predictable. Put everything project-specific in `app.conf` (settings and the
`app_build`/`app_release`/`app_env` hooks). Change the engine only for a real gap, and then
improve the template here too.

## Workflow

### 1. Pin down what and where

- **Project dir**: usually the current working directory (on Windows, e.g. `C:\newme\edgy`,
  which is `/mnt/c/newme/edgy` in WSL).
- **Subdomain**: what the user named; otherwise propose the folder name, lowercased, dashes only.
  `contzo.lol` itself and `buildyboy` are taken. Use the same value for `APP_NAME` unless it
  clashes with something in `~/apps`.
- If the project already has its own WSL deploy scripts (buildyboy has `deploy/deploy-wsl.sh`),
  use those instead and say so.

### 2. Survey the host (read-only, no sudo)

```powershell
wsl.exe -d Ubuntu -e bash /mnt/c/newme/buildyboy/skills/contzo-deploy/scripts/host-probe.sh <sub>
```
It lists Caddy sites and their ports, apps in `~/apps`, listening ports, runtimes, and suggests a
free port in 7710-7799. Stop and ask if the subdomain is taken.

### 3. Read the project and choose the recipe

Work out, from package.json scripts, framework config, entry files and README:
- static files (`KIND=static`) or a running server (`KIND=service`);
- build command, start command, and **how the server picks host and port**. It must listen on
  `127.0.0.1:$PORT`. A hardcoded port, or `listen(port)` with no host (which binds every
  interface, the common case), needs a small change: read `PORT` and `HOST` from the env, with
  `127.0.0.1` as the fallback host;
- a health route: use an existing cheap one (`/health`, `/api/health`). `/` is fine when it
  answers 200 without auth, redirects or heavy work; otherwise add a one-line `/health`;
- **state on disk** (SQLite files, uploads, generated files): each such dir goes in
  `SHARED_DIRS`, and the app must reach it by a path relative to its working dir (the release),
  not `__dirname` tricks into the source tree or absolute paths;
- extra processes (workers, schedulers), database, upload size limits, SSE, build-time env.

`references/stacks.md` has recipes for static/SPA, Node servers, Next.js, Nuxt, SvelteKit,
Remix, Astro, AdonisJS, monorepos and Python, plus Postgres/SQLite/uploads/workers. Read the
section that matches. Python needs uv or python3-venv installed first: ask the user.

If the app needs a code change to run in production (hardcoded port, no health route, binds
`0.0.0.0`), make the smallest change and mention it.

### 4. Generate the deploy files

1. Copy `templates/deploy.sh` byte for byte to `<project>/deploy/contzo/deploy.sh`.
2. Write `<project>/deploy/contzo/app.conf` from `templates/app.conf`: fill the placeholders, keep
   the comments that help, delete the static or service block that doesn't apply.
   Seed non-secret env and generated secrets in `app_env` (it runs once, on the host, so generated
   values never reach git).
3. Make sure `.gitattributes` has `*.sh text eol=lf` and `deploy/** text eol=lf` (`core.autocrlf`
   is true on this PC; CRLF breaks bash). Create or extend it.
4. Make sure `.gitignore` covers `node_modules/`, `.env`, `.env.*` (with `!.env.example`) and the
   dev copies of `SHARED_DIRS` (e.g. `/data/`, `/uploads/`). Create it if missing. Nothing secret
   goes into app.conf.

### 5. Dry run (no sudo, changes nothing)

```powershell
wsl.exe -d Ubuntu --cd <project dir> -e bash deploy/contzo/deploy.sh --dry-run
wsl.exe -d Ubuntu --cd <project dir> -e bash deploy/contzo/deploy.sh --setup --dry-run
```
Read the output: preflight warnings (port, lockfile, CRLF), sync excludes, the build commands,
units, and the Caddy site, which `--setup --dry-run` validates against the full live config.
Fix app.conf until it is right.

### 6. DNS

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File <skill dir>\scripts\check-dns.ps1 -Name <sub>
```
If it's not live (and there is no `*.contzo.lol` wildcard), give the user these Namecheap steps
and wait for them:
Domain List > contzo.lol > Manage > Advanced DNS > Add New Record > **A Record**, Host **`<sub>`**
(the label only, not the full name), Value **109.99.176.213**, TTL Automatic > green checkmark.
Re-run the check until the authoritative servers answer. DNS must be live before `--setup`,
because that's when Caddy requests the certificate. Mention once, as an option, that a wildcard
`*` A record would skip this step for every future subdomain.

### 7. Setup (sudo, once): in a Terminal tab

sudo needs the user's password, which you can't type. Run it with `run_in_terminal` and tell the
user to type their WSL password in that tab:
```
wsl.exe -d Ubuntu --cd <project dir> -e bash deploy/contzo/deploy.sh --setup
```
Watch it with `read_terminal`. It validates the Caddy config and restores the previous state on
any failure. For Postgres apps it also writes the DB credentials into `shared/.env`.

### 8. Deploy (no sudo)

```powershell
wsl.exe -d Ubuntu --cd <project dir> -e bash deploy/contzo/deploy.sh
```
First builds can take minutes; give the tool call a long timeout or run it in the background.
If the app needs secrets that `app_env` couldn't generate (API keys and the like), tell the user
the exact keys to add in `~/apps/<app>/shared/.env`, then restart with
`systemctl --user restart <app>` (no sudo). Never ask for secret values in chat.

### 9. Local access on this PC

Browsers on this PC time out on contzo.lol names unless the hosts file maps them to 127.0.0.1.
Ask before changing it, then run (it raises a UAC prompt for the user):
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File <skill dir>\scripts\add-hosts-entry.ps1 -Name <sub>
```

### 10. Verify and report

`deploy.sh --status` shows units, release, local health and public health through Caddy with
the real certificate. You can't test from outside this network yourself: your fetch tools fail
against this host, so don't read their errors as outages. Ask the user to open the URL on a phone
on mobile data for the real outside check. Report: the URL, what was generated (including any
code changes), where the env file is, what `BACKUP` covers (the database only: `SHARED_DIRS`
such as uploads persist across deploys but are not backed up), and the day-to-day commands:

| Task | Command (from the project dir, via `wsl.exe -d Ubuntu --cd <dir> -e bash ...`) |
|---|---|
| Redeploy | `deploy/contzo/deploy.sh` |
| Status / logs | `deploy/contzo/deploy.sh --status` / `--logs` |
| Roll back | `deploy/contzo/deploy.sh --rollback` |
| Remove | `deploy/contzo/deploy.sh --uninstall` (terminal tab: sudo) |

Committing the generated files is the user's call; offer it.

## Redeploys and other requests

- "Redeploy / update edgy": just step 8. It needs no sudo, so you can run it yourself.
- Changed `PORT`, `SUBDOMAIN`, `KIND`, `MAX_BODY`, `SSE`, basic auth or `CADDY_EXTRA`: re-run
  `--setup` (terminal tab) so the Caddy site matches, then deploy.
- "It's down / broken": `--status`, then `--logs`, then `references/troubleshooting.md`.
- Removing an app: `--uninstall` in a terminal tab, then remind the user about the DNS record and
  the hosts line (`add-hosts-entry.ps1 -Name <sub> -Remove`).

## Boundaries

- Never modify efacturi (contzo.lol) or buildyboy, their units, or the contzo blocks in the main
  Caddyfile. The engine refuses to touch them, but don't work around that.
- Treat it as production: dry-run before real runs, and ask before installing system packages,
  editing the hosts file, or deleting `~/apps/<app>` or a database.
- Keep secrets out of git, chat, and app.conf.

## Files in this skill

- `templates/deploy.sh`: the engine (`--help` lists every mode). `templates/app.conf`: annotated config.
- `scripts/host-probe.sh`: read-only host survey and free-port suggestion (WSL).
- `scripts/check-dns.ps1`: authoritative and public DNS check, wildcard and Host-field mistake detection (Windows).
- `scripts/add-hosts-entry.ps1`: hosts-file mapping for this PC, `-Remove` to undo (Windows, UAC).
- `references/host.md`: the host, network, Caddy, DNS, and lessons from real deploys.
- `references/stacks.md`: app.conf recipes per framework and for databases, uploads and workers.
- `references/troubleshooting.md`: symptom, then check, then fix.

The skill dir is usually `C:\Users\User1\.claude\skills\contzo-deploy` (a link into the buildyboy
repo, `C:\newme\buildyboy\skills\contzo-deploy`); in WSL use
`/mnt/c/newme/buildyboy/skills/contzo-deploy`.
