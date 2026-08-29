const $ = id => document.getElementById(id);
let posts = [];
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
  },
  'brand-visual-identity': {
    what: 'Logo usage, the color palette (with hex codes), and typography — Sakara\'s actual visual identity system, not the copywriting brand voice above. This is reference documentation, not something Claude quotes directly into a caption.',
    how: 'Keep hex codes exact and the logo/font asset paths current. When new sections of the brand guideline (tone, photo direction, graphics, icons, charts) get finalized, add them here rather than starting a separate file, so there\'s one place that documents the visual system.'
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
    // No client picked yet for this session — auto-pick the first one instead of blocking
    // with a mandatory popup; the org-badge switcher up top is always there to change it.
    const clients = await api('/api/clients') || [];
    if(clients.length){
      const first = clients[0];
      await api('/api/session/client', { method:'POST', body: JSON.stringify({ slug: first.slug }) });
      me.clientSlug = first.slug;
      me.clientName = first.name;
    } else {
      openClientPicker(true);
      return;
    }
  }

  $('org-name').textContent = me.clientName;
  currentOrgSlug = me.clientSlug;
  $('today-date').textContent = new Date().toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric' });

  posts = await api('/api/posts') || [];

  await loadMoodboardStudio();
  populateMbsBookingStartOptions();

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
  $('btn-brief-save').addEventListener('click', generateAndSaveBrief);
  document.querySelectorAll('#brief-vizref-toggle .tab-btn').forEach(btn => {
    btn.addEventListener('click', () => setBriefVizrefSource(btn.dataset.src));
  });
  $('brief-vizref-search').addEventListener('input', resetBriefVizrefPageAndRender);
  $('brief-vizref-date-from').addEventListener('change', resetBriefVizrefPageAndRender);
  $('brief-vizref-date-to').addEventListener('change', resetBriefVizrefPageAndRender);
  $('brief-vizref-sort-field').addEventListener('change', resetBriefVizrefPageAndRender);
  $('brief-vizref-sort-dir').addEventListener('change', resetBriefVizrefPageAndRender);
  $('brief-vizref-density').addEventListener('change', resetBriefVizrefPageAndRender);
  $('btn-brief-vizref-date-clear').addEventListener('click', () => {
    $('brief-vizref-date-from').value = '';
    $('brief-vizref-date-to').value = '';
    resetBriefVizrefPageAndRender();
  });

  $('btn-board-ext-search').addEventListener('click', searchBoardExternal);
  $('btn-board-send').addEventListener('click', sendBoardMessage);
  $('board-input').addEventListener('keydown', (e) => {
    if(e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); sendBoardMessage(); }
  });

  $('btn-mbs-new').addEventListener('click', createNewMbsDeck);
  $('btn-mbs-back').addEventListener('click', closeMbsEditor);
  $('btn-mbs-save').addEventListener('click', saveMbsDeck);
  $('btn-mbs-preview').addEventListener('click', openMbsPreview);
  $('btn-mbs-generate').addEventListener('click', async () => { await saveMbsDeck(); generateMbsDeck(); });
  $('mbs-preview-close').addEventListener('click', closeMbsPreview);
  $('mbs-preview-overlay').addEventListener('click', closeMbsPreview);
  $('mbs-preview-prev').addEventListener('click', mbsPreviewPrev);
  $('mbs-preview-next').addEventListener('click', mbsPreviewNext);
  $('btn-mbs-add-rundown-row').addEventListener('click', () => { mbsDeck.whereWhen.rundown.push({time:'',activity:'',duration:'',note:''}); renderMbsRundown(); });
  $('btn-mbs-auto-rundown').addEventListener('click', autoGenerateMbsRundown);
  $('btn-mbs-add-booking').addEventListener('click', addMbsBooking);
  $('btn-mbs-add-shot').addEventListener('click', addMbsShot);
  $('btn-mbs-add-background').addEventListener('click', addMbsBackground);
  $('btn-mbs-add-provided-prop').addEventListener('click', addMbsProvidedProp);
  $('btn-mbs-add-buy-prop').addEventListener('click', addMbsBuyProp);
  $('btn-mbs-add-styling').addEventListener('click', addMbsStyling);
  $('btn-mbs-coverImage').addEventListener('click', () => $('mbs-coverImage-input').click());
  $('mbs-coverImage-input').addEventListener('change', async () => {
    const file = $('mbs-coverImage-input').files[0];
    if(!file) return;
    mbsDeck.meta.coverImage = await readImageAsAsset(file);
    renderMbsSingleImage('mbs-coverImage-preview', mbsDeck.meta.coverImage, (img) => { mbsDeck.meta.coverImage = img; });
  });
  $('btn-mbs-directionImage').addEventListener('click', () => $('mbs-directionImage-input').click());
  $('mbs-directionImage-input').addEventListener('change', async () => {
    const file = $('mbs-directionImage-input').files[0];
    if(!file) return;
    mbsDeck.intention.directionImage = await readImageAsAsset(file);
    renderMbsSingleImage('mbs-directionImage-preview', mbsDeck.intention.directionImage, (img) => { mbsDeck.intention.directionImage = img; });
  });
  $('btn-mbs-locationImages').addEventListener('click', () => $('mbs-locationImages-input').click());
  $('mbs-locationImages-input').addEventListener('change', async () => {
    const files = Array.from($('mbs-locationImages-input').files || []);
    for(const file of files) mbsDeck.whereWhen.locationImages.push(await readImageAsAsset(file));
    renderMbsImageGrid('mbs-locationImages-grid', mbsDeck.whereWhen.locationImages);
  });
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
  document.querySelectorAll('[data-add-agent]').forEach(btn => {
    btn.addEventListener('click', () => addRuleRow('', 'ab-extra-' + btn.dataset.addAgent).querySelector('input').focus());
  });
  $('detail-close').addEventListener('click', closeDetail);
  $('detail-overlay').addEventListener('click', closeDetail);
  $('lightbox-close').addEventListener('click', closeLightbox);
  $('lightbox-overlay').addEventListener('click', closeLightbox);

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
      if(a.dataset.page === 'moodboard') loadMoodboardStudio();
    });
  });

  showPage('generate');

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
const CONTENT_PLAN_PAGES = ['generate'];
const PAGE_SUBTITLES = {
  analytics: "Competitor Instagram data — scrape, filter, and see what's working for them.",
  generate: 'Build a plan, check it against brand standing rules, and export it in Buranchi\'s house style.',
  moodboard: 'Cover, direction, shotlist, backgrounds, props, styling, and booking availability.',
  campaignbrief: 'Same sections as the real brief doc, plus AI rephrasing and a visual reference picker.',
  campaignboard: 'Compare reference from 4 sources, let the AI Judge reason about the pick, then refine in plain language.',
  ideation: 'Brainstorm raw content ideas before planning them out.',
  history: 'Every plan request across all 3 tabs, with token cost and post count.',
  agentbehavior: 'Guardrails global plus kondisi default per agent, dengan kondisi tambahan yang bisa lo edit sendiri.',
  creativechat: 'Ngobrol atau minta rencana konten — pilih sendiri modelnya, dalam 1 percakapan.',
  masterconfig: 'The brand files Claude and Gemini both read when drafting a plan.',
  dashboard: 'Ringkasan status konten plan untuk organisasi ini.'
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
// Density and page size are the same knob on purpose: fewer results per page means each one can
// afford to be shown bigger, more results means smaller — not two separate unrelated settings.
const BRIEF_VIZREF_DENSITY_PAGE_SIZE = { large: 12, medium: 24, small: 48, xsmall: 96 };
let briefVizrefPage = 0;

// Any change to source/search/sort/date should jump back to page 1 — otherwise a filter that
// shrinks the result set can leave the grid stranded on a now-empty page.
function resetBriefVizrefPageAndRender(){
  briefVizrefPage = 0;
  renderBriefVizrefGrid();
}

function setBriefVizrefSource(src){
  briefVizrefSource = src;
  document.querySelectorAll('#brief-vizref-toggle .tab-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.src === src));
  // Directory A has no engagement concept — only offer that sort field for competitor posts.
  // (Falls back to Date if "Likes" was selected and the source switches to internal.)
  $('brief-vizref-sort-likes-opt').style.display = src === 'competitor' ? 'block' : 'none';
  if(src !== 'competitor' && $('brief-vizref-sort-field').value === 'likes') $('brief-vizref-sort-field').value = 'date';
  resetBriefVizrefPageAndRender();
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
  const search = ($('brief-vizref-search').value || '').trim().toLowerCase();
  const dateFrom = $('brief-vizref-date-from').value;
  const dateTo = $('brief-vizref-date-to').value;
  const sortField = $('brief-vizref-sort-field').value;
  const sortDir = $('brief-vizref-sort-dir').value === 'asc' ? 1 : -1;
  let items = [];
  if(briefVizrefSource === 'competitor'){
    items = COMPETITOR_POSTS.filter(p => p.display_url)
      .filter(p => {
        const d = p.date || (p.timestamp || '').slice(0, 10);
        if(dateFrom && d < dateFrom) return false;
        if(dateTo && d > dateTo) return false;
        if(search && !`${p.brand_name||''} ${p.category||''} ${p.caption||''}`.toLowerCase().includes(search)) return false;
        return true;
      })
      .map(p => ({
        refKey: 'competitor:' + p.url, name: `${p.brand_name || ''} — ${p.category || ''}`, kind: 'competitor', url: mediaUrl(p.display_url),
        date: p.date || (p.timestamp || '').slice(0, 10),
        sortName: p.brand_name || '', likes: p.likes_hidden ? (p.comments || 0) : (p.likes_display || 0)
      }));
    $('brief-vizref-empty-text').textContent = (dateFrom || dateTo || search) ? 'No competitor posts match that filter.' : 'No competitor data scraped yet — visit the Competitor Dashboard.';
  } else {
    items = (DIRECTORY_A_MANIFEST || []).filter(f => f.hasThumbnail)
      .filter(f => {
        const d = (f.modifiedTime || '').slice(0, 10);
        if(dateFrom && d < dateFrom) return false;
        if(dateTo && d > dateTo) return false;
        if(search && !`${f.name||''} ${f.path||''}`.toLowerCase().includes(search)) return false;
        return true;
      })
      .map(f => ({
        refKey: 'internal:' + f.id, name: f.name, kind: 'internal', url: withBase('/media/directory-a/' + currentOrgSlug + '/' + f.id + '.jpg'),
        date: (f.modifiedTime || '').slice(0, 10), sortName: f.name || '', likes: 0
      }));
    $('brief-vizref-empty-text').textContent = (search || dateFrom || dateTo) ? 'No internal files match that filter.' : 'No internal archive synced yet — link a Google Drive folder in Directory A.';
  }

  // Sort field/direction applies before the 40-item display cap so "oldest first" etc. actually
  // surfaces the right items instead of just re-ordering whatever the cap happened to keep.
  items.sort((a, b) => {
    const cmp = sortField === 'name' ? (a.sortName || '').localeCompare(b.sortName || '')
      : sortField === 'likes' ? (a.likes || 0) - (b.likes || 0)
      : (a.date || '').localeCompare(b.date || '');
    return cmp * sortDir;
  });
  const density = $('brief-vizref-density').value;
  const pageSize = BRIEF_VIZREF_DENSITY_PAGE_SIZE[density] || BRIEF_VIZREF_DENSITY_PAGE_SIZE.medium;
  grid.className = 'moodboard-grid density-' + density;

  const totalItems = items.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  if(briefVizrefPage >= totalPages) briefVizrefPage = totalPages - 1;
  if(briefVizrefPage < 0) briefVizrefPage = 0;
  const pageItems = items.slice(briefVizrefPage * pageSize, (briefVizrefPage + 1) * pageSize);

  if(!totalItems){
    grid.innerHTML = '';
    $('brief-vizref-pagination').style.display = 'none';
    if(empty) empty.style.display = 'block';
    return;
  }
  if(empty) empty.style.display = 'none';
  grid.innerHTML = pageItems.map(item => `
    <div class="vizref-card ${briefRefImages.some(i => i.refKey === item.refKey) ? 'selected' : ''}" data-vizref-key="${esc(item.refKey)}">
      <img src="${esc(item.url)}" alt="${esc(item.name)}" loading="lazy" onload="this.closest('.vizref-card').classList.toggle('is-portrait', this.naturalHeight > this.naturalWidth)">
      <div class="vizref-label">${esc(item.name)}</div>
      ${item.date ? `<div class="vizref-date">${esc(fmtDate(item.date))}</div>` : ''}
    </div>
  `).join('');
  grid.querySelectorAll('[data-vizref-key]').forEach((card, i) => {
    card.addEventListener('click', () => toggleBriefVizref(pageItems[i]));
  });

  const pageNum = briefVizrefPage + 1;
  const pag = $('brief-vizref-pagination');
  pag.style.display = 'flex';
  pag.innerHTML = `
    <button class="btn btn-outline btn-sm" id="brief-vizref-pg-prev" ${pageNum <= 1 ? 'disabled' : ''}>← Prev</button>
    <span class="page-info">Page ${pageNum} of ${totalPages} — ${totalItems} result${totalItems === 1 ? '' : 's'}</span>
    <button class="btn btn-outline btn-sm" id="brief-vizref-pg-next" ${pageNum >= totalPages ? 'disabled' : ''}>Next →</button>`;
  $('brief-vizref-pg-prev').addEventListener('click', () => { briefVizrefPage--; renderBriefVizrefGrid(); });
  $('brief-vizref-pg-next').addEventListener('click', () => { briefVizrefPage++; renderBriefVizrefGrid(); });
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

// One button instead of three separate steps that always ran in the same order anyway: write
// (or rephrase) the headline/sub/caption, save the brief, then land on Campaign Board where the
// real before/after comparison lives. If the draft fields are empty, generate from scratch using
// the brief + picked references; if the user already typed something, rephrase that instead
// (auto-picking the first option — no separate pick-one step, same reasoning as merging the
// buttons in the first place).
async function generateAndSaveBrief(){
  const btn = $('btn-brief-save');
  const status = $('brief-generate-status');
  const fields = collectBriefFields();
  if(!fields.title){ alert('Give this campaign a name first.'); return; }

  btn.disabled = true;
  let visualCopywriting = null, strategySummary = null;

  try {
    if(!fields.draftHeadline && !fields.draftSub && !fields.draftCaption){
      status.textContent = 'Gemini is drafting…';
      const res = await api('/api/generate-brief-draft', { method:'POST', body: JSON.stringify(Object.assign({}, fields, { referenceImages: briefRefImages })) });
      if(res && res.ok){
        $('brief-draft-headline').value = res.headline;
        $('brief-draft-sub').value = res.sub;
        $('brief-draft-caption').value = res.caption;
        visualCopywriting = { headline: res.headline, sub: res.sub, caption: res.caption };
        strategySummary = res.strategySummary;
      } else {
        status.textContent = (res && res.error) || 'Could not generate a draft — saving as-is.';
      }
    } else {
      status.textContent = 'Gemini is rephrasing…';
      const rephraseBody = Object.assign({}, fields, { referenceImages: briefRefImages.filter(i => i.kind === 'upload').map(i => ({ mimeType: i.mimeType, data: i.data })) });
      const res = await api('/api/generate-brief', { method:'POST', body: JSON.stringify(rephraseBody) });
      if(res && res.ok && res.options && res.options[0]){
        const opt = res.options[0];
        $('brief-draft-headline').value = opt.headline || '';
        $('brief-draft-sub').value = opt.sub || '';
        $('brief-draft-caption').value = opt.caption || '';
        visualCopywriting = opt;
        strategySummary = res.strategySummary;
      } else {
        status.textContent = (res && res.error) || 'Could not rephrase — saving as-is.';
      }
    }
  } catch(e){
    status.textContent = 'AI step failed — saving as-is.';
  }

  status.textContent = 'Saving…';
  const finalFields = collectBriefFields(); // re-collect: the AI step above may have just filled the draft boxes
  const brief = Object.assign({}, finalFields, { referenceImages: briefRefImages, visualCopywriting, strategySummary });
  const saved = await api('/api/campaign-briefs', { method:'POST', body: JSON.stringify(brief) });
  btn.disabled = false;
  if(saved && saved.id){
    savedBriefs.push(saved);
    renderSavedBriefs();
    ['brief-title','brief-background','brief-audience','brief-objective','brief-timeline','brief-channels','brief-terms','brief-ref-links','brief-draft-headline','brief-draft-sub','brief-draft-caption'].forEach(id => $(id).value = '');
    briefRefImages = []; renderBriefRefImages(); renderBriefVizrefGrid();
    status.textContent = 'Saved ✓';
    openCampaignBoardPage(saved.id);
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
          <button class="btn btn-accent btn-sm" data-brief-board="${esc(b.id)}">Open Campaign Board</button>
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
  $('brief-saved-list').querySelectorAll('[data-brief-board]').forEach(btn => {
    btn.addEventListener('click', () => openCampaignBoardPage(btn.dataset.briefBoard));
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

/* ---------- campaign board ---------- */
let currentBoard = null;
// Category C candidates aren't persisted server-side — they only live for the current search,
// and get sent along with the next feedback message so the Judge can still reason about them.
let boardExternalResults = [];

let currentBoardBrief = null;

function renderBoardBriefRecap(brief){
  $('board-title').textContent = 'Campaign Board — ' + (brief.title || 'Untitled');
  $('board-subtitle').textContent = 'Every reference and decision below is scoped to this brief — refine it in plain language at the bottom.';
  const row = (lab, val) => val ? `<div class="board-brief-row"><div class="board-brief-label">${esc(lab)}</div><div class="board-brief-val">${esc(val)}</div></div>` : '';
  const vc = brief.visualCopywriting;
  $('board-brief-recap').innerHTML = `
    <div class="board-card-title">User Input</div>
    <div class="board-brief-row"><div class="board-brief-label">Campaign</div><div class="board-brief-val" style="font-weight:700; font-size:15px;">${esc(brief.title || 'Untitled')}</div></div>
    ${row('Background', brief.background)}
    ${row('Audience', brief.audience)}
    ${row('Objective', brief.objective)}
    ${row('Channels', brief.channels)}
    ${row('Terms / constraints', brief.terms)}
    ${vc ? `
    <div class="board-brief-row" style="margin-top:4px; padding-top:12px; border-top:1px solid var(--border);">
      <div class="board-brief-label">Generated post copy</div>
    </div>
    ${row('Headline', vc.headline)}
    ${row('Sub-headline', vc.sub)}
    ${row('Caption', vc.caption)}` : ''}
  `;
}

async function openCampaignBoardPage(briefId){
  showPage('campaignboard');
  document.querySelectorAll('.sidebar nav a').forEach(a => a.classList.toggle('active', a.dataset.page === 'campaignboard'));

  $('board-content').style.display = 'none';
  $('board-empty').style.display = 'block';
  $('board-empty').querySelector('.big').textContent = 'Loading…';
  $('board-empty').querySelector('div:last-child').textContent = '';

  const brief = savedBriefs.find(b => b.id === briefId);
  currentBoardBrief = brief || null;
  if(brief) renderBoardBriefRecap(brief);

  const existing = await api('/api/campaign-boards?briefId=' + encodeURIComponent(briefId)) || [];
  let board;
  if(existing.length){
    board = await api('/api/campaign-boards/' + existing[existing.length - 1].id);
  } else {
    board = await api('/api/campaign-boards', { method:'POST', body: JSON.stringify({ briefId }) });
  }

  if(!board || !board.id){
    $('board-empty').querySelector('.big').textContent = 'Could not open Campaign Board';
    $('board-empty').querySelector('div:last-child').textContent = (board && board.error) || 'Try again.';
    return;
  }

  currentBoard = board;
  boardExternalResults = [];
  $('board-ext-query').value = '';
  $('board-ext-status').textContent = '';
  $('board-empty').style.display = 'none';
  $('board-content').style.display = 'block';
  renderBoard();
}

function boardVersions(){
  return currentBoard.contents.filter(c => c.role === 'model').map(c => JSON.parse(c.parts[0].text));
}

function renderBoardRefColumn(cat, refs, decision){
  const chosenKeys = new Set([decision.primary, decision.supporting, decision.marketBenchmark, decision.personal].filter(Boolean).map(d => d.refKey));
  const grid = $('board-ref-' + cat);
  if(!refs.length){
    grid.innerHTML = `<div class="board-ref-empty">No candidates${cat === 'C' ? ' — search Pinterest/Behance above' : ' yet'}.</div>`;
    return;
  }
  // Only show what the Judge actually picked for this category — the reasoning below only
  // explains the winner, so showing every unpicked candidate here read as unexplained noise.
  const chosen = refs.filter(r => chosenKeys.has(r.refKey));
  if(!chosen.length){
    grid.innerHTML = `<div class="board-ref-empty">${refs.length} candidate${refs.length===1?'':'s'} available, none picked for this category.</div>`;
    return;
  }
  grid.innerHTML = chosen.map(r => `
    <div class="vizref-card board-ref-chosen" title="${esc(r.name)}">
      <img src="${esc(mediaUrl(r.url))}" loading="lazy" onload="this.closest('.vizref-card').classList.toggle('is-portrait', this.naturalHeight > this.naturalWidth)">
      <div class="vizref-label">${esc(r.name)}</div>
    </div>
  `).join('');
}

function renderBoardJudgeOutput(version){
  const pb = version.polishedBrief || {};
  // Post copy comes from THIS version, not the frozen brief.visualCopywriting — that's what
  // makes "ganti headline" feedback actually take effect round over round instead of always
  // showing whatever was generated on the very first pass.
  const vc = version.postCopy || (currentBoardBrief && currentBoardBrief.visualCopywriting);
  const row = (lab, val) => `<div class="detail-row"><div class="detail-lab">${esc(lab)}</div><div class="detail-val">${esc(val || '—')}</div></div>`;
  $('board-judge-output').innerHTML = `
    <div class="card board-card-ai" style="margin-top:0;">
      <div class="board-card-title">AI Recommendation</div>
      <div class="board-brief-label" style="margin-bottom:10px;">Polished brief — AI-tightened wording, same facts</div>
      ${row('Background', pb.background)}
      ${row('Audience', pb.audience)}
      ${row('Objective', pb.objective)}
      ${row('Channels', pb.channels)}
      ${row('Terms / constraints', pb.terms)}
      ${vc ? `
      <div class="board-brief-row" style="margin-top:4px; padding-top:12px; border-top:1px solid var(--border);">
        <div class="board-brief-label">Generated post copy</div>
      </div>
      ${row('Headline', vc.headline)}
      ${row('Sub-headline', vc.sub)}
      ${row('Caption', vc.caption)}` : ''}
    </div>`;
}

function renderBoard(){
  const versions = boardVersions();
  if(!versions.length) return;
  const latest = versions[versions.length - 1];
  ['A','B','C','D'].forEach(cat => renderBoardRefColumn(cat, (latest.references && latest.references[cat]) || [], latest.decision || {}));
  renderBoardJudgeOutput(latest);
  renderBoardLog(versions);
}

function renderBoardLog(versions){
  const feedbacks = currentBoard.contents.filter(c => c.role === 'user').map(c => c.parts[0].text);
  $('board-log').innerHTML = versions.map((v, idx) => {
    const isLatest = idx === versions.length - 1;
    const turnIndex = idx * 2 + 1;
    const approved = currentBoard.approvedTurnIndex === turnIndex;
    return `
    <div class="chat-row model">
      <div class="board-version-card">
        <div class="board-version-head">
          <b>Version ${v.version}</b>
          ${approved ? '<span class="event-flag">approved</span>' : ''}
          ${feedbacks[idx] ? `<span class="sub-inline">— "${esc(feedbacks[idx])}"</span>` : ''}
          <button class="btn btn-outline btn-sm" style="margin-left:auto;" data-board-toggle="${idx}">${isLatest ? 'Collapse' : 'Expand'}</button>
          ${!approved ? `<button class="btn btn-accent btn-sm" data-board-approve="${idx}">Approve this version</button>` : ''}
        </div>
        <div class="board-version-body" style="display:${isLatest ? 'block' : 'none'};">
          <div class="caption-box">${esc((v.postCopy && v.postCopy.headline) || (v.polishedBrief && v.polishedBrief.objective) || '')}</div>
        </div>
      </div>
    </div>`;
  }).join('');

  $('board-log').querySelectorAll('[data-board-toggle]').forEach(btn => {
    btn.addEventListener('click', () => {
      const card = btn.closest('.board-version-card');
      const body = card.querySelector('.board-version-body');
      const open = body.style.display !== 'none';
      body.style.display = open ? 'none' : 'block';
      btn.textContent = open ? 'Expand' : 'Collapse';
    });
  });
  $('board-log').querySelectorAll('[data-board-approve]').forEach(btn => {
    btn.addEventListener('click', () => approveBoardVersion(parseInt(btn.dataset.boardApprove, 10)));
  });
  $('board-log').scrollTop = $('board-log').scrollHeight;
}

async function approveBoardVersion(idx){
  const turnIndex = idx * 2 + 1;
  await api('/api/campaign-boards/' + currentBoard.id + '/approve', { method:'POST', body: JSON.stringify({ turnIndex }) });
  currentBoard.approvedTurnIndex = turnIndex;
  renderBoardLog(boardVersions());
}

async function searchBoardExternal(){
  const source = $('board-ext-source').value;
  const query = $('board-ext-query').value.trim();
  if(!query){ $('board-ext-status').textContent = 'Type a search keyword first.'; return; }
  $('btn-board-ext-search').disabled = true;
  $('board-ext-status').textContent = `Searching ${source}…`;
  const res = await api('/api/campaign-board/search-external', { method:'POST', body: JSON.stringify({ source, query }) });
  $('btn-board-ext-search').disabled = false;
  if(res && res.ok){
    boardExternalResults = res.results;
    $('board-ext-status').textContent = `${res.results.length} result${res.results.length === 1 ? '' : 's'} found.`;
    renderBoardRefColumn('C', res.results, {});
  } else {
    $('board-ext-status').textContent = (res && res.error) || 'Search failed.';
  }
}

async function sendBoardMessage(){
  const input = $('board-input');
  const feedback = input.value.trim();
  if(!feedback || !currentBoard) return;
  input.value = '';
  $('btn-board-send').disabled = true;
  input.disabled = true;
  // The Judge call reads several full-size images at once, so this genuinely takes 10-20s —
  // without this, the wait reads as "nothing happened" rather than "still working."
  $('board-send-status').textContent = 'AI Judge is looking at the references and thinking… (10-20s)';
  try {
    const res = await api('/api/campaign-boards/' + currentBoard.id + '/message', {
      method:'POST', body: JSON.stringify({ feedback, externalRefs: boardExternalResults })
    });
    if(res && res.ok){
      currentBoard = await api('/api/campaign-boards/' + currentBoard.id);
      renderBoard();
      $('board-send-status').textContent = 'Updated — new version added below.';
      setTimeout(() => { if($('board-send-status').textContent === 'Updated — new version added below.') $('board-send-status').textContent = ''; }, 4000);
    } else {
      $('board-send-status').textContent = (res && res.error) || 'Could not process feedback — try again.';
      input.value = feedback;
    }
  } catch(e){
    $('board-send-status').textContent = 'Request failed — try again.';
    input.value = feedback;
  } finally {
    $('btn-board-send').disabled = false;
    input.disabled = false;
  }
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

/* ---------- Moodboard Studio (full Wonder-team deck editor, per Moodboard-Studio-Wonder-Team-Spec.md) ---------- */
let mbsDecks = [];
let mbsDeck = null; // full deck object currently open in the editor, or null when on the list view
let mbsBookings = [];
let mbsPreviewSlides = [];
let mbsPreviewIdx = 0;

async function loadMoodboardStudio(){
  mbsDecks = await api('/api/moodboard-studio') || [];
  renderMbsDeckList();
  $('mbs-list-view').style.display = 'block';
  $('mbs-editor-view').style.display = 'none';
}

function renderMbsDeckList(){
  const empty = $('mbs-deck-empty');
  if(!mbsDecks.length){
    $('mbs-deck-list').innerHTML = '';
    if(empty) empty.style.display = 'block';
    return;
  }
  if(empty) empty.style.display = 'none';
  $('mbs-deck-list').innerHTML = mbsDecks.slice().reverse().map(d => `
    <div class="mbs-deck-card" data-mbs-open="${esc(d.id)}">
      <div>
        <div class="mbs-deck-title">${esc(d.title)}</div>
        <div class="mbs-deck-meta">${esc(d.clientName || 'No client set')}${d.date ? ' · ' + esc(d.date) : ''} · updated ${fmtDateTime(d.updatedAt)}</div>
      </div>
      <button class="btn btn-outline btn-sm" data-mbs-delete="${esc(d.id)}">Delete</button>
    </div>
  `).join('');
  $('mbs-deck-list').querySelectorAll('[data-mbs-open]').forEach(card => {
    card.addEventListener('click', (e) => { if(!e.target.closest('[data-mbs-delete]')) openMbsDeck(card.dataset.mbsOpen); });
  });
  $('mbs-deck-list').querySelectorAll('[data-mbs-delete]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if(!confirm('Delete this moodboard? This cannot be undone.')) return;
      await api('/api/moodboard-studio/' + btn.dataset.mbsDelete, { method:'DELETE' });
      loadMoodboardStudio();
    });
  });
}

async function createNewMbsDeck(){
  const deck = await api('/api/moodboard-studio', { method:'POST' });
  if(deck) openMbsDeck(deck.id);
}

async function openMbsDeck(id){
  const deck = await api('/api/moodboard-studio/' + id);
  if(!deck) return;
  mbsDeck = deck;
  await loadMbsBookings();
  populateMbsForm(deck);
  $('mbs-list-view').style.display = 'none';
  $('mbs-editor-view').style.display = 'block';
  $('mbs-save-status').textContent = '';
}

function closeMbsEditor(){
  mbsDeck = null;
  loadMoodboardStudio();
}

function populateMbsForm(d){
  $('mbs-clientName').value = d.meta.clientName || '';
  $('mbs-projectTitle').value = d.meta.projectTitle || '';
  $('mbs-year').value = d.meta.year || '';
  $('mbs-studioName').value = d.meta.studioName || '';
  $('mbs-confidentialNote').value = d.meta.confidentialNote || '';
  renderMbsSingleImage('mbs-coverImage-preview', d.meta.coverImage, (img) => { d.meta.coverImage = img; });

  $('mbs-concept').value = d.intention.concept || '';
  $('mbs-directionTitle').value = d.intention.directionTitle || '';
  $('mbs-lighting').value = d.intention.lighting || '';
  $('mbs-vibe').value = d.intention.vibe || '';
  $('mbs-focus').value = d.intention.focus || '';
  $('mbs-clientLikes').value = d.intention.clientLikes || '';
  $('mbs-clientEvaluation').value = d.intention.clientEvaluation || '';
  $('mbs-teamDiscernment').value = d.intention.teamDiscernment || '';
  const anchors = d.intention.anchorWords || ['','',''];
  $('mbs-anchor-0').value = anchors[0] || ''; $('mbs-anchor-1').value = anchors[1] || ''; $('mbs-anchor-2').value = anchors[2] || '';
  $('mbs-boundaries').value = d.intention.boundaries || '';
  renderMbsSingleImage('mbs-directionImage-preview', d.intention.directionImage, (img) => { d.intention.directionImage = img; });

  $('mbs-locationName').value = d.whereWhen.locationName || '';
  $('mbs-address').value = d.whereWhen.address || '';
  $('mbs-date').value = d.whereWhen.date || '';
  $('mbs-crewStandby').value = d.whereWhen.crewStandby || '';
  $('mbs-sessionTime').value = d.whereWhen.sessionTime || '';
  renderMbsImageGrid('mbs-locationImages-grid', d.whereWhen.locationImages);
  renderMbsRundown();
  renderMbsBookings();

  renderMbsShots();
  renderMbsBackgrounds();
  renderMbsProvidedProps();
  renderMbsBuyProps();
  renderMbsStyling();

  $('mbs-thankYouNote').value = d.closing.thankYouNote || '';
  $('mbs-nextStepsNote').value = d.closing.nextStepsNote || '';
}

// Writes every simple (non-repeatable-array) field back into mbsDeck. Repeatable arrays (rundown,
// shots, backgrounds, props, styling, images) are mutated live as the user edits them instead —
// see each section's render function — so they don't need collecting here.
function collectMbsSimpleFields(){
  const d = mbsDeck;
  d.meta.clientName = $('mbs-clientName').value.trim();
  d.meta.projectTitle = $('mbs-projectTitle').value.trim();
  d.meta.year = parseInt($('mbs-year').value, 10) || d.meta.year;
  d.meta.studioName = $('mbs-studioName').value.trim();
  d.meta.confidentialNote = $('mbs-confidentialNote').value.trim();

  d.intention.concept = $('mbs-concept').value.trim();
  d.intention.directionTitle = $('mbs-directionTitle').value.trim();
  d.intention.lighting = $('mbs-lighting').value.trim();
  d.intention.vibe = $('mbs-vibe').value.trim();
  d.intention.focus = $('mbs-focus').value.trim();
  d.intention.clientLikes = $('mbs-clientLikes').value.trim();
  d.intention.clientEvaluation = $('mbs-clientEvaluation').value.trim();
  d.intention.teamDiscernment = $('mbs-teamDiscernment').value.trim();
  d.intention.anchorWords = [$('mbs-anchor-0').value.trim(), $('mbs-anchor-1').value.trim(), $('mbs-anchor-2').value.trim()];
  d.intention.boundaries = $('mbs-boundaries').value.trim();

  d.whereWhen.locationName = $('mbs-locationName').value.trim();
  d.whereWhen.address = $('mbs-address').value.trim();
  d.whereWhen.date = $('mbs-date').value;
  d.whereWhen.crewStandby = $('mbs-crewStandby').value;
  d.whereWhen.sessionTime = $('mbs-sessionTime').value;

  d.closing.thankYouNote = $('mbs-thankYouNote').value.trim();
  d.closing.nextStepsNote = $('mbs-nextStepsNote').value.trim();
}

async function saveMbsDeck(){
  collectMbsSimpleFields();
  $('mbs-save-status').textContent = 'Saving…';
  const saved = await api('/api/moodboard-studio/' + mbsDeck.id, { method:'PUT', body: JSON.stringify(mbsDeck) });
  if(saved){ mbsDeck = saved; $('mbs-save-status').textContent = 'Saved ✓'; }
  else $('mbs-save-status').textContent = 'Could not save.';
}

/* -- single/multi image fields (cover, direction, location photos) -- */
async function readImageAsAsset(file){
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  return { name: file.name, mimeType: file.type, data: dataUrl.split(',')[1] };
}

function renderMbsSingleImage(containerId, img, onRemove){
  const el = $(containerId);
  if(!el) return;
  el.innerHTML = img ? `
    <div class="brief-ref-img-card">
      <img src="data:${img.mimeType};base64,${img.data}" alt="${esc(img.name||'')}">
      <button type="button" data-mbs-remove-single>×</button>
    </div>` : '';
  const btn = el.querySelector('[data-mbs-remove-single]');
  if(btn) btn.addEventListener('click', () => { onRemove(null); renderMbsSingleImage(containerId, null, onRemove); });
}

function renderMbsImageGrid(containerId, images){
  const el = $(containerId);
  if(!el) return;
  el.innerHTML = (images||[]).map((img, idx) => `
    <div class="brief-ref-img-card">
      <img src="data:${img.mimeType};base64,${img.data}" alt="${esc(img.name||'')}">
      <button type="button" data-mbs-remove-grid="${idx}">×</button>
    </div>`).join('');
  el.querySelectorAll('[data-mbs-remove-grid]').forEach(btn => {
    btn.addEventListener('click', () => { images.splice(parseInt(btn.dataset.mbsRemoveGrid,10), 1); renderMbsImageGrid(containerId, images); });
  });
}

/* -- 3. Where, When & Rundown -- */
function renderMbsRundown(){
  $('mbs-rundown-body').innerHTML = mbsDeck.whereWhen.rundown.map((r, idx) => `
    <tr>
      <td><input type="text" value="${esc(r.time||'')}" data-mbs-rundown="${idx}" data-field="time" style="width:80px;"></td>
      <td><input type="text" value="${esc(r.activity||'')}" data-mbs-rundown="${idx}" data-field="activity"></td>
      <td><input type="text" value="${esc(r.duration||'')}" data-mbs-rundown="${idx}" data-field="duration" style="width:80px;"></td>
      <td><input type="text" value="${esc(r.note||'')}" data-mbs-rundown="${idx}" data-field="note"></td>
      <td class="row-actions"><button data-mbs-rundown-del="${idx}">Remove</button></td>
    </tr>
  `).join('');
  $('mbs-rundown-body').querySelectorAll('[data-mbs-rundown]').forEach(input => {
    input.addEventListener('input', () => { mbsDeck.whereWhen.rundown[input.dataset.mbsRundown][input.dataset.field] = input.value; });
  });
  $('mbs-rundown-body').querySelectorAll('[data-mbs-rundown-del]').forEach(btn => {
    btn.addEventListener('click', () => { mbsDeck.whereWhen.rundown.splice(parseInt(btn.dataset.mbsRundownDel,10), 1); renderMbsRundown(); });
  });
}

// Fixed formula per spec §3: 60min prep, ~12min per shot, 20min changeover between concept/
// background groups (consecutive shots sharing the same conceptRef count as one group), 30min
// crew break after each group. Rows stay manually editable afterward.
function autoGenerateMbsRundown(){
  const shots = mbsDeck.shotlist.shots;
  if(!shots.length){ alert('Add shots to the shot list first.'); return; }
  const rows = [];
  let t = 9 * 60; // minutes from midnight, arbitrary start — team adjusts times as needed
  const fmt = (mins) => `${String(Math.floor(mins/60)%24).padStart(2,'0')}:${String(mins%60).padStart(2,'0')}`;
  rows.push({ time: fmt(t), activity: 'Prep', duration: '60 min', note: '' });
  t += 60;
  let lastConcept = undefined;
  shots.forEach((shot, i) => {
    if(i > 0 && shot.conceptRef !== lastConcept){
      rows.push({ time: fmt(t), activity: 'Changeover', duration: '20 min', note: `Into "${shot.conceptRef || 'next background'}"` });
      t += 20;
      rows.push({ time: fmt(t), activity: 'Crew break', duration: '30 min', note: '' });
      t += 30;
    }
    rows.push({ time: fmt(t), activity: `Shoot: ${shot.title || '(untitled shot)'}`, duration: '12 min', note: shot.conceptRef || '' });
    t += 12;
    lastConcept = shot.conceptRef;
  });
  mbsDeck.whereWhen.rundown = rows;
  renderMbsRundown();
}

/* -- Availability / Bookings (shared across every deck for this client) -- */
async function loadMbsBookings(){
  mbsBookings = await api('/api/moodboard-bookings') || [];
  renderMbsBookings();
}

function renderMbsBookings(){
  const el = $('mbs-bookings-list');
  if(!el) return;
  el.innerHTML = mbsBookings.slice().sort((a,b) => (a.date+a.start).localeCompare(b.date+b.start)).map(b => `
    <div class="mbs-booking-row">
      <span><b>${esc(b.date)}</b> · ${esc(b.start)} · ${esc(b.hours)}h <span class="mbs-booking-label">— ${esc(b.label||'')}</span></span>
      <button class="btn btn-outline btn-sm" data-mbs-booking-del="${esc(b.id)}">Remove</button>
    </div>
  `).join('') || '<div class="rec-item">No bookings yet.</div>';
  el.querySelectorAll('[data-mbs-booking-del]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await api('/api/moodboard-bookings/' + btn.dataset.mbsBookingDel, { method:'DELETE' });
      loadMbsBookings();
    });
  });
}

function populateMbsBookingStartOptions(){
  const sel = $('mbs-booking-start');
  const opts = [];
  for(let h = 9; h <= 21; h += 2) opts.push(`<option value="${String(h).padStart(2,'0')}:00">${String(h).padStart(2,'0')}:00</option>`);
  sel.innerHTML = opts.join('');
}

async function addMbsBooking(){
  const date = $('mbs-booking-date').value;
  const start = $('mbs-booking-start').value;
  const hours = $('mbs-booking-hours').value;
  const label = $('mbs-booking-label').value.trim();
  if(!date || !start){ alert('Pick a date and start time.'); return; }
  const res = await api('/api/moodboard-bookings', { method:'POST', body: JSON.stringify({ date, start, hours, label }) });
  if(res && res.id){
    $('mbs-booking-date').value = ''; $('mbs-booking-label').value = '';
    await loadMbsBookings();
  }
}

/* -- 4. Product Shot List -- */
function renderMbsShots(){
  $('mbs-shots-list').innerHTML = mbsDeck.shotlist.shots.map((s, idx) => `
    <div class="mbs-repeat-card">
      <div class="mbs-repeat-head"><b>Shot ${idx+1}</b><button class="btn btn-outline btn-sm" data-mbs-shot-del="${idx}">Remove</button></div>
      <div class="mbs-row">
        <div class="field"><label class="f-label">Type</label>
          <select data-mbs-shot="${idx}" data-field="type"><option value="group" ${s.type==='group'?'selected':''}>Group photo</option><option value="individual" ${s.type==='individual'?'selected':''}>Individual</option></select>
        </div>
        <div class="field"><label class="f-label">Shot title</label><input type="text" value="${esc(s.title||'')}" data-mbs-shot="${idx}" data-field="title"></div>
        <div class="field"><label class="f-label">Uses concept/background</label><input type="text" value="${esc(s.conceptRef||'')}" data-mbs-shot="${idx}" data-field="conceptRef"></div>
      </div>
      <div class="mbs-products" id="mbs-shot-products-${idx}"></div>
      <button class="btn btn-outline btn-sm" type="button" data-mbs-add-product="${idx}">+ Add product</button>
    </div>
  `).join('') || '<div class="rec-item">No shots yet.</div>';

  mbsDeck.shotlist.shots.forEach((s, idx) => renderMbsShotProducts(idx));

  $('mbs-shots-list').querySelectorAll('[data-mbs-shot]').forEach(inp => {
    inp.addEventListener('input', () => { mbsDeck.shotlist.shots[inp.dataset.mbsShot][inp.dataset.field] = inp.value; });
  });
  $('mbs-shots-list').querySelectorAll('[data-mbs-shot-del]').forEach(btn => {
    btn.addEventListener('click', () => { mbsDeck.shotlist.shots.splice(parseInt(btn.dataset.mbsShotDel,10), 1); renderMbsShots(); });
  });
  $('mbs-shots-list').querySelectorAll('[data-mbs-add-product]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.mbsAddProduct, 10);
      mbsDeck.shotlist.shots[idx].products.push({ name:'', variant:'', highlighted:false });
      renderMbsShotProducts(idx);
    });
  });
}

