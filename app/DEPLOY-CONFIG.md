# Buranchi Compass — Deploy Config (cPanel)

**Status: LIVE** at https://wccn.co.id/compass (moved here from a subdomain on 2026-08-20 — see note below).

## Where it actually lives
- Host: cPanel account `ulhlmfei` on server 210.16.64.86 (wccn.co.id)
- App root: `/home/ulhlmfei/public_html/compass`
- Node app is registered under the **main domain, at URI `/compass`** — `PassengerBaseURI "/compass"` in `.htaccess`.
- Managed via cPanel's **Setup Node.js App** (CloudLinux NodeJS Selector). This cPanel install doesn't expose that feature over the UAPI token, so app create/version/restart/env-vars/npm-install are done via SSH using the `cloudlinux-selector` CLI (no root needed, runs as the account user).
- `compass.wccn.co.id` (a subdomain, docroot `public_html/compassapp`) was the *first* deploy target and is still DNS-registered but **unused and empty** — left alone rather than deleted. Safe to remove later if you want to tidy it up.

## Why a subpath needed real code changes
The app used absolute paths everywhere (`/style.css`, `fetch('/api/...')`, cached image URLs). Under a real subfolder like `/compass`, the browser resolves those against the domain root, not the subfolder — breaks CSS, API calls, everything. Fixed properly (not worked around):
- `server.js` reads `BASE_PATH` from env (`/compass` here, empty for local dev) and injects a `<base href>` tag + `window.APP_BASE` into `index.html`/`login.html` at request time.
- `static/app.js` / `static/login.js` prefix every `fetch()` and image URL through a `withBase()`/`mediaUrl()` helper reading `window.APP_BASE`.
- Local dev is unaffected — `BASE_PATH` unset defaults to `/`, everything behaves exactly as before.

**Second gotcha found during this move:** Passenger/CloudLinux auto-serves anything inside an app's `public/` folder directly as static files, completely bypassing Node — silently ignoring the `<base>`-tag injection (and the auth gate) for `index.html`/`login.html`. Fixed by renaming the static asset folder from `public/` to `static/` (both locally and deployed) so Passenger's auto-static convention no longer matches it, forcing every request through Express.

## Runtime
- Node 24.19.0 (`nodevenv/public_html/compass/24`)
- Startup file: `server.js`
- Port: Passenger injects `PORT` automatically — don't hardcode it.

## Environment variables
Set via `.htaccess` `SetEnv` (written by `cloudlinux-selector set --env-vars '{"...":"..."}'`):

| Key | Set? | Notes |
|---|---|---|
| `COMPASS_SECRET` | ✅ set | random 64-char hex, session cookie signing |
| `BASE_PATH` | ✅ `/compass` | makes the app mount correctly under the subfolder — see above |
| `GEMINI_API_KEY` | not needed | Buranchi org already carries its own key in `data/orgs.json` |

## Storage
Still flat JSON under `data/` (no SQL). The initial deploy copied the whole local `data/` folder over as a one-time seed; it has diverged from local since (real usage on both sides) and is **not** re-synced on code-only redeploys — only `server.js` + `static/` get pushed for a normal update.

## Access for future changes
- cPanel API token (scoped to Fileman/Mysql/Email/DomainInfo/SubDomain — **not** NodeJS/Application/Passenger/SSHKeys, those modules aren't installed on this server) — token stored only in chat session history, not saved to a file.
- SSH: key-based only (password auth intentionally never used). A deploy key was generated locally and authorized via cPanel → **Security → SSH Access → Manage SSH Keys**.
- To redeploy code only: tar `server.js` + `static/` (skip `data/`, `context/`, `node_modules/`), scp to the server, extract into `/home/ulhlmfei/public_html/compass` (don't touch `.htaccess`/`tmp/`/`data/`), then `cloudlinux-selector restart --interpreter nodejs --app-root /home/ulhlmfei/public_html/compass`.
- **Important:** after a code change to `index.html`/`login.html`/routing, a plain `restart` sometimes isn't enough if a stale `lsnode` worker survived a prior `destroy`/`create` cycle — verify with `ps aux | grep lsnode.*compass` and `kill -9` any leftover PID if the response doesn't reflect the new code (check for `Last-Modified`/`Accept-Ranges` headers on an HTML response — those mean something is serving it as a static file, not through Node).
- If `npm install` is ever needed again (new dependency added): `cloudlinux-selector install-modules --interpreter nodejs --app-root /home/ulhlmfei/public_html/compass`.

## Verified working live (2026-08-20, after the /compass move)
Login, posts data, all 4 Master Config files (bundled `context/` copies), Usage History, Chat AI Agent, Guardrails, Creative Intelligence, Agent Behavior, Competitor Analytics with real cached images actually rendering in-browser (confirmed `naturalWidth` on a loaded `<img>`), and the auth gate correctly blocking `app.js`/API access when logged out — all tested end-to-end against `https://wccn.co.id/compass`, not just localhost.
