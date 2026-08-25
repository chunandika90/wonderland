# Buranchi Compass — Handoff / Continuity Doc

Written so work can pick up cleanly on a different machine. Read this before touching anything.

## 1. What this is

**Buranchi Compass** is a local-first content-planning web app for Buranchi café (Alam Sutera). It's an organizer/exporter, not a generator by itself — plans get written either by pasting a Claude-chat-drafted plan, by calling Gemini directly, or via **Creative Chat**, a conversational interface backed by a 3-agent Market→Brand→Judge pipeline (see §5). Multi-tenant: other orgs can be added, but Buranchi is the only real one in use.

No database — everything is flat JSON under `data/`.

## 2. Run it locally

```bash
cd "Marketing/_Projects/Buranchi Compass/app"
npm install        # only needed once, or after a dependency changes
node server.js      # or: npm start
```

Opens on **http://localhost:4200**. `start-compass.bat` / `start-compass-silent.vbs` do the same thing for double-click launch on Windows.

**Login:** org code `buranchi`, username `buranchi`, password `compass2026`.

Static assets live in `static/` (⚠ **not** `public/` — see §6.2 for why that matters).

## 3. It's also live

**https://wccn.co.id/compass** — same login as above. Deployed to a cPanel account the user owns (details in §4). Local and live are **not auto-synced** — every code change has to be manually pushed (see §4.4). As of this doc, local and live are in sync.

## 4. cPanel / server access

- Host: cPanel account `ulhlmfei`, server `210.16.64.86` (domain `wccn.co.id`)
- App root on server: `/home/ulhlmfei/public_html/compass`
- Managed via CloudLinux's Node.js Selector (`cloudlinux-selector` CLI over SSH — this cPanel install doesn't expose Node app management over the API token, only over SSH)