function renderMbsShotProducts(shotIdx){
  const el = $('mbs-shot-products-' + shotIdx);
  if(!el) return;
  const products = mbsDeck.shotlist.shots[shotIdx].products;
  el.innerHTML = products.map((p, pIdx) => `
    <div class="mbs-row">
      <div class="field"><input type="text" placeholder="Product name" value="${esc(p.name||'')}" data-mbs-product="${shotIdx}:${pIdx}" data-field="name"></div>
      <div class="field"><input type="text" placeholder="Variant" value="${esc(p.variant||'')}" data-mbs-product="${shotIdx}:${pIdx}" data-field="variant"></div>
      <label style="display:flex; align-items:center; gap:6px; font-size:12px; color:var(--fg-muted); white-space:nowrap;"><input type="checkbox" ${p.highlighted?'checked':''} data-mbs-product="${shotIdx}:${pIdx}" data-field="highlighted"> Highlighted</label>
      <button class="btn btn-outline btn-sm" type="button" data-mbs-product-del="${shotIdx}:${pIdx}">×</button>
    </div>
  `).join('');
  el.querySelectorAll('[data-mbs-product]').forEach(inp => {
    inp.addEventListener('input', () => {
      const [sIdx, pIdx] = inp.dataset.mbsProduct.split(':').map(Number);
      const val = inp.type === 'checkbox' ? inp.checked : inp.value;
      mbsDeck.shotlist.shots[sIdx].products[pIdx][inp.dataset.field] = val;
    });
  });
  el.querySelectorAll('[data-mbs-product-del]').forEach(btn => {
    btn.addEventListener('click', () => {
      const [sIdx, pIdx] = btn.dataset.mbsProductDel.split(':').map(Number);
      mbsDeck.shotlist.shots[sIdx].products.splice(pIdx, 1);
      renderMbsShotProducts(sIdx);
    });
  });
}

