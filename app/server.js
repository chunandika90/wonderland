const express = require('express');
const session = require('express-session');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 4200;
const DATA_DIR = path.join(__dirname, 'data');
const ORGS_FILE = path.join(DATA_DIR, 'orgs.json');

// Lets this same codebase run mounted at the domain root (local dev, or a dedicated subdomain —
// Passenger strips its own PassengerBaseURI before Node ever sees the request, so server-side
// routes never need to know about it) OR under a real subfolder like wccn.co.id/compass, where
// the browser's OWN absolute "/xxx" references would otherwise resolve to the domain root instead
// of the subfolder. Set BASE_PATH=/compass (leading slash, no trailing slash) for that case.
const BASE_PATH = ('/' + (process.env.BASE_PATH || '').replace(/^\/|\/$/g, '')).replace(/\/$/, '') || '';
const BASE_PATH_SLASH = BASE_PATH ? BASE_PATH + '/' : '/';

// Passenger already strips its PassengerBaseURI before Node sees the request in the real cPanel
// deployment, so this is normally a no-op there. It exists so BASE_PATH can also be tested (or
// run) standalone, behind a reverse proxy that doesn't strip prefixes, without Passenger at all.
if (BASE_PATH) {
  app.use((req, res, next) => {
    if (req.url === BASE_PATH) req.url = '/';
    else if (req.url.startsWith(BASE_PATH + '/') || req.url.startsWith(BASE_PATH + '?')) req.url = req.url.slice(BASE_PATH.length);
    next();
  });
}

// Buranchi's real brand files live in the Marketing project tree on this machine — point the
// default org straight at them instead of copying, so editing here always edits the one true
// source Claude reads in chat. A deployed copy of the app won't have that surrounding folder
// tree, so it ships its own `context/` folder alongside server.js instead; if that folder
// exists we read from it, otherwise we fall back to the local dev tree. Orgs created later
// (via scripts/create-org.js) get their own private config/ folder under data/orgs/<slug>/.
const BUNDLED_CONTEXT_DIR = path.join(__dirname, 'context');
const HAS_BUNDLED_CONTEXT = fs.existsSync(BUNDLED_CONTEXT_DIR);
const LOCAL_CONTEXT_DIR = path.join(__dirname, '..', '..', '..', '_context');
const LOCAL_ASSISTANT_FILE = path.join(__dirname, '..', 'Buranchi-Compass-Assistant.md');
const BURANCHI_CONFIG_FILES = {
  'brand-context': { label: 'Brand Context', desc: 'Business, positioning, priorities, standing rules', path: HAS_BUNDLED_CONTEXT ? path.join(BUNDLED_CONTEXT_DIR, 'brand-context.md') : path.join(LOCAL_CONTEXT_DIR, 'brand-context.md') },
  'brand-voice': { label: 'Brand Voice', desc: 'Tone, vocabulary, do/don\'t phrasing patterns', path: HAS_BUNDLED_CONTEXT ? path.join(BUNDLED_CONTEXT_DIR, 'brand-voice.md') : path.join(LOCAL_CONTEXT_DIR, 'brand-voice.md') },
  'icp': { label: 'Ideal Customer Profile', desc: 'The two personas and how to target them', path: HAS_BUNDLED_CONTEXT ? path.join(BUNDLED_CONTEXT_DIR, 'ideal-customer-profile.md') : path.join(LOCAL_CONTEXT_DIR, 'ideal-customer-profile.md') },
  'compass-assistant': { label: 'Wonderland Assistant Instructions', desc: 'Full role, design system, and output contract Claude follows',path: HAS_BUNDLED_CONTEXT ? path.join(BUNDLED_CONTEXT_DIR, 'Buranchi-Compass-Assistant.md') : LOCAL_ASSISTANT_FILE },
};
const CONFIG_LABELS = {
  'brand-context': { label: 'Brand Context', desc: 'Business, positioning, priorities, standing rules', file: 'brand-context.md' },
  'brand-voice': { label: 'Brand Voice', desc: 'Tone, vocabulary, do/don\'t phrasing patterns', file: 'brand-voice.md' },
  'icp': { label: 'Ideal Customer Profile', desc: 'The two personas and how to target them', file: 'ideal-customer-profile.md' },
  'compass-assistant': { label: 'Wonderland Assistant Instructions', desc: 'Full role, design system, and output contract Claude follows',file: 'compass-assistant.md' },
};

app.use(express.json({ limit: '2mb' }));
app.use(session({
  secret: process.env.COMPASS_SECRET || 'buranchi-compass-local-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 } // 7 days
}));

// --- Org registry ---
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
function loadOrgs() { return readJson(ORGS_FILE, []); }
function findOrgBySlug(slug) { return loadOrgs().find(o => o.slug === slug); }

function orgDataDir(slug) { return path.join(DATA_DIR, 'orgs', slug); }
function orgPostsFile(slug) { return path.join(orgDataDir(slug), 'posts.json'); }
function orgConfigDir(slug) { return path.join(orgDataDir(slug), 'config'); }
// Every scrape is kept as its own timestamped snapshot (never overwritten), so past pulls stay
// viewable — e.g. the original 2026-07-27 research is still there after later rescrapes.
function orgAnalyticsHistoryDir(slug) { return path.join(orgDataDir(slug), 'analytics-history'); }
function listAnalyticsSnapshotFiles(slug) {
  const dir = orgAnalyticsHistoryDir(slug);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort(); // filenames are ISO timestamps, so lexical sort = chronological
}
function loadAnalyticsSnapshot(slug, filename) { return readJson(path.join(orgAnalyticsHistoryDir(slug), filename), null); }
function loadLatestAnalyticsSnapshot(slug) {
  const files = listAnalyticsSnapshotFiles(slug);
  if (!files.length) return null;
  return { file: files[files.length - 1], data: loadAnalyticsSnapshot(slug, files[files.length - 1]) };
}
function saveAnalyticsSnapshot(slug, data) {
  const dir = orgAnalyticsHistoryDir(slug);
  fs.mkdirSync(dir, { recursive: true });
  const filename = data.lastScrapedAt.replace(/[:.]/g, '-') + '.json';
  writeJson(path.join(dir, filename), data);
  return filename;
}
function listSnapshotMeta(slug) {
  return listAnalyticsSnapshotFiles(slug).map(file => {
    const data = loadAnalyticsSnapshot(slug, file);
    return { file, scrapedAt: data ? data.lastScrapedAt : null, postCount: data ? data.posts.length : 0, source: data ? data.scrapeSource : null };
  }).reverse(); // newest first
}

// Competitor accounts tracked per client for the analytics dashboard — lives on the client's
// own orgs.json record (org.competitors, an array of {handle, brandName, color}) instead of
// hardcoded here, so any staffer can manage any client's list without a code change.
const COMPETITOR_COLOR_PALETTE = ['#8B9B5E', '#C98A3E', '#4FA3C4', '#726654', '#B5560C', '#7C3AED', '#1C5EA6', '#0E7A5F'];
function resolveCompetitorAccounts(slug) {
  const org = findOrgBySlug(slug);
  if (!org || !org.competitors || !org.competitors.length) return null;
  const accounts = {};
  org.competitors.forEach(c => { accounts[c.handle] = { brandName: c.brandName, handle: '@' + c.handle, color: c.color }; });
  return accounts;
}
// Accepts a pasted Instagram profile URL in any of its common shapes, a bare "@handle", or a
// bare handle with no "@" — always returns just the handle, no "@" and no surrounding URL.
function parseInstagramHandle(input) {
  const s = (input || '').trim();
  const urlMatch = s.match(/instagram\.com\/([a-zA-Z0-9._]+)/);
  if (urlMatch) return urlMatch[1].replace(/\/$/, '');
  const bare = s.replace(/^@/, '');
  return /^[a-zA-Z0-9._]{1,30}$/.test(bare) ? bare : null;
}

// One-time bootstrap: register the default Buranchi org, migrating any pre-multi-org data.
(function bootstrapDefaultOrg() {
  if (fs.existsSync(ORGS_FILE)) return;
  const legacyPosts = path.join(DATA_DIR, 'posts.json');
  const org = {
    slug: 'buranchi',
    name: 'Buranchi',
    username: process.env.COMPASS_USER || 'buranchi',
    password: process.env.COMPASS_PASS || 'compass2026',
    userName: 'Juan',
    useSharedConfig: true, // reads BURANCHI_CONFIG_FILES (the real Marketing/_context files) instead of a private config/ folder
    createdAt: new Date(0).toISOString()
  };
  writeJson(ORGS_FILE, [org]);
  const target = orgPostsFile(org.slug);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(legacyPosts)) {
    fs.copyFileSync(legacyPosts, target);
  } else if (!fs.existsSync(target)) {
    writeJson(target, []);
  }
})();

function readPosts(slug) { return readJson(orgPostsFile(slug), []); }
function writePosts(slug, posts) { writeJson(orgPostsFile(slug), posts); }

// --- Internal WCCN staff accounts ---
// Nobody outside the agency logs into this tool — clients are workspaces picked from inside
// the app (see /api/clients, /api/session/client), never separate accounts. This file holds
// only the people who actually sign in.
const INTERNAL_USERS_FILE = path.join(DATA_DIR, 'internal-users.json');
function loadInternalUsers() { return readJson(INTERNAL_USERS_FILE, []); }
function findInternalUser(username) { return loadInternalUsers().find(u => u.username === username); }

function requireAuth(req, res, next) {
  if (req.session && req.session.loggedIn) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
  return res.redirect(BASE_PATH_SLASH + 'login.html');
}

// A logged-in staffer isn't automatically "in" a client's data — they pick one via
// /api/session/client first (see the client-picker UI). Routes that touch a specific client's
// data (posts, chat, guardrails, Directory A, ...) need this in addition to requireAuth; routes
// that operate across clients or before one is picked (me, clients, agency-overview, logout)
// don't.
function requireActiveClient(req, res, next) {
  if (req.session && req.session.orgSlug) return next();
  return res.status(400).json({ error: 'No client selected' });
}
const CLIENT_AGNOSTIC_API_PATHS = ['/api/me', '/api/clients', '/api/session/client', '/api/logout', '/api/agency-overview'];

function requireAdmin(req, res, next) {
  if (req.session && req.session.loggedIn && req.session.isAdmin) return next();
  return res.status(403).json({ error: 'Admin access only' });
}

// --- Auth routes ---
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = findInternalUser((username || '').trim());
  if (!user || user.password !== password) {
    return res.status(401).json({ ok: false, error: 'Invalid username or password' });
  }
  req.session.loggedIn = true;
  req.session.internalUsername = user.username;
  req.session.name = user.name;
  req.session.isAdmin = !!user.isAdmin;
  return res.json({ ok: true, name: user.name });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  if (req.session && req.session.loggedIn) {
    const org = req.session.orgSlug ? findOrgBySlug(req.session.orgSlug) : null;
    return res.json({
      loggedIn: true, name: req.session.name, isAdmin: !!req.session.isAdmin,
      clientSlug: req.session.orgSlug || null, clientName: org ? org.name : null
    });
  }
  return res.json({ loggedIn: false });
});

function saveOrgs(orgs) { writeJson(ORGS_FILE, orgs); }
function slugify(name) { return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'client'; }

app.get('/api/clients', requireAuth, (req, res) => {
  res.json(loadOrgs().map(o => ({ slug: o.slug, name: o.name })));
});

