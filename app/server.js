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
  'brand-visual-identity': { label: 'Brand Visual Identity', desc: 'Logo, color palette, and typography — Sakara\'s visual identity system', file: 'brand-visual-identity.md' },
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

function orgCampaignBriefsFile(slug) { return path.join(orgDataDir(slug), 'campaign-briefs.json'); }
function readCampaignBriefs(slug) { return readJson(orgCampaignBriefsFile(slug), []); }
function writeCampaignBriefs(slug, items) { writeJson(orgCampaignBriefsFile(slug), items); }

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
// that operate before one is picked (me, clients, logout) don't.
function requireActiveClient(req, res, next) {
  if (req.session && req.session.orgSlug) return next();
  return res.status(400).json({ error: 'No client selected' });
}
const CLIENT_AGNOSTIC_API_PATHS = ['/api/me', '/api/clients', '/api/session/client', '/api/logout'];

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

  // This instance is single-client (Buranchi) — skip the client picker and drop straight into
  // it. If more clients ever get added, the picker comes back automatically since this only
  // fires when there's exactly one to choose from anyway.
  const orgs = loadOrgs();
  if (orgs.length === 1) req.session.orgSlug = orgs[0].slug;

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
  res.json(loadOrgs().filter(o => o.active !== false).map(o => ({ slug: o.slug, name: o.name })));
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
    'compass-assistant.md': `# ${name} — Assistant Instructions\n\n(Fill this in via Master Config.)\n`,
    'brand-visual-identity.md': `# Brand Visual Identity — ${name}\n\n(Fill this in via Master Config — logo, color hex codes, typography.)\n`
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

// --- Competitor list management (scoped to the logged-in org's own client — managed inline on
// the Competitor Dashboard). This list is what drives scraping direction: scrapeCompetitorsForOrg()
// only ever scrapes Instagram accounts named here, nothing is ever discovered automatically.
// LinkedIn competitors are stored the same way but never scraped — no LinkedIn pipeline exists yet.
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
  const platform = (req.body && req.body.platform) === 'linkedin' ? 'linkedin' : 'instagram';
  const link = ((req.body && req.body.link) || '').trim();
  if (!name) return res.status(400).json({ error: 'Competitor name is required.' });

  let handle, extra = {};
  if (platform === 'instagram') {
    handle = parseInstagramHandle(link);
    if (!handle) return res.status(400).json({ error: "Couldn't find an Instagram handle in that link." });
  } else {
    if (!link) return res.status(400).json({ error: 'A LinkedIn link is required.' });
    handle = 'li-' + slugify(name);
    extra.linkedinUrl = link;
  }

  org.competitors = org.competitors || [];
  if (org.competitors.find(c => c.handle === handle)) {
    return res.status(400).json({ error: `${name} is already on this client's list.` });
  }
  const color = COMPETITOR_COLOR_PALETTE[org.competitors.length % COMPETITOR_COLOR_PALETTE.length];
  org.competitors.push({ handle, brandName: name, color, platform, ...extra });
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
  if (req.path === '/login.html' || req.path.startsWith('/assets/') || req.path === '/style.css' || req.path === '/login.js' || req.path.startsWith('/brand/') || req.path.startsWith('/fonts/')) {
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

// --- Dashboard (single-org overview, always scoped to whichever org is logged in).
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

// --- Moodboard Studio (scoped to the logged-in org) ---
// Full Wonder-team deck editor per Moodboard-Studio-Wonder-Team-Spec.md: 8 independently-optional
// sections, one JSON object per project/deck. This replaces the earlier simple paste-based
// moodboard. Deviates from the spec's own "single self-contained HTML file" implementation on
// purpose — Wonderland already has a real per-org backend, so deck state is stored there (solving
// the spec's own documented cross-client-copy limitation) and "Generate Moodboard" instead produces
// a downloadable standalone HTML file (client-side), since this app has no public/anon link hosting.
// The client-facing intake side (companion spec, not provided) is out of scope — every field here
// is filled by the Wonder team directly, no auto-population from a client submission.
function orgMoodboardDecksFile(slug) { return path.join(orgDataDir(slug), 'moodboard-decks.json'); }
function readMoodboardDecks(slug) { return readJson(orgMoodboardDecksFile(slug), []); }
function writeMoodboardDecks(slug, decks) { writeJson(orgMoodboardDecksFile(slug), decks); }

function orgMoodboardBookingsFile(slug) { return path.join(orgDataDir(slug), 'moodboard-bookings.json'); }
function readMoodboardBookings(slug) { return readJson(orgMoodboardBookingsFile(slug), []); }
function writeMoodboardBookings(slug, bookings) { writeJson(orgMoodboardBookingsFile(slug), bookings); }

const BLANK_MOODBOARD_DECK = () => ({
  meta: { studioName: '', clientName: '', projectTitle: '', year: new Date().getFullYear(), confidentialNote: '', coverImage: null },
  intention: { concept: '', directionTitle: '', lighting: '', vibe: '', focus: '', clientLikes: '', clientEvaluation: '', teamDiscernment: '', anchorWords: ['', '', ''], boundaries: '', directionImage: null },
  whereWhen: { locationName: '', address: '', date: '', crewStandby: '', sessionTime: '', locationImages: [], rundown: [] },
  shotlist: { shots: [] },
  backgrounds: { concepts: [] },
  props: { providedItems: [], noPropsNote: '', buyItems: [] },
  styling: { items: [] },
  closing: { thankYouNote: '', nextStepsNote: '' }
});

app.get('/api/moodboard-studio', (req, res) => {
  const decks = readMoodboardDecks(req.session.orgSlug);
  res.json(decks.map(d => ({ id: d.id, title: d.meta.projectTitle || '(untitled)', clientName: d.meta.clientName, date: d.whereWhen.date, updatedAt: d.updatedAt, createdAt: d.createdAt })));
});

app.get('/api/moodboard-studio/:id', (req, res) => {
  const deck = readMoodboardDecks(req.session.orgSlug).find(d => d.id === req.params.id);
  if (!deck) return res.status(404).json({ error: 'Moodboard not found' });
  res.json(deck);
});

app.post('/api/moodboard-studio', (req, res) => {
  const decks = readMoodboardDecks(req.session.orgSlug);
  const now = new Date().toISOString();
  const deck = Object.assign(BLANK_MOODBOARD_DECK(), { id: Date.now() + '-' + Math.random().toString(36).slice(2, 8), createdAt: now, updatedAt: now });
  decks.push(deck);
  writeMoodboardDecks(req.session.orgSlug, decks);
  res.json(deck);
});

app.put('/api/moodboard-studio/:id', (req, res) => {
  const decks = readMoodboardDecks(req.session.orgSlug);
  const idx = decks.findIndex(d => d.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Moodboard not found' });
  const { id, createdAt, ...rest } = req.body || {};
  decks[idx] = Object.assign({}, decks[idx], rest, { id: decks[idx].id, createdAt: decks[idx].createdAt, updatedAt: new Date().toISOString() });
  writeMoodboardDecks(req.session.orgSlug, decks);
  res.json(decks[idx]);
});

app.delete('/api/moodboard-studio/:id', (req, res) => {
  let decks = readMoodboardDecks(req.session.orgSlug);
  decks = decks.filter(d => d.id !== req.params.id);
  writeMoodboardDecks(req.session.orgSlug, decks);
  res.json({ ok: true });
});

// Bookings are shared across every deck for this client, not per-deck — per §4's own
// recommendation, so availability stays consistent no matter which deck a session is booked from.
app.get('/api/moodboard-bookings', (req, res) => res.json(readMoodboardBookings(req.session.orgSlug)));

app.post('/api/moodboard-bookings', (req, res) => {
  const bookings = readMoodboardBookings(req.session.orgSlug);
  const b = req.body || {};
  if (!b.date || !b.start || !b.hours) return res.status(400).json({ error: 'date, start, and hours are required' });
  b.id = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  bookings.push(b);
  writeMoodboardBookings(req.session.orgSlug, bookings);
  res.json(b);
});

app.delete('/api/moodboard-bookings/:id', (req, res) => {
  let bookings = readMoodboardBookings(req.session.orgSlug);
  bookings = bookings.filter(b => b.id !== req.params.id);
  writeMoodboardBookings(req.session.orgSlug, bookings);
  res.json({ ok: true });
});

// --- Campaign Briefs API (scoped to the logged-in org) ---
app.get('/api/campaign-briefs', (req, res) => res.json(readCampaignBriefs(req.session.orgSlug)));

app.post('/api/campaign-briefs', (req, res) => {
  const briefs = readCampaignBriefs(req.session.orgSlug);
  const brief = req.body || {};
  if (!brief.title) return res.status(400).json({ error: 'Campaign name is required.' });
  brief.id = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  brief.createdAt = new Date().toISOString();
  briefs.push(brief);
  writeCampaignBriefs(req.session.orgSlug, briefs);
  res.json(brief);
});

app.delete('/api/campaign-briefs/:id', (req, res) => {
  let briefs = readCampaignBriefs(req.session.orgSlug);
  briefs = briefs.filter(b => b.id !== req.params.id);
  writeCampaignBriefs(req.session.orgSlug, briefs);
  res.json({ ok: true });
});

// --- Canva integration (Design CRUD + Brand Template autofill only — no Magic Media/Magic
// Design/generative anything). Wonderland stays the copywriting layer; this hands structured
// fields to a pre-built Canva Brand Template and lets a designer take it from there.
//
// Endpoint paths, param names, and scopes below follow Canva's public Connect API docs
// (canva.dev/docs/connect) as of when this was written. Canva's API is still evolving —
// verify each one against the current docs once real OAuth credentials exist; nothing here
// has been tested against the live API.
//
// Requires CANVA_CLIENT_ID and CANVA_CLIENT_SECRET (Canva Developer Portal — needs a Canva
// Enterprise/Teams plan for Brand Template + Autofill API access) as env vars. One OAuth2 app
// for the whole instance; each org connects (or doesn't) its own Canva account/token.
const CANVA_CLIENT_ID = process.env.CANVA_CLIENT_ID;
const CANVA_CLIENT_SECRET = process.env.CANVA_CLIENT_SECRET;
const CANVA_SCOPES = 'asset:read asset:write brandtemplate:meta:read brandtemplate:content:read design:content:read design:content:write design:meta:read profile:read';

function canvaRedirectUri(req) {
  return `${req.protocol}://${req.get('host')}${BASE_PATH_SLASH}api/canva/oauth/callback`;
}
function base64url(buf) { return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

function orgCanvaTokenFile(slug) { return path.join(orgDataDir(slug), 'canva-token.json'); }
function loadCanvaToken(slug) { return readJson(orgCanvaTokenFile(slug), null); }
function saveCanvaToken(slug, token) { writeJson(orgCanvaTokenFile(slug), token); }
function clearCanvaToken(slug) { try { fs.unlinkSync(orgCanvaTokenFile(slug)); } catch (e) {} }

// Refreshes automatically when the stored token is within 60s of expiry. Returns null if never
// connected, so callers can surface "connect your Canva account first" instead of a raw API error.
async function getCanvaAccessToken(org) {
  const token = loadCanvaToken(org.slug);
  if (!token) return null;
  if (token.expiresAt - Date.now() > 60 * 1000) return token.accessToken;

  const r = await fetch('https://api.canva.com/rest/v1/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token', refresh_token: token.refreshToken,
      client_id: CANVA_CLIENT_ID, client_secret: CANVA_CLIENT_SECRET
    })
  });
  if (!r.ok) { clearCanvaToken(org.slug); return null; }
  const data = await r.json();
  const refreshed = {
    accessToken: data.access_token, refreshToken: data.refresh_token || token.refreshToken,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000, connectedName: token.connectedName
  };
  saveCanvaToken(org.slug, refreshed);
  return refreshed.accessToken;
}