function addMbsShot(){
  mbsDeck.shotlist.shots.push({ type:'group', title:'', conceptRef:'', products:[] });
  renderMbsShots();
}

/* -- 5. Background Used -- */
function renderMbsBackgrounds(){
  $('mbs-backgrounds-list').innerHTML = mbsDeck.backgrounds.concepts.map((c, idx) => `
    <div class="mbs-repeat-card">
      <div class="mbs-repeat-head"><b>Background ${idx+1}</b><button class="btn btn-outline btn-sm" data-mbs-bg-del="${idx}">Remove</button></div>
      <div class="mbs-row">
        <div class="field"><label class="f-label">Name</label><input type="text" value="${esc(c.name||'')}" data-mbs-bg="${idx}" data-field="name"></div>
        <div class="field"><label class="f-label">Top background</label><input type="text" value="${esc(c.bgTop||'')}" data-mbs-bg="${idx}" data-field="bgTop"></div>
        <div class="field"><label class="f-label">Bottom background</label><input type="text" value="${esc(c.bgBottom||'')}" data-mbs-bg="${idx}" data-field="bgBottom"></div>
      </div>
      <div class="field"><label class="f-label">Reasoning</label><textarea data-mbs-bg="${idx}" data-field="note" style="min-height:50px;">${esc(c.note||'')}</textarea></div>
      <div class="field">
        <label class="f-label">Pairing mock-up</label>
        <div id="mbs-bg-image-${idx}" class="moodboard-grid" style="margin-top:0;"></div>
        <input type="file" data-mbs-bg-image-input="${idx}" accept="image/*" style="display:none;">
        <button class="btn btn-outline btn-sm" type="button" data-mbs-bg-image-btn="${idx}">+ Add mock-up</button>
      </div>
    </div>
  `).join('') || '<div class="rec-item">No backgrounds yet.</div>';

  mbsDeck.backgrounds.concepts.forEach((c, idx) => {
    renderMbsSingleImage('mbs-bg-image-' + idx, c.mockupImage, (img) => { c.mockupImage = img; });
  });
  $('mbs-backgrounds-list').querySelectorAll('[data-mbs-bg]').forEach(inp => {
    inp.addEventListener('input', () => { mbsDeck.backgrounds.concepts[inp.dataset.mbsBg][inp.dataset.field] = inp.value; });
  });
  $('mbs-backgrounds-list').querySelectorAll('[data-mbs-bg-del]').forEach(btn => {
    btn.addEventListener('click', () => { mbsDeck.backgrounds.concepts.splice(parseInt(btn.dataset.mbsBgDel,10), 1); renderMbsBackgrounds(); });
  });
  $('mbs-backgrounds-list').querySelectorAll('[data-mbs-bg-image-btn]').forEach(btn => {
    const idx = btn.dataset.mbsBgImageBtn;
    btn.addEventListener('click', () => $(`[data-mbs-bg-image-input="${idx}"]`).click());
  });
  $('mbs-backgrounds-list').querySelectorAll('[data-mbs-bg-image-input]').forEach(input => {
    const idx = parseInt(input.dataset.mbsBgImageInput, 10);
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      if(!file) return;
      mbsDeck.backgrounds.concepts[idx].mockupImage = await readImageAsAsset(file);
      renderMbsBackgrounds();
    });
  });
}