app.post('/api/clients', requireAuth, (req, res) => {
  const name = ((req.body && req.body.name) || '').trim();
  if (!name) return res.status(400).json({ error: 'Client name is required.' });
  const orgs = loadOrgs();
  let slug = slugify(name);
  for (let suffix = 2; orgs.find(o => o.slug === slug); suffix++) slug = slugify(name) + '-' + suffix;

  orgs.push({ slug, name, useSharedConfig: false, createdAt: new Date().toISOString() });
  saveOrgs(orgs);
  writeJson(orgPostsFile(slug), []);
  const configDir = orgConfigDir(slug);
  fs.mkdirSync(configDir, { recursive: true });
  const templates = {
    'brand-context.md': `# Brand Context — ${name}\n\n(Fill this in via Master Config.)\n`,
    'brand-voice.md': `# Brand Voice — ${name}\n\n(Fill this in via Master Config.)\n`,
    'ideal-customer-profile.md': `# Ideal Customer Profile — ${name}\n\n(Fill this in via Master Config.)\n`,
    'compass-assistant.md': `# ${name} — Assistant Instructions\n\n(Fill this in via Master Config.)\n`
  };
  Object.entries(templates).forEach(([file, content]) => fs.writeFileSync(path.join(configDir, file), content, 'utf8'));

  res.json({ ok: true, slug, name });
});

app.post('/api/session/client', requireAuth, (req, res) => {
  const { slug } = req.body || {};
  const org = findOrgBySlug(slug);
  if (!org) return res.status(404).json({ error: 'Unknown client' });
  req.session.orgSlug = org.slug;
  res.json({ ok: true, clientSlug: org.slug, clientName: org.name });
});

// --- Directory A management (cross-client — this is explicitly NOT scoped to whichever client
// is active in the session; it's a browse/configure-any-client screen, same spirit as Agency
// Overview). A full crawl can run past a minute on a large archive — well past the reverse
// proxy's own request timeout on the live server (confirmed: a synchronous sync there 500'd at
// ~60s even though it was still working) — so sync runs as a fire-and-forget background job per
// client; the client polls GET /api/directory-a/:slug for status instead of waiting on it.
const directoryASyncStatus = {}; // slug -> 'syncing' | 'done' | 'error'
const directoryASyncError = {};  // slug -> last error message, if any

// Accepts a pasted Drive folder URL in any of Google's link shapes, or a bare folder ID.
function parseDriveFolderId(input) {
  const s = (input || '').trim();
  const foldersMatch = s.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (foldersMatch) return foldersMatch[1];
  const idParamMatch = s.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (idParamMatch) return idParamMatch[1];
  if (/^[a-zA-Z0-9_-]{10,}$/.test(s)) return s; // looks like a bare folder ID already
  return null;
}

app.get('/api/directory-a/overview', requireAuth, (req, res) => {
  res.json(loadOrgs().map(org => {
    const manifest = loadDirectoryAManifest(org.slug);
    return {
      slug: org.slug, name: org.name,
      configured: !!(org.directoryA && org.directoryA.driveFolderId),
      fileCount: manifest ? manifest.files.length : null,
      syncedAt: manifest ? manifest.syncedAt : null,
      syncStatus: directoryASyncStatus[org.slug] || 'idle',
      syncError: directoryASyncError[org.slug] || null
    };
  }));
});

app.post('/api/directory-a/:slug/link', requireAuth, async (req, res) => {
  const org = findOrgBySlug(req.params.slug);
  if (!org) return res.status(404).json({ error: 'Unknown client' });
  const folderId = parseDriveFolderId((req.body && req.body.folderUrl) || '');
  if (!folderId) return res.status(400).json({ error: "Couldn't find a folder ID in that link." });

  try {
    const keyPath = path.join(__dirname, DRIVE_SHARED_SERVICE_ACCOUNT_KEY_FILE);
    const token = await getDriveAccessToken(keyPath);
    const key = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
    const checkRes = await fetch(`https://www.googleapis.com/drive/v3/files/${folderId}?fields=id,name,mimeType`, { headers: { Authorization: 'Bearer ' + token } });
    if (!checkRes.ok) {
      return res.status(400).json({ error: `Can't access that folder yet — share it with ${key.client_email} first, then try again.` });
    }
    const meta = await checkRes.json();
    if (meta.mimeType !== 'application/vnd.google-apps.folder') {
      return res.status(400).json({ error: 'That link points at a file, not a folder.' });
    }
  } catch (e) {
    return res.status(500).json({ error: 'Could not verify Drive access: ' + e.message });
  }

  const orgs = loadOrgs();
  const target = orgs.find(o => o.slug === req.params.slug);
  target.directoryA = { driveFolderId: folderId };
  saveOrgs(orgs);
  res.json({ ok: true, driveFolderId: folderId });
});

app.get('/api/directory-a/:slug', requireAuth, (req, res) => {
  const org = findOrgBySlug(req.params.slug);
  if (!org) return res.status(404).json({ error: 'Unknown client' });
  res.json({
    configured: !!(org.directoryA && org.directoryA.driveFolderId),
    manifest: loadDirectoryAManifest(req.params.slug),
    syncStatus: directoryASyncStatus[req.params.slug] || 'idle',
    syncError: directoryASyncError[req.params.slug] || null
  });
});

app.post('/api/directory-a/:slug/sync', requireAuth, (req, res) => {
  const org = findOrgBySlug(req.params.slug);
  if (!org || !org.directoryA) return res.status(400).json({ error: 'Directory A is not configured for this client.' });
  if (directoryASyncStatus[org.slug] === 'syncing') return res.json({ ok: true, alreadyRunning: true });

  directoryASyncStatus[org.slug] = 'syncing';
  directoryASyncError[org.slug] = null;
  syncDirectoryA(org)
    .then(() => { directoryASyncStatus[org.slug] = 'done'; })
    .catch(e => { directoryASyncStatus[org.slug] = 'error'; directoryASyncError[org.slug] = e.message; });

  res.json({ ok: true, started: true });
});

// --- Competitor list management (cross-client, same spirit as Directory A above — browse or
// edit any client's competitor list without switching the active session client). This list is
// what drives scraping direction: scrapeCompetitorsForOrg() only ever scrapes accounts named
// here, nothing is ever discovered automatically.
app.get('/api/competitors/overview', requireAuth, (req, res) => {
  res.json(loadOrgs().map(o => ({ slug: o.slug, name: o.name, count: (o.competitors || []).length })));
});

app.get('/api/competitors/:slug', requireAuth, (req, res) => {
  const org = findOrgBySlug(req.params.slug);
  if (!org) return res.status(404).json({ error: 'Unknown client' });
  res.json(org.competitors || []);
});

app.post('/api/competitors/:slug', requireAuth, (req, res) => {
  const orgs = loadOrgs();
  const org = orgs.find(o => o.slug === req.params.slug);
  if (!org) return res.status(404).json({ error: 'Unknown client' });

  const name = ((req.body && req.body.name) || '').trim();
  const handle = parseInstagramHandle((req.body && req.body.igLink) || '');
  if (!name) return res.status(400).json({ error: 'Competitor name is required.' });
  if (!handle) return res.status(400).json({ error: "Couldn't find an Instagram handle in that link." });

  org.competitors = org.competitors || [];
  if (org.competitors.find(c => c.handle === handle)) {
    return res.status(400).json({ error: `@${handle} is already on this client's list.` });
  }
  const color = COMPETITOR_COLOR_PALETTE[org.competitors.length % COMPETITOR_COLOR_PALETTE.length];
  org.competitors.push({ handle, brandName: name, color });
  saveOrgs(orgs);
  res.json({ ok: true, competitors: org.competitors });
});

app.delete('/api/competitors/:slug/:handle', requireAuth, (req, res) => {
  const orgs = loadOrgs();
  const org = orgs.find(o => o.slug === req.params.slug);
  if (!org) return res.status(404).json({ error: 'Unknown client' });
  org.competitors = (org.competitors || []).filter(c => c.handle !== req.params.handle);
  saveOrgs(orgs);
  res.json({ ok: true, competitors: org.competitors });
});

// --- Gate everything else in /api and the app shell ---
app.use((req, res, next) => {
  if (req.path === '/login.html' || req.path.startsWith('/assets/') || req.path === '/style.css' || req.path === '/login.js') {
    return next();
  }
  // Sakara Ops bridge routes authenticate via their own shared-secret header (see
  // requireBridgeSecret below), not a browser session — they're server-to-server calls
  // from a separate app with no Compass login of their own to send.
  if (req.path.startsWith('/api/bridge/')) return next();
  requireAuth(req, res, next);
});

// A second gate, API-only: most routes below need an active client picked, a handful don't.
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  if (req.path.startsWith('/api/bridge/')) return next();
  if (CLIENT_AGNOSTIC_API_PATHS.includes(req.path)) return next();
  requireActiveClient(req, res, next);
});

// --- Agency Overview (admin-only, aggregates across every org) ---
// A post's `date` is a loose string ("Aug 8" or an ISO "2026-08-20"), never guaranteed to
// carry a year — same reconstruction logic as the client-side calendar grid, just in Node.
function parsePostDateServer(post) {
  if (!post.date) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(post.date.trim());
  if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  const year = post.createdAt ? new Date(post.createdAt).getFullYear() : new Date().getFullYear();
  const guess = new Date(`${post.date} ${year}`);
  return isNaN(guess.getTime()) ? null : guess;
}

// Shared by /api/agency-overview (loops this over every org) and /api/dashboard (calls it once,
// for just the logged-in org) — one org's shape of "how's this client doing" stats.
function computeOrgOverview(org, now, in7Days, ago7Days, ago30Days) {
  const posts = readJson(orgPostsFile(org.slug), []);
  const log = readJson(orgGenerationLogFile(org.slug), []);

  const upcoming = posts
    .map(p => ({ post: p, date: parsePostDateServer(p) }))
    .filter(x => x.date && x.date >= now && x.date <= in7Days)
    .sort((a, b) => a.date - b.date);

  const upcomingEntries = upcoming.map(x => ({
    orgSlug: org.slug, orgName: org.name, date: x.date.toISOString(),
    headline: x.post.headline, format: x.post.format
  }));

  const activityEntries = log.map(entry => ({ ...entry, orgSlug: org.slug, orgName: org.name }));

  const recentLog = log.filter(e => e.timestamp && new Date(e.timestamp) >= ago30Days);
  const aiUsage30d = {
    count: recentLog.length,
    tokens: recentLog.reduce((sum, e) => sum + ((e.tokenUsage && e.tokenUsage.total) || 0), 0)
  };

  const lastPostAt = posts.reduce((max, p) => (p.createdAt && p.createdAt > max) ? p.createdAt : max, '');
  const lastLogAt = log.reduce((max, e) => (e.timestamp && e.timestamp > max) ? e.timestamp : max, '');
  const lastActivityAt = [lastPostAt, lastLogAt].sort().pop() || null;
  const atRisk = !lastActivityAt || new Date(lastActivityAt) < ago7Days;

  return {
    slug: org.slug,
    name: org.name,
    postCount: posts.length,
    upcomingCount7d: upcoming.length,
    nearestDeadline: upcoming.length ? { date: upcoming[0].date.toISOString(), headline: upcoming[0].post.headline } : null,
    lastActivityAt,
    atRisk,
    aiUsage30d,
    upcomingEntries,
    activityEntries
  };
}

app.get('/api/agency-overview', requireAdmin, (req, res) => {
  const orgs = loadOrgs();
  const now = new Date();
  const in7Days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const ago7Days = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const ago30Days = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const perOrg = orgs.map(org => computeOrgOverview(org, now, in7Days, ago7Days, ago30Days));
  const clients = perOrg.map(({ upcomingEntries, activityEntries, ...rest }) => rest);
  const allUpcoming = perOrg.flatMap(o => o.upcomingEntries).sort((a, b) => new Date(a.date) - new Date(b.date));
  const allActivity = perOrg.flatMap(o => o.activityEntries).sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));

  res.json({
    totalClients: orgs.length,
    totalPosts: clients.reduce((s, c) => s + c.postCount, 0),
    aiUsage30d: {
      count: clients.reduce((s, c) => s + c.aiUsage30d.count, 0),
      tokens: clients.reduce((s, c) => s + c.aiUsage30d.tokens, 0)
    },
    atRiskCount: clients.filter(c => c.atRisk).length,
    clients,
    upcomingDeadlines: allUpcoming.slice(0, 10),
    activityFeed: allActivity.slice(0, 15)
  });
});