app.get('/api/canva/status', async (req, res) => {
  const org = findOrgBySlug(req.session.orgSlug);
  if (!CANVA_CLIENT_ID || !CANVA_CLIENT_SECRET) return res.json({ configured: false, connected: false });
  const token = loadCanvaToken(org.slug);
  res.json({ configured: true, connected: !!token, connectedName: token ? token.connectedName : null, templates: org.canvaTemplates || {} });
});

app.get('/api/canva/connect', (req, res) => {
  if (!CANVA_CLIENT_ID || !CANVA_CLIENT_SECRET) {
    return res.status(400).send('Canva is not configured yet — CANVA_CLIENT_ID / CANVA_CLIENT_SECRET are not set on the server.');
  }
  const verifier = base64url(crypto.randomBytes(64));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  req.session.canvaVerifier = verifier;
  req.session.canvaOrgSlug = req.session.orgSlug; // callback runs before requireActiveClient re-checks, so pin it explicitly

  const params = new URLSearchParams({
    code_challenge: challenge, code_challenge_method: 'S256', response_type: 'code',
    client_id: CANVA_CLIENT_ID, redirect_uri: canvaRedirectUri(req), scope: CANVA_SCOPES
  });
  res.redirect('https://www.canva.com/api/oauth/authorize?' + params.toString());
});

app.get('/api/canva/oauth/callback', async (req, res) => {
  const { code } = req.query;
  const verifier = req.session.canvaVerifier;
  const slug = req.session.canvaOrgSlug;
  if (!code || !verifier || !slug) return res.status(400).send('Canva connection failed — missing code/verifier. Try connecting again.');

  try {
    const r = await fetch('https://api.canva.com/rest/v1/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code, code_verifier: verifier,
        client_id: CANVA_CLIENT_ID, client_secret: CANVA_CLIENT_SECRET, redirect_uri: canvaRedirectUri(req)
      })
    });
    if (!r.ok) throw new Error(await r.text());
    const data = await r.json();

    let connectedName = null;
    try {
      const profileRes = await fetch('https://api.canva.com/rest/v1/users/me/profile', { headers: { Authorization: 'Bearer ' + data.access_token } });
      if (profileRes.ok) connectedName = (await profileRes.json()).display_name || null;
    } catch (e) {}

    saveCanvaToken(slug, {
      accessToken: data.access_token, refreshToken: data.refresh_token,
      expiresAt: Date.now() + (data.expires_in || 3600) * 1000, connectedName
    });
    res.redirect(BASE_PATH_SLASH + '#canva');
  } catch (e) {
    res.status(400).send('Canva connection failed: ' + e.message);
  }
});

app.post('/api/canva/disconnect', (req, res) => {
  clearCanvaToken(req.session.orgSlug);
  res.json({ ok: true });
});

app.get('/api/canva/brand-templates', async (req, res) => {
  const org = findOrgBySlug(req.session.orgSlug);
  const accessToken = await getCanvaAccessToken(org);
  if (!accessToken) return res.status(400).json({ error: 'Canva not connected yet.' });
  try {
    const r = await fetch('https://api.canva.com/rest/v1/brand-templates', { headers: { Authorization: 'Bearer ' + accessToken } });
    if (!r.ok) throw new Error(await r.text());
    const data = await r.json();
    res.json({ ok: true, templates: (data.items || []).map(t => ({ id: t.id, title: t.title, thumbnailUrl: t.thumbnail && t.thumbnail.url })) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/canva/template-mapping', (req, res) => {
  const orgs = loadOrgs();
  const org = orgs.find(o => o.slug === req.session.orgSlug);
  if (!org) return res.status(404).json({ error: 'Organization not found' });
  org.canvaTemplates = req.body && req.body.templates || {};
  saveOrgs(orgs);
  res.json({ ok: true, templates: org.canvaTemplates });
});

// Uploads one image (base64, no data: prefix) to Canva as an asset. Canva's upload endpoint takes
// raw binary with a JSON metadata header, not a JSON body — different shape from the rest of this API.
async function uploadCanvaAsset(accessToken, name, mimeType, base64Data) {
  const r = await fetch('https://api.canva.com/rest/v1/asset-uploads', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + accessToken,
      'Content-Type': 'application/octet-stream',
      'Asset-Upload-Metadata': JSON.stringify({ name })
    },
    body: Buffer.from(base64Data, 'base64')
  });
  if (!r.ok) throw new Error('Canva asset upload failed: ' + await r.text());
  const { job } = await r.json();
  for (let attempt = 0; attempt < 20; attempt++) {
    const jr = await fetch(`https://api.canva.com/rest/v1/asset-uploads/${job.id}`, { headers: { Authorization: 'Bearer ' + accessToken } });
    const jdata = (await jr.json()).job;
    if (jdata.status === 'success') return jdata.asset.id;
    if (jdata.status === 'failed') throw new Error('Canva asset upload job failed.');
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error('Canva asset upload timed out.');
}

// Runs a Brand Template autofill job to completion and returns the resulting design's edit link.
async function runCanvaAutofill(accessToken, brandTemplateId, title, data) {
  const r = await fetch('https://api.canva.com/rest/v1/autofills', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ brand_template_id: brandTemplateId, title, data })
  });
  if (!r.ok) throw new Error('Canva autofill failed: ' + await r.text());
  const { job } = await r.json();

  let design;
  for (let attempt = 0; attempt < 20; attempt++) {
    const jr = await fetch(`https://api.canva.com/rest/v1/autofills/${job.id}`, { headers: { Authorization: 'Bearer ' + accessToken } });
    const jdata = (await jr.json()).job;
    if (jdata.status === 'success') { design = jdata.result.design; break; }
    if (jdata.status === 'failed') throw new Error('Canva autofill job failed.');
    await new Promise(r => setTimeout(r, 1500));
  }
  if (!design) throw new Error('Canva autofill timed out.');

  const dr = await fetch(`https://api.canva.com/rest/v1/designs/${design.id}`, { headers: { Authorization: 'Bearer ' + accessToken } });
  const ddata = dr.ok ? (await dr.json()).design : null;
  return {
    designId: design.id,
    editUrl: (ddata && ddata.urls && ddata.urls.edit_url) || design.url || null,
    thumbnailUrl: (ddata && ddata.thumbnail && ddata.thumbnail.url) || null
  };
}