function addMbsBackground(){
  mbsDeck.backgrounds.concepts.push({ name:'', bgTop:'', bgBottom:'', mockupImage:null, note:'' });
  renderMbsBackgrounds();
}

/* -- 6. Props & Background -- */
function renderMbsProvidedProps(){
  $('mbs-noPropsNote').value = mbsDeck.props.noPropsNote || '';
  $('mbs-provided-props-list').innerHTML = mbsDeck.props.providedItems.map((p, idx) => `
    <div class="mbs-row">
      <div class="field"><input type="text" placeholder="Prop name" value="${esc(p.name||'')}" data-mbs-provided="${idx}" data-field="name"></div>
      <div class="field"><input type="text" placeholder="Note" value="${esc(p.note||'')}" data-mbs-provided="${idx}" data-field="note"></div>
      <button class="btn btn-outline btn-sm" type="button" data-mbs-provided-del="${idx}">×</button>
    </div>
  `).join('') || '<div class="rec-item">None added yet.</div>';
  $('mbs-provided-props-list').querySelectorAll('[data-mbs-provided]').forEach(inp => {
    inp.addEventListener('input', () => { mbsDeck.props.providedItems[inp.dataset.mbsProvided][inp.dataset.field] = inp.value; });
  });
  $('mbs-provided-props-list').querySelectorAll('[data-mbs-provided-del]').forEach(btn => {
    btn.addEventListener('click', () => { mbsDeck.props.providedItems.splice(parseInt(btn.dataset.mbsProvidedDel,10), 1); renderMbsProvidedProps(); });
  });
  if(!$('mbs-noPropsNote').dataset.wired){
    $('mbs-noPropsNote').addEventListener('input', (e) => { mbsDeck.props.noPropsNote = e.target.value; });
    $('mbs-noPropsNote').dataset.wired = '1';
  }
}
function addMbsProvidedProp(){ mbsDeck.props.providedItems.push({ name:'', note:'' }); renderMbsProvidedProps(); }

