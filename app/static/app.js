const $ = id => document.getElementById(id);
let posts = [];
let moodboard = [];
let currentOrgSlug = '';

/* ---------- theme toggle (works pre-login too, so it's wired outside init()) ---------- */
function applyTheme(theme){
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('compass-theme', theme);
  $('theme-icon-moon').style.display = theme === 'dark' ? 'none' : 'block';
  $('theme-icon-sun').style.display = theme === 'dark' ? 'block' : 'none';
}
applyTheme(document.documentElement.getAttribute('data-theme') || 'light');
$('btn-theme-toggle').addEventListener('click', () => {
  applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
});

// What each master config file controls, and how it should be written — shown when a file is opened
// so a new merchant filling in blank templates knows what to put and in what voice.
const CONFIG_EXPLAINERS = {
  'brand-context': {
    what: 'The business facts, positioning, and standing marketing rules Claude checks every plan against — what the business is, what makes it different, what this quarter\'s priorities are, and the non-negotiable rules (e.g. "always lead with the venue, not the food").',
    how: 'Write it like operating instructions, not marketing copy — plain, factual, third person. Short paragraphs and numbered rules. Be specific: real numbers, real priorities, real constraints. This file is never quoted directly in a caption — it\'s the brief, not the voice.'
  },
  'brand-voice': {
    what: 'Defines exactly how the writing should sound — tone words, vocabulary to lean toward or avoid, and do/don\'t phrasing examples. This is the file that shapes every headline and caption Claude writes.',
    how: 'Write the example lines in the actual voice you want, since Claude mirrors them directly — if you write a stiff example, you\'ll get stiff captions. Keep tone attributes to short labelled bullets ("Warm, not corporate"), and always pair a "Do" example with a "Don\'t" example so the contrast is unambiguous.'
  },
  'icp': {
    what: 'Who the content is actually for — the persona(s) buying or visiting, their demographics, what triggers them to show up, and what makes them hesitate. Claude uses this to target copy correctly instead of guessing at "the customer."',
    how: 'Write it as a descriptive profile, not in-voice copy — demographics, psychographics, buying triggers, objections, where they spend time online. If there\'s more than one persona, keep them clearly separated so Claude knows which one a given post should speak to.'
  },
  'compass-assistant': {
    what: 'The full assistant instructions — role definition, the design system, the intake checklist, and the exact output format Claude uses to hand off a plan to this app. This is the file you\'d paste into a separate Claude Project if you ever want Wonderland to run outside this chat.',
    how: 'Write it as direct instructions to an AI, not as documentation for a person — imperative, structured under clear headers, precise about what to do and what not to do. Advanced edit: most day-to-day brand changes belong in the three files above, not here.'
  }
};

// window.APP_BASE is injected server-side (defaults to "/") so this same code works whether the
// app is mounted at the domain root or under a real subfolder like /compass.
const APP_BASE = (window.APP_BASE || '/');
function withBase(path){
  return path.startsWith('/') ? APP_BASE.replace(/\/$/, '') + path : path;
}
// display_url can be our own cached "/media/..." path (needs the base prefix) or a raw external
// Instagram CDN URL (already absolute, must be left alone) — this tells the two apart.
function mediaUrl(url){
  return url && url.startsWith('/') ? withBase(url) : url;
}
async function api(path, opts){
  const res = await fetch(withBase(path), Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts));
  if(res.status === 401){ window.location.href = withBase('/login.html'); return null; }
  return res.json();
}

async function init(){
  const me = await api('/api/me');
  if(!me || !me.loggedIn) return;
  $('welcome').textContent = 'Welcome back, ' + me.name;
  $('avatar').textContent = me.name.slice(0,1).toUpperCase();
  $('org-name-sidebar-wrap').addEventListener('click', () => openClientPicker(false));
  $('clientpicker-close').addEventListener('click', closeClientPicker);
  $('clientpicker-overlay').addEventListener('click', closeClientPicker);

  if(!me.clientSlug){
    openClientPicker(true);
    return;
  }

  $('org-name').textContent = me.clientName;
  currentOrgSlug = me.clientSlug;
  $('today-date').textContent = new Date().toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric' });

  posts = await api('/api/posts') || [];

  moodboard = await api('/api/moodboard') || [];
  renderMoodboard();

  savedBriefs = await api('/api/campaign-briefs') || [];
  renderSavedBriefs();

  $('btn-paste').addEventListener('click', loadPastedPlan);
  $('paste-file').addEventListener('change', loadPastedPlanFile);
  $('btn-clear').addEventListener('click', clearAll);
  $('btn-fill-refs').addEventListener('click', fillMissingReferences);
  $('btn-export').addEventListener('click', exportPlan);
  $('btn-ai-generate').addEventListener('click', generateAiPlan);
  $('btn-ai-add-all').addEventListener('click', addAiRecommendationsToPlan);
  $('btn-ai-discard').addEventListener('click', discardAiRecommendations);
  $('btn-gen-attach').addEventListener('click', () => $('gen-file-input').click());
  $('gen-file-input').addEventListener('change', addGenAttachments);
  document.querySelectorAll('#gen-mode-toggle .tab-btn').forEach(btn => {
    btn.addEventListener('click', () => setGenMode(btn.dataset.mode));
  });

  $('btn-brief-attach-image').addEventListener('click', () => $('brief-image-input').click());
  $('brief-image-input').addEventListener('change', addBriefRefImages);
  $('btn-brief-generate').addEventListener('click', generateBriefCopy);
  $('btn-brief-save').addEventListener('click', saveBrief);
  document.querySelectorAll('#brief-vizref-toggle .tab-btn').forEach(btn => {
    btn.addEventListener('click', () => setBriefVizrefSource(btn.dataset.src));
  });

  $('btn-mb-paste').addEventListener('click', loadPastedMoodboard);
  $('mb-paste-file').addEventListener('change', loadPastedMoodboardFile);
  $('btn-mb-clear').addEventListener('click', clearMoodboard);
  $('btn-logout').addEventListener('click', async () => { await api('/api/logout', { method:'POST' }); window.location.href = withBase('/login.html'); });

  $('config-save').addEventListener('click', saveConfig);
  $('btn-save-guardrails').addEventListener('click', saveGuardrails);
  $('btn-add-rule').addEventListener('click', () => addRuleRow('').querySelector('input').focus());
  $('btn-cc-new').addEventListener('click', newCcConversation);
  $('btn-cc-send').addEventListener('click', sendCcMessage);
  $('cc-input').addEventListener('keydown', (e) => {
    if(e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); sendCcMessage(); }
  });
  $('btn-cc-attach').addEventListener('click', () => $('cc-file-input').click());
  $('cc-file-input').addEventListener('change', addCcAttachments);
  const savedModel = localStorage.getItem('compass-cc-model');
  if(savedModel) $('cc-model-select').value = savedModel;
  $('cc-model-select').addEventListener('change', () => localStorage.setItem('compass-cc-model', $('cc-model-select').value));
  $('btn-save-agent-behavior').addEventListener('click', saveAgentBehavior);
  $('btn-dira-sync').addEventListener('click', syncDirectoryA);
  $('btn-dira-add-client').addEventListener('click', () => { $('dira-add-client-form').style.display = 'block'; });
  $('btn-dira-cancel-create').addEventListener('click', () => { $('dira-add-client-form').style.display = 'none'; });
  $('btn-dira-create-client').addEventListener('click', createNewClient);
  $('btn-dira-back').addEventListener('click', closeDirectoryADetail);
  $('btn-dira-link').addEventListener('click', linkDriveFolder);
  $('btn-canva-connect').addEventListener('click', () => { window.location.href = withBase('/api/canva/connect'); });
  $('btn-canva-disconnect').addEventListener('click', disconnectCanva);
  $('btn-canva-save-mapping').addEventListener('click', saveCanvaMapping);
  document.querySelectorAll('[data-add-agent]').forEach(btn => {
    btn.addEventListener('click', () => addRuleRow('', 'ab-extra-' + btn.dataset.addAgent).querySelector('input').focus());
  });
  $('detail-close').addEventListener('click', closeDetail);
  $('detail-overlay').addEventListener('click', closeDetail);
  $('lightbox-close').addEventListener('click', closeLightbox);
  $('lightbox-overlay').addEventListener('click', closeLightbox);

  ['cal-agent-filter','cal-date-filter','prev-agent-filter','prev-date-filter'].forEach(id => {
    $(id).addEventListener('change', renderCalendarAndPreviews);
  });
  $('cal-view-grid').addEventListener('click', () => setCalView('grid'));
  $('cal-view-list').addEventListener('click', () => setCalView('list'));
  $('cal-prev-month').addEventListener('click', () => {
    calGridMonth = new Date(calGridMonth.getFullYear(), calGridMonth.getMonth() - 1, 1);
    renderCalendarAndPreviews();
  });
  $('cal-next-month').addEventListener('click', () => {
    calGridMonth = new Date(calGridMonth.getFullYear(), calGridMonth.getMonth() + 1, 1);
    renderCalendarAndPreviews();
  });
  $('cal-today-btn').addEventListener('click', () => {
    calGridMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    renderCalendarAndPreviews();
  });
  setCalView(calViewMode);

  // Mobile: hamburger toggles the sidebar as an off-canvas drawer. Desktop keeps the sidebar always visible.
  $('btn-hamburger').addEventListener('click', () => {
    $('sidebar').classList.add('mobile-open');
    $('sidebar-overlay').classList.add('open');
  });
  $('sidebar-overlay').addEventListener('click', closeMobileSidebar);

  // Sidebar groups collapse/expand independently, remembered per browser via localStorage —
  // a group stays collapsed across reloads until the user opens it again, or until it contains
  // the page currently being navigated to (see showPage(), which force-expands the active group).
  document.querySelectorAll('.nav-group').forEach(group => {
    const key = 'compass-nav-collapsed-' + group.dataset.group;
    if(localStorage.getItem(key) === '1') group.classList.add('collapsed');
    group.querySelector('.nav-group-label').addEventListener('click', () => {
      const collapsed = group.classList.toggle('collapsed');
      localStorage.setItem(key, collapsed ? '1' : '0');
    });
  });

  document.querySelectorAll('.sidebar nav a').forEach(a => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      document.querySelectorAll('.sidebar nav a').forEach(x => x.classList.remove('active'));
      a.classList.add('active');
      closeMobileSidebar();
      if(a.dataset.page) showPage(a.dataset.page);
      if(a.dataset.configId) openConfigFile(a.dataset.configId);
      if(a.dataset.page === 'history') loadHistory();
      if(a.dataset.page === 'agentbehavior'){ loadGuardrails(); loadAgentBehavior(); }
      if(a.dataset.page === 'creativechat') initCreativeChatPage();
      if(a.dataset.page === 'dashboard') loadDashboard();
      if(a.dataset.page === 'directorya') loadDirectoryA();
      if(a.dataset.page === 'canva') loadCanvaPage();
      if(a.dataset.page === 'calendar' || a.dataset.page === 'previews') renderCalendarAndPreviews();
    });
  });

  if(location.hash === '#canva'){ showPage('canva'); loadCanvaPage(); }
  else showPage('generate');

  initAnalytics().then(renderBriefVizrefGrid);
  loadDirectoryAManifestCache().then(renderBriefVizrefGrid);
}

// Clients aren't logins here — any signed-in WCCN staffer can work in any client's workspace.
// `mandatory` is true right after login when no client has been picked yet (no close button,
// nothing else on the page can run without one); false when reopened via the sidebar switch.
async function openClientPicker(mandatory){
  $('clientpicker-close').style.display = mandatory ? 'none' : 'block';
  $('clientpicker-modal').classList.add('open');
  $('clientpicker-overlay').classList.add('open');
  $('clientpicker-list').innerHTML = '<div class="rec-item">Loading…</div>';
  const clients = await api('/api/clients') || [];
  $('clientpicker-list').innerHTML = clients.map(c => `
    <button class="client-pick-item" data-slug="${esc(c.slug)}">
      <span class="client-pick-name">${esc(c.name)}</span>
      <span class="client-pick-arrow">→</span>
    </button>`).join('') || '<div class="rec-item">No clients yet — add one with scripts/create-org.js.</div>';
  $('clientpicker-list').querySelectorAll('.client-pick-item').forEach(btn => {
    btn.addEventListener('click', async () => {
      const res = await api('/api/session/client', { method:'POST', body: JSON.stringify({ slug: btn.dataset.slug }) });
      if(res && res.ok) window.location.reload();
    });
  });
}
function closeClientPicker(){
  if($('clientpicker-close').style.display === 'none') return; // mandatory — can't dismiss without picking
  $('clientpicker-modal').classList.remove('open');
  $('clientpicker-overlay').classList.remove('open');
}

// Each sidebar destination is its own page — only one is visible at a time, no more
// scroll-through-everything. The plan KPI strip + Clear/Export/Re-match actions only make
// sense for the content-plan pages, so they hide on Analytics and Master Config.
const CONTENT_PLAN_PAGES = ['generate', 'calendar', 'previews'];
const PAGE_SUBTITLES = {
  analytics: "Competitor Instagram data — scrape, filter, and see what's working for them.",
  generate: 'Build a plan, check it against brand standing rules, and export it in Buranchi\'s house style.',
  moodboard: 'Visual direction and reference boards.',
  campaignbrief: 'Same sections as the real brief doc, plus AI rephrasing and a visual reference picker.',
  ideation: 'Brainstorm raw content ideas before planning them out.',
  calendar: "Every post in this plan, in the order they were added.",
  previews: "Mockups follow Buranchi's scrapbook design system.",
  history: 'Every plan request across all 3 tabs, with token cost and post count.',
  agentbehavior: 'Guardrails global plus kondisi default per agent, dengan kondisi tambahan yang bisa lo edit sendiri.',
  creativechat: 'Ngobrol atau minta rencana konten — pilih sendiri modelnya, dalam 1 percakapan.',
  masterconfig: 'The brand files Claude and Gemini both read when drafting a plan.',
  dashboard: 'Ringkasan status konten plan untuk organisasi ini.',
  directorya: "Read-only mirror of the client's Google Drive creative archive.",
  canva: 'Wonderland writes the copy; Canva builds the visual via Brand Template autofill.'
};

function showPage(pageId){
  document.querySelectorAll('.page-view').forEach(el => el.classList.remove('active-page'));
  const target = document.querySelector(`.page-view[data-page="${pageId}"]`);
  if(target) target.classList.add('active-page');

  const showPlanChrome = CONTENT_PLAN_PAGES.includes(pageId);
  $('content-plan-actions').style.display = showPlanChrome ? 'flex' : 'none';
  $('page-subtitle').textContent = PAGE_SUBTITLES[pageId] || '';

  document.querySelectorAll('.sidebar nav a').forEach(a => a.classList.toggle('active', a.dataset.page === pageId));

  const activeLink = document.querySelector(`.sidebar nav a[data-page="${pageId}"]`);
  const activeGroup = activeLink && activeLink.closest('.nav-group');
  if(activeGroup && activeGroup.classList.contains('collapsed')){
    activeGroup.classList.remove('collapsed');
    localStorage.setItem('compass-nav-collapsed-' + activeGroup.dataset.group, '0');
  }

  window.scrollTo(0, 0);
}

function closeMobileSidebar(){
  $('sidebar').classList.remove('mobile-open');
  $('sidebar-overlay').classList.remove('open');
}

/* ---------- master config (inline section, one file per sidebar link) ---------- */
let activeConfigId = null;

async function openConfigFile(id){
  activeConfigId = id;
  $('config-editor-title').textContent = document.querySelector(`.sidebar nav a[data-config-id="${id}"]`).textContent.trim();

  const explainer = CONFIG_EXPLAINERS[id];
  $('config-explainer').innerHTML = explainer ? `
    <div class="config-explainer-row"><b>What this controls</b><p>${esc(explainer.what)}</p></div>
    <div class="config-explainer-row"><b>How to write it</b><p>${esc(explainer.how)}</p></div>
  ` : '';

  $('config-editor').value = 'Loading…';
  const data = await api('/api/config/' + id);
  $('config-editor').value = (data && data.content) || '';
  $('config-save-status').textContent = '';
}
async function saveConfig(){
  if(!activeConfigId) return;
  $('config-save-status').textContent = 'Saving…';
  const content = $('config-editor').value;
  const res = await api('/api/config/' + activeConfigId, { method:'PUT', body: JSON.stringify({ content }) });
  $('config-save-status').textContent = res && res.ok ? 'Saved — Claude will read this updated version next time you generate a plan in chat.' : 'Could not save.';
}

/* ---------- competitor analytics ---------- */
function fmtPct(x){ return (x).toFixed(2) + '%'; }
function fmtNum(x){ return (x===null||x===undefined) ? '—' : x.toLocaleString(); }

