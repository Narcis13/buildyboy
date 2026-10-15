# Stack recipes for app.conf

How common project types map onto `KIND`, `PROCESSES`, `HEALTH_PATH` and the hooks. Read the
project's own `package.json` scripts, framework config and README before choosing: they win over
these defaults. Every recipe assumes the engine's environment: `PORT`, `HOST=127.0.0.1`,
`NODE_ENV=production`, plus everything in `shared/.env`.

The key question for any server: **how does it pick its host and port?** Find where it listens
(`listen(`, `serve(`, framework docs). If it reads `PORT`/`HOST`, nothing to do. If it hardcodes
them, either pass flags in the `PROCESSES` command or make a small code change (read
`process.env.PORT`), and tell the user about that change.

## Contents
- Static sites and SPAs
- Node servers (Express, Hono, Fastify, Koa, plain http)
- Full-stack frameworks (Next.js, Nuxt, SvelteKit, Remix/React Router, Astro SSR, AdonisJS)
- Vite SPA + API server in one repo
- Monorepos
- Python (FastAPI, Flask, Django)
- Databases, uploads, workers
- What not to do

## Static sites and SPAs

Vite/React/Vue/Svelte SPAs, Astro static, Eleventy, plain HTML: no process, Caddy serves files.

```bash
KIND="static"
STATIC_DIR="dist"     # Vite, Astro: dist | CRA: build | Eleventy: _site | plain HTML folder: its path
SPA=1                 # 0 for multi-page sites (Astro static, Eleventy), so 404s stay 404s
```
Default `app_build` (install + `build` script) is right for most. Plain HTML with no package.json:
the build does nothing and `STATIC_DIR` points at the folder holding `index.html`
(`STATIC_DIR="."` publishes the whole repo, so prefer a `public/` or `site/` folder).

Build-time env (`VITE_API_URL=...`) is baked into the bundle. Export it in the hook:
```bash
app_build() { export VITE_API_URL="https://api-edgy.contzo.lol"; node_build; }
```

## Node servers

```bash
KIND="service"
PROCESSES=("web|node src/server.js")            # or: "web|npm run start"
HEALTH_PATH="/health"
```
- `app.listen(3000)` or `server.listen(port)` with no host listens on **every interface**
  (`::`), which would publish the port past Caddy. Change it to read the env, keeping dev usable:
  ```js
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '127.0.0.1';
  app.listen(port, host);
  ```
- TypeScript compiled by `tsc`: `"web|node dist/server.js"` after the default build.
- TypeScript run directly on Node 24 (`node --experimental-strip-types` or plain `node file.ts`
  when the project already does that, like buildyboy): use the same command the project's
  `start` script uses.
- `tsx`/`ts-node` in production pulls devDependencies: fine, but then don't `node_prune`.
- Prefer `node <entry>` over `npm start` when easy: one less process between systemd and the app,
  and signals reach the app directly.

## Full-stack frameworks

**Next.js**
```bash
PROCESSES=("web|node_modules/.bin/next start -p \$PORT -H 127.0.0.1")
```
With `output: 'standalone'` in next.config: `"web|node .next/standalone/server.js"` (reads `PORT`
and `HOSTNAME`; set `HOSTNAME=127.0.0.1` via `app_env`), and copy assets in `app_release`:
`cp -r .next/static .next/standalone/.next/ && cp -r public .next/standalone/ 2>/dev/null || true`.

**Nuxt / Nitro**: `"web|node .output/server/index.mjs"` (reads `PORT`/`HOST`, or `NITRO_PORT`/`NITRO_HOST`).

**SvelteKit (adapter-node)**: `"web|node build"` (reads `PORT`/`HOST`). Set `ORIGIN=https://<domain>`
in `app_env`, or form actions fail CSRF checks behind the proxy.

**Remix / React Router v7**: `"web|node_modules/.bin/react-router-serve ./build/server/index.js"`
(reads `PORT`; `HOST` too in recent versions).

**Astro SSR (@astrojs/node, standalone)**: `"web|node dist/server/entry.mjs"` (reads `PORT`/`HOST`).
Astro without an adapter is static: use the static recipe.

**AdonisJS 6** (same shape as efacturi on this host):
```bash
PROCESSES=("web|node bin/server.js")            # run from the build/ output, see below
HEALTH_PATH="/"                                  # or the app's health route
app_build() { node_install; node ace build; }
app_release() {
  # the release is a copy of src/, but Adonis runs from build/. Install prod deps there.
  cd build && cp ../.env . 2>/dev/null || true
  case "$(cd .. && pm)" in pnpm) cp ../pnpm-workspace.yaml . 2>/dev/null || true; pnpm install --prod --frozen-lockfile ;; *) npm ci --omit=dev ;; esac
  load_env && node ace migration:run --force
}
```
and make the command `"web|cd build && exec node bin/server.js"`. Add the scheduler or queue
worker as a second process (`"scheduler|cd build && exec node ace scheduler:run"`). Seed `APP_KEY`
with `app_env` (`echo "APP_KEY=$(openssl rand -hex 32)"`), and set `HOST=127.0.0.1`, `PORT`,
`APP_URL=https://<domain>`, `SESSION_DRIVER=cookie`.