function renderMbsBuyProps(){
  $('mbs-buy-props-list').innerHTML = mbsDeck.props.buyItems.map((p, idx) => `
    <div class="mbs-row">
      <div class="field"><input type="text" placeholder="Item" value="${esc(p.name||'')}" data-mbs-buy="${idx}" data-field="name"></div>
      <div class="field"><input type="text" placeholder="Shopee link" value="${esc(p.shopeeLink||'')}" data-mbs-buy="${idx}" data-field="shopeeLink"></div>
      <div class="field"><input type="text" placeholder="Used in shot" value="${esc(p.usedInShot||'')}" data-mbs-buy="${idx}" data-field="usedInShot"></div>
      <div class="field" style="max-width:100px;"><input type="number" placeholder="Unit price" value="${p.unitPrice||''}" data-mbs-buy="${idx}" data-field="unitPrice"></div>
      <div class="field" style="max-width:80px;"><input type="number" placeholder="Qty" value="${p.quantity||''}" data-mbs-buy="${idx}" data-field="quantity"></div>
      <button class="btn btn-outline btn-sm" type="button" data-mbs-buy-del="${idx}">×</button>
    </div>
  `).join('') || '<div class="rec-item">None added yet.</div>';
  $('mbs-buy-props-list').querySelectorAll('[data-mbs-buy]').forEach(inp => {
    inp.addEventListener('input', () => {
      const val = (inp.dataset.field === 'unitPrice' || inp.dataset.field === 'quantity') ? (parseFloat(inp.value) || 0) : inp.value;
      mbsDeck.props.buyItems[inp.dataset.mbsBuy][inp.dataset.field] = val;
      updateMbsBuyTotal();
    });
  });
  $('mbs-buy-props-list').querySelectorAll('[data-mbs-buy-del]').forEach(btn => {
    btn.addEventListener('click', () => { mbsDeck.props.buyItems.splice(parseInt(btn.dataset.mbsBuyDel,10), 1); renderMbsBuyProps(); updateMbsBuyTotal(); });
  });
  updateMbsBuyTotal();
}
function addMbsBuyProp(){ mbsDeck.props.buyItems.push({ name:'', shopeeLink:'', usedInShot:'', unitPrice:0, quantity:1 }); renderMbsBuyProps(); }
function updateMbsBuyTotal(){
  const total = mbsDeck.props.buyItems.reduce((sum, p) => sum + (p.unitPrice||0) * (p.quantity||0), 0);
  $('mbs-buy-total').textContent = 'Rp ' + total.toLocaleString('id-ID');
}