const analyticsCharts = {};
let analyticsFiltered = [];
let COMPETITOR_POSTS = [];
let DIRECTORY_A_MANIFEST = null;
let ACCOUNTS = [];
let ACCOUNT_COLORS = {};
let FOLLOWERS = {};
let BRAND_NAMES = {};
let HANDLES = {};
let analyticsLastScrapedAt = null;
let analyticsSnapshots = []; // [{file, scrapedAt, postCount, source}], newest first
let analyticsActiveSnapshot = null;
let allPostsSort = { field: 'engagement_rate_pct', dir: 'desc' };
let allPostsPage = 1;
const ALL_POSTS_PAGE_SIZE = 30;
const WEEKDAY_ORDER = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];

async function initAnalytics(){
  await loadAnalyticsData();
  await loadTrackedCompetitors();

  $('acct-filter').addEventListener('change', applyAnalyticsFilter);
  $('snapshot-filter').addEventListener('change', (e) => { allPostsPage = 1; loadAnalyticsData(e.target.value); });
  $('btn-rescrape').addEventListener('click', runRescrape);
  $('btn-comp-add').addEventListener('click', addCompetitor);
  $('comp-new-platform').addEventListener('change', () => {
    const isLinkedin = $('comp-new-platform').value === 'linkedin';
    $('comp-new-link-label').textContent = isLinkedin ? 'LinkedIn link' : 'Instagram link or handle';
    $('comp-new-link').placeholder = isLinkedin ? 'https://linkedin.com/company/kurasu-indonesia' : 'https://instagram.com/kurasuid or @kurasuid';
  });

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      $('panel-overview').style.display = btn.dataset.tab === 'overview' ? 'block' : 'none';
      $('panel-allposts').style.display = btn.dataset.tab === 'allposts' ? 'block' : 'none';
    });
  });

  document.querySelectorAll('#all-table thead th[data-field]').forEach(th => {
    th.addEventListener('click', () => {
      const f = th.getAttribute('data-field');
      if(allPostsSort.field === f){ allPostsSort.dir = allPostsSort.dir === 'asc' ? 'desc' : 'asc'; }
      else { allPostsSort = { field: f, dir: 'desc' }; }
      allPostsPage = 1;
      renderAllPostsTable();
    });
  });
}

async function loadAnalyticsData(snapshotFile){
  const qs = snapshotFile ? ('?at=' + encodeURIComponent(snapshotFile)) : '';
  const data = await api('/api/analytics' + qs) || {};
  COMPETITOR_POSTS = data.posts || [];
  ACCOUNTS = data.accounts || [];
  ACCOUNT_COLORS = data.accountColors || {};
  FOLLOWERS = data.followers || {};
  BRAND_NAMES = data.brandNames || {};
  HANDLES = data.handles || {};
  analyticsLastScrapedAt = data.lastScrapedAt || null;
  analyticsSnapshots = data.snapshots || [];
  analyticsActiveSnapshot = data.activeSnapshot || null;
  analyticsFiltered = COMPETITOR_POSTS;
  allPostsPage = 1;

  $('analytics-empty').style.display = COMPETITOR_POSTS.length ? 'none' : 'block';
  updateRescrapeStatus();
  renderSnapshotFilter();
  renderRecommendations(data.recommendations || []);

  const sel = $('acct-filter');
  sel.innerHTML = '<option value="all">All accounts</option>';
  ACCOUNTS.forEach(a => {
    const opt = document.createElement('option');
    opt.value = a; opt.textContent = (BRAND_NAMES[a] || a) + ' (' + (HANDLES[a] || a) + ')';
    sel.appendChild(opt);
  });

  renderReferencePicker();

  if(!COMPETITOR_POSTS.length){
    Object.keys(analyticsCharts).forEach(k => { analyticsCharts[k].destroy(); delete analyticsCharts[k]; });
    $('competitor-kpi-row').innerHTML = '';
    $('top10-body').innerHTML = '';
    $('all-body').innerHTML = '';
    $('all-posts-pagination').innerHTML = '';
    $('all-posts-sub').textContent = 'No data yet.';
    return;
  }

  renderCompetitorKpis();
  renderTypeChart();
  renderTopicChart();
  renderWeekdayChart();
  renderFreqChart();
  renderTop10();
  renderAllPostsTable();
}

function renderRecommendations(recs){
  const card = $('recs-card');
  if(!recs.length){
    card.style.display = 'none';
    return;
  }
  card.style.display = 'block';
  $('recs-list').innerHTML = recs.map(r => `
    <div class="rec-item"><div class="rec-icon">→</div><div>${esc(r.text)}</div></div>`).join('');
}

function renderReferencePicker(){
  const sel = $('f-reference');
  if(!sel) return;
  const withPhoto = [...COMPETITOR_POSTS].filter(p => p.display_url).sort((a,b) => (b.engagement_rate_pct||0) - (a.engagement_rate_pct||0));
  sel.innerHTML = '<option value="">None — no competitor benchmark</option>' + withPhoto.map(p =>
    `<option value="${esc(p.url)}">${esc(p.brand_name)} — ${esc(p.category)} — ${fmtPct(p.engagement_rate_pct||0)}</option>`
  ).join('');
  if(!withPhoto.length){
    sel.innerHTML = '<option value="">None available — rescrape after the photo-capture update to populate this</option>';
  }
}

function renderSnapshotFilter(){
  const sel = $('snapshot-filter');
  sel.innerHTML = analyticsSnapshots.map((s, i) => {
    const label = new Date(s.scrapedAt).toLocaleString('en-US', { dateStyle:'medium', timeStyle:'short' }) + (i===0 ? ' (latest)' : '') + ' — ' + s.postCount + ' posts';
    return `<option value="${s.file}" ${s.file===analyticsActiveSnapshot?'selected':''}>${esc(label)}</option>`;
  }).join('');
}

function updateRescrapeStatus(){
  const el = $('rescrape-status');
  el.className = 'rescrape-status';
  el.textContent = analyticsLastScrapedAt
    ? 'Last updated ' + new Date(analyticsLastScrapedAt).toLocaleString('en-US', { dateStyle:'medium', timeStyle:'short' })
    : 'No data scraped yet';
}

async function runRescrape(){
  const btn = $('btn-rescrape');
  const status = $('rescrape-status');
  btn.disabled = true;
  status.className = 'rescrape-status';
  status.textContent = 'Rescraping — this can take a minute…';
  try {
    const res = await api('/api/analytics/rescrape', { method: 'POST' });
    if(res && res.ok){
      status.className = 'rescrape-status ok';
      status.textContent = `Done — ${res.count} posts refreshed.`;
      await loadAnalyticsData();
    } else {
      status.className = 'rescrape-status error';
      status.textContent = (res && res.error) || 'Rescrape failed.';
    }
  } catch(e){
    status.className = 'rescrape-status error';
    status.textContent = 'Could not reach the server.';
  } finally {
    btn.disabled = false;
  }
}

function applyAnalyticsFilter(){
  const v = $('acct-filter').value;
  analyticsFiltered = v === 'all' ? COMPETITOR_POSTS : COMPETITOR_POSTS.filter(p => p.account === v);
  allPostsPage = 1;
  renderTypeChart();
  renderTopicChart();
  renderWeekdayChart();
  renderFreqChart();
  renderTop10();
  renderAllPostsTable();
}

function renderCompetitorKpis(){
  const row = $('competitor-kpi-row');
  row.innerHTML = '';
  ACCOUNTS.forEach(acc => {
    const plist = COMPETITOR_POSTS.filter(p => p.account === acc);
    const visibleLikes = plist.filter(p => !p.likes_hidden);
    const erValues = plist.map(p => p.engagement_rate_pct).filter(v => typeof v === 'number');
    const avgER = erValues.length ? erValues.reduce((a,b) => a+b, 0) / erValues.length : null;
    const avgLikes = visibleLikes.length ? Math.round(visibleLikes.reduce((s,p) => s + p.likes_display, 0) / visibleLikes.length) : null;
    const avgComments = Math.round(plist.reduce((s,p) => s + p.comments, 0) / plist.length);
    const dates = plist.map(p => new Date(p.date)).sort((a,b) => a - b);
    const spanDays = Math.max(1, (dates[dates.length-1] - dates[0]) / 86400000);
    const freq = (plist.length / (spanDays / 7)).toFixed(2);
    const followerCount = FOLLOWERS[acc];
    const card = document.createElement('div');
    card.className = 'kpi-card';
    card.style.borderTopColor = ACCOUNT_COLORS[acc];
    card.innerHTML = `
      <div class="top-row"><div class="lab">${esc(BRAND_NAMES[acc])}</div></div>
      <div style="font-size:11.5px; color:var(--fg-soft); margin:2px 0 10px;">${esc(HANDLES[acc])}${followerCount ? ' · ' + followerCount.toLocaleString() + ' followers' : ''}</div>
      <div class="row2" style="gap:10px;">
        <div><div class="cap" style="margin:0;">Avg eng. rate</div><div class="val" style="font-size:17px;">${avgER===null?'—':fmtPct(avgER)}</div></div>
        <div><div class="cap" style="margin:0;">Posts/week</div><div class="val" style="font-size:17px;">${freq}</div></div>
      </div>
      <div class="row2" style="gap:10px; margin-top:8px;">
        <div><div class="cap" style="margin:0;">Avg likes</div><div class="val" style="font-size:17px;">${avgLikes===null?'Hidden':fmtNum(avgLikes)}</div></div>
        <div><div class="cap" style="margin:0;">Avg comments</div><div class="val" style="font-size:17px;">${fmtNum(avgComments)}</div></div>
      </div>`;
    row.appendChild(card);
  });
}