### 4.1 cPanel API token
Used for read-only-ish account operations (Fileman, Mysql, Email, DomainInfo, SubDomain — **not** NodeJS/Application/Passenger/SSHKeys, those modules aren't installed on this server). The token was generated and shared once in chat; it is **not saved anywhere in this repo**. If you need it again: cPanel → Security → Manage API Tokens → generate a new one (the old one, if still listed, can be reused or revoked).

Password-based login to cPanel/SSH was deliberately never used in this project — only the API token and the SSH key below. Keep it that way.

### 4.2 SSH access (for actual deploys)
Key-based only, no password. The keypair is in **`deploy-keys/`** right next to this file — see `deploy-keys/README.md`. It's already authorized on the server (cPanel → Security → SSH Access → Manage SSH Keys, on the `ulhlmfei` account).

Connect:
```bash
ssh -i deploy-keys/compass_deploy ulhlmfei@210.16.64.86
```

### 4.3 Env vars set on the live app
Set via `.htaccess` `SetEnv` (there's a `cloudlinux-selector set --env-vars '{...}'` command for this — see §4.4):

| Key | Value | Why |
|---|---|---|
| `COMPASS_SECRET` | random 64-hex | session cookie signing |
| `BASE_PATH` | `/compass` | see §6.1 — without this the app breaks under the subpath |

### 4.4 How to redeploy a code change
Only `server.js` and `static/` need to move for a normal code change (not `data/`, not `node_modules/`, not `context/` unless the brand `.md` files changed):

```bash
# from the app/ folder locally
mkdir -p /tmp/deploy-stage && cp server.js /tmp/deploy-stage/ && cp -r static /tmp/deploy-stage/
tar -czf /tmp/deploy.tar.gz -C /tmp/deploy-stage .
scp -i deploy-keys/compass_deploy /tmp/deploy.tar.gz ulhlmfei@210.16.64.86:/home/ulhlmfei/deploy.tar.gz

ssh -i deploy-keys/compass_deploy ulhlmfei@210.16.64.86 "
  cd /home/ulhlmfei/public_html/compass &&
  tar -xzf /home/ulhlmfei/deploy.tar.gz &&
  rm /home/ulhlmfei/deploy.tar.gz &&
  /usr/sbin/cloudlinux-selector restart --interpreter nodejs --json --app-root /home/ulhlmfei/public_html/compass
"
```

**After restarting, always verify with a real curl/browser check** — `cloudlinux-selector restart` reporting `"result":"success"` doesn't always mean the change actually took effect (see the stale-worker gotcha in §6.3). If a change to `index.html`/`login.html`/routing doesn't seem to show up:
```bash
ssh -i deploy-keys/compass_deploy ulhlmfei@210.16.64.86 "ps aux | grep 'lsnode.*public_html/compass/' | grep -v grep | awk '{print \$2}' | xargs -r kill -9"
```
then re-test — Passenger will spawn a fresh worker on the next request.

If a new npm dependency was added, run once after uploading `package.json`:
```bash
ssh -i deploy-keys/compass_deploy ulhlmfei@210.16.64.86 "/usr/sbin/cloudlinux-selector install-modules --interpreter nodejs --json --app-root /home/ulhlmfei/public_html/compass"
```

### 4.5 Loose end
`compass.wccn.co.id` (a subdomain) was the *first* deploy target before moving to `/compass`. It's still DNS-registered but empty/unused (docroot `public_html/compassapp`, now empty). Left alone rather than deleted — safe to clean up whenever, not urgent.

## 5. What was built this session (feature map)

| Feature | Where | Notes |
|---|---|---|
| Multi-tenant org login | `server.js` (`orgs.json`), `scripts/create-org.js` | Buranchi's config points at the real `Marketing/_context/*.md` files directly (`useSharedConfig: true`), not a copy |
| Competitor analytics dashboard | `/api/analytics`, Apify scrape pipeline, cached images at `data/orgs/<slug>/analytics-images/` | Rescrape button + daily cron; images cached locally because Instagram's signed URLs expire |
| Generate a plan (3 tabs) | `#generate` page | Gemini (direct), Claude (paste from chat), Manual |
| Chat AI Agent | `#chatagent`, `/api/chat/*` | Multi-turn, multiple saved conversations, proposes posts but requires explicit "Add to plan" click before anything is written |
| Guardrails | `#guardrails`, `/api/chat/guardrails` | Max-posts cap + freeform rule list, applies to both the Gemini tab and Chat AI Agent |
| Usage History | `#history` | Every generation across all agents, with token cost |
| **Creative Chat** | `#creativechat`, `/api/creative-chat/*` | Conversational front-end for the 3-agent pipeline, with an auto-routing guard (see §5.1) |
| **Agent Behavior** | `#agentbehavior`, `/api/intelligence/agent-behavior` | Per-agent editable "additional conditions" on top of the hardcoded defaults — still used by Creative Chat's pipeline |
| Sidebar collapse/scroll | `static/index.html`, `static/app.js` | Groups collapse independently (localStorage-persisted), auto-expand on navigation |

### 5.1 Creative Chat — how it actually works
Loosely based on `SAKARA_CREATIVE_INTELLIGENCE_ENGINE_SPEC.md`/`.pdf` (one level up, in `Marketing/Buranchi/`) — that doc was written for a different project ("Sakara") but the concept got applied here since this is the app with the AI agent infrastructure. Three sequential Gemini calls per full analysis, **not** two different LLM vendors (user chose this explicitly — cheaper, no new API key needed):

1. **Market & Visual Intelligence** persona — reads competitor data + this org's own post history, proposes market-driven opportunities.
2. **Brand & Creative Strategy** persona — reads brand rules, is shown the Market proposal, explicitly reacts to it (can reject parts of it).
3. **Creative Judge** — synthesizes both into a final content calendar + creative briefs + evidence/assumptions/confidence.

There was originally a separate standalone "Creative Intelligence" one-shot page (`#intelligence`, `/api/intelligence/generate` + `/sessions*`) — **it was removed** once Creative Chat fully replaced its purpose. Don't re-add `/api/intelligence/generate`/`/sessions` routes; the pipeline now lives in the shared helper `runCreativeIntelligencePipeline()` in `server.js`, called from Creative Chat's `/message` endpoint.

**The auto-routing guard** is the important design point: a single `Send` button posts to `/api/creative-chat/conversations/:id/message`, which makes ONE Gemini call (`buildCreativeChatRouterInstruction`) that decides `needsFullAnalysis: true/false` for that message. If true, the server runs the 3-agent pipeline internally and appends an `intelligence-result` turn; if false, it just answers conversationally (same behavior as Chat AI Agent). This means asking "kenapa lo pilih itu?" after a result costs one cheap call, not a full re-run — that was the whole point (user explicitly didn't want "double kerja").

"Directory A" (historical memory) is currently thin — it only reads this app's own `posts.json`, not a real external creative archive. If the user provides a folder of Buranchi's actual past campaign assets, that should get wired into `buildHistoricalMemory()` in `server.js`.

Every turn (chat or intelligence-result) stores its own `tokenUsage` inline in the conversation JSON — the UI shows a per-message token caption plus a running session-total in the toolbar (`ccSessionTotals()` in `app.js`, sums every turn). Content/post cards (proposed posts, or a full analysis result) get a distinct accent-tinted style (`.chat-proposal` / `.intel-card-inline`, both with an accent left-border and a "📋/📊" eyebrow label) so they're never confused with a plain chat bubble.

Output posts get `generatedBy: 'intelligence'` (from a full analysis) or `'gemini-chat'` (from casual conversation), badge label **"Gemini Creative"** / **"Gemini Chat"** respectively — labels live in `AGENT_BADGE_MAP` in `static/app.js`.

## 6. Non-obvious gotchas learned the hard way

### 6.1 Absolute paths + subpath deployment
The app used absolute paths everywhere (`/style.css`, `fetch('/api/...')`). Under a real subfolder like `/compass`, the browser resolves those against the domain root, not the subfolder. Fixed via `BASE_PATH` env var → server injects `<base href>` + `window.APP_BASE` into `index.html`/`login.html`, and `app.js`/`login.js` prefix every `fetch()`/image URL through a `withBase()`/`mediaUrl()` helper. Local dev is unaffected (`BASE_PATH` unset defaults to root).

### 6.2 Why the static folder is `static/`, not `public/`
Passenger/CloudLinux **auto-serves anything inside an app's `public/` folder directly as static files**, completely bypassing Node — this silently ignored the `<base>`-tag injection and the auth gate for `index.html`/`login.html` on the live server, even though the code was correct. Renamed the folder to `static/` (both locally and deployed) to stop Passenger's auto-static convention from matching it. **Do not rename it back to `public/`** without re-solving this.

### 6.3 Stale Passenger workers
`cloudlinux-selector restart` (which touches `tmp/restart.txt`) doesn't always kill an already-running `lsnode` worker, especially right after a `destroy`/`create` app-registration cycle. If a deployed change doesn't seem to take effect, check `ps aux | grep lsnode` on the server and `kill -9` any leftover PID for that app path (see the exact command in §4.4).

### 6.4 No SQL, no image generation
- Storage is 100% flat JSON files, no MySQL — the database that came with the hosting plan is unused.
- Gemini is a text model; the "photo" field on every post is a visual *description*, not a rendered image. No image-generation model is wired in.

## 7. Reference: useful scripts

All run from `app/`:
```bash
node scripts/create-org.js <slug> "<Org Name>" <username> <password> "<Your Name>"
node scripts/set-gemini-key.js <org-slug> <gemini-api-key>
node scripts/set-apify-token.js <org-slug> <apify-token>
```

## 8. Sensitive files in this folder (don't commit / don't share)
- `deploy-keys/compass_deploy` — SSH private key
- `data/orgs.json` — contains Buranchi's real Gemini/Apify API keys and login password
- This file mentions server IPs/paths but no live secrets itself