/* -- 7. Styling Reference per Shot -- */
function renderMbsStyling(){
  $('mbs-styling-list').innerHTML = mbsDeck.styling.items.map((s, idx) => `
    <div class="mbs-repeat-card">
      <div class="mbs-repeat-head"><b>Styling ${idx+1}</b><button class="btn btn-outline btn-sm" data-mbs-styling-del="${idx}">Remove</button></div>
      <div class="mbs-row">
        <div class="field"><label class="f-label">Shot #</label><input type="text" value="${esc(s.shotRef||'')}" data-mbs-styling="${idx}" data-field="shotRef"></div>
        <div class="field"><label class="f-label">Product name</label><input type="text" value="${esc(s.productName||'')}" data-mbs-styling="${idx}" data-field="productName"></div>
        <div class="field"><label class="f-label">Background pairing</label><input type="text" value="${esc(s.backgroundUsed||'')}" data-mbs-styling="${idx}" data-field="backgroundUsed"></div>
      </div>
      <div class="field"><label class="f-label">Objective</label><input type="text" value="${esc(s.objective||'')}" data-mbs-styling="${idx}" data-field="objective"></div>
      <div class="field"><label class="f-label">Styling reasoning</label><textarea data-mbs-styling="${idx}" data-field="reasoning" style="min-height:50px;">${esc(s.reasoning||'')}</textarea></div>
      <div class="field">
        <label class="f-label">Reference photos</label>
        <div id="mbs-styling-images-${idx}" class="moodboard-grid" style="margin-top:0;"></div>
        <input type="file" data-mbs-styling-image-input="${idx}" accept="image/*" multiple style="display:none;">
        <button class="btn btn-outline btn-sm" type="button" data-mbs-styling-image-btn="${idx}">+ Add reference photo</button>
      </div>
    </div>
  `).join('') || '<div class="rec-item">No styling references yet.</div>';

  mbsDeck.styling.items.forEach((s, idx) => renderMbsImageGrid('mbs-styling-images-' + idx, s.refImages));
  $('mbs-styling-list').querySelectorAll('[data-mbs-styling]').forEach(inp => {
    inp.addEventListener('input', () => { mbsDeck.styling.items[inp.dataset.mbsStyling][inp.dataset.field] = inp.value; });
  });
  $('mbs-styling-list').querySelectorAll('[data-mbs-styling-del]').forEach(btn => {
    btn.addEventListener('click', () => { mbsDeck.styling.items.splice(parseInt(btn.dataset.mbsStylingDel,10), 1); renderMbsStyling(); });
  });
  $('mbs-styling-list').querySelectorAll('[data-mbs-styling-image-btn]').forEach(btn => {
    const idx = btn.dataset.mbsStylingImageBtn;
    btn.addEventListener('click', () => $(`[data-mbs-styling-image-input="${idx}"]`).click());
  });
  $('mbs-styling-list').querySelectorAll('[data-mbs-styling-image-input]').forEach(input => {
    const idx = parseInt(input.dataset.mbsStylingImageInput, 10);
    input.addEventListener('change', async () => {
      const files = Array.from(input.files || []);
      for(const file of files) mbsDeck.styling.items[idx].refImages.push(await readImageAsAsset(file));
      renderMbsImageGrid('mbs-styling-images-' + idx, mbsDeck.styling.items[idx].refImages);
    });
  });
}
function addMbsStyling(){ mbsDeck.styling.items.push({ shotRef:'', productName:'', objective:'', backgroundUsed:'', reasoning:'', refImages:[] }); renderMbsStyling(); }