## Vite SPA + API server in one repo

Preferred: one service where the API also serves the built SPA (most frameworks have a static
middleware), so one domain, one port, no CORS.

Two apps from one repo also work: the engine treats the directory two levels up from the script
as the project, so `deploy/contzo/` (the API, `KIND=service`) and `deploy/contzo-web/` (the SPA,
`KIND=static`, its own `APP_NAME` and `SUBDOMAIN`) each get a copy of `deploy.sh` and their own
`app.conf`. Ask the user which shape they want before splitting.

## Monorepos

The engine syncs the whole repo and builds at the root. Point the hooks at the package:
```bash
app_build() { node_install; pnpm --filter web build; }
PROCESSES=("web|node apps/web/dist/server.js")
```
For static output inside a package: `STATIC_DIR="apps/web/dist"`.

## Python

The host has Python 3.14 but **no venv module, pip or uv**. Ask the user before installing one:
- `uv` (no sudo, recommended): `curl -LsSf https://astral.sh/uv/install.sh | sh` in WSL
  (installs to `~/.local/bin`, which the launchers already have on PATH).
- or the venv module: `sudo apt install python3-venv`.

With uv:
```bash
app_build() { uv sync --frozen --no-dev; }        # pyproject.toml + uv.lock
# requirements.txt only: uv venv && uv pip install -r requirements.txt
```
Processes (the `.venv` is inside the release because the release is a copy of src/):
- FastAPI: `"web|.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port \$PORT --proxy-headers"`
- Flask: `"web|.venv/bin/gunicorn -b 127.0.0.1:\$PORT 'app:create_app()'"`
- Django: `"web|.venv/bin/gunicorn -b 127.0.0.1:\$PORT project.wsgi"`, with
  `app_release() { load_env; .venv/bin/python manage.py migrate --noinput; .venv/bin/python manage.py collectstatic --noinput; }`,
  `ALLOWED_HOSTS`/`CSRF_TRUSTED_ORIGINS` for the domain, and `SECURE_PROXY_SSL_HEADER`.

Note the escaped `\$PORT` inside double quotes in app.conf: it must reach the launcher literally
and expand at run time. Single quotes work too: `'web|uvicorn ... --port $PORT'`.

## Databases, uploads, workers

- **Postgres**: `DATABASE="postgres"` (+ `BACKUP="postgres"`). `--setup` creates the role and
  database and writes `DB_HOST DB_PORT DB_USER DB_PASSWORD DB_DATABASE DATABASE_URL` into
  `shared/.env`. If the app wants other variable names, map them in `app_env` or tell the user.
  Run migrations in `app_release` after `load_env`, never as part of the start command (a restart
  loop must not race the schema).
- **SQLite**: keep the file outside releases: `SHARED_DIRS=("data")` and point the app at
  `data/app.db` (the release's `data` is a symlink into `shared/`). `BACKUP="sqlite:data/app.db"`.
  This works because processes run with the release as working dir; an app that builds paths
  from `__dirname`/`import.meta.url` into a nested folder needs the shared dir at that nested
  path (`SHARED_DIRS=("server/data")` works too) or an env var for the path.
- **Uploads / generated files**: add their dir to `SHARED_DIRS`. The engine never syncs
  `SHARED_DIRS` from the dev machine, so local test data stays local. Uploads are not in
  `BACKUP`; say so to the user.
- **Upload size**: `MAX_BODY` in Caddy must sit above the app's own limit plus multipart
  overhead, or Caddy answers 413 first. Units matter: Caddy reads `50MB` as 50,000,000 bytes and
  `50MiB` as 52,428,800; JS limits like `50 * 1024 * 1024` are MiB. multer at 50 MiB ->
  `MAX_BODY="60MiB"`. Empty `MAX_BODY` means no cap in Caddy.
- **Redis**: shared instance at 127.0.0.1:6379; pick a db index (`REDIS_DB`) or key prefix.
- **Workers / schedulers / queues**: extra `PROCESSES` entries; each becomes `<app>-<name>.service`
  and restarts with every deploy.
- **WebSockets** pass through Caddy's `reverse_proxy` with no extra config. **SSE**: `SSE=1`.

## Lockfiles

Without a lockfile the default build falls back to `npm install` and resolves versions afresh on
every deploy (the engine warns). Suggest committing one; with the user's OK, run `npm install` on
the dev side to create `package-lock.json`.

## What not to do

- Don't run dev servers in production (`vite`, `next dev`, `nodemon`, `npm run dev`).
- Don't bind `0.0.0.0`: the port would be public past Caddy (the host firewall is off).
- Don't use Docker: it isn't installed, and plain units are what the rest of the host uses.
- Don't commit `.env` values into app.conf; seed placeholders with `app_env` and let the user
  fill real secrets in `~/apps/<app>/shared/.env`.