// Sends one saved Campaign Brief's visual copywriting + first reference image to a Canva Brand
// Template via autofill, and stores the resulting design link back on the brief.
app.post('/api/canva/autofill/brief/:id', async (req, res) => {
  const org = findOrgBySlug(req.session.orgSlug);
  const accessToken = await getCanvaAccessToken(org);
  if (!accessToken) return res.status(400).json({ error: 'Canva not connected yet.' });

  const templateId = (org.canvaTemplates || {})[req.body && req.body.templateKey || 'briefCover'];
  if (!templateId) return res.status(400).json({ error: 'No Canva template mapped for this format yet — set one on the Canva page.' });

  const briefs = readCampaignBriefs(org.slug);
  const brief = briefs.find(b => b.id === req.params.id);
  if (!brief) return res.status(404).json({ error: 'Brief not found' });
  const vc = brief.visualCopywriting;
  if (!vc) return res.status(400).json({ error: 'Generate and select a visual copywriting option first.' });

  try {
    const data = {
      Headline: { type: 'text', text: vc.headline || '' },
      Subheadline: { type: 'text', text: vc.sub || '' }
    };
    const firstImage = (brief.referenceImages || [])[0];
    if (firstImage && firstImage.kind === 'upload') {
      const assetId = await uploadCanvaAsset(accessToken, firstImage.name, firstImage.mimeType, firstImage.data);
      data.Photo = { type: 'image', asset_id: assetId };
    }
    const result = await runCanvaAutofill(accessToken, templateId, brief.title, data);
    brief.canva = result;
    writeCampaignBriefs(org.slug, briefs);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// --- Master config API (scoped to the logged-in org) ---
function configEntriesFile(slug, id) { return path.join(orgConfigDir(slug), `${id}.entries.json`); }

function resolveConfigPath(org, id) {
  // Shared-config orgs (Buranchi) read the 4 original files from the external Marketing/_context
  // folder. A config key added later (like brand-visual-identity) that was never part of that
  // external set falls through to the normal per-org local file instead of a hard 404.
  // Once someone adds/edits an entry via the list UI for one of those 4 (configEntriesFile exists
  // locally), this org+id "forks" to its own local copy from then on — the shared external file
  // is only ever a read-only seed, never overwritten by in-app edits.
  if (org.useSharedConfig && BURANCHI_CONFIG_FILES[id] && !fs.existsSync(configEntriesFile(org.slug, id))) {
    return BURANCHI_CONFIG_FILES[id].path;
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

// Each Master Config category (Brand Context, Brand Voice, ...) is really a *list* of entries —
// short text notes or attached reference images/files, addable/editable/removable one at a time —
// rather than one giant hand-edited document. The flat .md file at resolveConfigPath() still
// exists and still is what every AI generation call in this app reads; it's just now a derived,
// auto-regenerated concatenation of the text entries below, kept in sync on every add/edit/remove
// so nothing else in the codebase needs to change.
function loadConfigEntries(org, id) {
  const entriesPath = configEntriesFile(org.slug, id);
  const existing = readJson(entriesPath, null);
  if (existing) return existing;
  // First time this category is opened under the new list UI — migrate whatever was already
  // there (the old single hand-edited file, shared or local) into one seed entry so nothing
  // written before this feature existed is lost.
  let legacyContent = '';
  try { legacyContent = fs.readFileSync(resolveConfigPath(org, id), 'utf8'); } catch (e) { /* nothing to migrate */ }
  const seeded = legacyContent && legacyContent.trim()
    ? [{ id: crypto.randomUUID(), type: 'text', title: 'Original content', content: legacyContent, createdAt: new Date().toISOString() }]
    : [];
  writeJson(entriesPath, seeded);
  return seeded;
}

function regenerateConfigFile(org, id, entries) {
  const meta = CONFIG_LABELS[id];
  if (!meta) return;
  const localPath = path.join(orgConfigDir(org.slug), meta.file);
  const combined = entries.map(e => e.type === 'text'
    ? `## ${e.title || 'Untitled'}\n\n${e.content || ''}`
    : `## ${e.title || e.name || 'Attachment'}\n\n(Attached image — see Master Config in the app to view it.)`
  ).join('\n\n---\n\n');
  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  fs.writeFileSync(localPath, combined, 'utf8');
}

app.get('/api/config/:id/entries', (req, res) => {
  const org = findOrgBySlug(req.session.orgSlug);
  if (!CONFIG_LABELS[req.params.id]) return res.status(404).json({ error: 'Unknown config file' });
  res.json(loadConfigEntries(org, req.params.id));
});

app.post('/api/config/:id/entries', (req, res) => {
  const org = findOrgBySlug(req.session.orgSlug);
  const id = req.params.id;
  const meta = CONFIG_LABELS[id];
  if (!meta) return res.status(404).json({ error: 'Unknown config file' });
  const { type, title, content, mimeType, data } = req.body || {};
  let entry;
  if (type === 'file') {
    if (!mimeType || !mimeType.startsWith('image/') || !data) return res.status(400).json({ error: 'A valid image (mimeType + base64 data) is required.' });
    entry = { id: crypto.randomUUID(), type: 'file', title: title || 'Attachment', mimeType, data, createdAt: new Date().toISOString() };
  } else {
    if (!content || !content.trim()) return res.status(400).json({ error: 'Content is required.' });
    entry = { id: crypto.randomUUID(), type: 'text', title: title || 'Untitled', content, createdAt: new Date().toISOString() };
  }
  const entries = loadConfigEntries(org, id);
  entries.push(entry);
  writeJson(configEntriesFile(org.slug, id), entries);
  regenerateConfigFile(org, id, entries);
  appendConfigHistory(org.slug, entry.type === 'file'
    ? { type: 'image', label: `${meta.label}: "${entry.title}" added`, mimeType: entry.mimeType, data: entry.data, assetId: entry.id }
    : { type: 'text', configId: id, label: `${meta.label}: "${entry.title}" added`, content: entry.content });
  res.status(201).json(entry);
});

app.put('/api/config/:id/entries/:entryId', (req, res) => {
  const org = findOrgBySlug(req.session.orgSlug);
  const id = req.params.id;
  const meta = CONFIG_LABELS[id];
  if (!meta) return res.status(404).json({ error: 'Unknown config file' });
  const { title, content } = req.body || {};
  const entries = loadConfigEntries(org, id);
  const entry = entries.find(e => e.id === req.params.entryId && e.type === 'text');
  if (!entry) return res.status(404).json({ error: 'Entry not found (only text entries can be edited — remove and re-add a file entry instead).' });
  if (typeof title === 'string') entry.title = title;
  if (typeof content === 'string') entry.content = content;
  writeJson(configEntriesFile(org.slug, id), entries);
  regenerateConfigFile(org, id, entries);
  appendConfigHistory(org.slug, { type: 'text', configId: id, label: `${meta.label}: "${entry.title}" updated`, content: entry.content });
  res.json(entry);
});

app.delete('/api/config/:id/entries/:entryId', (req, res) => {
  const org = findOrgBySlug(req.session.orgSlug);
  const id = req.params.id;
  const meta = CONFIG_LABELS[id];
  if (!meta) return res.status(404).json({ error: 'Unknown config file' });
  const entries = loadConfigEntries(org, id);
  const entry = entries.find(e => e.id === req.params.entryId);
  const next = entries.filter(e => e.id !== req.params.entryId);
  writeJson(configEntriesFile(org.slug, id), next);
  regenerateConfigFile(org, id, next);
  if (entry) appendConfigHistory(org.slug, { type: entry.type === 'file' ? 'image' : 'text', label: `${meta.label}: "${entry.title}" removed`, content: '(removed)' });
  res.json({ ok: true });
});

// --- Master Config update history — every text save or image upload becomes one entry in a
// single chronological log per org, so someone can see "what changed and when" across all 5
// files plus brand images without hunting through each file separately. Capped so the log file
// can't grow unbounded (image entries carry their own base64 data, which adds up).
function configHistoryFile(slug) { return path.join(orgDataDir(slug), 'master-config-history.json'); }
const MAX_HISTORY_ENTRIES = 30;
function appendConfigHistory(slug, entry) {
  const history = readJson(configHistoryFile(slug), []);
  history.unshift({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), ...entry });
  writeJson(configHistoryFile(slug), history.slice(0, MAX_HISTORY_ENTRIES));
}

app.get('/api/master-config-history', (req, res) => {
  res.json(readJson(configHistoryFile(req.session.orgSlug), []));
});

app.put('/api/config/:id', (req, res) => {
  const org = findOrgBySlug(req.session.orgSlug);
  const filePath = org && resolveConfigPath(org, req.params.id);
  if (!filePath) return res.status(404).json({ error: 'Unknown config file' });
  const { content } = req.body || {};
  if (typeof content !== 'string') return res.status(400).json({ error: 'content must be a string' });
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
  const label = (CONFIG_LABELS[req.params.id] || {}).label || req.params.id;
  appendConfigHistory(org.slug, { type: 'text', configId: req.params.id, label: `${label} updated`, content });
  res.json({ ok: true });
});

// --- Brand Summary — an AI synthesis of the 5 Master Config files (+ any uploaded brand
// images) into a short "at a glance" brief, so nobody has to read all 5 docs before writing
// content for a client. Generated on demand (never automatically) and cached per org, so it
// only costs a Gemini call when someone actually asks for a refresh.
function brandSummaryFile(slug) { return path.join(orgDataDir(slug), 'brand-summary.json'); }
function brandAssetsFile(slug) { return path.join(orgDataDir(slug), 'brand-assets.json'); }
const MAX_BRAND_ASSETS = 6;

app.get('/api/brand-summary', (req, res) => {
  res.json(readJson(brandSummaryFile(req.session.orgSlug), { summary: null, generatedAt: null }));
});

app.get('/api/brand-assets', (req, res) => {
  res.json(readJson(brandAssetsFile(req.session.orgSlug), []));
});

app.post('/api/brand-assets', (req, res) => {
  const { name, mimeType, data } = req.body || {};
  if (!mimeType || !mimeType.startsWith('image/') || !data) return res.status(400).json({ error: 'A valid image (mimeType + base64 data) is required.' });
  const assets = readJson(brandAssetsFile(req.session.orgSlug), []);
  if (assets.length >= MAX_BRAND_ASSETS) return res.status(400).json({ error: `Max ${MAX_BRAND_ASSETS} brand images — remove one first.` });
  const asset = { id: crypto.randomUUID(), name: name || 'image', mimeType, data, uploadedAt: new Date().toISOString() };
  assets.push(asset);
  writeJson(brandAssetsFile(req.session.orgSlug), assets);
  appendConfigHistory(req.session.orgSlug, { type: 'image', label: `Image uploaded: ${asset.name}`, mimeType: asset.mimeType, data: asset.data, assetId: asset.id });
  res.status(201).json(asset);
});

app.delete('/api/brand-assets/:id', (req, res) => {
  const assets = readJson(brandAssetsFile(req.session.orgSlug), []);
  writeJson(brandAssetsFile(req.session.orgSlug), assets.filter(a => a.id !== req.params.id));
  res.json({ ok: true });
});

const BRAND_SUMMARY_PROMPT = `You are synthesizing a brand's Master Config files (Brand Context, Brand Voice, Ideal Customer Profile, Brand Visual Identity, and Assistant Instructions) — plus any brand images provided — into a short "at a glance" brief for someone about to write content for this brand today, who hasn't read the full files.

Return strict JSON with this shape, nothing else:
{
  "oneLiner": "one sentence capturing what this brand is and its core differentiator",
  "positioning": "2-3 sentences on positioning and current priorities",
  "toneWords": ["3-6 short words/phrases describing the voice"],
  "targetAudience": "2-3 sentences on who this content is for",
  "visualIdentity": "2-3 sentences on the visual system — colors, typography, logo usage, and what the provided images show if any",
  "keyRules": ["3-6 short standing rules or guardrails to never violate"]
}

If a section has no real source material, say so plainly in that field instead of inventing anything ("Not documented yet" style) — never fabricate specifics.`;

app.post('/api/brand-summary/generate', async (req, res) => {
  const org = findOrgBySlug(req.session.orgSlug);
  const apiKey = org.geminiApiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(400).json({ error: 'No Gemini API key configured for this client.' });

  const fileIds = ['brand-context', 'brand-voice', 'icp', 'brand-visual-identity', 'compass-assistant'];
  const sections = fileIds.map(id => {
    const filePath = resolveConfigPath(org, id);
    let content = '';
    try { content = fs.readFileSync(filePath, 'utf8'); } catch (e) { /* not written yet */ }
    return `### ${CONFIG_LABELS[id].label}\n${content || '(empty)'}`;
  }).join('\n\n');

  const assets = readJson(brandAssetsFile(org.slug), []);
  const entryImages = fileIds.flatMap(id => loadConfigEntries(org, id).filter(e => e.type === 'file'));
  const imageParts = [...assets, ...entryImages].map(a => ({ inlineData: { mimeType: a.mimeType, data: a.data } }));
  const contents = [{ role: 'user', parts: [{ text: sections }, ...imageParts] }];

  try {
    const { parsed } = await callGeminiJSON(apiKey, BRAND_SUMMARY_PROMPT, contents);
    const result = { summary: parsed, generatedAt: new Date().toISOString() };
    writeJson(brandSummaryFile(org.slug), result);
    res.json(result);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
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

// Auto-provisioning from Sakara Ops — every Sakara Ops client gets its own
// lightweight org here (just enough for the Ads/Competitors bridge to work:
// slug, name, active flag, empty competitors list), kept in sync whenever
// that client is created/renamed/deleted on the Sakara Ops side. Deliberately
// skips the posts.json/config template scaffolding create-org.js writes for a
// real Wonderland content-planning client — these orgs only exist so Sakara
// Ops has somewhere to point its Compass Org Slug at, not to run the content
// planner. `active: false` (never a hard delete) is the same soft-delete
// philosophy Sakara Ops itself uses for clients — history stays, just hidden.
app.post('/api/bridge/orgs', requireBridgeSecret, (req, res) => {
  const { slug, name } = req.body || {};
  if (!slug || !name) return res.status(400).json({ ok: false, error: 'slug and name are required' });
  if (!/^[a-z0-9-]+$/.test(slug)) return res.status(400).json({ ok: false, error: 'slug must be lowercase letters, numbers, and hyphens only' });
  const orgs = loadOrgs();
  const existing = orgs.find(o => o.slug === slug);
  if (existing) {
    existing.name = name;
    existing.active = true;
    saveOrgs(orgs);
    return res.json({ ok: true, slug, created: false });
  }
  orgs.push({ slug, name, useSharedConfig: false, active: true, competitors: [], createdAt: new Date().toISOString() });
  saveOrgs(orgs);
  res.json({ ok: true, slug, created: true });
});

app.patch('/api/bridge/orgs/:slug', requireBridgeSecret, (req, res) => {
  const orgs = loadOrgs();
  const org = orgs.find(o => o.slug === req.params.slug);
  if (!org) return res.status(404).json({ ok: false, error: 'Organization not found' });
  if (req.body.name !== undefined) org.name = req.body.name;
  if (req.body.active !== undefined) org.active = !!req.body.active;
  saveOrgs(orgs);
  res.json({ ok: true });
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

  // maxPostsPerProposal (Chat AI Agent > Guardrails) is a hard ceiling shared with the other
  // generation surfaces; totalCount from the question box is a request within that ceiling, not
  // a replacement for it. Gemini decides the actual dates itself from the context text (e.g.
  // "tanggal kembar Agustus-September" should land on non-consecutive dates spanning two months,
  // not just "the next N days from today").
  const guardrails = loadGuardrails(org.slug);
  const maxPosts = guardrails.maxPostsPerProposal;
  const body = req.body || {};
  const requestedTotal = Number.isFinite(parseInt(body.totalCount, 10)) && parseInt(body.totalCount, 10) > 0 ? parseInt(body.totalCount, 10) : null;
  const feedCount = Number.isFinite(parseInt(body.feedCount, 10)) && parseInt(body.feedCount, 10) >= 0 ? parseInt(body.feedCount, 10) : null;
  const storyCount = Number.isFinite(parseInt(body.storyCount, 10)) && parseInt(body.storyCount, 10) >= 0 ? parseInt(body.storyCount, 10) : null;
  const totalCount = Math.min(requestedTotal || maxPosts, maxPosts);
  const clamped = !!requestedTotal && requestedTotal > maxPosts;

  const goal = (body.goal || '').trim();
  const products = (body.products || '').trim();
  const occasion = (body.occasion || '').trim();
  const specialRequest = (body.specialRequest || '').trim();
  const contextLines = [];
  if (goal) contextLines.push(`Goal of this content plan: ${goal}`);
  if (products) contextLines.push(`Products to be highlighted: ${products}`);
  if (occasion) contextLines.push(`Special occasion: ${occasion}`);
  if (specialRequest) contextLines.push(`Special request: ${specialRequest}`);
  const attachments = Array.isArray(body.attachments) ? body.attachments : [];
  const focus = contextLines.join('\n') + buildAttachmentText(attachments);
  const imageParts = attachments.filter(a => a && a.kind === 'image' && a.mimeType && a.content).map(a => ({ inlineData: { mimeType: a.mimeType, data: a.content } }));

  // The two modes need genuinely different instructions, not just a tone tweak: "before photo
  // shoot" is a shot brief for content that doesn't exist yet; "existing database" must NOT
  // invent new shoot direction and instead point at what's already in Directory A.
  const mode = body.mode === 'existingDatabase' ? 'existingDatabase' : 'beforeShoot';
  const directoryASummary = buildDirectoryASummary(org.slug);
  const modeBlock = mode === 'existingDatabase'
    ? `EXISTING-ASSET MODE: These posts must be built around content that has already been captured — do NOT invent new photo/video shoot direction. For every post, set "directoryAKeyword" to a short keyword/phrase (a folder or file name fragment) that would match the right existing asset below, and write the "photo" field describing which existing shot/style to reuse, not a new one to go capture.

EXISTING ASSET LIBRARY (synced from the client's Google Drive — Directory A):
${directoryASummary || "Not synced yet — no existing asset library data is available. Say so plainly in a post's strategicRationale rather than inventing folder names, and fall back to Master Config's brand/product descriptions only."}`
    : `SHOOT MODE: These posts have NOT been photographed yet — this plan doubles as a shoot brief. For every post, the "photo" field must be concrete, actionable direction for the photographer/videographer: subject, framing/angle, lighting, props, location, and any reference points (competitor posts, mood boards, style) to shoot toward. Describe what needs to be captured, not a photo that already exists.`;

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

${modeBlock}

---

TASK: Today is ${today}. Generate a content plan of exactly ${totalCount} post(s) total${feedCount !== null || storyCount !== null ? ` (aim for ${feedCount || 0} feed and ${storyCount || 0} story — adjust slightly if it doesn't add up to ${totalCount}, but stay close)` : ''}. ${focus ? `Context provided by the user:\n${focus}` : 'Use a balanced mix per the standing rules — no specific context given.'}

Read the context above carefully and figure out the actual dates yourself:
- If it asks for a normal upcoming window (e.g. "next week", or nothing specific), plan forward from today using the Sat/Mon/Wed/Thu-style alternating feed/story cadence described in your instructions, adapted to fit within the ${totalCount}-post cap.
- If it names or implies specific, non-standard dates — including things like "tanggal kembar" (twin dates: 8/8, 9/9, 10/10, 11/11, 12/12, etc.), a specific holiday, a specific date range, or an explicit list of dates — work out which real calendar date(s) that refers to yourself (relative to today, ${today}) and schedule posts ONLY on those date(s), even if they're non-consecutive or span multiple months. Do not pad the plan with extra unrelated dates just to fill out the cap. Give each such date its own reasoning for format/tone rather than forcing the regular weekly cadence onto it, since these dates were chosen for a specific reason, not as a regular week.

Output ONLY a raw JSON array of post objects matching the Output Contract schema (Section 6 of your instructions). No markdown formatting, no code fences, no commentary — the response body must be valid JSON and nothing else.`;

  async function callGemini(model) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }, ...imageParts] }],
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
    if (posts.length > totalCount) posts = posts.slice(0, totalCount); // hard backstop behind the prompt-level cap

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

    res.json({
      ok: true, posts, tokenUsage: { total: usage.totalTokenCount || 0, prompt: usage.promptTokenCount || 0, output: usage.candidatesTokenCount || 0 },
      model: data.modelVersion || GEMINI_MODEL,
      note: clamped ? `Requested ${requestedTotal} posts, clamped to the org's guardrail max of ${maxPosts}.` : null
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// Writes the "Visual Copywriting" section of a Campaign Brief — headline/sub/caption, a few
// distinct options to choose from — grounded in the brief's own fields (background, audience,
// objective, timeline, channels, terms) rather than a dated content-plan cadence. Reference
// images the user attached are sent along as visual context, same inlineData shape Creative
// Chat uses for image attachments.
app.post('/api/generate-brief', async (req, res) => {
  const org = findOrgBySlug(req.session.orgSlug);
  if (!org) return res.status(404).json({ ok: false, error: 'Organization not found' });
  const apiKey = org.geminiApiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(400).json({ ok: false, error: 'Gemini API key not configured. Add one via scripts/set-model-key.js, then try again.' });

  const body = req.body || {};
  const title = (body.title || '').trim();
  const background = (body.background || '').trim();
  const audience = (body.audience || '').trim();
  const objective = (body.objective || '').trim();
  const timeline = (body.timeline || '').trim();
  const channels = (body.channels || '').trim();
  const terms = (body.terms || '').trim();
  const refLinks = (body.refLinks || '').trim();
  const draftHeadline = (body.draftHeadline || '').trim();
  const draftSub = (body.draftSub || '').trim();
  const draftCaption = (body.draftCaption || '').trim();
  const referenceImages = Array.isArray(body.referenceImages) ? body.referenceImages : [];

  if (!draftHeadline && !draftSub && !draftCaption) {
    return res.status(400).json({ ok: false, error: 'Write a draft headline, sub-headline, or caption first — rephrasing needs something to work from.' });
  }

  const readConfig = (id) => { try { return fs.readFileSync(resolveConfigPath(org, id), 'utf8'); } catch (e) { return ''; } };
  const assistantInstructions = org.useSharedConfig
    ? (() => { try { return fs.readFileSync(BURANCHI_CONFIG_FILES['compass-assistant'].path, 'utf8'); } catch (e) { return ''; } })()
    : readConfig('compass-assistant');

  const briefText = `Campaign name: ${title || '(untitled)'}
Campaign Background: ${background || '(not given)'}
Target Audience: ${audience || '(not given)'}
Campaign Objective: ${objective || '(not given)'}
Timeline Campaign: ${timeline || '(not given)'}
Media Channels: ${channels || '(not given)'}
Terms and Condition Campaign: ${terms || '(not given)'}
References Content (existing posts, tone/format reference only, not to copy): ${refLinks || '(none given)'}

--- DRAFT WORDING TO REPHRASE (this is the actual source of truth for content) ---
Draft headline: ${draftHeadline || '(none given)'}
Draft sub-headline: ${draftSub || '(none given)'}
Draft caption: ${draftCaption || '(none given)'}`;

  const systemInstruction = `${assistantInstructions}

---

CAMPAIGN BRIEF MODE — REPHRASE ONLY. The user already wrote their own draft headline/sub-headline/caption below. Your job is ONLY to reword it, not to write new copy from scratch. Do not invent new facts, offers, dates, products, or angles that aren't already in the draft or the brief context above — every option must carry the exact same message, offer, and details as the draft, just phrased differently (tone, sentence structure, word choice). If a draft field was left blank, leave it blank in every option too rather than inventing content for it.

Give exactly 3 rephrased variations. Use the brief context (audience, objective, channel) only to judge tone/register — never to add content the draft didn't have. If reference images are attached, they're mood/style context only, not something to describe.

Respond with ONLY a raw JSON object matching exactly:
{"strategySummary": "1-2 sentence note on what changed between the draft and these options (tone/phrasing only), in the user's language", "options": [{"headline": "...", "sub": "...", "caption": "..."}, {"headline": "...", "sub": "...", "caption": "..."}, {"headline": "...", "sub": "...", "caption": "..."}]}`;

  const imageParts = referenceImages.filter(a => a && a.mimeType && a.data).map(a => ({ inlineData: { mimeType: a.mimeType, data: a.data } }));
  const contents = [{ role: 'user', parts: [{ text: briefText }, ...imageParts] }];

  try {
    const result = await callGeminiJSON(apiKey, systemInstruction, contents);
    const options = Array.isArray(result.parsed.options) ? result.parsed.options : [];
    logGeneration(org.slug, {
      timestamp: new Date().toISOString(), agent: 'gemini', model: result.model,
      requestText: `Campaign brief: ${title || '(untitled)'}`, postCount: 0, tokenUsage: result.tokenUsage
    });
    res.json({ ok: true, strategySummary: result.parsed.strategySummary || '', options, tokenUsage: result.tokenUsage, model: result.model });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// A briefRefImages entry is either an upload (already has base64 mimeType/data from the client)
// or a database pick (competitor/internal — only a refKey + display url, no bytes). This resolves
// either kind to real inlineData bytes so BOTH count as visual context for generation, not just
// uploads — reuses the exact same local-file resolution Campaign Board's Judge already does.
function resolveBriefRefImageInline(org, ref) {
  if (ref.kind === 'upload' && ref.mimeType && ref.data) return { inlineData: { mimeType: ref.mimeType, data: ref.data } };
  if (ref.kind === 'internal') {
    const fileId = (ref.refKey || '').replace(/^internal:/, '');
    return readLocalImageAsInlineData(path.join(orgDirectoryAThumbsDir(org.slug), fileId + '.jpg'));
  }
  if (ref.kind === 'competitor') {
    const postUrl = (ref.refKey || '').replace(/^competitor:/, '');
    const snapshot = loadLatestAnalyticsSnapshot(org.slug);
    const post = ((snapshot && snapshot.data && snapshot.data.posts) || []).find(p => p.url === postUrl);
    if (!post || !post.display_url || !post.display_url.startsWith('/media/analytics/')) return null;
    return readLocalImageAsInlineData(path.join(orgImagesDir(org.slug), path.basename(post.display_url)));
  }
  return null;
}

const CAMPAIGN_BRIEF_DRAFT_PROMPT = `You are a senior copywriter drafting the FIRST version of an Instagram headline, sub-headline, and caption for a campaign brief — not rephrasing anything, writing it from scratch. Base it on the brief fields given (background, audience, objective, channels, terms) and, if shown, the attached reference images — look at what's actually in them (subject, mood, setting) and let that inform the angle, don't just treat them as generic mood board filler.

Write in the same language the brief itself is written in. Keep it grounded in what the brief actually says — don't invent offers, prices, dates, or products it didn't mention.

Respond with ONLY a raw JSON object matching exactly:
{"headline": "...", "sub": "...", "caption": "...", "strategySummary": "1-2 sentences on the angle you took and why, in the user's language"}`;

app.post('/api/generate-brief-draft', async (req, res) => {
  const org = findOrgBySlug(req.session.orgSlug);
  if (!org) return res.status(404).json({ ok: false, error: 'Organization not found' });
  const apiKey = org.geminiApiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(400).json({ ok: false, error: 'Gemini API key not configured. Add one via scripts/set-model-key.js, then try again.' });

  const body = req.body || {};
  const title = (body.title || '').trim();
  const background = (body.background || '').trim();
  const audience = (body.audience || '').trim();
  const objective = (body.objective || '').trim();
  const channels = (body.channels || '').trim();
  const terms = (body.terms || '').trim();
  const referenceImages = Array.isArray(body.referenceImages) ? body.referenceImages : [];

  if (!background && !audience && !objective) {
    return res.status(400).json({ ok: false, error: 'Fill in at least the background, audience, or objective first — generation needs something to work from.' });
  }

  const briefText = `Campaign name: ${title || '(untitled)'}
Campaign Background: ${background || '(not given)'}
Target Audience: ${audience || '(not given)'}
Campaign Objective: ${objective || '(not given)'}
Media Channels: ${channels || '(not given)'}
Terms and Condition Campaign: ${terms || '(not given)'}`;

  const imageParts = referenceImages.slice(0, 10).map(r => resolveBriefRefImageInline(org, r)).filter(Boolean);
  const contents = [{ role: 'user', parts: [{ text: briefText }, ...imageParts] }];

  try {
    const result = await callGeminiJSON(apiKey, CAMPAIGN_BRIEF_DRAFT_PROMPT, contents);
    logGeneration(org.slug, {
      timestamp: new Date().toISOString(), agent: 'gemini', model: result.model,
      requestText: `Campaign brief draft: ${title || '(untitled)'}`, postCount: 0, tokenUsage: result.tokenUsage
    });
    res.json({
      ok: true, headline: result.parsed.headline || '', sub: result.parsed.sub || '', caption: result.parsed.caption || '',
      strategySummary: result.parsed.strategySummary || '', tokenUsage: result.tokenUsage, model: result.model
    });
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

// --- Multi-provider Creative Chat ---
// Gemini keeps its full auto-router + Market->Brand->Judge pipeline below (it's a bespoke
// structured-JSON pipeline, not something worth re-deriving per provider). Claude/GPT/Kimi are a
// simpler direct conversational call sharing the same brand/market context, so the user can compare
// tone and token cost across providers without the auto-analysis step, which stays Gemini-only.
function orgProviderApiKey(org, provider) {
  if (provider === 'claude') return org.claudeApiKey || process.env.ANTHROPIC_API_KEY;
  if (provider === 'gpt') return org.openaiApiKey || process.env.OPENAI_API_KEY;
  if (provider === 'kimi') return org.kimiApiKey || process.env.KIMI_API_KEY;
  return org.geminiApiKey || process.env.GEMINI_API_KEY;
}
const PROVIDER_KEY_SETUP_HINT = {
  gemini: 'node scripts/set-model-key.js <org-slug> gemini <key> (or scripts/set-gemini-key.js)',
  claude: 'node scripts/set-model-key.js <org-slug> claude <key>',
  gpt: 'node scripts/set-model-key.js <org-slug> gpt <key>',
  kimi: 'node scripts/set-model-key.js <org-slug> kimi <key>'
};

// Text attachments get inlined into the prompt text (same spirit as the .md paste flow elsewhere
// in the app); image attachments are handled separately per-provider since each API wants images
// in its own message-content shape.
function buildAttachmentText(attachments) {
  const textAttachments = (attachments || []).filter(a => a.kind === 'text');
  if (!textAttachments.length) return '';
  return '\n\n' + textAttachments.map(a => `--- ATTACHED FILE: ${a.name} ---\n${a.content}`).join('\n\n');
}

// Turns a stored conversation turn (which for 'model' turns is a JSON blob — {type:'chat',...} or
// {type:'intelligence-result',...} — not plain text) into plain readable text, so history stays
// coherent for a plain chat model even after switching providers mid-conversation.
function extractTurnText(turn) {
  const raw = (turn.parts && turn.parts[0] && turn.parts[0].text) || '';
  if (turn.role === 'user') return raw;
  try {
    const parsed = JSON.parse(raw);
    if (parsed.type === 'intelligence-result') return (parsed.judge && parsed.judge.strategySummary) || '[ran a full content-plan analysis]';
    return parsed.message || '';
  } catch (e) {
    return raw;
  }
}

function buildSimpleChatSystemInstruction(assistantInstructions, recsText, competitorSampleText, ownPlanText, today) {
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

CREATIVE CHAT MODE. Today is ${today}. Chat naturally with the user about Buranchi's content strategy, using the context above. The user may attach images or text files — read and use them. You are a text model — you cannot generate, attach, or send actual new image files yourself, only describe or discuss what's given to you. Reply in the user's language, plainly — no markdown code fences, no JSON, just your message as normal chat text.`;
}

async function callClaudeChat(apiKey, systemInstruction, history, userMessage, attachments) {
  const imageBlocks = (attachments || []).filter(a => a.kind === 'image').map(a => ({
    type: 'image', source: { type: 'base64', media_type: a.mimeType, data: a.content }
  }));
  const messages = history.map(turn => ({ role: turn.role === 'model' ? 'assistant' : 'user', content: extractTurnText(turn) }))
    .concat([{ role: 'user', content: imageBlocks.length ? [...imageBlocks, { type: 'text', text: userMessage }] : userMessage }]);

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 2048, system: systemInstruction, messages })
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`Claude request failed (${r.status}): ${text.slice(0, 300)}`);
  }
  const data = await r.json();
  const message = (data.content || []).map(b => b.text || '').join('');
  const usage = data.usage || {};
  const prompt = usage.input_tokens || 0, output = usage.output_tokens || 0;
  return { message, tokenUsage: { prompt, output, total: prompt + output }, model: data.model || 'claude' };
}

// Shared by GPT (OpenAI) and Kimi (Moonshot AI) — both speak the same Chat Completions shape.
async function callOpenAICompatibleChat(baseUrl, apiKey, model, systemInstruction, history, userMessage, attachments) {
  const imageParts = (attachments || []).filter(a => a.kind === 'image').map(a => ({
    type: 'image_url', image_url: { url: `data:${a.mimeType};base64,${a.content}` }
  }));
  const messages = [{ role: 'system', content: systemInstruction }]
    .concat(history.map(turn => ({ role: turn.role === 'model' ? 'assistant' : 'user', content: extractTurnText(turn) })))
    .concat([{ role: 'user', content: imageParts.length ? [...imageParts, { type: 'text', text: userMessage }] : userMessage }]);

  const r = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages })
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`${model} request failed (${r.status}): ${text.slice(0, 300)}`);
  }
  const data = await r.json();
  const message = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
  const usage = data.usage || {};
  return { message, tokenUsage: { prompt: usage.prompt_tokens || 0, output: usage.completion_tokens || 0, total: usage.total_tokens || 0 }, model: data.model || model };
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

const CHAT_PROVIDERS = ['gemini', 'claude', 'gpt', 'kimi'];

app.post('/api/creative-chat/conversations/:id/message', async (req, res) => {
  const org = findOrgBySlug(req.session.orgSlug);
  if (!org) return res.status(404).json({ ok: false, error: 'Organization not found' });

  const provider = CHAT_PROVIDERS.includes(req.body && req.body.provider) ? req.body.provider : 'gemini';
  const apiKey = orgProviderApiKey(org, provider);
  if (!apiKey) return res.status(400).json({ ok: false, error: `No API key configured for ${provider}. Add one via: ${PROVIDER_KEY_SETUP_HINT[provider]}` });

  const userMessage = (req.body && req.body.message || '').trim();
  const attachments = Array.isArray(req.body && req.body.attachments) ? req.body.attachments : [];
  if (!userMessage && !attachments.length) return res.status(400).json({ ok: false, error: 'Message is required.' });
  const userMessageForModel = userMessage + buildAttachmentText(attachments);

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
  const windowedHistory = convo.contents.slice(-CHAT_HISTORY_LIMIT);

  if (provider !== 'gemini') {
    try {
      const simpleSystemInstruction = buildSimpleChatSystemInstruction(assistantInstructions, recsText, competitorSampleText, ownPlanText, today);
      const call = provider === 'claude'
        ? callClaudeChat(apiKey, simpleSystemInstruction, windowedHistory, userMessageForModel, attachments)
        : callOpenAICompatibleChat(
            provider === 'gpt' ? 'https://api.openai.com/v1' : 'https://api.moonshot.ai/v1',
            apiKey, provider === 'gpt' ? 'gpt-5' : 'moonshot-v1-32k-vision-preview',
            simpleSystemInstruction, windowedHistory, userMessageForModel, attachments
          );
      const result = await call;

      convo.contents.push({ role: 'user', parts: [{ text: userMessage || '(attachment only)' }] });
      if (convo.contents.length === 1) convo.title = chatConvoTitle(userMessage || attachments.map(a => a.name).join(', '));
      convo.contents.push({ role: 'model', parts: [{ text: JSON.stringify({ type: 'chat', message: result.message, posts: null, tokenUsage: result.tokenUsage, model: result.model }) }] });
      convo.updatedAt = new Date().toISOString();
      saveCreativeChatConversations(org.slug, list);

      const agentKey = provider + '-chat';
      logGeneration(org.slug, {
        timestamp: convo.updatedAt, agent: agentKey, model: result.model,
        requestText: userMessage, postCount: 0,
        tokenUsage: { prompt: result.tokenUsage.prompt, thoughts: 0, output: result.tokenUsage.output, total: result.tokenUsage.total }
      });

      return res.json({ ok: true, needsFullAnalysis: false, type: 'chat', message: result.message, posts: null, turnIndex: convo.contents.length - 1, tokenUsage: result.tokenUsage, model: result.model });
    } catch (e) {
      return res.status(400).json({ ok: false, error: e.message });
    }
  }

  const systemInstruction = buildCreativeChatRouterInstruction(assistantInstructions, recsText, competitorSampleText, ownPlanText, today, guardrails);
  const imageParts = attachments.filter(a => a.kind === 'image').map(a => ({ inlineData: { mimeType: a.mimeType, data: a.content } }));
  const contents = windowedHistory.concat([{ role: 'user', parts: [{ text: userMessageForModel }, ...imageParts] }]);

  try {
    const router = await callGeminiJSON(apiKey, systemInstruction, contents);
    let message = router.parsed.message || '';
    let posts = Array.isArray(router.parsed.posts) ? router.parsed.posts : null;
    const needsFullAnalysis = !!router.parsed.needsFullAnalysis;

    convo.contents.push({ role: 'user', parts: [{ text: userMessage || '(attachment only)' }] });
    if (convo.contents.length === 1) convo.title = chatConvoTitle(userMessage || attachments.map(a => a.name).join(', '));

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

// --- Campaign Board: iterative AI creative-decision workspace layered on top of a saved
// Campaign Brief. Retrieves 4 categories of visual reference (A=Directory A/historical,
// B=Competitor, C=Pinterest/Behance external search, D=personal upload from the brief), runs a
// single Gemini vision call to reason about which to use and produce concrete creative
// direction, then lets the user refine that decision in plain language. Each round is appended
// as a new conversation turn and never overwrites the last — same "the conversation IS the
// version history" pattern as Creative Chat above, reusing the exact same shape.
function orgCampaignBoardsFile(slug) { return path.join(orgDataDir(slug), 'campaign-boards.json'); }
function loadCampaignBoards(slug) { return readJson(orgCampaignBoardsFile(slug), []); }
function saveCampaignBoards(slug, list) { writeJson(orgCampaignBoardsFile(slug), list); }
function orgCampaignBoardMediaDir(slug) { return path.join(orgDataDir(slug), 'campaign-board-media'); }

// Downloads and caches an external (Pinterest/Behance) image once so its refKey stays valid even
// if the source CDN blocks hotlinking or the pin/project is deleted later — same "download once,
// never re-fetch" approach as cacheDisplayImages() above, just keyed by an md5 of the source id
// instead of an Instagram shortCode.
async function cacheCampaignBoardImage(slug, sourceUrl, idHint) {
  const dir = orgCampaignBoardMediaDir(slug);
  fs.mkdirSync(dir, { recursive: true });
  const filename = crypto.createHash('md5').update(idHint || sourceUrl).digest('hex') + '.jpg';
  const filePath = path.join(dir, filename);
  if (!fs.existsSync(filePath)) {
    const res = await fetch(sourceUrl);
    if (!res.ok) return null;
    fs.writeFileSync(filePath, Buffer.from(await res.arrayBuffer()));
  }
  return filename;
}

function readLocalImageAsInlineData(filePath) {
  try {
    return { inlineData: { mimeType: 'image/jpeg', data: fs.readFileSync(filePath).toString('base64') } };
  } catch (e) {
    return null;
  }
}

app.get('/media/campaign-board/:slug/:file', (req, res) => {
  if (req.params.slug !== req.session.orgSlug) return res.status(403).end();
  const filePath = path.join(orgCampaignBoardMediaDir(req.params.slug), path.basename(req.params.file));
  if (!fs.existsSync(filePath)) return res.status(404).end();
  res.sendFile(filePath);
});

// Category C retrieval — a scoped keyword search against one of two freshly-connected Apify
// actors, not a blind pull. Input shapes below were confirmed from real test runs already made
// on the account (fatihtahta/pinterest-scraper-search wants a search URL; headlessagent/
// behance-search-scraper wants query arrays), not guessed from docs.
app.post('/api/campaign-board/search-external', async (req, res) => {
  const org = findOrgBySlug(req.session.orgSlug);
  const { source, query } = req.body || {};
  if (!query || !query.trim()) return res.status(400).json({ error: 'A search keyword is required.' });
  const token = org.apifyToken || process.env.APIFY_API_TOKEN;
  if (!token) return res.status(400).json({ error: 'Apify API token not configured. Add one via scripts/set-apify-token.js, then try again.' });

  try {
    let items;
    if (source === 'pinterest') {
      const r = await fetch(`https://api.apify.com/v2/acts/fatihtahta~pinterest-scraper-search/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          startUrls: [`https://www.pinterest.com/search/pins/?q=${encodeURIComponent(query)}`],
          type: 'all-pins', limit: 40,
          proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] }
        })
      });
      if (!r.ok) throw new Error(`Apify request failed (${r.status}): ${(await r.text().catch(() => '')).slice(0, 300)}`);
      const raw = await r.json();
      if (!Array.isArray(raw)) throw new Error('Unexpected response shape from Apify.');
      items = raw.slice(0, 24).map(p => ({
        id: p.id || p.pinId || p.link,
        name: (p.title || p.description || 'Pinterest pin').slice(0, 80),
        imageUrl: p.imageUrl || p.image || (p.images && p.images.orig && p.images.orig.url),
        sourceLink: p.link || p.pinUrl
      })).filter(p => p.imageUrl);
    } else if (source === 'behance') {
      const r = await fetch(`https://api.apify.com/v2/acts/headlessagent~behance-search-scraper/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageQueries: [query], maxResults: 20 })
      });
      if (!r.ok) throw new Error(`Apify request failed (${r.status}): ${(await r.text().catch(() => '')).slice(0, 300)}`);
      const raw = await r.json();
      if (!Array.isArray(raw)) throw new Error('Unexpected response shape from Apify.');
      items = raw.slice(0, 24).map(p => ({
        id: p.id || p.url,
        name: (p.title || p.name || 'Behance result').slice(0, 80),
        imageUrl: p.imageUrl || p.image || p.thumbnail,
        sourceLink: p.url || p.projectUrl
      })).filter(p => p.imageUrl);
    } else {
      return res.status(400).json({ error: 'source must be "pinterest" or "behance"' });
    }

    const cached = [];
    for (const item of items) {
      const filename = await cacheCampaignBoardImage(org.slug, item.imageUrl, source + ':' + item.id);
      if (!filename) continue;
      cached.push({
        refKey: `external:${source}:${item.id}`, name: item.name,
        url: `/media/campaign-board/${org.slug}/${filename}`, sourceLink: item.sourceLink, localFile: filename
      });
    }
    res.json({ ok: true, results: cached });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

const CAMPAIGN_BOARD_JUDGE_PROMPT = `You are the AI Judge for a Campaign Board — a workspace that helps an agency pick reference visuals before production, by comparing four categories:
A — Historical/Internal: the brand's own past visual archive. Role: brand guardrail. Question: what have we done before?
B — Competitor: scraped competitor posts. Role: market benchmark. Question: what is the market doing?
C — External (Pinterest/Behance): outside creative inspiration the user searched for. Role: primary creative inspiration. Question: what else is creatively possible?
D — Personal: reference images the user uploaded themselves. Role: user intent. Question: what does the user already have in mind?

You will be shown labeled candidate images from some or all of these categories, plus the campaign brief, and — if this is a refinement round — the previous decision and the user's new feedback (treat that feedback as an explicit constraint, not a suggestion).

For each category that has candidates, silently pick your single best pick — judge for relevance to the brief, not technical polish. Do not explain the pick; the field for that is gone from the output on purpose.

Your other job: many briefs are typed quickly and casually by whoever's filling the form, not written carefully. Rewrite each brief field into polished, professional marketing language an expert strategist would write — same facts, same intent, same core meaning, just properly worded. Never invent new claims, numbers, or details that weren't in the original. If a field was already well-written, keep it close to as-is rather than padding it.

You also own the actual Instagram post copy (headline/sub-headline/caption) — you'll be shown the current copy (either a first draft or what you wrote last round). On a fresh round with no feedback yet, keep it as-is unless it's clearly weak. On a refinement round, this is the MAIN thing user feedback usually targets ("ganti headline", "kurang menarik", etc.) — if feedback says anything about the headline/caption/wording, actually change it accordingly; don't just leave it identical to last round while only touching the brief fields above.

Respond with ONLY a raw JSON object matching exactly:
{
  "decision": {
    "primary": {"refKey": "...", "category": "A|B|C|D"} | null,
    "supporting": {"refKey": "...", "category": "A|B|C|D"} | null,
    "marketBenchmark": {"refKey": "...", "category": "B"} | null,
    "personal": {"refKey": "...", "category": "D"} | null
  },
  "polishedBrief": {"background": "...", "audience": "...", "objective": "...", "channels": "...", "terms": "..."},
  "postCopy": {"headline": "...", "sub": "...", "caption": "..."}
}
Never invent a refKey that wasn't shown to you. Leave a polishedBrief field "" if the original brief field was empty — don't fabricate content for it.`;

// Ranks candidates by how many brief keywords show up in whatever text is actually available for
// them (Directory A only has filenames/folder paths; competitor posts have real captions) — used
// to pick relevant material for the Judge to look at instead of an arbitrary "first N" slice.
function briefKeywordsFor(brief) {
  const raw = [brief.title, brief.background, brief.audience, brief.objective, brief.terms].filter(Boolean).join(' ').toLowerCase();
  const stop = new Set(['this', 'that', 'with', 'from', 'have', 'will', 'your', 'their', 'about', 'which', 'into', 'more', 'than', 'then', 'were', 'been', 'they', 'them']);
  return [...new Set(raw.split(/[^a-z0-9]+/).filter(w => w.length > 3 && !stop.has(w)))];
}
function textRelevanceScore(text, keywords) {
  const lower = (text || '').toLowerCase();
  return keywords.reduce((score, kw) => score + (lower.includes(kw) ? 1 : 0), 0);
}

// Directory A mirrors a client's whole Drive, which usually holds more than finished visual
// work — planning-tool screenshots, spreadsheets, brand-mark exports. Those keep matching a
// brief's own vocabulary suspiciously well (a "Screenshot Planner" folder full of files
// literally named "Feeds"/"Stories" kept winning against real photography) without being
// usable creative reference, so they're excluded before scoring even starts rather than left
// for the relevance score to (incorrectly) rank highly.
const DIRECTORY_A_NON_REFERENCE_PATTERN = /screenshot|planner|\blogo\b/i;
function isLikelyVisualReference(file) {
  return !DIRECTORY_A_NON_REFERENCE_PATTERN.test(`${file.path || ''} ${file.name || ''}`);
}

async function runCampaignBoardJudge(org, brief, priorVersion, feedback, externalRefs) {
  const apiKey = org.geminiApiKey || process.env.GEMINI_API_KEY;
  const briefKeywords = briefKeywordsFor(brief);

  const manifest = loadDirectoryAManifest(org.slug);
  const candA = ((manifest && manifest.files) || [])
    .filter(f => f.hasThumbnail && isLikelyVisualReference(f))
    .map(f => ({
      refKey: 'internal:' + f.id, name: f.name, localPath: path.join(orgDirectoryAThumbsDir(org.slug), f.id + '.jpg'),
      score: textRelevanceScore(f.name + ' ' + (f.path || ''), briefKeywords)
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);

  const snapshot = loadLatestAnalyticsSnapshot(org.slug);
  const candB = (() => {
    const allB = ((snapshot && snapshot.data && snapshot.data.posts) || [])
      .filter(p => p.display_url && p.display_url.startsWith('/media/analytics/'));
    const byAccount = {};
    allB.forEach(p => { (byAccount[p.account || p.brand_name || 'unknown'] = byAccount[p.account || p.brand_name || 'unknown'] || []).push(p); });
    Object.values(byAccount).forEach(list => {
      list.sort((a, b) => textRelevanceScore(`${b.caption || ''} ${b.category || ''}`, briefKeywords) - textRelevanceScore(`${a.caption || ''} ${a.category || ''}`, briefKeywords));
    });
    // Round-robin across every tracked competitor account (ranked by brief relevance within
    // each account first) so all of them get a chance to be seen by the Judge — a plain top-N
    // slice on the raw post list let whichever account scraped first silently crowd out others.
    const accountKeys = Object.keys(byAccount);
    const picked = [];
    for (let round = 0; picked.length < 6 && accountKeys.some(k => byAccount[k][round]); round++) {
      accountKeys.forEach(k => { if (picked.length < 6 && byAccount[k][round]) picked.push(byAccount[k][round]); });
    }
    return picked.map(p => ({
      refKey: 'competitor:' + p.url, name: `${p.brand_name || ''} — ${p.category || ''}`,
      localPath: path.join(orgImagesDir(org.slug), path.basename(p.display_url))
    }));
  })();

  const candC = (externalRefs || []).slice(0, 12).map(r => ({
    refKey: r.refKey, name: r.name, localPath: path.join(orgCampaignBoardMediaDir(org.slug), r.localFile)
  }));

  const candD = ((brief.referenceImages || []).filter(i => i.kind === 'upload')).slice(0, 6).map((i, idx) => ({
    refKey: 'personal:' + idx, name: i.name || `Upload ${idx + 1}`, inline: { inlineData: { mimeType: i.mimeType, data: i.data } }
  }));

  const parts = [];
  const labelLines = [];
  [['A', candA], ['B', candB], ['C', candC], ['D', candD]].forEach(([cat, list]) => {
    list.forEach(c => {
      const inline = c.inline || readLocalImageAsInlineData(c.localPath);
      if (!inline) return;
      parts.push(inline);
      labelLines.push(`[${cat}] refKey="${c.refKey}" name="${c.name}"`);
    });
  });

  const briefText = `CAMPAIGN BRIEF
Title: ${brief.title || ''}
Background: ${brief.background || ''}
Audience: ${brief.audience || ''}
Objective: ${brief.objective || ''}
Channels: ${brief.channels || ''}
Terms/constraints: ${brief.terms || ''}`;

  // The post copy carries forward from round to round (prior version's postCopy once one
  // exists, else the brief's original draft/generated copy) so feedback like "ganti headline"
  // has something concrete to actually change instead of the Judge inventing from nothing.
  const currentCopy = (priorVersion && priorVersion.postCopy) || brief.visualCopywriting || {};
  const priorText = priorVersion ? `\n\nPREVIOUS DECISION:\n${JSON.stringify(priorVersion.decision)}\n${JSON.stringify(priorVersion.polishedBrief)}` : '';
  const copyText = `\n\nCURRENT POST COPY (headline/sub/caption — refine this, don't ignore it):\n${JSON.stringify(currentCopy)}`;
  const feedbackText = feedback ? `\n\nUSER FEEDBACK ON THE PREVIOUS DECISION (treat as explicit constraint): ${feedback}` : '';

  const textPart = { text: `${briefText}${priorText}${copyText}${feedbackText}\n\nCANDIDATE IMAGES SHOWN BELOW, IN ORDER:\n${labelLines.join('\n') || '(no candidates available)'}` };
  const contents = [{ role: 'user', parts: [textPart, ...parts] }];

  const { parsed, tokenUsage, model } = await callGeminiJSON(apiKey, CAMPAIGN_BOARD_JUDGE_PROMPT, contents);

  const versionPayload = {
    type: 'board-version',
    version: priorVersion ? priorVersion.version + 1 : 1,
    references: {
      A: candA.map(c => ({ refKey: c.refKey, name: c.name, url: `/media/directory-a/${org.slug}/${path.basename(c.localPath)}` })),
      B: candB.map(c => ({ refKey: c.refKey, name: c.name, url: `/media/analytics/${org.slug}/${path.basename(c.localPath)}` })),
      C: (externalRefs || []).map(r => ({ refKey: r.refKey, name: r.name, url: r.url })),
      D: candD.map(c => ({ refKey: c.refKey, name: c.name, url: `data:${c.inline.inlineData.mimeType};base64,${c.inline.inlineData.data}` }))
    },
    decision: parsed.decision,
    polishedBrief: parsed.polishedBrief,
    postCopy: parsed.postCopy || currentCopy,
    tokenUsage, model
  };
  return { versionPayload };
}

app.get('/api/campaign-boards', (req, res) => {
  const briefId = req.query.briefId;
  const list = loadCampaignBoards(req.session.orgSlug).filter(b => !briefId || b.briefId === briefId);
  res.json(list.map(b => ({
    id: b.id, briefId: b.briefId, title: b.title, createdAt: b.createdAt, updatedAt: b.updatedAt,
    versionCount: b.contents.filter(c => c.role === 'model').length, approvedTurnIndex: b.approvedTurnIndex
  })));
});

app.get('/api/campaign-boards/:id', (req, res) => {
  const board = loadCampaignBoards(req.session.orgSlug).find(b => b.id === req.params.id);
  if (!board) return res.status(404).json({ error: 'Board not found' });
  res.json(board);
});

app.post('/api/campaign-boards', async (req, res) => {
  const org = findOrgBySlug(req.session.orgSlug);
  const { briefId } = req.body || {};
  const brief = readCampaignBriefs(org.slug).find(b => b.id === briefId);
  if (!brief) return res.status(404).json({ error: 'Campaign brief not found' });

  const list = loadCampaignBoards(org.slug);
  const now = new Date().toISOString();
  const board = { id: Date.now() + '-' + Math.random().toString(36).slice(2, 8), briefId, title: brief.title, createdAt: now, updatedAt: now, contents: [], approvedTurnIndex: null };

  try {
    const { versionPayload } = await runCampaignBoardJudge(org, brief, null, '', []);
    board.contents.push({ role: 'user', parts: [{ text: '' }] });
    board.contents.push({ role: 'model', parts: [{ text: JSON.stringify(versionPayload) }] });
    list.push(board);
    saveCampaignBoards(org.slug, list);
    res.json(board);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/campaign-boards/:id/message', async (req, res) => {
  const org = findOrgBySlug(req.session.orgSlug);
  const list = loadCampaignBoards(org.slug);
  const board = list.find(b => b.id === req.params.id);
  if (!board) return res.status(404).json({ error: 'Board not found' });
  const brief = readCampaignBriefs(org.slug).find(b => b.id === board.briefId);
  if (!brief) return res.status(404).json({ error: 'Campaign brief not found' });

  const feedback = ((req.body && req.body.feedback) || '').trim();
  const externalRefs = (req.body && req.body.externalRefs) || [];
  if (!feedback) return res.status(400).json({ error: 'Feedback text is required.' });

  const priorModelTurns = board.contents.filter(c => c.role === 'model');
  const priorVersion = priorModelTurns.length ? JSON.parse(priorModelTurns[priorModelTurns.length - 1].parts[0].text) : null;

  try {
    const { versionPayload } = await runCampaignBoardJudge(org, brief, priorVersion, feedback, externalRefs);
    board.contents.push({ role: 'user', parts: [{ text: feedback }] });
    board.contents.push({ role: 'model', parts: [{ text: JSON.stringify(versionPayload) }] });
    board.updatedAt = new Date().toISOString();
    saveCampaignBoards(org.slug, list);
    res.json({ ok: true, turnIndex: board.contents.length - 1, versionPayload });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/campaign-boards/:id/approve', (req, res) => {
  const list = loadCampaignBoards(req.session.orgSlug);
  const board = list.find(b => b.id === req.params.id);
  if (!board) return res.status(404).json({ error: 'Board not found' });
  const turnIndex = parseInt(req.body && req.body.turnIndex, 10);
  board.approvedTurnIndex = turnIndex;
  saveCampaignBoards(req.session.orgSlug, list);
  res.json({ ok: true });
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
    // This document is rewritten per-request (base path injected above) — never let the browser
    // cache it, or a user who loaded it before a deploy can be stuck on a stale shell indefinitely.
    res.set('Cache-Control', 'no-cache');
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