/* -- Preview: one slide per populated section -- */
function buildMbsPreviewSlides(){
  collectMbsSimpleFields();
  const d = mbsDeck;
  const slides = [];
  slides.push({ title: d.meta.projectTitle || '(untitled project)', html: `
    <p class="sub">${esc(d.meta.clientName||'')} · ${esc(String(d.meta.year||''))} · ${esc(d.meta.studioName||'')}</p>
    ${d.meta.coverImage ? `<img src="data:${d.meta.coverImage.mimeType};base64,${d.meta.coverImage.data}" style="max-width:100%; border-radius:12px; margin-top:12px;">` : ''}
    ${d.meta.confidentialNote ? `<p class="sub" style="margin-top:10px;">${esc(d.meta.confidentialNote)}</p>` : ''}
  `});
  if(d.intention.concept || d.intention.anchorWords.some(Boolean) || d.intention.boundaries){
    slides.push({ title: 'Core Intention', html: `
      <p><b>${esc(d.intention.concept||'')}</b></p>
      ${d.intention.directionTitle ? `<p>${esc(d.intention.directionTitle)}</p>` : ''}
      <div class="moodboard-tags">${d.intention.anchorWords.filter(Boolean).map(w => `<span class="moodboard-tag">${esc(w)}</span>`).join('')}</div>
      ${d.intention.boundaries ? `<p class="sub" style="margin-top:10px;">NOT: ${esc(d.intention.boundaries)}</p>` : ''}
      ${d.intention.directionImage ? `<img src="data:${d.intention.directionImage.mimeType};base64,${d.intention.directionImage.data}" style="max-width:100%; border-radius:12px; margin-top:10px;">` : ''}
    `});
  }
  if(d.whereWhen.locationName || d.whereWhen.date){
    slides.push({ title: 'Where, When & Rundown', html: `
      <p>${esc(d.whereWhen.locationName||'')} — ${esc(d.whereWhen.address||'')}</p>
      <p class="sub">${esc(d.whereWhen.date||'')} · crew ${esc(d.whereWhen.crewStandby||'')} · session ${esc(d.whereWhen.sessionTime||'')}</p>
      <table class="plan-table"><tbody>${d.whereWhen.rundown.map(r=>`<tr><td>${esc(r.time||'')}</td><td>${esc(r.activity||'')}</td><td>${esc(r.duration||'')}</td></tr>`).join('')}</tbody></table>
    `});
  }
  if(d.shotlist.shots.length) slides.push({ title: 'Product Shot List', html: d.shotlist.shots.map(s => `<p><b>${esc(s.title||'')}</b> (${esc(s.type)}) — ${s.products.map(p=>esc(p.name)).join(', ')}</p>`).join('') });
  if(d.backgrounds.concepts.length) slides.push({ title: 'Background Used', html: d.backgrounds.concepts.map(c => `<p><b>${esc(c.name||'')}</b> — top: ${esc(c.bgTop||'')}, bottom: ${esc(c.bgBottom||'')}</p>`).join('') });
  if(d.props.providedItems.length || d.props.buyItems.length) slides.push({ title: 'Props & Background', html: `
    <p><b>Provided:</b> ${d.props.providedItems.map(p=>esc(p.name)).join(', ') || '—'}</p>
    <p><b>To buy:</b> ${d.props.buyItems.map(p=>esc(p.name)).join(', ') || '—'}</p>
  `});
  if(d.styling.items.length) slides.push({ title: 'Styling Reference per Shot', html: d.styling.items.map(s => `<p><b>${esc(s.productName||'')}</b> — ${esc(s.reasoning||'')}</p>`).join('') });
  if(d.closing.thankYouNote || d.closing.nextStepsNote) slides.push({ title: 'Closing', html: `<p>${esc(d.closing.thankYouNote||'')}</p><p class="sub">${esc(d.closing.nextStepsNote||'')}</p>` });
  return slides;
}