function renderTypeChart(){
  const types = [...new Set(COMPETITOR_POSTS.map(p => p.post_type))];
  const datasets = ACCOUNTS.map(acc => {
    const plist = analyticsFiltered.filter(p => p.account === acc);
    const data = types.map(t => {
      const sub = plist.filter(p => p.post_type === t);
      if(!sub.length) return null;
      return +(sub.reduce((s,p) => s + p.engagement_rate_pct, 0) / sub.length).toFixed(3);
    });
    return { label: BRAND_NAMES[acc], data, backgroundColor: ACCOUNT_COLORS[acc], borderRadius: 4 };
  });
  if(analyticsCharts.type) analyticsCharts.type.destroy();
  analyticsCharts.type = new Chart($('chart-type'), {
    type: 'bar',
    data: { labels: types, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } },
        tooltip: { callbacks: { label: c => c.dataset.label + ': ' + fmtPct(c.parsed.y) } } },
      scales: { y: { ticks: { callback: v => v + '%' } } }
    }
  });
}
function renderTopicChart(){
  const cats = {};
  analyticsFiltered.forEach(p => { (cats[p.category] = cats[p.category] || []).push(p.engagement_rate_pct); });
  let rows = Object.entries(cats).map(([cat,arr]) => ({ cat, avg: arr.reduce((a,b) => a+b, 0) / arr.length, n: arr.length }));
  rows.sort((a,b) => b.avg - a.avg);
  rows = rows.slice(0, 8);
  if(analyticsCharts.topic) analyticsCharts.topic.destroy();
  analyticsCharts.topic = new Chart($('chart-topic'), {
    type: 'bar',
    data: { labels: rows.map(r => r.cat + ' (n=' + r.n + ')'),
      datasets: [{ data: rows.map(r => +r.avg.toFixed(3)), backgroundColor: '#007AFF', borderRadius: 4 }] },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => fmtPct(c.parsed.x) } } },
      scales: { x: { ticks: { callback: v => v + '%' } } }
    }
  });
}
function renderWeekdayChart(){
  const datasets = ACCOUNTS.map(acc => {
    const plist = analyticsFiltered.filter(p => p.account === acc);
    const counts = WEEKDAY_ORDER.map(wd => plist.filter(p => p.weekday === wd).length);
    return { label: BRAND_NAMES[acc], data: counts, backgroundColor: ACCOUNT_COLORS[acc], borderRadius: 4 };
  });
  if(analyticsCharts.weekday) analyticsCharts.weekday.destroy();
  analyticsCharts.weekday = new Chart($('chart-weekday'), {
    type: 'bar',
    data: { labels: WEEKDAY_ORDER.map(w => w.slice(0,3)), datasets },
    options: { responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } } },
      scales: { y: { ticks: { stepSize: 1 } } } }
  });
}
function renderFreqChart(){
  const accs = $('acct-filter').value === 'all' ? ACCOUNTS : [$('acct-filter').value];
  const labels = accs.map(a => BRAND_NAMES[a]);
  const data = accs.map(acc => {
    const plist = COMPETITOR_POSTS.filter(p => p.account === acc);
    const dates = plist.map(p => new Date(p.date)).sort((a,b) => a - b);
    const spanDays = Math.max(1, (dates[dates.length-1] - dates[0]) / 86400000);
    return +(plist.length / (spanDays / 7)).toFixed(2);
  });
  if(analyticsCharts.freq) analyticsCharts.freq.destroy();
  analyticsCharts.freq = new Chart($('chart-freq'), {
    type: 'bar',
    data: { labels, datasets: [{ data, backgroundColor: accs.map(a => ACCOUNT_COLORS[a]), borderRadius: 4 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
  });
}
function fmtDate(d){
  if(!d) return '—';
  return new Date(d).toLocaleDateString('en-US', { year:'numeric', month:'short', day:'numeric' });
}

function renderTop10(){
  const top10 = [...analyticsFiltered].sort((a,b) => b.engagement_rate_pct - a.engagement_rate_pct).slice(0, 10);
  const scrapedLabel = fmtDate(analyticsLastScrapedAt);
  $('top10-body').innerHTML = top10.map((p,i) => `
    <tr>
      <td><span class="rank-pill">${i+1}</span></td>
      <td><span class="competitor-badge" style="background:${ACCOUNT_COLORS[p.account]}22;color:${ACCOUNT_COLORS[p.account]}">${esc(p.brand_name)}</span></td>
      <td>${esc(p.post_type)}</td>
      <td>${esc(p.category)}</td>
      <td><strong>${fmtPct(p.engagement_rate_pct)}</strong></td>
      <td>${p.likes_hidden ? 'Hidden' : fmtNum(p.likes_display)}</td>
      <td>${fmtNum(p.comments)}</td>
      <td>${fmtDate(p.date)}</td>
      <td>${scrapedLabel}</td>
      <td class="caption-cell"><a class="post-link" href="${p.url}" target="_blank" rel="noopener">${esc(p.caption_preview)}</a></td>
    </tr>`).join('');
}
function renderAllPostsTable(){
  const { field, dir } = allPostsSort;
  const sorted = [...analyticsFiltered].sort((a,b) => {
    let av = a[field], bv = b[field];
    if(av===null||av===undefined) av = -Infinity;
    if(bv===null||bv===undefined) bv = -Infinity;
    if(typeof av === 'string'){ const c = av.localeCompare(bv); return dir==='asc'?c:-c; }
    const c = av - bv; return dir==='asc'?c:-c;
  });

  const totalPages = Math.max(1, Math.ceil(sorted.length / ALL_POSTS_PAGE_SIZE));
  allPostsPage = Math.min(allPostsPage, totalPages);
  const start = (allPostsPage - 1) * ALL_POSTS_PAGE_SIZE;
  const pageItems = sorted.slice(start, start + ALL_POSTS_PAGE_SIZE);
  const scrapedLabel = fmtDate(analyticsLastScrapedAt);

  $('all-posts-sub').textContent = `Showing ${pageItems.length ? start+1 : 0}–${start+pageItems.length} of ${sorted.length} posts — sorted by ${field.replace(/_/g,' ')} (${dir})`;
  $('all-body').innerHTML = pageItems.map(p => `
    <tr>
      <td><span class="competitor-badge" style="background:${ACCOUNT_COLORS[p.account]}22;color:${ACCOUNT_COLORS[p.account]}">${esc(p.brand_name)}</span></td>
      <td>${esc(p.post_type)}</td>
      <td>${esc(p.category)}</td>
      <td>${fmtPct(p.engagement_rate_pct)}</td>
      <td>${p.likes_hidden ? 'Hidden' : fmtNum(p.likes_display)}</td>
      <td>${fmtNum(p.comments)}</td>
      <td>${fmtDate(p.date)}</td>
      <td>${scrapedLabel}</td>
      <td class="caption-cell"><a class="post-link" href="${p.url}" target="_blank" rel="noopener">${esc(p.caption_preview)}</a></td>
    </tr>`).join('');

  $('all-posts-pagination').innerHTML = `
    <button class="btn btn-outline btn-sm" id="pg-prev" ${allPostsPage<=1?'disabled':''}>← Prev</button>
    <span class="page-info">Page ${allPostsPage} of ${totalPages}</span>
    <button class="btn btn-outline btn-sm" id="pg-next" ${allPostsPage>=totalPages?'disabled':''}>Next →</button>`;
  const prevBtn = $('pg-prev'), nextBtn = $('pg-next');
  if(prevBtn) prevBtn.addEventListener('click', () => { allPostsPage--; renderAllPostsTable(); });
  if(nextBtn) nextBtn.addEventListener('click', () => { allPostsPage++; renderAllPostsTable(); });
}

// Snapshots the matched competitor post into the draft (not just its URL) so the comparison
// still renders correctly later even if that post ages out of future scrapes.
function resolveReferencePost(url){
  if(!url) return null;
  const p = COMPETITOR_POSTS.find(x => x.url === url);
  if(!p) return null;
  return {
    url: p.url, brand_name: p.brand_name, account: p.account, display_url: p.display_url,
    category: p.category, post_type: p.post_type, engagement_rate_pct: p.engagement_rate_pct,
    caption_preview: p.caption_preview, date: p.date
  };
}

// Auto-attach: when Claude names the competitor category a recommendation was based on
// (posts pasted from chat carry `referenceCategory`), pick the single best-performing post
// in that category as the visual benchmark — no manual picking required.
// Picks the strongest candidate that hasn't already been used elsewhere in this plan, so
// multiple posts don't all end up pointing at the exact same "best overall" competitor post —
// only repeats a post as a benchmark when there's genuinely no distinct alternative left.
function pickDiverse(candidates, usedUrls){
  if(!candidates.length) return null;
  const unused = candidates.find(c => !usedUrls || !usedUrls.has(c.url));
  return unused || candidates[0];
}

function autoResolveReferenceByCategory(category, usedUrls){
  if(!category) return null;
  const needle = category.trim().toLowerCase();
  const candidates = COMPETITOR_POSTS
    .filter(p => p.display_url && p.category && p.category.trim().toLowerCase() === needle)
    .sort((a,b) => (b.engagement_rate_pct||0) - (a.engagement_rate_pct||0));
  const pick = pickDiverse(candidates, usedUrls);
  return pick ? resolveReferencePost(pick.url) : null;
}

// Every post gets a benchmark, even when it wasn't written to chase a specific data insight:
// 1) exact category match (the strongest signal — set by Claude via referenceCategory)
// 2) same post_type family as the post's format (feed ~ Photo/Carousel, story ~ Reel/Video)
// 3) highest-engagement competitor post overall, as a last resort
// Always picks the single highest-engagement candidate within whichever tier matches.
function autoResolveReferenceForPost(post, usedUrls){
  const byCategory = autoResolveReferenceByCategory(post.referenceCategory, usedUrls);
  if(byCategory) return byCategory;

  const withPhoto = COMPETITOR_POSTS.filter(p => p.display_url);
  if(!withPhoto.length) return null;

  const wantTypes = post.format === 'story' ? ['Reel/Video'] : ['Photo', 'Carousel'];
  const byFormat = withPhoto
    .filter(p => wantTypes.includes(p.post_type))
    .sort((a,b) => (b.engagement_rate_pct||0) - (a.engagement_rate_pct||0));
  const formatPick = pickDiverse(byFormat, usedUrls);
  if(formatPick) return resolveReferencePost(formatPick.url);

  const overall = [...withPhoto].sort((a,b) => (b.engagement_rate_pct||0) - (a.engagement_rate_pct||0));
  const overallPick = pickDiverse(overall, usedUrls);
  return overallPick ? resolveReferencePost(overallPick.url) : null;
}

function usedReferenceUrls(){
  return new Set(posts.filter(p => p.referencePost).map(p => p.referencePost.url));
}

async function loadDirectoryAManifestCache(){
  const data = await api('/api/directory-a/' + currentOrgSlug);
  DIRECTORY_A_MANIFEST = (data && data.manifest) ? data.manifest.files : null;
}

function usedDirectoryARefIds(){
  return new Set(posts.filter(p => p.directoryARef).map(p => p.directoryARef.id));
}

// Mirrors autoResolveReferenceForPost, but points at the CLIENT's own visual archive (Directory
// A) instead of a competitor's. Deliberately never forces a match: only fires when the agent
// itself named a `directoryAKeyword` on the post (e.g. "pastry", "pool session") — the archive
// can be thousands of files, and guessing a match without that signal would be noise, not signal.
function autoResolveDirectoryAReference(post, usedIds){
  if(!DIRECTORY_A_MANIFEST || !post.directoryAKeyword) return null;
  const needle = post.directoryAKeyword.trim().toLowerCase();
  if(!needle) return null;
  const candidates = DIRECTORY_A_MANIFEST.filter(f =>
    f.hasThumbnail &&
    ((f.name || '').toLowerCase().includes(needle) || (f.path || '').toLowerCase().includes(needle))
  );
  if(!candidates.length) return null;
  const unused = candidates.find(f => !usedIds.has(f.id)) || candidates[0];
  return {
    id: unused.id, name: unused.name, path: unused.path,
    thumbnailUrl: withBase('/media/directory-a/' + currentOrgSlug + '/' + unused.id + '.jpg'),
    webViewLink: unused.webViewLink
  };
}

/* ---------- generate with AI (question box -> recommendations you review before adding) ---------- */
let aiRecommendations = [];
let genMode = 'beforeShoot';
let genAttachments = [];

async function addGenAttachments(){
  const input = $('gen-file-input');
  genAttachments.push(...await readAttachmentFiles(Array.from(input.files || [])));
  input.value = '';
  renderGenAttachments();
}

function removeGenAttachment(idx){
  genAttachments.splice(idx, 1);
  renderGenAttachments();
}

function renderGenAttachments(){
  renderAttachmentChips('gen-attachments', genAttachments, removeGenAttachment);
}

const GEN_MODE_HINTS = {
  beforeShoot: "Nothing's been shot yet — each post's photo direction becomes a brief for the photographer/videographer, with references to shoot toward.",
  existingDatabase: "Grounded in what's already in Directory A (Master Config's Google Drive database) — no new shoot direction, just which existing asset to use."
};

function setGenMode(mode){
  genMode = mode;
  document.querySelectorAll('#gen-mode-toggle .tab-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.mode === mode));
  $('gen-mode-hint').textContent = GEN_MODE_HINTS[mode] || '';
}

async function generateAiPlan(){
  const btn = $('btn-ai-generate');
  const status = $('ai-generate-status');
  btn.disabled = true;
  status.textContent = 'Gemini is thinking…';

  const body = {
    mode: genMode,
    totalCount: parseInt($('gen-total-count').value, 10) || null,
    feedCount: parseInt($('gen-feed-count').value, 10) || null,
    storyCount: parseInt($('gen-story-count').value, 10) || null,
    goal: $('gen-goal').value.trim(),
    products: $('gen-products').value.trim(),
    occasion: $('gen-occasion').value.trim(),
    specialRequest: $('gen-special-request').value.trim(),
    attachments: genAttachments
  };

  try {
    const res = await api('/api/generate-plan', { method:'POST', body: JSON.stringify(body) });
    if(res && res.ok){
      // Same auto-match enrichment the Claude-paste flow gets, so "existing database" mode's
      // directoryAKeyword actually resolves to a real Directory A file where possible.
      const used = usedReferenceUrls();
      const usedDir = usedDirectoryARefIds();
      res.posts.forEach(item => {
        if(!item.referencePost) item.referencePost = autoResolveReferenceForPost(item, used);
        if(item.referencePost) used.add(item.referencePost.url);
        if(!item.directoryARef) item.directoryARef = autoResolveDirectoryAReference(item, usedDir);
        if(item.directoryARef) usedDir.add(item.directoryARef.id);
      });
      aiRecommendations = res.posts;
      renderAiRecommendations();
      status.textContent = `${res.posts.length} recommendation${res.posts.length===1?'':'s'} — ${res.tokenUsage.total.toLocaleString()} tokens · ${res.model}` + (res.note ? ` (${res.note})` : '');
    } else {
      status.textContent = (res && res.error) || 'Could not generate a plan.';
    }
  } catch(e){
    status.textContent = 'Request failed — try again.';
  } finally {
    btn.disabled = false;
  }
}

function renderAiRecommendations(){
  const wrap = $('ai-recs-wrap');
  if(!aiRecommendations.length){
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = 'block';
  $('ai-recs-list').innerHTML = aiRecommendations.map((p, idx) => `
    <div class="ai-rec-card">
      <div class="ai-rec-head">
        <div class="ai-rec-meta"><span class="fmt-pill ${p.format}">${esc(p.format||'')}</span>${esc(p.date||'')}</div>
        <button class="btn btn-outline btn-sm" data-ai-remove="${idx}">Remove</button>
      </div>
      <div class="ai-rec-headline">${esc(p.headline||'(untitled)')}</div>
      ${p.sub ? `<div class="ai-rec-sub">${esc(p.sub)}</div>` : ''}
      ${p.photo ? `<p class="ai-rec-caption"><b>Photo direction:</b> ${esc(p.photo)}</p>` : ''}
      <p class="ai-rec-caption">${esc(p.caption||'')}</p>
      ${p.directoryARef ? `<div class="ai-rec-meta" style="margin-top:8px;">🗂️ Matched existing file: ${esc(p.directoryARef.name)}</div>` : ''}
      ${p.referencePost ? `<div class="ai-rec-meta" style="margin-top:4px;">🔗 Reference: ${esc(p.referencePost.brand_name || '')}</div>` : ''}
    </div>
  `).join('');
  $('ai-recs-list').querySelectorAll('[data-ai-remove]').forEach(btn => {
    btn.addEventListener('click', () => {
      aiRecommendations.splice(parseInt(btn.dataset.aiRemove, 10), 1);
      renderAiRecommendations();
    });
  });
}

async function addAiRecommendationsToPlan(){
  if(!aiRecommendations.length) return;
  posts = await api('/api/posts/bulk', { method:'POST', body: JSON.stringify(aiRecommendations) }) || posts;
  aiRecommendations = [];
  renderAiRecommendations();
  $('ai-generate-status').textContent = 'Added to plan ✓';
}

function discardAiRecommendations(){
  aiRecommendations = [];
  renderAiRecommendations();
  $('ai-generate-status').textContent = '';
}

/* ---------- campaign brief (form -> generated visual copywriting -> save -> export) ---------- */
let savedBriefs = [];
let briefRefImages = []; // [{name, mimeType, data}] — data is base64, no data: prefix
let briefRecOptions = [];
let briefStrategySummary = '';
let briefSelectedRec = null;

async function addBriefRefImages(){
  const input = $('brief-image-input');
  const files = Array.from(input.files || []);
  for(const file of files){
    if(!file.type.startsWith('image/')) continue;
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      briefRefImages.push({ name: file.name, kind: 'upload', mimeType: file.type, data: dataUrl.split(',')[1] });
    } catch(e){
      alert(`Could not read "${file.name}".`);
    }
  }
  input.value = '';
  renderBriefRefImages();
}

function removeBriefRefImage(idx){
  briefRefImages.splice(idx, 1);
  renderBriefRefImages();
  renderBriefVizrefGrid();
}

// briefRefImages holds two kinds of entries: uploaded files (kind:'upload', base64 data) and
// picks from the competitor/internal database pickers below (kind:'competitor'|'internal', a URL
// on this server instead of base64 — only uploads get sent to Gemini as image context; database
// picks are for the brief document itself).
function renderBriefRefImages(){
  $('brief-ref-images').innerHTML = briefRefImages.map((img, idx) => `
    <div class="brief-ref-img-card">
      <img src="${img.kind === 'upload' ? `data:${img.mimeType};base64,${img.data}` : esc(img.url)}" alt="${esc(img.name)}">
      <button type="button" data-brief-remove-img="${idx}">×</button>
    </div>
  `).join('');
  $('brief-ref-images').querySelectorAll('[data-brief-remove-img]').forEach(btn => {
    btn.addEventListener('click', () => removeBriefRefImage(parseInt(btn.dataset.briefRemoveImg, 10)));
  });
}

let briefVizrefSource = 'competitor';

function setBriefVizrefSource(src){
  briefVizrefSource = src;
  document.querySelectorAll('#brief-vizref-toggle .tab-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.src === src));
  renderBriefVizrefGrid();
}

function toggleBriefVizref(item){
  const idx = briefRefImages.findIndex(i => i.refKey === item.refKey);
  if(idx > -1) briefRefImages.splice(idx, 1);
  else briefRefImages.push(item);
  renderBriefRefImages();
  renderBriefVizrefGrid();
}

function renderBriefVizrefGrid(){
  const grid = $('brief-vizref-grid');
  if(!grid) return;
  const empty = $('brief-vizref-empty');
  let items = [];
  if(briefVizrefSource === 'competitor'){
    items = COMPETITOR_POSTS.filter(p => p.display_url).slice(0, 40).map(p => ({
      refKey: 'competitor:' + p.url, name: `${p.brand_name || ''} — ${p.category || ''}`, kind: 'competitor', url: mediaUrl(p.display_url)
    }));
    $('brief-vizref-empty-text').textContent = 'No competitor data scraped yet — visit the Competitor Dashboard.';
  } else {
    items = (DIRECTORY_A_MANIFEST || []).filter(f => f.hasThumbnail).slice(0, 40).map(f => ({
      refKey: 'internal:' + f.id, name: f.name, kind: 'internal', url: withBase('/media/directory-a/' + currentOrgSlug + '/' + f.id + '.jpg')
    }));
    $('brief-vizref-empty-text').textContent = 'No internal archive synced yet — link a Google Drive folder in Directory A.';
  }
  if(!items.length){
    grid.innerHTML = '';
    if(empty) empty.style.display = 'block';
    return;
  }
  if(empty) empty.style.display = 'none';
  grid.innerHTML = items.map(item => `
    <div class="vizref-card ${briefRefImages.some(i => i.refKey === item.refKey) ? 'selected' : ''}" data-vizref-key="${esc(item.refKey)}">
      <img src="${esc(item.url)}" alt="${esc(item.name)}" loading="lazy">
      <div class="vizref-label">${esc(item.name)}</div>
    </div>
  `).join('');
  grid.querySelectorAll('[data-vizref-key]').forEach((card, i) => {
    card.addEventListener('click', () => toggleBriefVizref(items[i]));
  });
}

function collectBriefFields(){
  return {
    title: $('brief-title').value.trim(),
    background: $('brief-background').value.trim(),
    audience: $('brief-audience').value.trim(),
    objective: $('brief-objective').value.trim(),
    timeline: $('brief-timeline').value.trim(),
    channels: $('brief-channels').value.trim(),
    terms: $('brief-terms').value.trim(),
    refLinks: $('brief-ref-links').value.trim(),
    draftHeadline: $('brief-draft-headline').value.trim(),
    draftSub: $('brief-draft-sub').value.trim(),
    draftCaption: $('brief-draft-caption').value.trim()
  };
}

async function generateBriefCopy(){
  const btn = $('btn-brief-generate');
  const status = $('brief-generate-status');
  const body = collectBriefFields();
  if(!body.draftHeadline && !body.draftSub && !body.draftCaption){
    alert('Write a draft headline, sub-headline, or caption first — rephrasing needs something to work from.');
    return;
  }
  btn.disabled = true;
  status.textContent = 'Gemini is thinking…';

  body.referenceImages = briefRefImages.filter(i => i.kind === 'upload').map(i => ({ mimeType: i.mimeType, data: i.data }));

  try {
    const res = await api('/api/generate-brief', { method:'POST', body: JSON.stringify(body) });
    if(res && res.ok){
      briefRecOptions = res.options;
      briefStrategySummary = res.strategySummary;
      briefSelectedRec = null;
      renderBriefRecs();
      status.textContent = `${res.options.length} option${res.options.length===1?'':'s'} — ${res.tokenUsage.total.toLocaleString()} tokens · ${res.model}`;
    } else {
      status.textContent = (res && res.error) || 'Could not rephrase.';
    }
  } catch(e){
    status.textContent = 'Request failed — try again.';
  } finally {
    btn.disabled = false;
  }
}

function renderBriefRecs(){
  const wrap = $('brief-recs-wrap');
  if(!briefRecOptions.length){
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = 'block';
  $('brief-recs-list').innerHTML = (briefStrategySummary ? `<p class="sub" style="margin:0 0 12px;">${esc(briefStrategySummary)}</p>` : '') +
    briefRecOptions.map((o, idx) => `
      <div class="ai-rec-card selectable ${briefSelectedRec === idx ? 'selected' : ''}" data-brief-select-rec="${idx}">
        <div class="ai-rec-headline">${esc(o.headline||'(untitled)')}</div>
        ${o.sub ? `<div class="ai-rec-sub">${esc(o.sub)}</div>` : ''}
        <p class="ai-rec-caption">${esc(o.caption||'')}</p>
      </div>
    `).join('');
  $('brief-recs-list').querySelectorAll('[data-brief-select-rec]').forEach(card => {
    card.addEventListener('click', () => {
      briefSelectedRec = parseInt(card.dataset.briefSelectRec, 10);
      renderBriefRecs();
    });
  });
}

async function saveBrief(){
  const fields = collectBriefFields();
  if(!fields.title){ alert('Give this campaign a name first.'); return; }
  const status = $('brief-generate-status');
  const brief = Object.assign({}, fields, {
    referenceImages: briefRefImages,
    visualCopywriting: briefSelectedRec !== null ? briefRecOptions[briefSelectedRec] : null,
    strategySummary: briefSelectedRec !== null ? briefStrategySummary : null
  });
  const saved = await api('/api/campaign-briefs', { method:'POST', body: JSON.stringify(brief) });
  if(saved && saved.id){
    savedBriefs.push(saved);
    renderSavedBriefs();
    ['brief-title','brief-background','brief-audience','brief-objective','brief-timeline','brief-channels','brief-terms','brief-ref-links','brief-draft-headline','brief-draft-sub','brief-draft-caption'].forEach(id => $(id).value = '');
    briefRefImages = []; renderBriefRefImages(); renderBriefVizrefGrid();
    briefRecOptions = []; briefSelectedRec = null; renderBriefRecs();
    status.textContent = 'Saved ✓';
  } else {
    status.textContent = (saved && saved.error) || 'Could not save.';
  }
}

async function deleteBrief(id){
  if(!confirm('Delete this campaign brief?')) return;
  await api('/api/campaign-briefs/' + id, { method:'DELETE' });
  savedBriefs = savedBriefs.filter(b => b.id !== id);
  renderSavedBriefs();
}

function renderSavedBriefs(){
  const empty = $('brief-saved-empty');
  if(!savedBriefs.length){
    $('brief-saved-list').innerHTML = '';
    if(empty) empty.style.display = 'block';
    return;
  }
  if(empty) empty.style.display = 'none';
  $('brief-saved-list').innerHTML = savedBriefs.slice().reverse().map(b => `
    <div class="brief-saved-card">
      <div class="brief-saved-head">
        <div>
          <div class="brief-saved-title">${esc(b.title)}</div>
          <div class="brief-saved-meta">${fmtDateTime(b.createdAt)}${b.timeline ? ' · ' + esc(b.timeline) : ''}</div>
        </div>
        <div class="brief-saved-actions">
          <button class="btn btn-outline btn-sm" data-brief-canva="${esc(b.id)}">${b.canva ? 'Re-send to Canva' : 'Send to Canva'}</button>
          <button class="btn btn-outline btn-sm" data-brief-export="${esc(b.id)}">Export</button>
          <button class="btn btn-outline btn-sm" data-brief-delete="${esc(b.id)}">Delete</button>
        </div>
      </div>
      ${b.objective ? `<p class="ai-rec-caption">${esc(b.objective)}</p>` : ''}
      <div id="brief-canva-status-${esc(b.id)}" class="rescrape-status" style="margin-top:6px;">
        ${b.canva && b.canva.editUrl ? `<a href="${esc(b.canva.editUrl)}" target="_blank" rel="noopener">Open in Canva ↗</a>` : ''}
      </div>
    </div>
  `).join('');
  $('brief-saved-list').querySelectorAll('[data-brief-delete]').forEach(btn => {
    btn.addEventListener('click', () => deleteBrief(btn.dataset.briefDelete));
  });
  $('brief-saved-list').querySelectorAll('[data-brief-export]').forEach(btn => {
    btn.addEventListener('click', () => exportBrief(btn.dataset.briefExport));
  });
  $('brief-saved-list').querySelectorAll('[data-brief-canva]').forEach(btn => {
    btn.addEventListener('click', () => sendBriefToCanva(btn.dataset.briefCanva));
  });
}

async function sendBriefToCanva(id){
  const statusEl = $('brief-canva-status-' + id);
  statusEl.textContent = 'Sending to Canva…';
  const res = await api('/api/canva/autofill/brief/' + id, { method:'POST', body: JSON.stringify({ templateKey: 'briefCover' }) });
  if(res && res.ok !== false && res.editUrl){
    const brief = savedBriefs.find(b => b.id === id);
    if(brief) brief.canva = res;
    statusEl.innerHTML = `<a href="${esc(res.editUrl)}" target="_blank" rel="noopener">Open in Canva ↗</a>`;
  } else {
    statusEl.textContent = (res && res.error) || 'Could not send to Canva.';
  }
}

function exportBrief(id){
  const b = savedBriefs.find(x => x.id === id);
  if(!b) return;
  const vc = b.visualCopywriting;
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>${esc(b.title)} — Campaign Brief</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,500;0,9..144,700&family=Inclusive+Sans:wght@400;600;700&display=swap" rel="stylesheet">
<style>
body{margin:0;font-family:'Inclusive Sans',sans-serif;background:#EFEAE0;color:#2B221B;padding:0 0 60px;}
.serif{font-family:'Fraunces',serif;}
h1{font-family:'Fraunces',serif;padding:32px 40px 0;margin:0;}
.sub{padding:0 40px;color:#726654;}
section{padding:18px 40px;}
h2{font-size:12px; text-transform:uppercase; letter-spacing:.06em; color:#726654; margin:0 0 8px;}
p{margin:0; line-height:1.6; white-space:pre-wrap;}
.imgs{display:flex; flex-wrap:wrap; gap:14px; margin-top:8px;}
.imgs img{width:220px; height:220px; object-fit:cover; border-radius:10px; border:1px solid #E5DFD0;}
.vc-card{background:#FCFBF7; border:1px solid #E5DFD0; border-radius:12px; padding:18px 20px; margin-top:8px;}
.vc-card .headline{font-family:'Fraunces',serif; font-size:20px; margin-bottom:4px;}
.vc-card .subhead{font-style:italic; color:#726654; margin-bottom:10px;}
hr{border:none; border-top:1px solid #E5DFD0; margin:0;}
</style></head><body>
<h1>${esc(b.title)}</h1>
<p class="sub">Campaign brief — exported from Wonderland, ${fmtDateTime(b.createdAt)}</p>
<hr>
<section><h2>Campaign Background</h2><p>${esc(b.background||'—')}</p></section>
<section><h2>Target Audience</h2><p>${esc(b.audience||'—')}</p></section>
<section><h2>Campaign Objective</h2><p>${esc(b.objective||'—')}</p></section>
<section><h2>Timeline Campaign</h2><p>${esc(b.timeline||'—')}</p></section>
<section><h2>Media Channels</h2><p>${esc(b.channels||'—')}</p></section>
<section><h2>Terms and Condition Campaign</h2><p>${esc(b.terms||'—')}</p></section>
<section><h2>References Visual</h2><div class="imgs">${(b.referenceImages||[]).map(img => `<img src="${img.kind === 'upload' ? `data:${img.mimeType};base64,${img.data}` : (location.origin + img.url)}" alt="${esc(img.name)}">`).join('') || '<p>—</p>'}</div></section>
<section><h2>References Content</h2><p>${esc(b.refLinks||'—')}</p></section>
<section><h2>Visual Copywriting</h2>
${vc ? `<div class="vc-card">
  <div class="headline">${esc(vc.headline||'')}</div>
  ${vc.sub ? `<div class="subhead">${esc(vc.sub)}</div>` : ''}
  <p>${esc(vc.caption||'')}</p>
</div>` : '<p>Not generated yet.</p>'}
</section>
</body></html>`;
  const blob = new Blob([html], {type:'text/html'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `${b.title.replace(/[^a-z0-9]+/gi,'-')}-Campaign-Brief.html`;
  a.click();
  URL.revokeObjectURL(url);
}

async function loadPastedPlanFromText(raw){
  const cleaned = raw.trim().replace(/^```(js|json)?/i,'').replace(/```$/,'').trim();
  const arr = new Function('return ' + cleaned)();
  if(!Array.isArray(arr)) throw new Error('not an array');
  const used = usedReferenceUrls();
  const usedDir = usedDirectoryARefIds();
  arr.forEach(item => {
    if(!item.referencePost) item.referencePost = autoResolveReferenceForPost(item, used);
    if(item.referencePost) used.add(item.referencePost.url);
    if(!item.directoryARef) item.directoryARef = autoResolveDirectoryAReference(item, usedDir);
    if(item.directoryARef) usedDir.add(item.directoryARef.id);
    if(!item.generatedBy) item.generatedBy = 'claude'; // pasted from a Claude chat session
  });
  posts = await api('/api/posts/bulk', { method:'POST', body: JSON.stringify(arr) }) || posts;
}

async function loadPastedPlan(){
  const raw = $('paste-box').value.trim();
  if(!raw) return;
  try {
    await loadPastedPlanFromText(raw);
    $('paste-box').value = '';
  } catch(e){
    alert('Could not parse that plan. Make sure it\'s a valid posts array. (' + e.message + ')');
  }
}

async function loadPastedPlanFile(){
  const input = $('paste-file');
  const file = input.files && input.files[0];
  if(!file) return;
  try {
    const text = await file.text();
    await loadPastedPlanFromText(text);
    input.value = '';
    $('paste-box').value = '';
  } catch(e){
    alert('Could not parse that .md file. Make sure it contains a valid posts array. (' + e.message + ')');
  }
}

async function clearAll(){
  if(!confirm('Clear all posts in this plan?')) return;
  await api('/api/posts', { method:'DELETE' });
  posts = [];
}

/* ---------- moodboard (same paste-from-Claude-chat workflow as the content plan) ---------- */
async function loadPastedMoodboardFromText(raw){
  const cleaned = raw.trim().replace(/^```(js|json)?/i,'').replace(/```$/,'').trim();
  const arr = new Function('return ' + cleaned)();
  if(!Array.isArray(arr)) throw new Error('not an array');
  arr.forEach(item => { if(!item.generatedBy) item.generatedBy = 'claude'; });
  moodboard = await api('/api/moodboard/bulk', { method:'POST', body: JSON.stringify(arr) }) || moodboard;
  renderMoodboard();
}

async function loadPastedMoodboard(){
  const raw = $('mb-paste-box').value.trim();
  if(!raw) return;
  try {
    await loadPastedMoodboardFromText(raw);
    $('mb-paste-box').value = '';
  } catch(e){
    alert('Could not parse that moodboard. Make sure it\'s a valid items array. (' + e.message + ')');
  }
}

async function loadPastedMoodboardFile(){
  const input = $('mb-paste-file');
  const file = input.files && input.files[0];
  if(!file) return;
  try {
    const text = await file.text();
    await loadPastedMoodboardFromText(text);
    input.value = '';
    $('mb-paste-box').value = '';
  } catch(e){
    alert('Could not parse that .md file. Make sure it contains a valid items array. (' + e.message + ')');
  }
}

async function clearMoodboard(){
  if(!confirm('Clear the whole moodboard for this client?')) return;
  await api('/api/moodboard', { method:'DELETE' });
  moodboard = [];
  renderMoodboard();
}

async function deleteMoodboardItem(id){
  await api('/api/moodboard/' + id, { method:'DELETE' });
  moodboard = moodboard.filter(m => m.id !== id);
  renderMoodboard();
}

function renderMoodboard(){
  const grid = $('moodboard-grid');
  if(!grid) return;
  const empty = $('moodboard-empty');
  if(!moodboard.length){
    grid.innerHTML = '';
    if(empty) empty.style.display = 'block';
    return;
  }
  if(empty) empty.style.display = 'none';
  grid.innerHTML = moodboard.map(item => `
    <div class="moodboard-card">
      ${item.referenceImage ? `<img src="${esc(item.referenceImage)}" alt="${esc(item.title || '')}">` : ''}
      <h3>${esc(item.title || 'Untitled')}</h3>
      ${item.description ? `<p>${esc(item.description)}</p>` : ''}
      ${Array.isArray(item.colorPalette) && item.colorPalette.length ? `<div class="moodboard-swatches">${item.colorPalette.map(c => `<div class="moodboard-swatch" style="background:${esc(c)}" title="${esc(c)}"></div>`).join('')}</div>` : ''}
      ${Array.isArray(item.tags) && item.tags.length ? `<div class="moodboard-tags">${item.tags.map(t => `<span class="moodboard-tag">${esc(t)}</span>`).join('')}</div>` : ''}
      <div class="moodboard-card-actions"><button class="btn btn-outline btn-sm" data-mb-del="${esc(item.id)}">Remove</button></div>
    </div>
  `).join('');
  grid.querySelectorAll('[data-mb-del]').forEach(btn => {
    btn.addEventListener('click', () => deleteMoodboardItem(btn.dataset.mbDel));
  });
}


// Recomputes every post's reference from scratch (not just the ones missing one) — run this
// after the category taxonomy or matching logic improves, so old low-quality/duplicated
// matches (e.g. many posts pointing at the same "best overall" post) get replaced with
// better, more varied ones. Tracks used URLs as it goes so posts spread across distinct
// competitor examples instead of collapsing onto a single repeated favorite.
async function fillMissingReferences(){
  if(!posts.length){ alert('No posts in this plan yet.'); return; }
  const btn = $('btn-fill-refs');
  btn.disabled = true;
  const originalText = btn.textContent;
  const used = new Set();
  const usedDir = new Set();
  let filled = 0;
  for(let i = 0; i < posts.length; i++){
    const p = posts[i];
    const guess = autoResolveReferenceForPost(p, used);
    const dirGuess = autoResolveDirectoryAReference(p, usedDir);
    if(dirGuess) usedDir.add(dirGuess.id);
    const sameCompetitorRef = guess && p.referencePost && p.referencePost.url === guess.url;
    const sameDirRef = (dirGuess ? dirGuess.id : null) === (p.directoryARef ? p.directoryARef.id : null);
    if(guess) used.add(guess.url);
    if((!guess || sameCompetitorRef) && sameDirRef) continue; // nothing changed, skip the write
    btn.textContent = `Matching… (${i+1}/${posts.length})`;
    const body = {};
    if(guess) body.referencePost = guess;
    body.directoryARef = dirGuess;
    const updated = await api('/api/posts/' + p.id, { method: 'PUT', body: JSON.stringify(body) });
    if(updated){
      posts[i] = updated;
      filled++;
    }
  }
  btn.textContent = originalText;
  btn.disabled = false;
  alert(`Re-matched ${filled} post${filled===1?'':'s'} to a reference (competitor and/or your own archive).`);
}

function esc(s){ return (s||'').toString().replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }

const AGENT_BADGE_MAP = {
  gemini: { label: 'Gemini', cls: 'agent-gemini' },
  'gemini-chat': { label: 'Gemini Chat', cls: 'agent-gemini-chat' },
  intelligence: { label: 'Gemini Creative', cls: 'agent-intelligence' },
  claude: { label: 'Claude', cls: 'agent-claude' },
  'claude-chat': { label: 'Claude Chat', cls: 'agent-claude-chat' },
  'gpt-chat': { label: 'GPT Chat', cls: 'agent-gpt-chat' },
  'kimi-chat': { label: 'Kimi Chat', cls: 'agent-kimi-chat' },
  manual: { label: 'Manual', cls: 'agent-manual' }
};

function agentBadgeByName(agent){
  const m = AGENT_BADGE_MAP[agent] || AGENT_BADGE_MAP.claude;
  return `<span class="agent-badge ${m.cls}">${m.label}</span>`;
}

function fmtDateTime(iso){
  if(!iso) return '—';
  return new Date(iso).toLocaleString('en-US', { year:'numeric', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
}

async function loadDashboard(){
  const data = await api('/api/dashboard');
  if(!data) return;

  $('dash-kpi-posts').textContent = data.totalPosts;
  $('dash-kpi-upcoming').textContent = data.upcomingCount7d;
  $('dash-kpi-aiusage').textContent = data.aiUsage30d.count;
  $('dash-kpi-aiusage-cap').textContent = data.aiUsage30d.tokens.toLocaleString() + ' tokens';
  $('dash-kpi-status').textContent = data.atRisk ? 'Perlu perhatian' : 'Aktif';
  $('dash-kpi-status-icon').style.background = data.atRisk ? '#FDECEC' : 'var(--success-bg)';
  $('dash-kpi-status-icon').style.color = data.atRisk ? '#DC2626' : 'var(--success)';
  $('dash-kpi-lastactivity').textContent = data.lastActivityAt ? 'Aktivitas terakhir ' + fmtDateTime(data.lastActivityAt) : 'Belum ada aktivitas';

  $('dash-deadlines-list').innerHTML = data.upcomingDeadlines.map(d => `
    <div class="rec-item"><div class="rec-icon">◆</div><div>
      <b>${esc(d.headline || '(untitled)')}</b><br>
      <span style="color:var(--fg-muted);">${fmtDateTime(d.date)}${d.format ? ' · ' + esc(d.format) : ''}</span>
    </div></div>`).join('') || '<div class="rec-item">Gak ada deadline dalam 7 hari ke depan.</div>';

  $('dash-activity-list').innerHTML = data.activityFeed.map(e => `
    <div class="rec-item"><div class="rec-icon">✦</div><div>
      <b>${esc(e.agent || 'agent')}</b> — ${esc((e.requestText || '').slice(0, 80))}<br>
      <span style="color:var(--fg-muted);">${fmtDateTime(e.timestamp)}${e.postCount ? ' · ' + e.postCount + ' post' : ''}</span>
    </div></div>`).join('') || '<div class="rec-item">Belum ada aktivitas.</div>';
}

// Directory A is a cross-client screen — not tied to whichever client is active in the
// session — so it tracks its own "which client's detail am I looking at" state separately.
let dirDetailSlug = null;
const DRIVE_SERVICE_ACCOUNT_EMAIL = 'wonderland-drive-reader@gen-lang-client-0440538800.iam.gserviceaccount.com';

async function loadDirectoryA(){
  dirDetailSlug = null;
  $('dira-list-view').style.display = 'block';
  $('dira-detail-view').style.display = 'none';
  await renderDirectoryAClientList();
}

async function renderDirectoryAClientList(){
  $('dira-client-list').innerHTML = '<div class="rec-item">Loading…</div>';
  const clients = await api('/api/directory-a/overview') || [];
  $('dira-client-list').innerHTML = clients.map(c => `
    <div class="dira-client-row">
      <div>
        <div class="dira-client-name">${esc(c.name)}</div>
        <div class="dira-client-meta">${c.configured
          ? (c.fileCount !== null ? `${c.fileCount} file — sync terakhir ${fmtDateTime(c.syncedAt)}` : 'Folder linked, belum pernah di-sync')
          : 'Belum ada folder Drive terhubung'}</div>
      </div>
      <div class="dira-client-actions">
        <button class="btn btn-accent btn-sm" data-open-detail="${esc(c.slug)}">${c.configured ? 'View details' : 'Link folder'}</button>
      </div>
    </div>`).join('') || '<div class="rec-item">Belum ada klien.</div>';
  $('dira-client-list').querySelectorAll('[data-open-detail]').forEach(btn => {
    btn.addEventListener('click', () => openDirectoryADetail(btn.dataset.openDetail));
  });
}

function closeDirectoryADetail(){
  loadDirectoryA();
}

async function openDirectoryADetail(slug){
  dirDetailSlug = slug;
  $('dira-list-view').style.display = 'none';
  $('dira-detail-view').style.display = 'block';
  $('dira-link-help').textContent = `Belum bisa diakses? Share folder itu dulu ke ${DRIVE_SERVICE_ACCOUNT_EMAIL} (Viewer), baru link lagi.`;
  $('dira-link-input').value = '';
  $('dira-link-status').textContent = '';

  const data = await api('/api/directory-a/' + slug);
  if(!data) return;
  $('dira-not-configured').style.display = data.configured ? 'none' : 'block';
  $('btn-dira-sync').style.display = data.configured ? 'inline-block' : 'none';
  renderDirectoryA(data.manifest);
  if(data.syncStatus === 'syncing'){
    $('btn-dira-sync').disabled = true;
    $('dira-status').textContent = 'Syncing dari Google Drive… bisa makan waktu 1-2 menit kalau arsipnya besar.';
    pollDirectoryASync();
  } else if(data.syncStatus === 'error'){
    $('dira-status').textContent = 'Sync gagal: ' + (data.syncError || 'unknown error');
  }
}

async function pollDirectoryASync(){
  if(!dirDetailSlug) return;
  const data = await api('/api/directory-a/' + dirDetailSlug);
  if(!data) return;
  if(data.syncStatus === 'syncing'){
    setTimeout(pollDirectoryASync, 4000);
    return;
  }
  $('btn-dira-sync').disabled = false;
  if(data.syncStatus === 'error'){
    $('dira-status').textContent = 'Sync gagal: ' + (data.syncError || 'unknown error');
  } else {
    renderDirectoryA(data.manifest);
  }
}

function renderDirectoryA(manifest){
  if(!manifest){
    $('dira-status').textContent = 'Belum pernah di-sync.';
    $('dira-groups').innerHTML = '';
    return;
  }
  $('dira-status').textContent = `Terakhir sync ${fmtDateTime(manifest.syncedAt)} — ${manifest.files.length} file${manifest.truncated ? ' (dipotong, arsipnya lebih besar dari batas)' : ''}.`;

  const byFolder = {};
  manifest.files.forEach(f => {
    const key = f.path || '(root)';
    (byFolder[key] = byFolder[key] || []).push(f);
  });

  $('dira-groups').innerHTML = Object.entries(byFolder).map(([folder, files]) => `
    <div class="dira-folder">
      <h3>${esc(folder)} <span class="dira-count">(${files.length})</span></h3>
      <div class="dira-grid">
        ${files.map(f => f.hasThumbnail
          ? `<a class="dira-thumb" href="${esc(f.webViewLink)}" target="_blank" title="${esc(f.name)}${f.isRawArchiveSummary ? ' — ' + f.fileCount + ' files, not indexed individually' : ''}"><img src="${withBase('/media/directory-a/' + dirDetailSlug + '/' + f.id + '.jpg')}" loading="lazy">${f.isRawArchiveSummary ? `<span class="dira-thumb-badge">${f.fileCount}</span>` : ''}</a>`
          : `<a class="dira-thumb no-thumb" href="${esc(f.webViewLink)}" target="_blank" title="${esc(f.name)}">${esc(f.name)}${f.isRawArchiveSummary ? '<br>' + f.fileCount + ' files' : ''}</a>`
        ).join('')}
      </div>
    </div>`).join('');
}

async function syncDirectoryA(){
  if(!dirDetailSlug) return;
  const btn = $('btn-dira-sync');
  btn.disabled = true;
  $('dira-status').textContent = 'Syncing dari Google Drive… bisa makan waktu 1-2 menit kalau arsipnya besar.';
  try {
    const res = await api('/api/directory-a/' + dirDetailSlug + '/sync', { method:'POST' });
    if(res && res.ok){
      pollDirectoryASync(); // re-enables the button itself once the background sync finishes
    } else {
      $('dira-status').textContent = (res && res.error) || 'Sync gagal.';
      btn.disabled = false;
    }
  } catch(e){
    $('dira-status').textContent = 'Could not reach the server.';
    btn.disabled = false;
  }
}

async function linkDriveFolder(){
  if(!dirDetailSlug) return;
  const url = $('dira-link-input').value.trim();
  if(!url) return;
  $('dira-link-status').textContent = 'Checking access…';
  const res = await api('/api/directory-a/' + dirDetailSlug + '/link', { method:'POST', body: JSON.stringify({ folderUrl: url }) });
  if(res && res.ok){
    await openDirectoryADetail(dirDetailSlug);
  } else {
    $('dira-link-status').textContent = (res && res.error) || 'Gagal link folder.';
  }
}

/* ---------- Canva (Brand Template autofill — connect account, map templates, send briefs) ---------- */
let canvaTemplateOptions = [];

async function loadCanvaPage(){
  const status = await api('/api/canva/status');
  if(!status){ return; }

  $('canva-not-configured').style.display = status.configured ? 'none' : 'block';
  $('canva-connect-row').style.display = (status.configured && !status.connected) ? 'flex' : 'none';
  $('canva-connected-row').style.display = (status.configured && status.connected) ? 'flex' : 'none';
  $('canva-connected-name').textContent = status.connectedName ? ` as ${status.connectedName}` : '';
  $('canva-mapping-card').style.display = status.connected ? 'block' : 'none';

  if(status.connected){
    await loadCanvaTemplateOptions();
    ['briefCover','feed','story'].forEach(key => {
      $('canva-map-' + key).value = (status.templates && status.templates[key]) || '';
    });
  }
}

async function loadCanvaTemplateOptions(){
  const res = await api('/api/canva/brand-templates');
  canvaTemplateOptions = (res && res.templates) || [];
  const optionsHtml = '<option value="">— pick a template —</option>' +
    canvaTemplateOptions.map(t => `<option value="${esc(t.id)}">${esc(t.title)}</option>`).join('');
  ['briefCover','feed','story'].forEach(key => { $('canva-map-' + key).innerHTML = optionsHtml; });
  if(!res || !res.ok) $('canva-mapping-status').textContent = (res && res.error) || 'Could not load Brand Templates.';
}

async function saveCanvaMapping(){
  const templates = {
    briefCover: $('canva-map-briefCover').value,
    feed: $('canva-map-feed').value,
    story: $('canva-map-story').value
  };
  $('canva-mapping-status').textContent = 'Saving…';
  const res = await api('/api/canva/template-mapping', { method:'POST', body: JSON.stringify({ templates }) });
  $('canva-mapping-status').textContent = (res && res.ok) ? 'Saved ✓' : ((res && res.error) || 'Could not save.');
}

async function disconnectCanva(){
  if(!confirm('Disconnect this Canva account?')) return;
  await api('/api/canva/disconnect', { method:'POST' });
  loadCanvaPage();
}

async function createNewClient(){
  const input = $('dira-new-client-name');
  const name = input.value.trim();
  if(!name) return;
  $('dira-create-status').textContent = 'Creating…';
  const res = await api('/api/clients', { method:'POST', body: JSON.stringify({ name }) });
  if(res && res.ok){
    input.value = '';
    $('dira-create-status').textContent = '';
    $('dira-add-client-form').style.display = 'none';
    renderDirectoryAClientList();
  } else {
    $('dira-create-status').textContent = (res && res.error) || 'Gagal bikin client.';
  }
}

// Competitor tracking now lives directly on the Competitor Dashboard (Analytics page) instead of
// its own cross-client tab — this instance is single-client (Buranchi), so a client-picker landing
// view added nothing. Instagram is the only platform actually scraped; LinkedIn entries are stored
// for reference so the list can grow before that pipeline exists.
async function loadTrackedCompetitors(){
  const list = await api('/api/competitors/' + currentOrgSlug) || [];
  renderTrackedCompetitors(list);
}

function renderTrackedCompetitors(list){
  $('comp-rows').innerHTML = list.map(c => `
    <div class="comp-row">
      <div class="comp-row-info">
        <span class="comp-swatch" style="background:${esc(c.color)};"></span>
        <span class="comp-row-name">${esc(c.brandName)}</span>
        <span class="comp-row-handle">${c.platform === 'linkedin' ? 'LinkedIn' : '@' + esc(c.handle)}</span>
      </div>
      <button class="btn btn-outline btn-sm" data-remove-comp="${esc(c.handle)}">Remove</button>
    </div>`).join('') || '<div class="rec-item">No competitors tracked yet.</div>';
  $('comp-rows').querySelectorAll('[data-remove-comp]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await api('/api/competitors/' + currentOrgSlug + '/' + encodeURIComponent(btn.dataset.removeComp), { method:'DELETE' });
      loadTrackedCompetitors();
    });
  });
}

async function addCompetitor(){
  const name = $('comp-new-name').value.trim();
  const platform = $('comp-new-platform').value;
  const link = $('comp-new-link').value.trim();
  if(!name || !link) return;
  $('comp-add-status').textContent = 'Adding…';
  const res = await api('/api/competitors/' + currentOrgSlug, { method:'POST', body: JSON.stringify({ name, platform, link }) });
  if(res && res.ok){
    $('comp-new-name').value = '';
    $('comp-new-link').value = '';
    $('comp-add-status').textContent = '';
    loadTrackedCompetitors();
  } else {
    $('comp-add-status').textContent = (res && res.error) || 'Could not add competitor.';
  }
}

async function loadHistory(){
  const log = await api('/api/generate-plan/history') || [];

  const totals = { requests: log.length, posts: 0, tokens: 0 };
  const byAgent = { gemini: { requests: 0, posts: 0, tokens: 0 }, 'gemini-chat': { requests: 0, posts: 0, tokens: 0 }, intelligence: { requests: 0, posts: 0, tokens: 0 }, claude: { requests: 0, posts: 0 }, manual: { requests: 0, posts: 0 } };
  log.forEach(e => {
    const agent = e.agent || 'claude';
    totals.posts += e.postCount || 0;
    totals.tokens += (e.tokenUsage && e.tokenUsage.total) || 0;
    if(!byAgent[agent]) byAgent[agent] = { requests: 0, posts: 0, tokens: 0 };
    byAgent[agent].requests += 1;
    byAgent[agent].posts += e.postCount || 0;
    if(e.tokenUsage) byAgent[agent].tokens = (byAgent[agent].tokens || 0) + (e.tokenUsage.total || 0);
  });

  $('history-summary').innerHTML = `
    <div class="kpi-card">
      <div class="top-row"><div class="lab">Total requests</div><div class="kpi-icon" style="background:var(--accent-50); color:var(--accent);">◆</div></div>
      <div class="val">${totals.requests}</div>
    </div>
    <div class="kpi-card">
      <div class="top-row"><div class="lab">Total posts generated</div><div class="kpi-icon" style="background:#FFF4CC; color:#8A6D00;">▦</div></div>
      <div class="val">${totals.posts}</div>
    </div>
    <div class="kpi-card">
      <div class="top-row"><div class="lab">Total tokens used (Gemini)</div><div class="kpi-icon" style="background:#E4F0FF; color:#1C5EA6;">⚡</div></div>
      <div class="val">${totals.tokens.toLocaleString()}</div>
    </div>
    <div class="kpi-card">
      <div class="top-row"><div class="lab">By agent</div></div>
      <div style="font-size:13px; line-height:1.9; margin-top:10px;">
        ${['gemini','gemini-chat','intelligence','claude','claude-chat','gpt-chat','kimi-chat','manual'].map(a => `${agentBadgeByName(a)} ${byAgent[a] ? byAgent[a].requests : 0} req · ${byAgent[a] ? byAgent[a].posts : 0} posts`).join('<br>')}
      </div>
    </div>
  `;

  $('history-empty').style.display = log.length ? 'none' : 'block';
  $('history-body').innerHTML = log.map(e => {
    const request = e.requestText || e.focus || (e.days ? `Generate plan (${e.days} post cap)` : '—');
    const tokens = (e.tokenUsage && typeof e.tokenUsage.total === 'number')
      ? `${e.tokenUsage.total.toLocaleString()}` + (typeof e.tokenUsage.prompt === 'number' && typeof e.tokenUsage.output === 'number'
          ? ` <span style="color:var(--muted); font-size:12px;">(in ${e.tokenUsage.prompt.toLocaleString()} / out ${e.tokenUsage.output.toLocaleString()})</span>`
          : '')
      : '—';
    return `<tr>
      <td>${fmtDateTime(e.timestamp)}</td>
      <td>${agentBadgeByName(e.agent || 'claude')}</td>
      <td>${esc(request)}</td>
      <td>${e.postCount || 0}</td>
      <td>${tokens}</td>
    </tr>`;
  }).join('');
}

function timeAgo(iso){
  if(!iso) return '';
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if(mins < 1) return 'just now';
  if(mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if(hrs < 24) return `${hrs}h ago`;
  return fmtDate(iso);
}

function addRuleRow(value, listId){
  const list = $(listId || 'gr-rules-list');
  const empty = list.querySelector('.gr-rules-empty');
  if(empty) empty.remove();
  const row = document.createElement('div');
  row.className = 'gr-rule-row';
  row.innerHTML = `<input type="text" value="${esc(value || '')}" placeholder="e.g. Jangan pernah janjikan diskon spesifik tanpa konfirmasi manual">
    <button type="button" class="gr-rule-remove" title="Remove">×</button>`;
  row.querySelector('.gr-rule-remove').addEventListener('click', () => {
    row.remove();
    if(!list.children.length) list.innerHTML = '<div class="gr-rules-empty">Belum ada aturan tambahan.</div>';
  });
  list.appendChild(row);
  return row;
}

function renderRulesList(rules, listId){
  const list = $(listId || 'gr-rules-list');
  list.innerHTML = '';
  if(rules && rules.length){
    rules.forEach(r => addRuleRow(r, listId));
  } else {
    list.innerHTML = '<div class="gr-rules-empty">Belum ada aturan tambahan.</div>';
  }
}

function collectRules(listId){
  return Array.from($(listId || 'gr-rules-list').querySelectorAll('.gr-rule-row input'))
    .map(inp => inp.value.trim())
    .filter(Boolean);
}

async function loadGuardrails(){
  const g = await api('/api/chat/guardrails');
  if(g){
    $('gr-max-posts').value = g.maxPostsPerProposal || 10;
    renderRulesList(g.rules || []);
  }
  guardrailsLoaded = true;
}

async function saveGuardrails(){
  const maxPostsPerProposal = parseInt($('gr-max-posts').value, 10) || 10;
  const rules = collectRules();
  $('guardrails-status').textContent = 'Saving…';
  const res = await api('/api/chat/guardrails', { method:'PUT', body: JSON.stringify({ maxPostsPerProposal, rules }) });
  $('guardrails-status').textContent = res && res.ok ? 'Saved.' : 'Could not save.';
  if(res && res.ok) renderRulesList(res.guardrails.rules);
}

/* ---------- creative chat (chat + creative intelligence merged, with an auto-routing guard) ---------- */
let ccConversations = [];
let activeCcConversationId = null;
let ccBusy = false;
let ccTurnCounter = 0; // gives every rendered intelligence-result card a unique DOM id, so multiple can coexist in one conversation
let ccAttachments = []; // [{name, mimeType, kind:'text'|'image', content}] — content is text or base64 (no data: prefix)
const CC_PROVIDER_LABELS = { gemini: 'Gemini', claude: 'Claude', gpt: 'GPT', kimi: 'Kimi' };

const ATTACHMENT_TEXT_TYPES = /\.(txt|md|markdown|csv|json)$/i;

// Shared by Creative Chat and the Content Plan "Generate with AI" form — both let the user attach
// images (sent as inlineData for the model to see) or small text docs (inlined into the prompt).
async function readAttachmentFiles(files){
  const results = [];
  for(const file of files){
    const isImage = file.type.startsWith('image/');
    try {
      if(isImage){
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
        results.push({ name: file.name, mimeType: file.type, kind: 'image', content: dataUrl.split(',')[1] });
      } else if(ATTACHMENT_TEXT_TYPES.test(file.name)){
        const text = await file.text();
        results.push({ name: file.name, mimeType: file.type || 'text/plain', kind: 'text', content: text });
      } else {
        alert(`"${file.name}" isn't a supported attachment type (images, or .txt/.md/.csv/.json).`);
      }
    } catch(e){
      alert(`Could not read "${file.name}".`);
    }
  }
  return results;
}

function renderAttachmentChips(containerId, list, onRemove){
  $(containerId).innerHTML = list.map((a, idx) => `
    <span class="cc-attachment-chip">${a.kind === 'image' ? '🖼️' : '📄'} ${esc(a.name)}<button type="button" data-att-remove="${idx}">×</button></span>
  `).join('');
  $(containerId).querySelectorAll('[data-att-remove]').forEach(btn => {
    btn.addEventListener('click', () => onRemove(parseInt(btn.dataset.attRemove, 10)));
  });
}

async function addCcAttachments(){
  const input = $('cc-file-input');
  ccAttachments.push(...await readAttachmentFiles(Array.from(input.files || [])));
  input.value = '';
  renderCcAttachments();
}

function removeCcAttachment(idx){
  ccAttachments.splice(idx, 1);
  renderCcAttachments();
}

function renderCcAttachments(){
  renderAttachmentChips('cc-attachments', ccAttachments, removeCcAttachment);
}

function tagList(items){
  if(!items || !items.length) return '<span style="color:var(--fg-soft); font-size:12px;">None flagged.</span>';
  return `<div class="intel-tag-list">${items.map(t => `<span class="intel-tag">${esc(t)}</span>`).join('')}</div>`;
}

// Judge's contentCalendar and creativeBriefs are two separate arrays matched loosely by
// contentRef text (e.g. "2026-09-03 Sore santai di tepi kolam") — this finds the brief that
// belongs to a given calendar post so its visualDirection can render alongside it.
function matchCreativeBrief(post, briefs){
  if(!briefs || !briefs.length) return null;
  return briefs.find(b => b.contentRef && post.date && b.contentRef.includes(post.date) && post.headline && b.contentRef.includes(post.headline))
    || briefs.find(b => b.contentRef && post.headline && b.contentRef.includes(post.headline))
    || null;
}

// A full per-post breakdown — format/ratio, persona/priority, visual direction bullets, the
// complete caption, CTA, and photo direction — deliberately as detailed as a design-brief deck
// (headline, sub, visual direction, caption, CTA, reference photo per slide) so this can be
// reviewed and sharpened in conversation before anything is approved into the calendar.
function renderIntelCalendarPost(p, idx, total, briefs, uid){
  const brief = matchCreativeBrief(p, briefs);
  const visualDirection = (brief && brief.visualDirection && brief.visualDirection.length) ? brief.visualDirection : (p.brief || []);
  const ratio = p.format === 'story' ? '9:16' : '4:5';
  let dayLabel = '';
  try { const d = new Date(p.date); if(!isNaN(d.getTime())) dayLabel = d.toLocaleDateString('en-US', { weekday: 'short' }); } catch(e){}
  const checkId = `${uid}-check-${idx}`;

  return `
    <div class="intel-post-card">
      <div class="intel-post-head">
        <label class="intel-post-approve" title="Centang untuk ikut di-approve">
          <input type="checkbox" id="${checkId}" class="intel-approve-check" data-idx="${idx}" checked>
        </label>
        <span class="intel-post-num">POST ${idx + 1}/${total}</span>
        <span class="intel-post-date">${esc(p.date || '')}${dayLabel ? ' (' + dayLabel + ')' : ''}</span>
        <span class="fmt-pill ${esc(p.format || '')}">${esc((p.format || '').toUpperCase())} · ${ratio}</span>
        ${p.event ? '<span class="event-flag">event</span>' : ''}
        <button type="button" class="btn btn-outline btn-sm intel-refine-btn" style="margin-left:auto;" data-idx="${idx}">✎ Refine via chat</button>
      </div>
      <div class="intel-post-headline">${esc(p.headline || '')}</div>
      ${p.sub ? `<div class="intel-post-sub">${esc(p.sub)}</div>` : ''}
      <div class="intel-post-meta-row">
        <span><b>Persona</b> ${esc(p.persona || '—')}</span>
        <span><b>Priority</b> ${esc(p.priority || '—')}</span>
        ${p.campaignPillar ? `<span><b>Pillar</b> ${esc(p.campaignPillar)}</span>` : ''}
      </div>
      ${visualDirection.length ? `
      <div class="intel-post-section">
        <div class="intel-post-section-label">Visual Direction</div>
        <ul class="detail-list">${visualDirection.map(v => `<li>${esc(v)}</li>`).join('')}</ul>
      </div>` : ''}
      <div class="intel-post-section">
        <div class="intel-post-section-label">Instagram Caption</div>
        <div class="caption-box">${esc(p.caption || '—')}</div>
      </div>
      <div class="intel-post-section">
        <div class="intel-post-section-label">CTA / Data Capture</div>
        <div>${esc(p.cta || '—')}</div>
      </div>
      ${p.photo ? `
      <div class="intel-post-section">
        <div class="intel-post-section-label">Design Reference</div>
        <div style="font-size:12px; color:var(--fg-muted);">${ratio} · ${esc((p.format||'').charAt(0).toUpperCase() + (p.format||'').slice(1))} — Photo direction: ${esc(p.photo)}</div>
      </div>` : ''}
    </div>`;
}

function fmtInputTokens(u){ return u ? `Input: ${(u.prompt||0).toLocaleString()} tokens` : ''; }
function fmtOutputTokens(u){ return u ? `Output: ${(u.output||0).toLocaleString()} tokens` : ''; }

// Sums every turn's token cost in this conversation, split by category — content-plan (the
// 3-agent Market/Brand/Judge pipeline) vs conversation (the router+chat calls, in/out separately)
// — so it's obvious which side of the conversation is actually burning through tokens.
function ccSessionTotals(convo){
  const totals = { total: 0, contentPlan: 0, convoInput: 0, convoOutput: 0, convoTotal: 0 };
  if(!convo || !convo.contents) return totals;
  convo.contents.forEach(turn => {
    if(turn.role !== 'model') return;
    let parsed;
    try { parsed = JSON.parse((turn.parts[0] && turn.parts[0].text) || '{}'); } catch(e){ return; }
    if(!parsed.tokenUsage || typeof parsed.tokenUsage.total !== 'number') return;
    if(parsed.type === 'intelligence-result'){
      totals.contentPlan += parsed.tokenUsage.total;
      totals.total += parsed.tokenUsage.total;
    } else {
      totals.convoInput += parsed.tokenUsage.prompt || 0;
      totals.convoOutput += parsed.tokenUsage.output || 0;
      totals.convoTotal += parsed.tokenUsage.total;
      totals.total += parsed.tokenUsage.total;
    }
  });
  return totals;
}

function renderCcSessionTotals(convo){
  const t = ccSessionTotals(convo);
  $('cc-session-tokens').textContent = t.total
    ? `Session total: ${t.total.toLocaleString()} tokens — Content plan: ${t.contentPlan.toLocaleString()} · Conversation: ${t.convoTotal.toLocaleString()} (in ${t.convoInput.toLocaleString()} / out ${t.convoOutput.toLocaleString()})`
    : '';
}

function renderCcConvoList(){
  const container = $('cc-convo-items');
  if(!ccConversations.length){
    container.innerHTML = '<div class="chat-convo-empty">Belum ada percakapan.</div>';
    return;
  }
  container.innerHTML = ccConversations.map(c => `
    <div class="chat-convo-item ${c.id === activeCcConversationId ? 'active' : ''}" data-id="${c.id}">
      <div class="convo-title">${esc(c.title)}</div>
      <span class="convo-time">${timeAgo(c.updatedAt)} · ${c.messageCount} msg</span>
    </div>
  `).join('');
  container.querySelectorAll('.chat-convo-item').forEach(el => {
    el.addEventListener('click', () => openCcConversation(el.dataset.id));
  });
}

async function loadCcConversationList(autoOpen){
  ccConversations = await api('/api/creative-chat/conversations') || [];
  renderCcConvoList();
  if(autoOpen && !activeCcConversationId && ccConversations.length){
    await openCcConversation(ccConversations[0].id);
  }
}

function ccScrollToBottom(){
  const log = $('cc-log');
  log.scrollTop = log.scrollHeight;
}

function renderCcChatBubble(role, text){
  const empty = $('cc-empty');
  if(empty) empty.remove();
  const row = document.createElement('div');
  row.className = 'chat-row ' + role;
  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble';
  bubble.textContent = text;
  row.appendChild(bubble);
  $('cc-log').appendChild(row);
  ccScrollToBottom();
}

// A user turn shows what THAT exchange cost in input (prompt) tokens; the model turn right after
// it shows the output tokens for its own reply — split from one Gemini call's combined usage so
// each side of the conversation carries its own half of the cost, not one merged caption.
function appendCcTokenCaption(role, label){
  const metaRow = document.createElement('div');
  metaRow.className = 'chat-row ' + role + ' chat-token-row';
  const meta = document.createElement('div');
  meta.className = 'chat-token-meta';
  meta.textContent = label;
  metaRow.appendChild(meta);
  $('cc-log').appendChild(metaRow);
  ccScrollToBottom();
}

function renderCcProposal(proposedPosts, conversationId, turnIndex, alreadyCommitted){
  const empty = $('cc-empty');
  if(empty) empty.remove();
  const wrap = document.createElement('div');
  wrap.className = 'chat-row model';
  const box = document.createElement('div');
  box.className = 'chat-proposal';
  box.innerHTML = `
    <div class="content-card-eyebrow">📋 Content idea</div>
    <div class="chat-proposal-head">Proposed — ${proposedPosts.length} post${proposedPosts.length === 1 ? '' : 's'}</div>
    ${proposedPosts.map(p => `<div class="chat-proposal-item"><b>${esc(p.date || '')} · ${esc(p.headline || '')}</b>${esc(p.sub || '')}</div>`).join('')}
    <button class="btn btn-accent btn-sm" style="margin-top:10px;" ${alreadyCommitted ? 'disabled' : ''}>${alreadyCommitted ? 'Added to plan ✓' : 'Add these to the plan'}</button>
  `;
  if(!alreadyCommitted){
    box.querySelector('button').addEventListener('click', async (e) => {
      e.target.disabled = true;
      e.target.textContent = 'Adding…';
      const used = usedReferenceUrls();
      const usedDir = usedDirectoryARefIds();
      proposedPosts.forEach(item => {
        if(!item.referencePost) item.referencePost = autoResolveReferenceForPost(item, used);
        if(item.referencePost) used.add(item.referencePost.url);
        if(!item.directoryARef) item.directoryARef = autoResolveDirectoryAReference(item, usedDir);
        if(item.directoryARef) usedDir.add(item.directoryARef.id);
      });
      posts = await api('/api/posts/bulk', { method:'POST', body: JSON.stringify(proposedPosts) }) || posts;
      await api(`/api/creative-chat/conversations/${conversationId}/commit`, { method:'POST', body: JSON.stringify({ turnIndex }) });
      e.target.textContent = 'Added to plan ✓';
    });
  }
  wrap.appendChild(box);
  $('cc-log').appendChild(wrap);
  ccScrollToBottom();
}

// Renders a full intelligence-result payload as a compact tabbed card inline in the chat log —
// same content as the Creative Intelligence page, just scoped to a unique id per turn so several
// can coexist in one long conversation without their tab state colliding.
function renderCcIntelligenceCard(result, conversationId, turnIndex, alreadyCommitted){
  const empty = $('cc-empty');
  if(empty) empty.remove();
  const uid = 'cc-intel-' + (ccTurnCounter++);
  const calendar = (result.judge && result.judge.contentCalendar) || [];
  const briefs = (result.judge && result.judge.creativeBriefs) || [];
  const ev = (result.judge && result.judge.evidence) || {};

  const wrap = document.createElement('div');
  wrap.className = 'chat-row model';
  wrap.style.maxWidth = '92%';
  wrap.innerHTML = `
    <div class="intel-card-inline">
      <div class="content-card-eyebrow">📊 Content plan (Market → Brand → Judge)</div>
      <div class="tab-row" id="${uid}-tabs" style="margin-bottom:12px;">
        <button class="tab-btn active" data-itab="strategy">Strategy</button>
        <button class="tab-btn" data-itab="market">Market</button>
        <button class="tab-btn" data-itab="brand">Brand</button>
        <button class="tab-btn" data-itab="calendar">Calendar</button>
        <button class="tab-btn" data-itab="briefs">Briefs</button>
        <button class="tab-btn" data-itab="evidence">Evidence</button>
      </div>
      <div class="intel-panel" id="${uid}-strategy">
        <p>${esc((result.judge && result.judge.strategySummary) || '')}</p>
        <p style="margin-top:10px;"><b>Confidence:</b> ${esc((result.judge && result.judge.confidence) || 'Unknown')}</p>
        <p style="color:var(--fg-muted); font-size:12px; margin-top:8px;">${result.tokenUsage.total.toLocaleString()} tokens (market ${result.tokenUsage.market.total.toLocaleString()} · brand ${result.tokenUsage.brand.total.toLocaleString()} · judge ${result.tokenUsage.judge.total.toLocaleString()})</p>
      </div>
      <div class="intel-panel" id="${uid}-market" style="display:none;">
        <p>${esc((result.market && result.market.marketView) || '')}</p>
        <div class="intel-evidence-group"><h4>Opportunities</h4>${tagList(result.market && result.market.opportunities)}</div>
        <div class="intel-evidence-group"><h4>Avoid</h4>${tagList(result.market && result.market.avoid)}</div>
      </div>
      <div class="intel-panel" id="${uid}-brand" style="display:none;">
        <p>${esc((result.brand && result.brand.brandView) || '')}</p>
        <p style="margin-top:8px;"><b>Recommendation:</b> ${esc((result.brand && result.brand.recommendation) || '')}</p>
        <div class="intel-evidence-group"><h4>Rejected from market view</h4>${tagList(result.brand && result.brand.rejectedFromMarketView)}</div>
      </div>
      <div class="intel-panel" id="${uid}-calendar" style="display:none;">
        <div class="chat-proposal" style="max-width:none;">
          <div class="chat-proposal-head">${calendar.length} post${calendar.length === 1 ? '' : 's'}</div>
          ${calendar.map((p, i) => renderIntelCalendarPost(p, i, calendar.length, briefs, uid)).join('')}
          <button class="btn btn-accent btn-sm" id="${uid}-commit" style="margin-top:10px;" ${alreadyCommitted ? 'disabled' : ''}>${alreadyCommitted ? 'Added to plan ✓' : `Approve selected (${calendar.length})`}</button>
        </div>
      </div>
      <div class="intel-panel" id="${uid}-briefs" style="display:none;">
        ${briefs.map(b => `
          <div class="intel-brief-card">
            <h4>${esc(b.contentRef || '')}</h4>
            <div class="intel-brief-row"><b>Hook</b> ${esc(b.hook || '')}</div>
            <div class="intel-brief-row"><b>Composition</b> ${esc(b.composition || '')}</div>
            <div class="intel-brief-row"><b>Mood</b> ${esc(b.mood || '')}</div>
          </div>
        `).join('') || '<p style="color:var(--fg-soft);">No briefs generated.</p>'}
      </div>
      <div class="intel-panel" id="${uid}-evidence" style="display:none;">
        <div class="intel-evidence-group"><h4>Historical (A)</h4>${tagList(ev.historical)}</div>
        <div class="intel-evidence-group"><h4>Market (B)</h4>${tagList(ev.market)}</div>
        <div class="intel-evidence-group"><h4>Brand (C)</h4>${tagList(ev.brand)}</div>
        <div class="intel-evidence-group"><h4>Assumptions</h4>${tagList(result.judge && result.judge.assumptions)}</div>
      </div>
    </div>
  `;
  $('cc-log').appendChild(wrap);

  wrap.querySelectorAll(`#${uid}-tabs .tab-btn`).forEach(btn => {
    btn.addEventListener('click', () => {
      wrap.querySelectorAll(`#${uid}-tabs .tab-btn`).forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      ['strategy','market','brand','calendar','briefs','evidence'].forEach(t => {
        const panel = wrap.querySelector(`#${uid}-${t}`);
        if(panel) panel.style.display = (t === btn.dataset.itab) ? 'block' : 'none';
      });
    });
  });

  // Refine: instead of a free-for-all text edit, hand the specific post's identity back to the
  // composer so the user's follow-up message stays scoped ("perbaiki post ini") and the model
  // still has the full conversation for context — same "propose, then explicit confirm" pattern,
  // just aimed at one post instead of the whole calendar.
  wrap.querySelectorAll('.intel-refine-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = calendar[Number(btn.dataset.idx)];
      if(!item) return;
      const input = $('cc-input');
      input.value = `Tolong perbaiki post tanggal ${item.date || '?'} — "${item.headline || '(untitled)'}": `;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      input.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  });

  const commitBtn = wrap.querySelector(`#${uid}-commit`);
  const checkboxes = () => Array.from(wrap.querySelectorAll('.intel-approve-check'));
  const refreshCommitLabel = () => {
    if(alreadyCommitted) return;
    const n = checkboxes().filter(c => c.checked).length;
    commitBtn.textContent = n ? `Approve selected (${n})` : 'Approve selected';
    commitBtn.disabled = n === 0;
  };
  if(!alreadyCommitted){
    checkboxes().forEach(c => c.addEventListener('change', refreshCommitLabel));
    refreshCommitLabel();
    commitBtn.addEventListener('click', async (e) => {
      const selectedIdx = checkboxes().filter(c => c.checked).map(c => Number(c.dataset.idx));
      const selected = calendar.filter((_, i) => selectedIdx.includes(i));
      if(!selected.length) return;
      e.target.disabled = true;
      e.target.textContent = 'Adding…';
      const used = usedReferenceUrls();
      const usedDir = usedDirectoryARefIds();
      selected.forEach(item => {
        if(!item.referencePost) item.referencePost = autoResolveReferenceForPost(item, used);
        if(item.referencePost) used.add(item.referencePost.url);
        if(!item.directoryARef) item.directoryARef = autoResolveDirectoryAReference(item, usedDir);
        if(item.directoryARef) usedDir.add(item.directoryARef.id);
        // creativeBriefs never gets saved on its own — carry its visualDirection onto the post
        // itself as `brief` so the design-brief bullets survive past this chat turn.
        if(!item.brief || !item.brief.length){
          const matched = matchCreativeBrief(item, briefs);
          if(matched && matched.visualDirection && matched.visualDirection.length) item.brief = matched.visualDirection;
        }
      });
      posts = await api('/api/posts/bulk', { method:'POST', body: JSON.stringify(selected) }) || posts;
      await api(`/api/creative-chat/conversations/${conversationId}/commit`, { method:'POST', body: JSON.stringify({ turnIndex }) });
      e.target.textContent = `Added ${selected.length} to plan ✓`;
      checkboxes().forEach(c => c.disabled = true);
      wrap.querySelectorAll('.intel-refine-btn').forEach(b => b.disabled = true);
    });
  }
  ccScrollToBottom();
}

const CC_EMPTY_HTML = '<div class="chat-empty" id="cc-empty">Ketik apa yang mau direncanakan atau ditanyakan — misal "buatkan rencana konten untuk minggu ini" atau (setelah ada hasil) "kenapa lo pilih itu?".</div>';

async function openCcConversation(id){
  activeCcConversationId = id;
  renderCcConvoList();
  const convo = await api('/api/creative-chat/conversations/' + id);
  const log = $('cc-log');
  log.innerHTML = '';
  if(!convo || !convo.contents.length){
    log.innerHTML = CC_EMPTY_HTML;
    $('cc-session-tokens').textContent = '';
    return;
  }
  const committed = convo.committedTurns || [];
  convo.contents.forEach((turn, idx) => {
    if(turn.role === 'user'){
      renderCcChatBubble('user', (turn.parts[0] && turn.parts[0].text) || '');
    } else {
      let parsed = {};
      try { parsed = JSON.parse((turn.parts[0] && turn.parts[0].text) || '{}'); } catch(e){ parsed = { type:'chat', message: (turn.parts[0] && turn.parts[0].text) || '' }; }
      if(parsed.type === 'intelligence-result'){
        renderCcIntelligenceCard(parsed, id, idx, committed.includes(idx));
      } else {
        if(parsed.tokenUsage) appendCcTokenCaption('user', fmtInputTokens(parsed.tokenUsage));
        renderCcChatBubble('model', parsed.message || '');
        if(parsed.tokenUsage) appendCcTokenCaption('model', fmtOutputTokens(parsed.tokenUsage));
        if(parsed.posts && parsed.posts.length) renderCcProposal(parsed.posts, id, idx, committed.includes(idx));
      }
    }
  });
  renderCcSessionTotals(convo);
  ccScrollToBottom();
}

async function newCcConversation(){
  const convo = await api('/api/creative-chat/conversations', { method:'POST' });
  activeCcConversationId = convo.id;
  $('cc-log').innerHTML = CC_EMPTY_HTML;
  $('cc-status').textContent = '';
  $('cc-session-tokens').textContent = '';
  await loadCcConversationList(false);
}

async function ensureCcConversation(){
  if(activeCcConversationId) return activeCcConversationId;
  const convo = await api('/api/creative-chat/conversations', { method:'POST' });
  activeCcConversationId = convo.id;
  return convo.id;
}

// Single Send button — the server itself decides (one cheap router call) whether this message
// needs a full Market->Brand->Judge analysis or is just conversation, so the client only ever
// renders whichever shape comes back.
async function sendCcMessage(){
  if(ccBusy) return;
  const input = $('cc-input');
  const message = input.value.trim();
  if(!message && !ccAttachments.length) return;
  await ensureCcConversation();

  const attachments = ccAttachments;
  const provider = $('cc-model-select').value;
  const attachmentNote = attachments.length ? attachments.map(a => `📎 ${a.name}`).join(' ') : '';
  input.value = '';
  ccAttachments = [];
  renderCcAttachments();
  ccBusy = true;
  $('btn-cc-send').disabled = true;
  $('cc-status').textContent = `${CC_PROVIDER_LABELS[provider] || provider} is thinking…`;
  renderCcChatBubble('user', [message, attachmentNote].filter(Boolean).join('\n'));

  try {
    const res = await api(`/api/creative-chat/conversations/${activeCcConversationId}/message`, { method:'POST', body: JSON.stringify({ message, provider, attachments }) });
    if(res && res.ok){
      if(res.needsFullAnalysis){
        if(res.ackTokenUsage) appendCcTokenCaption('user', fmtInputTokens(res.ackTokenUsage));
        renderCcChatBubble('model', res.ack || 'Oke, saya analisis dulu ya…');
        if(res.ackTokenUsage) appendCcTokenCaption('model', fmtOutputTokens(res.ackTokenUsage));
        $('cc-status').textContent = 'Market agent → Brand agent → Creative Judge…';
        renderCcIntelligenceCard(res.result, activeCcConversationId, res.turnIndex, false);
        $('cc-status').textContent = `Done — ${res.result.tokenUsage.total.toLocaleString()} tokens total.`;
      } else {
        if(res.tokenUsage) appendCcTokenCaption('user', fmtInputTokens(res.tokenUsage));
        renderCcChatBubble('model', res.message || '(no reply)');
        if(res.tokenUsage) appendCcTokenCaption('model', fmtOutputTokens(res.tokenUsage));
        if(res.posts && res.posts.length) renderCcProposal(res.posts, activeCcConversationId, res.turnIndex, false);
        $('cc-status').textContent = res.tokenUsage ? `${res.tokenUsage.total.toLocaleString()} tokens · ${res.model}` : '';
      }
      const convo = await api('/api/creative-chat/conversations/' + activeCcConversationId);
      if(convo) renderCcSessionTotals(convo);
      await loadCcConversationList(false);
    } else {
      renderCcChatBubble('error', (res && res.error) || 'Something went wrong.');
      $('cc-status').textContent = '';
    }
  } catch(e){
    renderCcChatBubble('error', 'Request failed — try again.');
    $('cc-status').textContent = '';
  } finally {
    ccBusy = false;
    $('btn-cc-send').disabled = false;
  }
}

async function initCreativeChatPage(){
  await loadCcConversationList(true);
}

/* ---------- agent behavior ---------- */
const AGENT_KEYS = ['market', 'brand', 'judge'];

async function loadAgentBehavior(){
  const cfg = await api('/api/intelligence/agent-behavior');
  if(!cfg) return;
  AGENT_KEYS.forEach(key => {
    const agent = cfg[key] || { defaultConditions: [], extraConditions: [] };
    $('ab-default-' + key).innerHTML = (agent.defaultConditions || []).map(c => `<li>${esc(c)}</li>`).join('');
    renderRulesList(agent.extraConditions || [], 'ab-extra-' + key);
  });
}

async function saveAgentBehavior(){
  const body = {};
  AGENT_KEYS.forEach(key => { body[key] = collectRules('ab-extra-' + key); });
  $('agent-behavior-status').textContent = 'Saving…';
  const res = await api('/api/intelligence/agent-behavior', { method:'PUT', body: JSON.stringify(body) });
  $('agent-behavior-status').textContent = res && res.ok ? 'Saved — berlaku mulai generate berikutnya.' : 'Could not save.';
  if(res && res.ok) AGENT_KEYS.forEach(key => renderRulesList(res[key] || [], 'ab-extra-' + key));
}

/* ---------- calendar & post previews ---------- */
function agentBadge(p){
  const by = p.generatedBy || 'claude'; // plans pasted before this field existed were all Claude-chat-generated
  const m = AGENT_BADGE_MAP[by] || AGENT_BADGE_MAP.claude;
  return `<span class="agent-badge ${m.cls}">${m.label}</span>`;
}

function genDateOf(p){ return p.createdAt ? p.createdAt.slice(0,10) : null; }

function populateGenDateFilters(){
  const dates = [...new Set(posts.map(genDateOf).filter(Boolean))].sort().reverse();
  ['cal-date-filter','prev-date-filter'].forEach(id => {
    const sel = $(id);
    if(!sel) return;
    const current = sel.value;
    sel.innerHTML = '<option value="all">All dates</option>' + dates.map(d =>
      `<option value="${d}">${fmtDate(d)}</option>`
    ).join('');
    if(dates.includes(current)) sel.value = current;
  });
}

function applyPlanFilters(agentFilterId, dateFilterId){
  const agent = $(agentFilterId).value;
  const date = $(dateFilterId).value;
  return posts.filter(p => {
    if(agent !== 'all' && (p.generatedBy || 'claude') !== agent) return false;
    if(date !== 'all' && genDateOf(p) !== date) return false;
    return true;
  });
}

// The scheduled date on a post is a loose string ("Aug 8" or an ISO "2026-08-20"),
// never guaranteed to carry a year, so the grid has to reconstruct a real Date from it —
// falling back to the generation year (createdAt) when the string itself has none.
function parsePostDate(p){
  if(!p.date) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(p.date.trim());
  if(iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  const year = p.createdAt ? new Date(p.createdAt).getFullYear() : new Date().getFullYear();
  const guess = new Date(`${p.date} ${year}`);
  return isNaN(guess.getTime()) ? null : guess;
}

function calDateKey(d){
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

let calGridMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let calViewMode = localStorage.getItem('compass-cal-view') || 'grid';

function renderCalendarGrid(calPosts){
  const byDate = {};
  calPosts.forEach(p => {
    const d = parsePostDate(p);
    if(!d) return;
    const key = calDateKey(d);
    (byDate[key] = byDate[key] || []).push(p);
  });

  const monthStart = new Date(calGridMonth.getFullYear(), calGridMonth.getMonth(), 1);
  $('cal-grid-month-label').textContent = monthStart.toLocaleDateString('en-US', { month:'long', year:'numeric' });

  const gridStart = new Date(monthStart);
  gridStart.setDate(gridStart.getDate() - gridStart.getDay());

  const todayKey = calDateKey(new Date());
  let html = '';
  for(let i = 0; i < 42; i++){
    const cellDate = new Date(gridStart);
    cellDate.setDate(gridStart.getDate() + i);
    const key = calDateKey(cellDate);
    const inMonth = cellDate.getMonth() === monthStart.getMonth();
    const isToday = key === todayKey;
    const dayPosts = byDate[key] || [];
    const shown = dayPosts.slice(0, 3);
    const extra = dayPosts.length - shown.length;
    html += `<div class="cal-cell ${inMonth ? '' : 'cal-cell-out'} ${isToday ? 'cal-cell-today' : ''}">
      <div class="cal-cell-date">${cellDate.getDate()}${isToday ? '<span class="cal-today-dot"></span>' : ''}</div>
      <div class="cal-cell-posts">
        ${shown.map(p => `<div class="cal-chip ${(AGENT_BADGE_MAP[p.generatedBy||'claude']||AGENT_BADGE_MAP.claude).cls}" title="${esc(p.headline||'')}" onclick="openDetail('${p.id}')" style="cursor:pointer;">${esc(p.headline || '(untitled)')}</div>`).join('')}
        ${extra > 0 ? `<div class="cal-chip-more">+${extra} more</div>` : ''}
      </div>
    </div>`;
  }
  $('cal-grid').innerHTML = html;

  const todayPosts = byDate[todayKey] || [];
  const banner = $('cal-today-banner');
  if(todayPosts.length){
    banner.style.display = 'flex';
    banner.innerHTML = `<span class="cal-banner-icon">🔔</span><span>${todayPosts.length} post${todayPosts.length > 1 ? 's' : ''} due today — ${todayPosts.map(p => esc(p.headline || '(untitled)')).join(', ')}</span>`;
  } else {
    banner.style.display = 'none';
  }
}

function setCalView(mode){
  calViewMode = mode;
  localStorage.setItem('compass-cal-view', mode);
  $('cal-view-grid').classList.toggle('active', mode === 'grid');
  $('cal-view-list').classList.toggle('active', mode === 'list');
  $('cal-grid-panel').style.display = mode === 'grid' ? 'block' : 'none';
  $('cal-list-panel').style.display = mode === 'list' ? 'block' : 'none';
}

function mockupCard(p){
  const ratio = p.format === 'feed' ? 'ratio-feed' : 'ratio-story';
  const hClass = p.headlineType === 'script' ? 'h script' : (p.headlineType === 'sans' ? 'h sans' : 'h');
  const headlinePos = p.headlinePos || 'bottom';
  // In the compact thumbnail, force the badge to the corner opposite the headline so long headlines never collide with it.
  // The stored badgePos is still honored as-is in the full detail view / export.
  const thumbBadgePos = p.badge ? (headlinePos === 'top' ? 'bottom' : 'top') : '';
  const badgeHtml = p.badge ? `<div class="badge ${thumbBadgePos}">${esc(p.badge)}</div>` : '';
  const frameClass = p.frame === 'yellow-frame' ? 'photo-card yellow-frame' : 'photo-card';
  const photoInner = p.frame === 'yellow-frame'
    ? `<div class="photo-inner" style="border:4px solid var(--b-yellow);"><span>${esc(p.photo||'PHOTO DIRECTION')}</span></div>`
    : `<div class="photo-inner"><span>${esc(p.photo||'PHOTO DIRECTION')}</span></div>`;
  return `
  <div class="post-card" onclick="openDetail('${p.id}')">
    <div class="mockup ${p.base} ${ratio}">
      <div class="${frameClass}">${photoInner}</div>
      ${badgeHtml}
      <div class="headline-block pos-${headlinePos}">
        <div class="${hClass}">${esc(p.headline)}</div>
        ${p.sub ? `<div class="s">${esc(p.sub)}</div>` : ''}
      </div>
    </div>
    <div class="meta">
      <div class="kicker">${esc(p.date)} · ${p.format}</div>
      <div class="cap">${esc(p.caption||'').slice(0,120)}</div>
      <div class="row-actions">
        <button onclick="event.stopPropagation(); openDetail('${p.id}')">View detail</button>
        <button onclick="event.stopPropagation(); removePost('${p.id}')">Remove</button>
      </div>
    </div>
  </div>`;
}

async function removePost(id){
  await api('/api/posts/' + id, { method:'DELETE' });
  posts = posts.filter(p => p.id !== id);
  renderCalendarAndPreviews();
}

// Replaces the calendar/preview slice of the old monolithic render() — the KPI strip it used to
// also refresh is gone (Content Plan's overhauled AI-generate form doesn't have one), so this
// only touches what Calendar/Post Previews actually need.
function renderCalendarAndPreviews(){
  $('empty-state').style.display = posts.length ? 'none' : 'block';

  populateGenDateFilters();

  const calPosts = applyPlanFilters('cal-agent-filter', 'cal-date-filter');
  $('cal-body').innerHTML = calPosts.map((p,i) => `
    <tr onclick="openDetail('${p.id}')" style="cursor:pointer;">
      <td>#${String(i+1).padStart(2,'0')}</td>
      <td>${esc(p.date)}</td>
      <td>${esc(p.day)}</td>
      <td><span class="fmt-pill ${p.format}">${p.format}</span>${p.event ? '<span class="event-flag">event</span>' : ''}</td>
      <td>${esc(p.headline)}</td>
      <td>${esc(p.persona||'')}</td>
      <td>${esc(p.priority||'')}</td>
      <td>${agentBadge(p)}</td>
      <td class="row-actions"><button onclick="event.stopPropagation(); removePost('${p.id}')">Remove</button></td>
    </tr>`).join('');
  renderCalendarGrid(calPosts);

  const prevPosts = applyPlanFilters('prev-agent-filter', 'prev-date-filter');
  $('cards').innerHTML = prevPosts.map(p => mockupCard(p)).join('');
}

/* ---------- post detail modal ---------- */
async function openDetail(id){
  let p = posts.find(x => x.id === id);
  if(!p) return;

  // Every post should show a benchmark — auto-pick and save one the first time this post is opened,
  // instead of making the user hunt for a match themselves.
  if(!p.referencePost || !p.directoryARef){
    const guess = p.referencePost ? null : autoResolveReferenceForPost(p, usedReferenceUrls());
    const dirGuess = p.directoryARef ? null : autoResolveDirectoryAReference(p, usedDirectoryARefIds());
    if(guess || dirGuess){
      const body = {};
      if(guess) body.referencePost = guess;
      if(dirGuess) body.directoryARef = dirGuess;
      const updated = await api('/api/posts/' + id, { method: 'PUT', body: JSON.stringify(body) });
      if(updated){
        const idx = posts.findIndex(x => x.id === id);
        if(idx > -1) posts[idx] = updated;
        p = updated;
      }
    }
  }

  const ratio = p.format === 'feed' ? 'ratio-feed' : 'ratio-story';
  const hClass = p.headlineType === 'script' ? 'h script' : (p.headlineType === 'sans' ? 'h sans' : 'h');
  const detailHeadlinePos = p.headlinePos || 'bottom';
  // Same collision-avoidance as the thumbnail cards: force the badge to the corner opposite
  // the headline so long copy never overlaps it, regardless of the stored badgePos.
  const detailBadgePos = p.badge ? (detailHeadlinePos === 'top' ? 'bottom' : 'top') : '';
  const badgeHtml = p.badge ? `<div class="badge ${detailBadgePos}">${esc(p.badge)}</div>` : '';
  const frameClass = p.frame === 'yellow-frame' ? 'photo-card yellow-frame' : 'photo-card';
  const photoInner = p.frame === 'yellow-frame'
    ? `<div class="photo-inner" style="border:4px solid var(--b-yellow);"><span>${esc(p.photo||'PHOTO DIRECTION')}</span></div>`
    : `<div class="photo-inner"><span>${esc(p.photo||'PHOTO DIRECTION')}</span></div>`;
  const briefHtml = (p.brief && p.brief.length) ? `<ul class="detail-list">${p.brief.map(b=>`<li>${esc(b)}</li>`).join('')}</ul>` : `<div class="detail-empty">No design brief bullets on this post.</div>`;

  const ourMockupHtml = `
    <div class="mockup ${p.base} ${ratio}" style="width:100%; max-width:320px;">
      <div class="${frameClass}">${photoInner}</div>
      ${badgeHtml}
      <div class="headline-block pos-${detailHeadlinePos}">
        <div class="${hClass}">${esc(p.headline)}</div>
        ${p.sub ? `<div class="s">${esc(p.sub)}</div>` : ''}
      </div>
    </div>`;

  // The attached reference is a frozen snapshot (so caption/category/stats stay stable), but
  // Instagram's image URLs expire within hours — always try the freshest URL for the same post
  // from whatever's currently loaded, and only fall back to the frozen one if it's gone from the data.
  const rawRef = p.referencePost;
  const fresh = rawRef && COMPETITOR_POSTS.find(x => x.url === rawRef.url);
  const ref = rawRef ? Object.assign({}, rawRef, fresh ? { display_url: fresh.display_url } : {}) : null;
  const withPhoto = [...COMPETITOR_POSTS].filter(x => x.display_url).sort((a,b) => (b.engagement_rate_pct||0) - (a.engagement_rate_pct||0));
  const pickerOptions = '<option value="">Choose a competitor post…</option>' + withPhoto.map(x =>
    `<option value="${esc(x.url)}">${esc(x.brand_name)} — ${esc(x.category)} — ${fmtPct(x.engagement_rate_pct||0)}</option>`
  ).join('');

  const compareHtml = `
    ${ref ? `<div style="text-align:right; margin-bottom:10px;"><button class="btn btn-outline btn-sm" onclick="openLightbox('${p.id}')">⤢ View full size, side by side</button></div>` : ''}
    <div class="compare-grid">
      <div class="compare-col">
        <div class="compare-label ours">Our Recommendation</div>
        <div class="detail-mockup-wrap">${ourMockupHtml}</div>
      </div>
      <div class="compare-col">
        <div class="compare-label theirs">Competitor Reference</div>
        ${ref ? `
        <div class="compare-ref-photo">
          ${ref.display_url
            ? `<img src="${mediaUrl(ref.display_url)}" alt="${esc(ref.brand_name)} reference post" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'compare-ref-noimg',textContent:'Image expired — Instagram links go stale after a few hours. Rescrape to refresh, or open the original post below.'}))">`
            : `<div class="compare-ref-noimg">No image captured</div>`}
        </div>
        <div class="compare-ref-meta">
          <span class="competitor-badge" style="background:${(ACCOUNT_COLORS[ref.account]||'#726654')}22;color:${ACCOUNT_COLORS[ref.account]||'#726654'}">${esc(ref.brand_name)}</span>
          <span class="chip" style="cursor:default;">${esc(ref.category)}</span>
          <span class="chip" style="cursor:default;">${fmtPct(ref.engagement_rate_pct||0)} eng.</span>
        </div>
        <p class="compare-ref-caption">${esc(ref.caption_preview)}</p>
        <a class="post-link" href="${ref.url}" target="_blank" rel="noopener">Open original post →</a>
        <button class="btn btn-outline btn-sm" style="margin-top:10px;" onclick="changeDetailReference('${p.id}')">Change reference</button>
        ` : `
        <div class="compare-ref-empty">
          <p>No competitor benchmark attached to this post yet.</p>
          <select id="detail-ref-picker">${pickerOptions}</select>
          <button class="btn btn-accent btn-sm" style="margin-top:8px;" onclick="attachDetailReference('${p.id}')">Attach reference</button>
        </div>`}
      </div>
    </div>`;

  const directoryARefHtml = p.directoryARef ? `
    <div class="dira-ref-block">
      <div class="dira-ref-label">From your own archive (Directory A)</div>
      <a class="dira-ref-photo" href="${esc(p.directoryARef.webViewLink)}" target="_blank" title="${esc(p.directoryARef.name)}">
        <img src="${esc(p.directoryARef.thumbnailUrl)}" loading="lazy">
      </a>
      <div class="dira-ref-name">${esc(p.directoryARef.name)}</div>
      <div class="dira-ref-path">${esc(p.directoryARef.path)}</div>
    </div>` : '';

  const specHtml = `
    <div class="detail-spec">
      <div class="detail-tags">
        <span class="fmt-pill ${p.format}">${p.format === 'feed' ? 'Feed · 4:5' : 'Story · 9:16'}</span>
        ${p.event ? '<span class="event-flag">event-arm</span>' : ''}
        <span class="chip" style="cursor:default;">${esc(p.date)} · ${esc(p.day||'')}</span>
      </div>
      <div class="detail-row"><div class="detail-lab">Headline</div><div class="detail-val serif-val">${esc(p.headline)}</div></div>
      ${p.sub ? `<div class="detail-row"><div class="detail-lab">Sub-headline</div><div class="detail-val">${esc(p.sub)}</div></div>` : ''}
      <div class="detail-row"><div class="detail-lab">Persona</div><div class="detail-val">${esc(p.persona||'—')}</div></div>
      <div class="detail-row"><div class="detail-lab">Business priority</div><div class="detail-val">${esc(p.priority||'—')}</div></div>
      <div class="detail-row"><div class="detail-lab">Photo direction</div><div class="detail-val">${esc(p.photo||'—')}</div></div>
      <div class="detail-row"><div class="detail-lab">Design brief</div>${briefHtml}</div>
      <div class="detail-row"><div class="detail-lab">Caption</div><div class="detail-val caption-box">${esc(p.caption||'—')}</div></div>
      <div class="detail-row"><div class="detail-lab">CTA / data capture</div><div class="detail-val cta-box">${esc(p.cta||'—')}</div></div>
    </div>`;

  $('detail-body').innerHTML = `
    <div class="detail-grid has-compare">
      <details class="detail-compare-collapse">
        <summary>Mockup vs. competitor reference</summary>
        ${compareHtml}
      </details>
      <div class="detail-content-row ${p.directoryARef ? '' : 'no-dira'}">
        ${specHtml}
        ${directoryARefHtml}
      </div>
    </div>`;
  $('detail-modal').classList.add('open');
  $('detail-overlay').classList.add('open');
}

async function attachDetailReference(id){
  const picker = $('detail-ref-picker');
  const url = picker ? picker.value : '';
  if(!url){ alert('Pick a competitor post first.'); return; }
  const referencePost = resolveReferencePost(url);
  const updated = await api('/api/posts/' + id, { method: 'PUT', body: JSON.stringify({ referencePost }) });
  if(updated){
    const idx = posts.findIndex(p => p.id === id);
    if(idx > -1) posts[idx] = updated;
    openDetail(id);
  }
}

async function changeDetailReference(id){
  const updated = await api('/api/posts/' + id, { method: 'PUT', body: JSON.stringify({ referencePost: null }) });
  if(updated){
    const idx = posts.findIndex(p => p.id === id);
    if(idx > -1) posts[idx] = updated;
    openDetail(id);
  }
}

function closeDetail(){
  $('detail-modal').classList.remove('open');
  $('detail-overlay').classList.remove('open');
}

// Large side-by-side view for handing off to a designer — real Instagram export dimensions on
// our mockup, native resolution on the competitor photo. Opens as an overlay inside the same
// page (not a new tab), so the sidebar/topbar and login session stay exactly as they were.
function openLightbox(id){
  const p = posts.find(x => x.id === id);
  if(!p || !p.referencePost) return;
  const fresh = COMPETITOR_POSTS.find(x => x.url === p.referencePost.url);
  const ref = Object.assign({}, p.referencePost, fresh ? { display_url: fresh.display_url } : {});
  const specDims = p.format === 'feed' ? '1080 × 1350px (4:5)' : '1080 × 1920px (9:16)';
  const hClass = p.headlineType === 'script' ? 'h script' : (p.headlineType === 'sans' ? 'h sans' : 'h');
  const detailHeadlinePos = p.headlinePos || 'bottom';
  const detailBadgePos = p.badge ? (detailHeadlinePos === 'top' ? 'bottom' : 'top') : '';
  const badgeHtml = p.badge ? `<div class="badge ${detailBadgePos}">${esc(p.badge)}</div>` : '';
  const frameClass = p.frame === 'yellow-frame' ? 'photo-card yellow-frame' : 'photo-card';
  const photoInner = p.frame === 'yellow-frame'
    ? `<div class="photo-inner" style="border:4px solid var(--b-yellow);"><span>${esc(p.photo||'PHOTO DIRECTION')}</span></div>`
    : `<div class="photo-inner"><span>${esc(p.photo||'PHOTO DIRECTION')}</span></div>`;
  const ratio = p.format === 'feed' ? 'ratio-feed' : 'ratio-story';

  $('lightbox-body').innerHTML = `
    <div class="lightbox-grid">
      <div class="lightbox-col">
        <div class="compare-label ours">Our Recommendation</div>
        <div class="lightbox-dims">${specDims} — export size for the designer</div>
        <div class="mockup ${p.base} ${ratio} lightbox-mockup">
          <div class="${frameClass}">${photoInner}</div>
          ${badgeHtml}
          <div class="headline-block pos-${detailHeadlinePos}">
            <div class="${hClass}">${esc(p.headline)}</div>
            ${p.sub ? `<div class="s">${esc(p.sub)}</div>` : ''}
          </div>
        </div>
      </div>
      <div class="lightbox-col">
        <div class="compare-label theirs">Competitor Reference — ${esc(ref.brand_name)}</div>
        <div class="lightbox-dims" id="lightbox-ref-dims">Loading dimensions…</div>
        ${ref.display_url
          ? `<img class="lightbox-ref-img" src="${mediaUrl(ref.display_url)}" alt="${esc(ref.brand_name)} reference post"
               onload="document.getElementById('lightbox-ref-dims').textContent = this.naturalWidth + ' × ' + this.naturalHeight + 'px (native)'"
               onerror="document.getElementById('lightbox-ref-dims').textContent='Image unavailable'; this.replaceWith(Object.assign(document.createElement('div'),{className:'compare-ref-noimg',textContent:'Image expired — rescrape to refresh.'}))">`
          : `<div class="compare-ref-noimg">No image captured</div>`}
      </div>
    </div>`;
  $('lightbox-modal').classList.add('open');
  $('lightbox-overlay').classList.add('open');
}

function closeLightbox(){
  $('lightbox-modal').classList.remove('open');
  $('lightbox-overlay').classList.remove('open');
}

function exportPlan(){
  if(!posts.length){ alert('Add at least one post before exporting.'); return; }
  const dataJson = JSON.stringify(posts, null, 2);
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Buranchi — Content Plan</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,500;0,9..144,700&family=Inclusive+Sans:wght@400;600;700&family=Parisienne&display=swap" rel="stylesheet">
<style>
body{margin:0;font-family:'Inclusive Sans',sans-serif;background:#EFEAE0;color:#2B221B;}
.serif{font-family:'Fraunces',serif;} .script{font-family:'Parisienne',cursive;}
table{border-collapse:collapse;width:100%;margin:24px;} th,td{padding:8px 10px;border-bottom:1px solid #E5DFD0;text-align:left;font-size:13px;}
th{text-transform:uppercase;font-size:10px;color:#726654;border-bottom:2px solid #2B221B;}
h1{font-family:'Fraunces',serif;padding:24px;}
</style></head><body>
<h1>Buranchi — Content Plan (exported from Wonderland)</h1>
<table><thead><tr><th>#</th><th>Date</th><th>Format</th><th>Headline</th><th>Persona</th><th>Priority</th><th>CTA</th></tr></thead><tbody>
${posts.map((p,i)=>`<tr><td>${i+1}</td><td>${p.date}</td><td>${p.format}</td><td>${p.headline}</td><td>${p.persona||''}</td><td>${p.priority||''}</td><td>${p.cta||''}</td></tr>`).join('\n')}
</tbody></table>
<script>window.__buranchiCompassData = ${dataJson};<\/script>
</body></html>`;
  const blob = new Blob([html], {type:'text/html'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'Buranchi-Content-Plan.html';
  a.click();
  URL.revokeObjectURL(url);
}

init();