// --- Dashboard (single-org overview — the tenant-scoped counterpart to Agency Overview, which
// only admins can see across every client). Same shape of data, always scoped to whichever org
// is logged in — no client comparison table since there's only ever one org here.
app.get('/api/dashboard', (req, res) => {
  const org = findOrgBySlug(req.session.orgSlug);
  const now = new Date();
  const in7Days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const ago7Days = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const ago30Days = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const overview = computeOrgOverview(org, now, in7Days, ago7Days, ago30Days);
  res.json({
    totalPosts: overview.postCount,
    upcomingCount7d: overview.upcomingCount7d,
    aiUsage30d: overview.aiUsage30d,
    atRisk: overview.atRisk,
    lastActivityAt: overview.lastActivityAt,
    upcomingDeadlines: overview.upcomingEntries.sort((a, b) => new Date(a.date) - new Date(b.date)).slice(0, 10),
    activityFeed: overview.activityEntries.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || '')).slice(0, 15)
  });
});

// Directory A media is served by explicit :slug, not the active session client — see the
// cross-client routes below for why. Still behind requireAuth (applied via the gate further
// down, since this path doesn't start with /api/ and isn't in the early-exempt list either).
app.get('/media/directory-a/:slug/:file', (req, res) => {
  const filePath = path.join(orgDirectoryAThumbsDir(req.params.slug), path.basename(req.params.file));
  if (!fs.existsSync(filePath)) return res.status(404).end();
  res.sendFile(filePath);
});

// --- Posts API (scoped to the logged-in org) ---
app.get('/api/posts', (req, res) => res.json(readPosts(req.session.orgSlug)));

app.post('/api/posts', (req, res) => {
  const posts = readPosts(req.session.orgSlug);
  const post = req.body;
  if (!post || !post.headline || !post.date) return res.status(400).json({ error: 'date and headline are required' });
  post.id = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  post.createdAt = post.createdAt || new Date().toISOString();
  posts.push(post);
  writePosts(req.session.orgSlug, posts);
  logGeneration(req.session.orgSlug, {
    timestamp: post.createdAt, agent: 'manual', requestText: post.headline,
    postCount: 1, tokenUsage: null
  });
  res.json(post);
});

app.post('/api/posts/bulk', (req, res) => {
  const posts = readPosts(req.session.orgSlug);
  const incoming = Array.isArray(req.body) ? req.body : [];
  const batchTime = new Date().toISOString();
  incoming.forEach(p => { p.id = Date.now() + '-' + Math.random().toString(36).slice(2, 8); p.createdAt = p.createdAt || batchTime; posts.push(p); });
  writePosts(req.session.orgSlug, posts);

  // Gemini batches are already logged (with the real prompt + token usage) at the point of
  // generation, before they reach this endpoint — only log here for batches that arrive some
  // other way (Claude paste, or anything future that skips the dedicated generate endpoint).
  const byAgent = {};
  incoming.forEach(p => { const a = p.generatedBy || 'claude'; byAgent[a] = (byAgent[a] || 0) + 1; });
  Object.entries(byAgent).forEach(([agent, count]) => {
    if (agent === 'gemini' || agent === 'gemini-chat' || agent === 'intelligence') return; // already logged their own generation turn
    logGeneration(req.session.orgSlug, {
      timestamp: batchTime, agent, requestText: agent === 'claude' ? '(drafted in a Claude chat session)' : null,
      postCount: count, tokenUsage: null
    });
  });

  res.json(readPosts(req.session.orgSlug));
});