function openMbsPreview(){
  mbsPreviewSlides = buildMbsPreviewSlides();
  mbsPreviewIdx = 0;
  renderMbsPreviewSlide();
  $('mbs-preview-modal').classList.add('open');
  $('mbs-preview-overlay').classList.add('open');
}
function closeMbsPreview(){
  $('mbs-preview-modal').classList.remove('open');
  $('mbs-preview-overlay').classList.remove('open');
}
function renderMbsPreviewSlide(){
  const s = mbsPreviewSlides[mbsPreviewIdx];
  $('mbs-preview-body').innerHTML = s ? `<h2>${esc(s.title)}</h2>${s.html}` : '<p>Nothing to preview yet — fill in at least one section.</p>';
  $('mbs-preview-counter').textContent = mbsPreviewSlides.length ? `${mbsPreviewIdx+1} / ${mbsPreviewSlides.length}` : '';
}
function mbsPreviewPrev(){ if(mbsPreviewIdx > 0){ mbsPreviewIdx--; renderMbsPreviewSlide(); } }
function mbsPreviewNext(){ if(mbsPreviewIdx < mbsPreviewSlides.length - 1){ mbsPreviewIdx++; renderMbsPreviewSlide(); } }

/* -- Generate: standalone downloadable HTML deck (this app has no public link hosting, so
   "Generate Moodboard" produces a file instead of a published URL — state itself is already
   saved server-side via Save, independent of this). -- */
function generateMbsDeck(){
  const slides = buildMbsPreviewSlides();
  const d = mbsDeck;
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>${esc(d.meta.projectTitle||'Moodboard')}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,500;0,9..144,700&family=Inclusive+Sans:wght@400;600&display=swap" rel="stylesheet">
<style>
body{margin:0;font-family:'Inclusive Sans',sans-serif;background:#121212;color:#F5F5F0;}
section{min-height:100vh; padding:60px; box-sizing:border-box; border-bottom:1px solid #2a2a2a;}
h2{font-family:'Fraunces',serif; font-size:28px;}
.sub{color:#9AA3B2;}
img{max-width:100%; border-radius:12px;}
table{border-collapse:collapse; width:100%; margin-top:10px;} td{padding:6px 10px; border-bottom:1px solid #2a2a2a; font-size:13px;}
.moodboard-tags{display:flex; gap:8px; flex-wrap:wrap; margin-top:10px;}
.moodboard-tag{background:#1e1e1e; padding:4px 10px; border-radius:999px; font-size:12px;}
</style></head><body>
${slides.map(s => `<section><h2>${esc(s.title)}</h2>${s.html}</section>`).join('\n')}
</body></html>`;
  const blob = new Blob([html], {type:'text/html'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `${(d.meta.projectTitle||'moodboard').replace(/[^a-z0-9]+/gi,'-')}-Moodboard.html`;
  a.click();
  URL.revokeObjectURL(url);
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

/* ---------- post detail modal ---------- */
function closeDetail(){
  $('detail-modal').classList.remove('open');
  $('detail-overlay').classList.remove('open');
}

// Large side-by-side view for handing off to a designer — real Instagram export dimensions on
// our mockup, native resolution on the competitor photo. Opens as an overlay inside the same
// page (not a new tab), so the sidebar/topbar and login session stay exactly as they were.
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