app.put('/api/posts/:id', (req, res) => {
  const posts = readPosts(req.session.orgSlug);
  const post = posts.find(p => p.id === req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  Object.assign(post, req.body, { id: post.id }); // id is never overwritable from the client
  writePosts(req.session.orgSlug, posts);
  res.json(post);
});

app.delete('/api/posts/:id', (req, res) => {
  let posts = readPosts(req.session.orgSlug);
  posts = posts.filter(p => p.id !== req.params.id);
  writePosts(req.session.orgSlug, posts);
  res.json({ ok: true });
});

app.delete('/api/posts', (req, res) => {
  writePosts(req.session.orgSlug, []);
  res.json({ ok: true });
});

// --- Master config API (scoped to the logged-in org) ---
function resolveConfigPath(org, id) {
  if (org.useSharedConfig) {
    const f = BURANCHI_CONFIG_FILES[id];
    return f ? f.path : null;
  }
  const meta = CONFIG_LABELS[id];
  return meta ? path.join(orgConfigDir(org.slug), meta.file) : null;
}

app.get('/api/config', (req, res) => {
  res.json(Object.entries(CONFIG_LABELS).map(([id, f]) => ({ id, label: f.label, desc: f.desc })));
});

app.get('/api/config/:id', (req, res) => {
  const org = findOrgBySlug(req.session.orgSlug);
  const filePath = org && resolveConfigPath(org, req.params.id);
  if (!filePath) return res.status(404).json({ error: 'Unknown config file' });
  try {
    res.json({ content: fs.readFileSync(filePath, 'utf8') });
  } catch (e) {
    res.json({ content: '' });
  }
});

app.put('/api/config/:id', (req, res) => {
  const org = findOrgBySlug(req.session.orgSlug);
  const filePath = org && resolveConfigPath(org, req.params.id);
  if (!filePath) return res.status(404).json({ error: 'Unknown config file' });
  const { content } = req.body || {};
  if (typeof content !== 'string') return res.status(400).json({ error: 'content must be a string' });
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
  res.json({ ok: true });
});

// --- Competitor analytics API (scoped to the logged-in org) ---

// Very light best-effort content categorizer for freshly-scraped posts. Apify doesn't classify
// topics for us — this is a keyword guess, not a real taxonomy. Flag it clearly in the data so
// nobody mistakes it for the manually-reviewed categories in the original one-time analysis.
// Matches the same 14-category taxonomy used in the original manually-tagged research (see
// the July 27 snapshot), so newly auto-scraped posts stay comparable to it instead of
// collapsing into one crude bucket. Order matters — first match wins, most specific first.
function categorizeCaption(caption) {
  const c = (caption || '').toLowerCase();
  const rules = [
    [/collab|partnership|x @|teamed up|bersama @|kolaborasi/, 'Collaboration / Brand Partnership'],
    [/grand opening|new store|our \d(st|nd|rd|th) store|now open\b|opening soon|toko baru|cabang baru/, 'Store Opening / Expansion'],
    [/new menu|new product|launching|introducing|now available|menu baru|produk baru/, 'New Product / Menu Launch'],
    [/bazaar|pop.?up|market|festival|semasa/, 'Pop-up / Market / Bazaar'],
    [/behind the scenes?|bts\b|process|crafting|from scratch|di balik layar/, 'Behind-the-Scenes / Process & Craft'],
    [/live music|dj set|live session|live performance|gig\b|nge-dj/, 'Music / Entertainment (DJ & Live Sessions)'],
    [/run club|community|meetup|sports|yoga|workout|komunitas/, 'Community / Run Club & Sports Events'],
    [/interior|renovation|architecture|design of|ruang baru/, 'Design / Space & Interior'],
    [/promo\b|diskon|discount|loyalty|delivery|gofood|grabfood|ojek online/, 'Promo / Loyalty / Delivery / Ops'],
    [/our story|philosophy|our journey|why we|kami percaya|filosofi/, 'Brand Story / Philosophy'],
    [/hiring|we.?re looking for|join our team|lowongan|karir|karier/, 'Recruitment / Hiring'],
    [/meet the (team|barista)|staff spotlight|our team\b|tim kami/, 'People / Team / Community Feature'],
    [/feat\.|featuring|review by|thanks to @|credit to @|repost/, 'Influencer / Press Feature (UGC)'],
  ];
  for (const [re, label] of rules) if (re.test(c)) return label;
  return 'Brand Lifestyle / General';
}

function mapApifyItemToPost(item, accountKey, accountMeta, existingFollowers) {
  const type = item.type || item.__typename || '';
  const post_type = /sidecar|carousel/i.test(type) ? 'Carousel' : (/video|reel/i.test(type) ? 'Reel/Video' : 'Photo');
  const likesCount = typeof item.likesCount === 'number' ? item.likesCount : null;
  const likes_hidden = likesCount === null || likesCount < 0;
  const comments = item.commentsCount || 0;
  const followers = item.ownerFollowersCount || existingFollowers || null;
  const engagement_count = likes_hidden ? comments : (likesCount + comments);
  const engagement_rate_pct = followers ? +(100 * engagement_count / followers).toFixed(3) : null;
  const timestamp = item.timestamp || item.takenAtTimestamp || new Date().toISOString();
  const dateObj = new Date(timestamp);
  const caption = item.caption || '';
  return {
    account: accountKey,
    brand_name: accountMeta.brandName,
    shortCode: item.shortCode || (item.url || '').split('/').filter(Boolean).pop() || '',
    url: item.url || '',
    post_type,
    raw_type: type,
    caption,
    caption_preview: caption.length > 140 ? caption.slice(0, 140) + '…' : caption,
    hashtags: item.hashtags || [],
    likes_display: likesCount,
    likes_hidden,
    comments,
    video_views: item.videoViewCount || null,
    video_plays: item.videoPlayCount || null,
    engagement_count,
    engagement_rate_pct,
    metric_basis: likes_hidden ? 'comments_only' : 'likes_comments',
    category: categorizeCaption(caption),
    timestamp: dateObj.toISOString(),
    date: dateObj.toISOString().slice(0, 10),
    weekday: dateObj.toLocaleDateString('en-US', { weekday: 'long' }),
    hour_utc: dateObj.getUTCHours(),
    is_ugc_repost: false,
    owner_username: accountKey,
    followers,
    location: item.locationName || null,
    is_pinned: !!item.isPinned,
    // Raw Instagram CDN URL, captured before download — cacheDisplayImages() below rewrites
    // this to a permanent local path once the image is saved to disk.
    display_url: item.displayUrl || (Array.isArray(item.images) ? item.images[0] : null) || null,
  };
}

function orgImagesDir(slug) { return path.join(orgDataDir(slug), 'analytics-images'); }

// Downloads each post's thumbnail once and rewrites display_url to point at our own server
// instead of Instagram's CDN — the local copy never expires. Runs with limited concurrency so
// a scrape of ~100 posts doesn't open 100 sockets at once. Failures are non-fatal: a post just
// keeps its (eventually-expiring) original URL if the download doesn't work out.
async function cacheDisplayImages(slug, posts) {
  const dir = orgImagesDir(slug);
  fs.mkdirSync(dir, { recursive: true });
  const CONCURRENCY = 8;
  let cursor = 0;
  async function worker() {
    while (cursor < posts.length) {
      const post = posts[cursor++];
      if (!post.display_url || !post.shortCode) continue;
      try {
        const res = await fetch(post.display_url);
        if (!res.ok) continue;
        const buf = Buffer.from(await res.arrayBuffer());
        const filename = post.shortCode.replace(/[^a-zA-Z0-9_-]/g, '') + '.jpg';
        fs.writeFileSync(path.join(dir, filename), buf);
        post.display_url = `/media/analytics/${slug}/${filename}`;
      } catch (e) {
        // keep the original (possibly-expiring) URL as a fallback
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}

// --- Directory A: a read-only mirror of a client's Google Drive creative archive ---
// Auth is a hand-rolled service-account JWT exchange (RS256, signed with Node's built-in
// crypto) rather than the `googleapis` package — keeps this dependency-free, consistent with
// how the rest of the app talks to Gemini: plain fetch() calls, no SDK.
// One service account shared across every client — each client just shares their own Drive
// folder with its robot email, nothing per-client to provision on the Google Cloud side.
const DRIVE_SHARED_SERVICE_ACCOUNT_KEY_FILE = 'service-accounts/wonderland-drive-reader.json';
function orgDirectoryADir(slug) { return path.join(orgDataDir(slug), 'directory-a'); }
function orgDirectoryAManifestFile(slug) { return path.join(orgDirectoryADir(slug), 'manifest.json'); }
function orgDirectoryAThumbsDir(slug) { return path.join(orgDirectoryADir(slug), 'thumbs'); }

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getDriveAccessToken(serviceAccountKeyPath) {
  const key = JSON.parse(fs.readFileSync(serviceAccountKeyPath, 'utf8'));
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = { iss: key.client_email, scope: 'https://www.googleapis.com/auth/drive.readonly', aud: key.token_uri, exp: now + 3600, iat: now };
  const unsigned = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(claim));
  const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(key.private_key).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const res = await fetch(key.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + (unsigned + '.' + signature)
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Drive auth failed: ' + JSON.stringify(data));
  return data.access_token;
}

async function listDriveChildren(token, folderId) {
  const url = `https://www.googleapis.com/drive/v3/files?q='${folderId}'+in+parents+and+trashed=false&fields=files(id,name,mimeType,modifiedTime,webViewLink,thumbnailLink)&pageSize=200`;
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  const data = await res.json();
  if (!res.ok) throw new Error('Drive list failed: ' + JSON.stringify(data));
  return data.files || [];
}

const DRIVE_MAX_DEPTH = 6;
// Now that raw dumps are excluded (see DRIVE_RAW_DUMP_THRESHOLD above), what's left to index is
// genuinely curated material — a client can reasonably have thousands of those. Confirmed on a
// real client's archive: curated content alone (Design, Assets, Campaign Briefs, etc., not
// counting anything rolled up as a raw dump) already ran past the old 2000 cap.
const DRIVE_MAX_ITEMS = 6000;

// A folder holding more direct files than this reads as a flat camera-roll dump (a photoshoot's
// full take, raw video exports — hundreds of near-duplicates), not curated reference material —
// and would burn the entire DRIVE_MAX_ITEMS budget before the crawl even reaches a client's
// organized folders (confirmed on Buranchi's archive: one dump folder alone ate 1467 of 2000
// slots). This is a shape-based signal, not a name list — every client organizes their Drive
// differently, so there's no folder name that generalizes across clients.
const DRIVE_RAW_DUMP_THRESHOLD = 30;

async function countDriveFolderRecursive(token, folderId, depth) {
  if (depth > DRIVE_MAX_DEPTH) return 0;
  const children = await listDriveChildren(token, folderId);
  let count = 0;
  for (const child of children) {
    if (child.name === '.DS_Store') continue;
    if (child.mimeType === 'application/vnd.google-apps.folder') count += await countDriveFolderRecursive(token, child.id, depth + 1);
    else count++;
  }
  return count;
}

// A raw dump's own file names are useless for keyword matching ("IMG_4676.JPG"), but the shoot
// folder ONE level in is named for what it actually is ("Buranchi Pastry", "Buranchi Live
// Performance") — exactly the kind of name a `directoryAKeyword` from the AI would hit. So this
// grabs one representative photo per shoot folder without indexing the other 99.
async function findFirstImageThumbnail(token, folderId, depth) {
  if (depth > 3) return null;
  const children = await listDriveChildren(token, folderId);
  const image = children.find(c => c.mimeType.startsWith('image/') && c.thumbnailLink);
  if (image) return image.thumbnailLink;
  for (const child of children) {
    if (child.mimeType === 'application/vnd.google-apps.folder') {
      const found = await findFirstImageThumbnail(token, child.id, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

// Depth-first walk of the whole tree under the configured root folder. A folder whose direct
// files exceed DRIVE_RAW_DUMP_THRESHOLD becomes one summary entry (representative thumbnail +
// total count) instead of every file being indexed — otherwise it recurses into subfolders and
// indexes each file as its own manifest entry, with images additionally queued for a thumbnail
// download (never the full-resolution original, which can run 6-8MB apiece).
async function crawlDriveFolder(token, folderId, folderName, parentPath, depth, manifest, imageQueue) {
  if (depth > DRIVE_MAX_DEPTH || manifest.length >= DRIVE_MAX_ITEMS) return;
  const children = (await listDriveChildren(token, folderId)).filter(c => c.name !== '.DS_Store');
  const subfolders = children.filter(c => c.mimeType === 'application/vnd.google-apps.folder');
  const files = children.filter(c => c.mimeType !== 'application/vnd.google-apps.folder');

  if (files.length > DRIVE_RAW_DUMP_THRESHOLD) {
    const [count, thumbnailLink] = await Promise.all([
      countDriveFolderRecursive(token, folderId, depth),
      findFirstImageThumbnail(token, folderId, 0)
    ]);
    const entry = {
      id: folderId, name: folderName, path: parentPath, mimeType: 'application/vnd.google-apps.folder',
      modifiedTime: children.reduce((max, c) => (c.modifiedTime > max ? c.modifiedTime : max), ''),
      webViewLink: `https://drive.google.com/drive/folders/${folderId}`,
      hasThumbnail: false, isRawArchiveSummary: true, fileCount: count
    };
    manifest.push(entry);
    if (thumbnailLink) imageQueue.push({ entry, thumbnailLink });
    return;
  }

  const ownPath = depth === 0 ? parentPath : parentPath + '/' + folderName;
  for (const child of subfolders) {
    if (manifest.length >= DRIVE_MAX_ITEMS) break;
    await crawlDriveFolder(token, child.id, child.name, ownPath, depth + 1, manifest, imageQueue);
  }
  for (const child of files) {
    if (manifest.length >= DRIVE_MAX_ITEMS) break;
    const isImage = child.mimeType.startsWith('image/');
    const entry = {
      id: child.id, name: child.name, path: ownPath, mimeType: child.mimeType,
      modifiedTime: child.modifiedTime, webViewLink: child.webViewLink,
      hasThumbnail: false
    };
    manifest.push(entry);
    if (isImage && child.thumbnailLink) imageQueue.push({ entry, thumbnailLink: child.thumbnailLink });
  }
}

async function downloadDriveThumbnails(slug, imageQueue) {
  const dir = orgDirectoryAThumbsDir(slug);
  // Every sync rebuilds the manifest from scratch, so a stale thumbnail from a file that's since
  // been excluded (moved into a raw-dump folder, deleted, re-categorized) would otherwise sit
  // around unreferenced forever. Wipe and re-populate rather than only ever appending.
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const CONCURRENCY = 6;
  let cursor = 0;
  async function worker() {
    while (cursor < imageQueue.length) {
      const item = imageQueue[cursor++];
      try {
        const res = await fetch(item.thumbnailLink);
        if (!res.ok) continue;
        const buf = Buffer.from(await res.arrayBuffer());
        fs.writeFileSync(path.join(dir, item.entry.id + '.jpg'), buf);
        item.entry.hasThumbnail = true;
      } catch (e) {
        // no thumbnail cached — the manifest entry just falls back to webViewLink
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}

async function syncDirectoryA(org) {
  const config = org.directoryA;
  if (!config || !config.driveFolderId) {
    throw new Error('Directory A is not configured for this client.');
  }
  const keyPath = path.join(__dirname, DRIVE_SHARED_SERVICE_ACCOUNT_KEY_FILE);
  const token = await getDriveAccessToken(keyPath);
  const manifest = [];
  const imageQueue = [];
  await crawlDriveFolder(token, config.driveFolderId, '(root)', '', 0, manifest, imageQueue);
  await downloadDriveThumbnails(org.slug, imageQueue);
  const result = { syncedAt: new Date().toISOString(), truncated: manifest.length >= DRIVE_MAX_ITEMS, files: manifest };
  fs.mkdirSync(orgDirectoryADir(org.slug), { recursive: true });
  writeJson(orgDirectoryAManifestFile(org.slug), result);
  return result;
}

function loadDirectoryAManifest(slug) {
  return readJson(orgDirectoryAManifestFile(slug), null);
}

// A short, token-cheap summary of the archive's shape (folder names + counts + recency) for
// the Creative Chat agents — not full file listings, so the prompt doesn't blow up on an
// archive with thousands of files. Groups by top-level folder, same level a person browses at.
function buildDirectoryASummary(slug) {
  const manifest = loadDirectoryAManifest(slug);
  if (!manifest || !manifest.files.length) return null;
  const byTopFolder = {};
  manifest.files.forEach(f => {
    // A raw-dump summary entry (see DRIVE_RAW_DUMP_FOLDERS) is one shoot folder ("Buranchi
    // Pastry") with its own rolled-up count, nested a level under its category (path) same as
    // any real file — so grouping by path's top segment works uniformly for both.
    const top = (f.path.split('/').filter(Boolean)[0]) || '(root)';
    const inc = f.isRawArchiveSummary ? f.fileCount : 1;
    if (!byTopFolder[top]) byTopFolder[top] = { count: 0, lastModified: '' };
    byTopFolder[top].count += inc;
    if (f.modifiedTime > byTopFolder[top].lastModified) byTopFolder[top].lastModified = f.modifiedTime;
  });
  const lines = Object.entries(byTopFolder)
    .sort((a, b) => b[1].count - a[1].count)
    .map(([name, info]) => `- ${name}: ${info.count} files, most recent ${info.lastModified.slice(0, 10)}`);
  return `Synced ${manifest.syncedAt.slice(0, 10)} from the client's Google Drive:\n${lines.join('\n')}`;
}

async function scrapeCompetitorsForOrg(org) {
  const accounts = resolveCompetitorAccounts(org.slug);
  if (!accounts) throw new Error('No competitor accounts configured for this organization yet.');
  const token = org.apifyToken || process.env.APIFY_API_TOKEN;
  if (!token) throw new Error('Apify API token not configured. Add one via scripts/set-apify-token.js, then try again.');

  const latest = loadLatestAnalyticsSnapshot(org.slug);
  const existingFollowersByAccount = {};
  if (latest && latest.data && latest.data.followers) Object.assign(existingFollowersByAccount, latest.data.followers);

  const directUrls = Object.keys(accounts).map(u => `https://www.instagram.com/${u}/`);
  const res = await fetch(`https://api.apify.com/v2/acts/apify~instagram-scraper/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ directUrls, resultsType: 'posts', resultsLimit: 25 })
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Apify request failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const items = await res.json();
  if (!Array.isArray(items)) throw new Error('Unexpected response shape from Apify.');

  const posts = items.map(item => {
    const accountKey = item.ownerUsername || item.username ||
      Object.keys(accounts).find(u => (item.url || '').includes('/' + u + '/')) || 'unknown';
    const meta = accounts[accountKey] || { brandName: accountKey, handle: '@' + accountKey, color: '#726654' };
    return mapApifyItemToPost(item, accountKey, meta, existingFollowersByAccount[accountKey]);
  });

  const followers = {};
  Object.keys(accounts).forEach(acc => {
    const fromScrape = posts.find(p => p.account === acc && p.followers)?.followers;
    followers[acc] = fromScrape || existingFollowersByAccount[acc] || null;
  });

  // Instagram's CDN URLs are signed and expire within hours — download each thumbnail once, at
  // scrape time, so the side-by-side comparison keeps working long after the original link dies.
  await cacheDisplayImages(org.slug, posts);

  const out = {
    posts,
    accountColors: Object.fromEntries(Object.entries(accounts).map(([k, v]) => [k, v.color])),
    followers,
    brandNames: Object.fromEntries(Object.entries(accounts).map(([k, v]) => [k, v.brandName])),
    handles: Object.fromEntries(Object.entries(accounts).map(([k, v]) => [k, v.handle])),
    accounts: Object.keys(accounts),
    lastScrapedAt: new Date().toISOString(),
    scrapeSource: 'apify'
  };
  saveAnalyticsSnapshot(org.slug, out);
  return out;
}

// Picks real, representative competitor posts (not just aggregate stats) so Gemini has actual
// material to compile from — top performers spread across categories rather than just the
// single overall best, capped so the prompt doesn't balloon.
function buildCompetitorSample(data) {
  const posts = (data && data.posts) || [];
  if (!posts.length) return 'No competitor posts scraped yet.';
  const byCategory = {};
  posts.forEach(p => { (byCategory[p.category] = byCategory[p.category] || []).push(p); });
  const lines = [];
  Object.entries(byCategory).forEach(([cat, list]) => {
    list.sort((a, b) => (b.engagement_rate_pct || 0) - (a.engagement_rate_pct || 0));
    list.slice(0, 3).forEach(p => {
      const caption = (p.caption || '').replace(/\s+/g, ' ').slice(0, 220);
      lines.push(`[${cat}] ${p.brand_name} (${p.post_type}, ${(p.engagement_rate_pct || 0).toFixed(1)}% eng.): "${caption}"`);
    });
  });
  return lines.join('\n');
}

// Our own already-planned posts — so Gemini doesn't repeat a headline/date/theme that's already
// in the plan, and can see the brand's own established cadence and voice in practice.
function buildOwnPlanSample(orgSlug) {
  const existing = readPosts(orgSlug);
  const planText = existing.length
    ? existing.map(p => `- ${p.date} (${p.format}): "${p.headline}" — ${p.priority || 'no priority set'} [${p.generatedBy || 'unknown'}]`).join('\n')
    : 'No posts in the plan yet — this will be the first batch.';
  const directoryASummary = buildDirectoryASummary(orgSlug);
  if (!directoryASummary) return planText;
  return `${planText}\n\nCLIENT'S VISUAL/CREATIVE ARCHIVE (synced from their Google Drive — real category/folder names + file counts, not analyzed image-by-image):\n${directoryASummary}\n\nUse this to know what kinds of assets and past campaigns already exist — you cannot see the images themselves. When a post you're proposing genuinely matches something in this archive, set that post's "directoryAKeyword" to one of the EXACT category names listed above (or an exact substring of one, e.g. "Moodboard Photosession" matching "Moodboard Photosession - BR") — never a loose topic word like "pastry" or "pool" that just sounds related. The point is traceability: the user should see which real category a recommendation came from. Compass matches it against the actual archive and attaches a real photo from that category. Leave it "" when no listed category genuinely fits — a wrong guess surfaces an unrelated photo under a false category label, which is worse than no reference.`;
}

// Derives content-plan recommendations straight from the scraped competitor data — every number
// here is computed from data.posts, nothing is invented. Used to give the "Generate a plan" step
// something concrete and current to react to, instead of a static hand-written paragraph.
function computeContentRecommendations(data) {
  const posts = (data && data.posts) || [];
  if (posts.length < 5) return [];

  const avgBy = (keyFn) => {
    const groups = {};
    posts.forEach(p => {
      if (typeof p.engagement_rate_pct !== 'number') return;
      const k = keyFn(p);
      (groups[k] = groups[k] || []).push(p.engagement_rate_pct);
    });
    return Object.entries(groups)
      .map(([k, arr]) => ({ key: k, avg: arr.reduce((a, b) => a + b, 0) / arr.length, n: arr.length }))
      .filter(g => g.n >= 2) // ignore one-off outliers
      .sort((a, b) => b.avg - a.avg);
  };

  const recs = [];

  const byFormat = avgBy(p => p.post_type);
  if (byFormat.length >= 2) {
    const top = byFormat[0], rest = byFormat.slice(1);
    const restAvg = rest.reduce((s, r) => s + r.avg, 0) / rest.length;
    if (top.avg > restAvg * 1.15) {
      recs.push({
        type: 'format',
        text: `${top.key} is outperforming other formats among tracked competitors (${top.avg.toFixed(1)}% avg engagement vs ${restAvg.toFixed(1)}% for the rest, n=${top.n}) — lean toward ${top.key.toLowerCase()} for upcoming posts.`
      });
    }
  }

  const byCategory = avgBy(p => p.category);
  const realCategories = byCategory.filter(c => !/uncategorized/i.test(c.key));
  if (realCategories.length) {
    const top = realCategories[0];
    recs.push({
      type: 'category',
      text: `"${top.key}" content has the highest average engagement among tracked categories (${top.avg.toFixed(1)}%, n=${top.n}) — worth a similar angle in an upcoming Buranchi post.`
    });
  }

  const byWeekday = avgBy(p => p.weekday);
  if (byWeekday.length) {
    const top = byWeekday[0];
    recs.push({
      type: 'timing',
      text: `${top.key} posts show the highest average engagement across competitors (${top.avg.toFixed(1)}%, n=${top.n}) — a good day to schedule higher-priority content.`
    });
  }

  const byAccount = avgBy(p => p.brand_name);
  if (byAccount.length) {
    const top = byAccount[0];
    recs.push({
      type: 'leader',
      text: `${top.key} currently has the strongest average engagement in this set (${top.avg.toFixed(1)}%) — worth a closer look at what they're doing differently.`
    });
  }

  return recs;
}

// ?at=<snapshot filename> loads a specific historical scrape instead of the latest one.
// The response always includes `snapshots` (newest first) so the frontend can populate the
// scrape-date dropdown without a second request.
app.get('/api/analytics', (req, res) => {
  const slug = req.session.orgSlug;
  const snapshots = listSnapshotMeta(slug);
  if (!snapshots.length) {
    return res.json({ posts: [], accountColors: {}, followers: {}, brandNames: {}, handles: {}, accounts: [], lastScrapedAt: null, snapshots: [], recommendations: [] });
  }
  const requested = req.query.at && snapshots.find(s => s.file === req.query.at);
  const file = requested ? requested.file : snapshots[0].file; // snapshots[0] is newest (listSnapshotMeta reverses to newest-first)
  const data = loadAnalyticsSnapshot(slug, file) || {};
  const recommendations = computeContentRecommendations(data);
  res.json(Object.assign({}, data, { snapshots, activeSnapshot: file, recommendations }));
});

// Guards against burning through Apify credits by mashing the button — manual rescrapes are
// limited to once per hour per org. The daily cron job ignores this (it only runs once/day anyway).
const RESCRAPE_COOLDOWN_MS = 60 * 60 * 1000;

app.post('/api/analytics/rescrape', async (req, res) => {
  const org = findOrgBySlug(req.session.orgSlug);
  if (!org) return res.status(404).json({ ok: false, error: 'Organization not found' });

  const latest = loadLatestAnalyticsSnapshot(org.slug);
  if (latest && latest.data && latest.data.lastScrapedAt) {
    const elapsed = Date.now() - new Date(latest.data.lastScrapedAt).getTime();
    if (elapsed < RESCRAPE_COOLDOWN_MS) {
      const minutesLeft = Math.ceil((RESCRAPE_COOLDOWN_MS - elapsed) / 60000);
      return res.status(429).json({ ok: false, error: `Rescraped recently — try again in ${minutesLeft} min. (Limited to once/hour to protect your Apify credits.)` });
    }
  }

  try {
    const data = await scrapeCompetitorsForOrg(org);
    res.json({ ok: true, count: data.posts.length, lastScrapedAt: data.lastScrapedAt });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ---- Sakara Ops bridge — server-to-server only, no browser session involved ----
// Sakara Ops (a separate app on this same account) shows a per-client Competitors tab
// sourced from whichever Compass org that client is mapped to. It can't use the routes
// above because those trust req.session.orgSlug, which only exists for a human logged
// into Compass in a browser. This bridge takes the org slug as a URL param instead and
// checks a shared secret header — same "internal automation token" pattern as this
// server's own cPanel API calls, not meant to be exposed to any other caller.
const SAKARA_BRIDGE_SECRET = process.env.SAKARA_BRIDGE_SECRET || 'e411dfb6bb92a03e830877c328c683f8f294ce3e945f8061';
function requireBridgeSecret(req, res, next) {
  if (req.get('X-Bridge-Secret') !== SAKARA_BRIDGE_SECRET) return res.status(401).json({ ok: false, error: 'Invalid bridge secret' });
  next();
}

app.get('/api/bridge/orgs/:slug/analytics', requireBridgeSecret, (req, res) => {
  const slug = req.params.slug;
  const snapshots = listSnapshotMeta(slug);
  if (!snapshots.length) {
    return res.json({ posts: [], accountColors: {}, followers: {}, brandNames: {}, handles: {}, accounts: [], lastScrapedAt: null });
  }
  const data = loadAnalyticsSnapshot(slug, snapshots[0].file) || {};
  res.json(Object.assign({}, data, { activeSnapshot: snapshots[0].file }));
});

app.post('/api/bridge/orgs/:slug/rescrape', requireBridgeSecret, async (req, res) => {
  const org = findOrgBySlug(req.params.slug);
  if (!org) return res.status(404).json({ ok: false, error: 'Organization not found' });

  const latest = loadLatestAnalyticsSnapshot(org.slug);
  if (latest && latest.data && latest.data.lastScrapedAt) {
    const elapsed = Date.now() - new Date(latest.data.lastScrapedAt).getTime();
    if (elapsed < RESCRAPE_COOLDOWN_MS) {
      const minutesLeft = Math.ceil((RESCRAPE_COOLDOWN_MS - elapsed) / 60000);
      return res.status(429).json({ ok: false, error: `Rescraped recently — try again in ${minutesLeft} min. (Limited to once/hour to protect your Apify credits.)` });
    }
  }
  try {
    const data = await scrapeCompetitorsForOrg(org);
    res.json({ ok: true, count: data.posts.length, lastScrapedAt: data.lastScrapedAt });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// Daily auto-rescrape at midnight, local server time — runs for every org that has an Apify
// token configured (via its org record or the shared APIFY_API_TOKEN env var). Orgs without a
// token are skipped silently; nothing breaks if nobody has configured Apify yet.
cron.schedule('0 0 * * *', async () => {
  const orgs = loadOrgs();
  for (const org of orgs) {
    if (!resolveCompetitorAccounts(org.slug)) continue;
    if (!(org.apifyToken || process.env.APIFY_API_TOKEN)) continue;
    try {
      const data = await scrapeCompetitorsForOrg(org);
      console.log(`[cron] Rescraped analytics for ${org.name}: ${data.posts.length} posts`);
    } catch (e) {
      console.log(`[cron] Rescrape failed for ${org.name}: ${e.message}`);
    }
  }
});

// --- In-app AI generation (Gemini) — lets the user generate a plan without leaving the app ---
// gemini-flash-latest (3.7-flash) was hitting sustained 503 "high demand" during testing —
// the lite alias resolved fine, so defaulting to it for reliability. Swap back once capacity frees up.
const GEMINI_MODEL = 'gemini-flash-lite-latest';

function orgGenerationLogFile(slug) { return path.join(orgDataDir(slug), 'ai-generations.json'); }
function logGeneration(slug, entry) {
  const log = readJson(orgGenerationLogFile(slug), []);
  log.push(entry);
  writeJson(orgGenerationLogFile(slug), log);
}

app.get('/api/generate-plan/history', (req, res) => {
  res.json(readJson(orgGenerationLogFile(req.session.orgSlug), []).reverse());
});

app.post('/api/generate-plan', async (req, res) => {
  const org = findOrgBySlug(req.session.orgSlug);
  if (!org) return res.status(404).json({ ok: false, error: 'Organization not found' });
  const apiKey = org.geminiApiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(400).json({ ok: false, error: 'Gemini API key not configured. Add one via scripts/set-gemini-key.js, then try again.' });

  // Post count is governed by the same guardrail as the Chat AI Agent tab (Chat AI Agent > Guardrails)
  // rather than a separate field here — one shared limit instead of two settings that could drift.
  // Gemini decides the actual dates itself from the focus text (e.g. "tanggal kembar
  // Agustus-September" should land on non-consecutive dates spanning two months, not just
  // "the next N days from today").
  const guardrails = loadGuardrails(org.slug);
  const maxPosts = guardrails.maxPostsPerProposal;
  const focus = (req.body && req.body.focus || '').trim();

  const readConfig = (id) => { try { return fs.readFileSync(resolveConfigPath(org, id), 'utf8'); } catch (e) { return ''; } };
  const assistantInstructions = org.useSharedConfig
    ? (() => { try { return fs.readFileSync(BURANCHI_CONFIG_FILES['compass-assistant'].path, 'utf8'); } catch (e) { return ''; } })()
    : readConfig('compass-assistant');

  const analyticsData = loadLatestAnalyticsSnapshot(org.slug);
  const recommendations = analyticsData ? computeContentRecommendations(analyticsData.data) : [];
  const recsText = recommendations.length
    ? recommendations.map(r => '- ' + r.text).join('\n')
    : 'No competitor recommendations available yet — proceed using standing rules only.';

  // Real sample of the actual scraped posts (not just the aggregate recommendations above) —
  // top performers spread across categories, so Gemini can compile real patterns (what a strong
  // caption in a given category actually reads like) instead of only reasoning from summary stats.
  const competitorSampleText = buildCompetitorSample(analyticsData ? analyticsData.data : null);
  const ownPlanText = buildOwnPlanSample(org.slug);

  const today = new Date().toISOString().slice(0, 10);
  const prompt = `${assistantInstructions}

---

LIVE COMPETITOR RECOMMENDATIONS (computed from the current analytics data — use these as real basis for referenceCategory where relevant):
${recsText}

---

REAL COMPETITOR POST SAMPLES (actual scraped posts, top performers per category — use these to understand what's genuinely working, not just the stats above; do not copy captions verbatim, use them to inform tone/angle/format choices):
${competitorSampleText}

---

BURANCHI'S OWN CURRENT PLAN (already-scheduled posts — do not repeat these dates, headlines, or near-identical angles; vary base/headlineType/frame more than this existing set if it looks repetitive):
${ownPlanText}

---

TASK: Today is ${today}. Generate a content plan of no more than ${maxPosts} post(s) total. ${focus ? `Focus / instructions: ${focus}.` : 'Use a balanced mix per the standing rules — no single focus requested.'}

Read the focus text carefully and figure out the actual dates yourself:
- If it asks for a normal upcoming window (e.g. "next week", or nothing specific), plan forward from today using the Sat/Mon/Wed/Thu-style alternating feed/story cadence described in your instructions, adapted to fit within the ${maxPosts}-post cap.
- If it names or implies specific, non-standard dates — including things like "tanggal kembar" (twin dates: 8/8, 9/9, 10/10, 11/11, 12/12, etc.), a specific holiday, a specific date range, or an explicit list of dates — work out which real calendar date(s) that refers to yourself (relative to today, ${today}) and schedule posts ONLY on those date(s), even if they're non-consecutive or span multiple months. Do not pad the plan with extra unrelated dates just to fill out the cap. Give each such date its own reasoning for format/tone rather than forcing the regular weekly cadence onto it, since these dates were chosen for a specific reason, not as a regular week.

Output ONLY a raw JSON array of post objects matching the Output Contract schema (Section 6 of your instructions). No markdown formatting, no code fences, no commentary — the response body must be valid JSON and nothing else.`;

  async function callGemini(model) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json' }
      })
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`Gemini request failed (${res.status}): ${text.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  try {
    let data;
    try {
      data = await callGemini(GEMINI_MODEL);
    } catch (e) {
      // Transient capacity errors on the primary model — fall back to the lite variant once
      // before giving up, so a busy model doesn't just fail the whole request outright.
      if (e.status === 503 && GEMINI_MODEL !== 'gemini-flash-lite-latest') {
        data = await callGemini('gemini-flash-lite-latest');
      } else {
        throw e;
      }
    }
    const text = data.candidates && data.candidates[0] && data.candidates[0].content.parts.map(p => p.text || '').join('') || '';
    let posts;
    try {
      posts = JSON.parse(text);
    } catch (e) {
      throw new Error('Gemini returned non-JSON output — try again, or narrow the focus text.');
    }
    if (!Array.isArray(posts)) throw new Error('Gemini did not return a posts array.');
    if (posts.length > maxPosts) posts = posts.slice(0, maxPosts); // hard backstop behind the prompt-level cap

    const usage = data.usageMetadata || {};
    posts.forEach(p => { p.generatedBy = 'gemini'; });

    logGeneration(org.slug, {
      timestamp: new Date().toISOString(),
      agent: 'gemini',
      model: data.modelVersion || GEMINI_MODEL,
      focus: focus || null,
      postCount: posts.length,
      tokenUsage: {
        prompt: usage.promptTokenCount || 0,
        thoughts: usage.thoughtsTokenCount || 0,
        output: usage.candidatesTokenCount || 0,
        total: usage.totalTokenCount || 0
      }
    });

    res.json({ ok: true, posts, tokenUsage: { total: usage.totalTokenCount || 0, prompt: usage.promptTokenCount || 0, output: usage.candidatesTokenCount || 0 }, model: data.modelVersion || GEMINI_MODEL });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// --- Guardrails: a small per-org config (max posts per proposal + freeform rule lines) that
// Creative Chat enforces both in its prompt and as a hard server-side cap on every proposal.
const CHAT_HISTORY_LIMIT = 40; // turns kept per conversation before older ones are dropped from the prompt window

function orgChatGuardrailsFile(slug) { return path.join(orgConfigDir(slug), 'chat-guardrails.json'); }
const DEFAULT_GUARDRAILS = {
  maxPostsPerProposal: 10,
  rules: [] // each entry is one standalone guardrail line, not a single freeform blob
};
function loadGuardrails(slug) {
  const g = readJson(orgChatGuardrailsFile(slug), null);
  if (!g) return Object.assign({}, DEFAULT_GUARDRAILS);
  // Older saves stored one freeform "extraRules" string — split it into lines so it still renders as a list.
  const rules = Array.isArray(g.rules)
    ? g.rules
    : (typeof g.extraRules === 'string' ? g.extraRules.split('\n').map(s => s.trim()).filter(Boolean) : []);
  return { maxPostsPerProposal: g.maxPostsPerProposal || DEFAULT_GUARDRAILS.maxPostsPerProposal, rules };
}
function saveGuardrails(slug, guardrails) {
  fs.mkdirSync(orgConfigDir(slug), { recursive: true });
  writeJson(orgChatGuardrailsFile(slug), guardrails);
}

app.get('/api/chat/guardrails', (req, res) => {
  res.json(loadGuardrails(req.session.orgSlug));
});
app.put('/api/chat/guardrails', (req, res) => {
  const body = req.body || {};
  const maxPostsPerProposal = Math.max(1, Math.min(50, parseInt(body.maxPostsPerProposal, 10) || DEFAULT_GUARDRAILS.maxPostsPerProposal));
  const rules = Array.isArray(body.rules)
    ? body.rules.map(r => (r || '').toString().slice(0, 400).trim()).filter(Boolean).slice(0, 30)
    : [];
  const guardrails = { maxPostsPerProposal, rules };
  saveGuardrails(req.session.orgSlug, guardrails);
  res.json({ ok: true, guardrails });
});

function chatConvoTitle(firstUserMessage) {
  const t = (firstUserMessage || '').replace(/\s+/g, ' ').trim();
  return t.length > 42 ? t.slice(0, 42) + '…' : (t || 'New conversation');
}

// --- Creative Intelligence Engine (MVP, Phase 1 per SAKARA_CREATIVE_INTELLIGENCE_ENGINE_SPEC.md) ---
// Three knowledge directories, reusing data this app already has instead of new ingestion:
//   Directory A (historical memory)   -> this org's own posts.json + generation log
//   Directory B (market intelligence) -> the existing competitor analytics snapshot
//   Directory C (brand/strategy)      -> the existing Master Config files
// Two agent personas (both calling Gemini — see chat with the user: no second LLM vendor for
// this MVP) independently read the evidence, the Brand agent also sees the Market agent's
// proposal so it can react to it, and a third "Creative Judge" pass synthesizes both into one
// actionable plan. Nothing here touches posts.json directly — same "propose, then explicit
// confirm" pattern as the Chat AI Agent, reusing /api/posts/bulk for the actual write.
// Directory A — own historical memory: what we've already posted/generated, plus a quick
// frequency tally so the agents can spot repetition/gaps without re-deriving it themselves.
function buildHistoricalMemory(orgSlug) {
  const posts = readPosts(orgSlug);
  if (!posts.length) return 'No historical posts yet — this org has no content-plan history.';
  const formatCounts = {};
  const agentCounts = {};
  posts.forEach(p => {
    formatCounts[p.format] = (formatCounts[p.format] || 0) + 1;
    const a = p.generatedBy || 'unknown';
    agentCounts[a] = (agentCounts[a] || 0) + 1;
  });
  const statsLine = `Format mix: ${Object.entries(formatCounts).map(([k, v]) => `${k}=${v}`).join(', ')}. Source mix: ${Object.entries(agentCounts).map(([k, v]) => `${k}=${v}`).join(', ')}.`;
  const list = posts.slice(-30).map(p => `- ${p.date} (${p.format}): "${p.headline}" — ${p.priority || 'no priority set'}`).join('\n');
  const directoryASummary = buildDirectoryASummary(orgSlug);
  const directoryABlock = directoryASummary
    ? `\n\nCLIENT'S VISUAL/CREATIVE ARCHIVE (synced from their Google Drive — real category/folder names + file counts, not analyzed image-by-image):\n${directoryASummary}\n\nUse this to know what kinds of assets and past campaigns already exist (e.g. don't suggest a fresh photoshoot for something a folder already covers, reference past campaigns by name when relevant) — you cannot see the images themselves. When a post you're proposing genuinely matches something in this archive, set that post's "directoryAKeyword" to one of the EXACT category names listed above (or an exact substring of one, e.g. "Moodboard Photosession" matching "Moodboard Photosession - BR") — never a loose topic word like "pastry" or "pool" that just sounds related. The point is traceability: the user should see which real category a recommendation came from. Compass matches it against the actual archive and attaches a real photo from that category. Leave it "" when no listed category genuinely fits — a wrong guess surfaces an unrelated photo under a false category label, which is worse than no reference.`
    : '';
  return `${statsLine}\n\nRecent posts (up to last 30):\n${list}${directoryABlock}`;
}

function buildIntelligenceContext(org) {
  const readConfig = (id) => { try { return fs.readFileSync(resolveConfigPath(org, id), 'utf8'); } catch (e) { return ''; } };
  const assistantInstructions = org.useSharedConfig
    ? (() => { try { return fs.readFileSync(BURANCHI_CONFIG_FILES['compass-assistant'].path, 'utf8'); } catch (e) { return ''; } })()
    : readConfig('compass-assistant');
  const analyticsData = loadLatestAnalyticsSnapshot(org.slug);
  const recommendations = analyticsData ? computeContentRecommendations(analyticsData.data) : [];
  const recsText = recommendations.length ? recommendations.map(r => '- ' + r.text).join('\n') : 'No competitor recommendations available yet.';
  const competitorSampleText = buildCompetitorSample(analyticsData ? analyticsData.data : null);
  const historicalMemory = buildHistoricalMemory(org.slug);
  return { assistantInstructions, recsText, competitorSampleText, historicalMemory };
}

// `contentsOrText` is either a plain string (wrapped into a single user turn, the common case for
// the standalone agent calls) or a full multi-turn contents array (for a router call that needs
// the conversation's actual history, e.g. Creative Chat's auto-analysis guard).
async function callGeminiJSON(apiKey, systemInstruction, contentsOrText) {
  const contents = typeof contentsOrText === 'string' ? [{ role: 'user', parts: [{ text: contentsOrText }] }] : contentsOrText;
  async function call(model) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents,
        generationConfig: { responseMimeType: 'application/json' }
      })
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      const err = new Error(`Gemini request failed (${r.status}): ${text.slice(0, 300)}`);
      err.status = r.status;
      throw err;
    }
    return r.json();
  }
  // On a long, structurally complex ask (a full multi-post campaign is the clearest example),
  // Gemini occasionally returns output that isn't valid JSON despite responseMimeType being set
  // — a transient sampling issue, not a deterministic one, so a fresh call usually succeeds.
  // Retried here (not left for the user to notice and resend) since it's invisible either way.
  const JSON_RETRY_ATTEMPTS = 3;
  let lastError;
  for (let attempt = 1; attempt <= JSON_RETRY_ATTEMPTS; attempt++) {
    let data;
    try {
      data = await call(GEMINI_MODEL);
    } catch (e) {
      if (e.status === 503 && GEMINI_MODEL !== 'gemini-flash-lite-latest') data = await call('gemini-flash-lite-latest');
      else throw e;
    }
    const rawText = data.candidates && data.candidates[0] && data.candidates[0].content.parts.map(p => p.text || '').join('') || '';
    try {
      const parsed = JSON.parse(rawText);
      const usage = data.usageMetadata || {};
      return { parsed, tokenUsage: { prompt: usage.promptTokenCount || 0, output: usage.candidatesTokenCount || 0, total: usage.totalTokenCount || 0 }, model: data.modelVersion || GEMINI_MODEL };
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error('Gemini returned non-JSON output for the agent step after ' + JSON_RETRY_ATTEMPTS + ' tries — try again.');
}

const MARKET_AGENT_PROMPT = `You are the Market & Visual Intelligence Director for a content planning system. Your job is ONLY to analyze current market/competitor evidence and this brand's historical content, and surface opportunities, saturation, gaps, and visual angles — you do NOT decide what's on-brand, that's someone else's job.

Prioritize in this order: (1) competitor/market evidence, (2) historical content for gaps/repetition, (3) brand context only as a loose fit-check, not your main lens.

Respond with ONLY a raw JSON object matching exactly:
{"marketView": "2-4 paragraph analysis in the user's language", "opportunities": ["short phrase", ...], "saturatedPatterns": ["short phrase", ...], "historicalGaps": ["short phrase", ...], "visualOpportunities": ["short phrase", ...], "avoid": ["short phrase", ...]}`;

const BRAND_AGENT_PROMPT = `You are the Brand & Creative Strategy Director for a content planning system. You decide what is strategically appropriate for THIS brand and how a market opportunity should be adapted, not copied. You will be shown a Market & Visual Intelligence proposal from a colleague — react to it: agree, push back, or adapt it, using the brand's own rules and voice as your primary lens.

Prioritize in this order: (1) brand identity/strategy/standing rules, (2) historical consistency, (3) the market colleague's proposal as context, not gospel — you may reject parts of it that don't fit the brand.

Respond with ONLY a raw JSON object matching exactly:
{"brandView": "2-4 paragraph analysis in the user's language, explicitly reacting to the market proposal", "recommendation": "one clear direction in a sentence or two", "reasoning": ["short phrase", ...], "rejectedFromMarketView": ["short phrase of anything from the market proposal you're rejecting and why, or empty array"]}`;

const CREATIVE_JUDGE_PROMPT = `You are the Creative Judge for a content planning system. You have two proposals — one from a Market & Visual Intelligence Director, one from a Brand & Creative Strategy Director — plus the underlying evidence. Synthesize them into ONE actionable content plan. Reject direct competitor imitation. Flag unresolved assumptions honestly instead of hiding them.

The plan covers the requested period. Dates are relative to the "today" given to you — work them out yourself; don't just start from day 1 unless the request implies that.

Respond with ONLY a raw JSON object matching exactly:
{
  "strategySummary": "3-5 sentence synthesis explaining the final direction and why, in the user's language",
  "contentCalendar": [
    {
      "date": "YYYY-MM-DD", "format": "feed|story", "headline": "...", "sub": "...",
      "campaignPillar": "...", "objective": "...", "contentAngle": "...", "cta": "...",
      "strategicRationale": "1-2 sentences", "priority": "...",
      "photo": "visual description for the mockup", "frame": "yellow-frame|blue-frame|red-frame", "base": "light|dark", "headlineType": "serif|script", "headlinePos": "bottom|top", "badge": "...", "badgePos": "bottom|top", "doodle": ["star"], "event": false,
      "caption": "full caption copy", "persona": "...", "referenceCategory": "", "directoryAKeyword": ""
    }
  ],
  "creativeBriefs": [
    { "contentRef": "matches a contentCalendar date+headline", "objective": "...", "topic": "...", "hook": "...", "visualDirection": ["short phrase", ...], "composition": "...", "mood": "...", "avoid": ["short phrase", ...], "evidence": ["short evidence tag", ...] }
  ],
  "evidence": { "historical": ["short phrase", ...], "market": ["short phrase", ...], "brand": ["short phrase", ...] },
  "assumptions": ["short phrase", ...],
  "confidence": "Low|Medium|Medium-High|High"
}
Every contentCalendar item must have a matching creativeBriefs item. Keep contentCalendar to a sensible size for the requested period — do not pad with filler posts.`;

// Per-agent editable behavior: each agent's real prompt (above) already encodes a set of default
// conditions — these lists are a human-readable mirror of those same conditions, shown read-only
// in the UI, plus an org-editable list of ADDITIONAL conditions appended on top at generate time.
// Keep these in sync with the prose in MARKET_AGENT_PROMPT / BRAND_AGENT_PROMPT / CREATIVE_JUDGE_PROMPT above.
const AGENT_DEFAULT_CONDITIONS = {
  market: [
    "Role: Market & Visual Intelligence Director — reads competitor evidence and this brand's own history.",
    "Priority order: (1) competitor/market evidence, (2) historical gaps/repetition, (3) brand context as a loose fit-check only.",
    "Does not decide what's on-brand — that's the Brand agent's job, not this one.",
    "Surfaces opportunities, saturated patterns, historical gaps, visual opportunities, and things to avoid."
  ],
  brand: [
    "Role: Brand & Creative Strategy Director — decides what's strategically appropriate for this specific brand.",
    "Must explicitly react to the Market agent's proposal: agree, push back, or adapt it — not ignore it.",
    "Priority order: (1) brand identity/strategy/standing rules, (2) historical consistency, (3) the market proposal as context, not gospel.",
    "May reject parts of the market proposal that don't fit the brand, and must say so explicitly."
  ],
  judge: [
    "Role: Creative Judge — synthesizes the Market and Brand proposals into one actionable content plan.",
    "Must reject direct competitor imitation.",
    "Must flag unresolved assumptions honestly instead of hiding them.",
    "Works out real calendar dates relative to today, not just a fixed forward window.",
    "Every content-calendar item must have a matching creative brief.",
    "Does not pad the plan with filler posts just to fill out the requested period."
  ]
};

function orgAgentBehaviorFile(slug) { return path.join(orgConfigDir(slug), 'intelligence-agent-behavior.json'); }
function loadAgentBehavior(slug) {
  const g = readJson(orgAgentBehaviorFile(slug), null);
  return { market: (g && g.market) || [], brand: (g && g.brand) || [], judge: (g && g.judge) || [] };
}
function saveAgentBehavior(slug, cfg) {
  fs.mkdirSync(orgConfigDir(slug), { recursive: true });
  writeJson(orgAgentBehaviorFile(slug), cfg);
}
function withExtraConditions(basePrompt, extraRules) {
  if (!extraRules || !extraRules.length) return basePrompt;
  return `${basePrompt}\n\nADDITIONAL CONDITIONS SET BY THE ORG ADMIN FOR THIS ROLE (follow these strictly, on top of everything above):\n${extraRules.map(r => '- ' + r).join('\n')}`;
}

app.get('/api/intelligence/agent-behavior', (req, res) => {
  const cfg = loadAgentBehavior(req.session.orgSlug);
  res.json({
    market: { defaultConditions: AGENT_DEFAULT_CONDITIONS.market, extraConditions: cfg.market },
    brand: { defaultConditions: AGENT_DEFAULT_CONDITIONS.brand, extraConditions: cfg.brand },
    judge: { defaultConditions: AGENT_DEFAULT_CONDITIONS.judge, extraConditions: cfg.judge }
  });
});

app.put('/api/intelligence/agent-behavior', (req, res) => {
  const body = req.body || {};
  const clean = (arr) => Array.isArray(arr) ? arr.map(r => (r || '').toString().slice(0, 400).trim()).filter(Boolean).slice(0, 30) : [];
  const cfg = { market: clean(body.market), brand: clean(body.brand), judge: clean(body.judge) };
  saveAgentBehavior(req.session.orgSlug, cfg);
  res.json({ ok: true, ...cfg });
});

// Shared by Creative Chat's auto-router below — runs the 3-agent Market->Brand->Judge chain and
// returns a result payload, without touching any conversation/session storage itself (the caller
// decides where the result gets appended/logged). This used to also back a standalone one-shot
// "Creative Intelligence" page; that page was removed once Creative Chat (conversational, with an
// automatic guard deciding when a full analysis is actually needed) fully replaced its purpose.
async function runCreativeIntelligencePipeline(org, requestText, period) {
  const apiKey = org.geminiApiKey || process.env.GEMINI_API_KEY;
  const { assistantInstructions, recsText, competitorSampleText, historicalMemory } = buildIntelligenceContext(org);
  const today = new Date().toISOString().slice(0, 10);
  const evidenceBlock = `TODAY: ${today}\nREQUESTED PERIOD: ${period}\nUSER REQUEST: ${requestText}\n\n--- DIRECTORY A: HISTORICAL MEMORY ---\n${historicalMemory}\n\n--- DIRECTORY B: MARKET / COMPETITOR INTELLIGENCE ---\nComputed recommendations:\n${recsText}\n\nSample competitor posts:\n${competitorSampleText}\n\n--- DIRECTORY C: BRAND / STRATEGY KNOWLEDGE ---\n${assistantInstructions}`;

  const agentBehavior = loadAgentBehavior(org.slug);
  const market = await callGeminiJSON(apiKey, withExtraConditions(MARKET_AGENT_PROMPT, agentBehavior.market), evidenceBlock);
  const brandUserText = `${evidenceBlock}\n\n--- MARKET & VISUAL INTELLIGENCE PROPOSAL FROM YOUR COLLEAGUE ---\n${JSON.stringify(market.parsed)}`;
  const brand = await callGeminiJSON(apiKey, withExtraConditions(BRAND_AGENT_PROMPT, agentBehavior.brand), brandUserText);
  const judgeUserText = `${evidenceBlock}\n\n--- PROPOSAL A (Market & Visual Intelligence Director) ---\n${JSON.stringify(market.parsed)}\n\n--- PROPOSAL B (Brand & Creative Strategy Director) ---\n${JSON.stringify(brand.parsed)}`;
  const judge = await callGeminiJSON(apiKey, withExtraConditions(CREATIVE_JUDGE_PROMPT, agentBehavior.judge), judgeUserText);

  const calendar = Array.isArray(judge.parsed.contentCalendar) ? judge.parsed.contentCalendar : [];
  calendar.forEach(p => { p.generatedBy = 'intelligence'; });

  const totalTokens = {
    market: market.tokenUsage, brand: brand.tokenUsage, judge: judge.tokenUsage,
    total: market.tokenUsage.total + brand.tokenUsage.total + judge.tokenUsage.total
  };
  const resultPayload = { type: 'intelligence-result', request: requestText, period, market: market.parsed, brand: brand.parsed, judge: judge.parsed, tokenUsage: totalTokens, model: judge.model };
  return { resultPayload, calendar, totalTokens };
}

// --- Creative Chat (NEW, experimental menu) ---
// A merged trial of Chat AI Agent + Creative Intelligence in one conversation: normal back-and-forth
// chat (same single-Gemini-call behavior as Chat AI Agent, reusing buildChatSystemInstruction), plus
// an explicit "Run Creative Intelligence" action that runs the same 3-agent Market->Brand->Judge
// pipeline as the Creative Intelligence page and posts the result INTO this conversation's history —
// so every follow-up chat turn after that has full context to answer "why did you..." questions
// cheaply (one normal call), without re-running all 3 agents. Deliberately a separate menu/store
// from both Chat AI Agent and Creative Intelligence — neither of those is touched by this.
function orgCreativeChatFile(slug) { return path.join(orgDataDir(slug), 'creative-chat-conversations.json'); }
function loadCreativeChatConversations(slug) { return readJson(orgCreativeChatFile(slug), []); }
function saveCreativeChatConversations(slug, list) { writeJson(orgCreativeChatFile(slug), list); }

app.get('/api/creative-chat/conversations', (req, res) => {
  const list = loadCreativeChatConversations(req.session.orgSlug)
    .map(c => ({ id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt, messageCount: c.contents.length }))
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  res.json(list);
});

app.post('/api/creative-chat/conversations', (req, res) => {
  const list = loadCreativeChatConversations(req.session.orgSlug);
  const now = new Date().toISOString();
  const convo = { id: Date.now() + '-' + Math.random().toString(36).slice(2, 8), title: 'New conversation', createdAt: now, updatedAt: now, contents: [], committedTurns: [] };
  list.push(convo);
  saveCreativeChatConversations(req.session.orgSlug, list);
  res.json(convo);
});

app.get('/api/creative-chat/conversations/:id', (req, res) => {
  const convo = loadCreativeChatConversations(req.session.orgSlug).find(c => c.id === req.params.id);
  if (!convo) return res.status(404).json({ error: 'Conversation not found' });
  res.json(convo);
});

app.delete('/api/creative-chat/conversations/:id', (req, res) => {
  const list = loadCreativeChatConversations(req.session.orgSlug).filter(c => c.id !== req.params.id);
  saveCreativeChatConversations(req.session.orgSlug, list);
  res.json({ ok: true });
});

app.post('/api/creative-chat/conversations/:id/commit', (req, res) => {
  const list = loadCreativeChatConversations(req.session.orgSlug);
  const convo = list.find(c => c.id === req.params.id);
  if (!convo) return res.status(404).json({ error: 'Conversation not found' });
  const turnIndex = parseInt(req.body && req.body.turnIndex, 10);
  if (!Array.isArray(convo.committedTurns)) convo.committedTurns = [];
  if (!convo.committedTurns.includes(turnIndex)) convo.committedTurns.push(turnIndex);
  saveCreativeChatConversations(req.session.orgSlug, list);
  res.json({ ok: true });
});

// Auto-routing guard: one message in, one Gemini call to DECIDE whether the user wants a brand-new
// content-plan analysis or is just talking (a "why", a tweak, small talk) — then either runs the
// full 3-agent pipeline (and appends its result into this same conversation) or just answers
// conversationally, all from a single Send button. No separate "Run Creative Intelligence" action.
function buildCreativeChatRouterInstruction(assistantInstructions, recsText, competitorSampleText, ownPlanText, today, guardrails) {
  return `${assistantInstructions}

---

LIVE COMPETITOR RECOMMENDATIONS (computed from the current analytics data):
${recsText}

---

REAL COMPETITOR POST SAMPLES (actual scraped posts, top performers per category):
${competitorSampleText}

---

BURANCHI'S OWN CURRENT PLAN (already-scheduled posts — do not repeat these dates, headlines, or near-identical angles):
${ownPlanText}

---

CREATIVE CHAT MODE. Today is ${today}. This is ONE ongoing conversation. It may already contain a full Market + Brand + Judge content-plan analysis from earlier in this same thread — look for a prior turn carrying a "strategySummary" and "contentCalendar"; that is a previous full analysis you can see and reference directly.

For the user's LATEST message only, decide:

Set "needsFullAnalysis": true ONLY when the user is clearly asking you to generate a new content plan/recommendation, or meaningfully redo one (e.g. "buatkan rencana konten untuk...", "generate a plan for...", "bikin ide baru untuk minggu depan"). When true, keep "message" to one short, friendly acknowledgment sentence in the user's language (e.g. "Oke, saya analisis dulu ya berdasarkan data market dan brand kita.") — do not attempt to answer the request yourself; the actual analysis is generated separately right after this and will appear next.

Set "needsFullAnalysis": false for everything else — questions about a previous result ("kenapa...", "gimana kalau...", "jelasin lagi soal..."), clarifications, feedback, casual conversation, or a small tweak that doesn't need fresh market+brand+judge reasoning. When false, answer directly and conversationally in "message", using any earlier analysis already in this conversation as grounding if relevant. Never propose more than ${guardrails.maxPostsPerProposal} posts in "posts" if you do propose any — otherwise leave "posts" null.

You are a text model — you cannot generate, attach, or send actual image files. If asked for one, say so plainly.

${guardrails.rules && guardrails.rules.length ? `ADDITIONAL GUARDRAILS SET BY THE ORG ADMIN:\n${guardrails.rules.map(r => '- ' + r).join('\n')}\n\n---\n` : ''}
Respond with ONLY a raw JSON object, no markdown/code fences, matching exactly:
{"needsFullAnalysis": true or false, "message": "shown as-is in the chat", "posts": null OR an array of post objects matching the Output Contract schema (Section 6 of your instructions)}`;
}

app.post('/api/creative-chat/conversations/:id/message', async (req, res) => {
  const org = findOrgBySlug(req.session.orgSlug);
  if (!org) return res.status(404).json({ ok: false, error: 'Organization not found' });
  const apiKey = org.geminiApiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(400).json({ ok: false, error: 'Gemini API key not configured. Add one via scripts/set-gemini-key.js, then try again.' });

  const userMessage = (req.body && req.body.message || '').trim();
  if (!userMessage) return res.status(400).json({ ok: false, error: 'Message is required.' });

  const list = loadCreativeChatConversations(org.slug);
  const convo = list.find(c => c.id === req.params.id);
  if (!convo) return res.status(404).json({ ok: false, error: 'Conversation not found' });

  const guardrails = loadGuardrails(org.slug);
  const readConfig = (id) => { try { return fs.readFileSync(resolveConfigPath(org, id), 'utf8'); } catch (e) { return ''; } };
  const assistantInstructions = org.useSharedConfig
    ? (() => { try { return fs.readFileSync(BURANCHI_CONFIG_FILES['compass-assistant'].path, 'utf8'); } catch (e) { return ''; } })()
    : readConfig('compass-assistant');
  const analyticsData = loadLatestAnalyticsSnapshot(org.slug);
  const recommendations = analyticsData ? computeContentRecommendations(analyticsData.data) : [];
  const recsText = recommendations.length ? recommendations.map(r => '- ' + r.text).join('\n') : 'No competitor recommendations available yet — proceed using standing rules only.';
  const competitorSampleText = buildCompetitorSample(analyticsData ? analyticsData.data : null);
  const ownPlanText = buildOwnPlanSample(org.slug);
  const today = new Date().toISOString().slice(0, 10);
  const systemInstruction = buildCreativeChatRouterInstruction(assistantInstructions, recsText, competitorSampleText, ownPlanText, today, guardrails);

  const windowedHistory = convo.contents.slice(-CHAT_HISTORY_LIMIT);
  const contents = windowedHistory.concat([{ role: 'user', parts: [{ text: userMessage }] }]);

  try {
    const router = await callGeminiJSON(apiKey, systemInstruction, contents);
    let message = router.parsed.message || '';
    let posts = Array.isArray(router.parsed.posts) ? router.parsed.posts : null;
    const needsFullAnalysis = !!router.parsed.needsFullAnalysis;

    convo.contents.push({ role: 'user', parts: [{ text: userMessage }] });
    if (convo.contents.length === 1) convo.title = chatConvoTitle(userMessage);

    if (!needsFullAnalysis) {
      if (posts && posts.length > guardrails.maxPostsPerProposal) {
        posts = posts.slice(0, guardrails.maxPostsPerProposal);
        message += `\n\n(Dipotong ke ${guardrails.maxPostsPerProposal} post sesuai batas guardrail.)`;
      }
      if (posts) posts.forEach(p => { p.generatedBy = 'gemini-chat'; });

      convo.contents.push({ role: 'model', parts: [{ text: JSON.stringify({ type: 'chat', message, posts, tokenUsage: router.tokenUsage, model: router.model }) }] });
      convo.updatedAt = new Date().toISOString();
      saveCreativeChatConversations(org.slug, list);

      logGeneration(org.slug, {
        timestamp: convo.updatedAt, agent: 'gemini-chat', model: router.model,
        requestText: userMessage, postCount: posts ? posts.length : 0,
        tokenUsage: { prompt: router.tokenUsage.prompt, thoughts: 0, output: router.tokenUsage.output, total: router.tokenUsage.total }
      });

      return res.json({ ok: true, needsFullAnalysis: false, type: 'chat', message, posts, turnIndex: convo.contents.length - 1, tokenUsage: router.tokenUsage, model: router.model });
    }

    // Router decided this needs a fresh analysis — run the 3-agent pipeline now, using the same
    // user message as the request, and append its result right after the acknowledgment turn.
    convo.contents.push({ role: 'model', parts: [{ text: JSON.stringify({ type: 'chat', message, posts: null, tokenUsage: router.tokenUsage, model: router.model }) }] });

    const { resultPayload, calendar, totalTokens } = await runCreativeIntelligencePipeline(org, userMessage, '1 month');
    convo.contents.push({ role: 'model', parts: [{ text: JSON.stringify(resultPayload) }] });
    convo.updatedAt = new Date().toISOString();
    saveCreativeChatConversations(org.slug, list);

    logGeneration(org.slug, {
      timestamp: convo.updatedAt, agent: 'gemini-chat', model: router.model,
      requestText: userMessage, postCount: 0,
      tokenUsage: { prompt: router.tokenUsage.prompt, thoughts: 0, output: router.tokenUsage.output, total: router.tokenUsage.total }
    });
    logGeneration(org.slug, {
      timestamp: convo.updatedAt, agent: 'intelligence', model: resultPayload.model, requestText: userMessage,
      postCount: calendar.length,
      tokenUsage: {
        prompt: totalTokens.market.prompt + totalTokens.brand.prompt + totalTokens.judge.prompt,
        thoughts: 0, output: totalTokens.market.output + totalTokens.brand.output + totalTokens.judge.output,
        total: totalTokens.total
      }
    });

    res.json({ ok: true, needsFullAnalysis: true, ack: message, ackTokenUsage: router.tokenUsage, result: resultPayload, turnIndex: convo.contents.length - 1 });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// Serves the locally-cached competitor thumbnails. Gated by requireAuth (via the middleware
// above) plus an explicit ownership check here — a logged-in user can only ever see their own
// org's cached images, never another org's, even though the file paths are guessable.
app.get('/media/analytics/:slug/:file', (req, res) => {
  if (req.params.slug !== req.session.orgSlug) return res.status(403).end();
  const filePath = path.join(orgImagesDir(req.params.slug), path.basename(req.params.file));
  if (!fs.existsSync(filePath)) return res.status(404).end();
  res.sendFile(filePath);
});

// Serve the two HTML shells ourselves (instead of via express.static below) so we can inject the
// runtime base path — a <base> tag for the browser's own relative-link resolution, and a JS global
// for app.js/login.js to prefix their own fetch() calls with. Every other static asset (style.css,
// app.js, login.js) is unaffected and still comes straight from express.static, since only these
// two documents need per-request HTML rewriting.
function serveShell(file) {
  return (req, res) => {
    let html;
    try { html = fs.readFileSync(path.join(__dirname, 'static', file), 'utf8'); }
    catch (e) { return res.status(404).end(); }
    const inject = `<base href="${BASE_PATH_SLASH}">\n<script>window.APP_BASE=${JSON.stringify(BASE_PATH_SLASH)};</script>`;
    html = html.replace('</head>', inject + '\n</head>');
    res.type('html').send(html);
  };
}
app.get('/index.html', serveShell('index.html'));
app.get('/', serveShell('index.html'));
app.get('/login.html', serveShell('login.html'));

app.use(express.static(path.join(__dirname, 'static')));

app.listen(PORT, () => {
  const orgs = loadOrgs();
  const users = loadInternalUsers();
  console.log(`\n  Wonderland running at http://localhost:${PORT}`);
  console.log(`  Internal logins:`);
  users.forEach(u => console.log(`    - ${u.name}  (${u.username} / ${u.password})${u.isAdmin ? ' [admin]' : ''}`));
  console.log(`  Clients on this instance:`);
  orgs.forEach(o => console.log(`    - ${o.name}  (${o.slug})`));
  console.log(`  Add a client: node scripts/create-org.js <slug> "<Client Name>"`);
  console.log(`  Add a staff login: node scripts/create-internal-user.js <username> <password> "<Full Name>" [admin]\n`);
});
