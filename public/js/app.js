import { get, post, put, del, clientId } from './api.js';
import { hydrateIcons, icon } from './icons.js';
import {
  renderInto, extractTags, extractLinks, extractHeadings, plainText, wordCount, toggleTask, splitBlocks, escapeHtml as esc,
} from './markdown.js';
import { merge3, mapOffset } from './merge.js';
import { createGraph } from './graph.js';
import {
  $, $$, h, toast, modal, confirmDialog, promptDialog, popupMenu, avatarHtml, timeAgo, fmtDate, copyText, download,
} from './ui.js';
import {
  bindThemeToggles, autoFieldIcons, showVersion, watchForUpdates,
} from './common.js';
import { startTour } from './tour.js';
import { openAdmin } from './admin.js';

// ============================================================ state
const S = {
  config: {},
  me: null,
  notes: new Map(),
  view: localStorage.getItem('allnote-view') || 'files',
  expanded: new Set(JSON.parse(localStorage.getItem('allnote-expanded') || '["@pinned"]')),
  tabs: JSON.parse(localStorage.getItem('allnote-tabs') || '[]'),
  activeFolder: '',
  query: '',
  sort: localStorage.getItem('allnote-sort') || 'title',
  mode: localStorage.getItem('allnote-mode') || 'live',
  currentId: null,
  sync: null, // { id, base, baseTitle, version, dirty, saving, timer }
  presence: new Map(), // noteId -> Map(key -> { user, state, ts })
  rev: 0,
};

const el = {};
const isWide = () => window.innerWidth > 1440;

// ============================================================ boot
hydrateIcons();
bindThemeToggles();
autoFieldIcons();
boot();

async function boot() {
  S.config = await get('/api/config').catch(() => ({ appName: 'AllNote' }));
  document.title = S.config.appName;
  $$('.app-name').forEach((n) => { n.textContent = S.config.appName; });
  showVersion(S.config);
  S.checkUpdate = watchForUpdates(S.config.build, {
    beforeReload: async (cfg) => {
      toast(`Updating to version ${cfg.version}`);
      await flushSave().catch(() => {});
    },
  });
  const me = await get('/api/auth/me').catch(() => ({ user: null }));
  const err = new URLSearchParams(location.search).get('error');
  const path = location.pathname;
  if (err || path === '/login' || path === '/signup') history.replaceState(null, '', `/${location.hash}`);
  if (me.user) return startApp(me.user);
  let mode = 'login';
  if (me.twoFactorRequired) mode = '2fa';
  else if (S.config.setupRequired || (path === '/signup' && S.config.allowSignup)) mode = 'register';
  showAuth(mode, err);
}

// ============================================================ auth screen
function showAuth(mode = 'login', error = '') {
  $('#app').classList.add('hidden');
  $('#auth').classList.remove('hidden');
  $('#auth-home').classList.toggle('hidden', !S.config.landing || S.config.setupRequired);
  ['login', 'register', 'twofa'].forEach((m) => $(`#${m}-form`).classList.toggle('hidden', m !== (mode === '2fa' ? 'twofa' : mode)));
  $('#google-block').classList.toggle('hidden', !S.config.google || mode === '2fa');
  const setup = S.config.setupRequired && mode === 'register';
  $('#approval-hint').classList.toggle('hidden', setup || !S.config.approvalRequired);
  $('#auth-sub').textContent = setup
    ? 'Welcome! Create the first account — it becomes the administrator.'
    : 'Linked notes, shared and published from anywhere.';
  $('#register-form button[type=submit]').textContent = setup ? 'Create admin account' : 'Create account';
  const errBox = $('#auth-error');
  errBox.textContent = error || '';
  errBox.classList.toggle('hidden', !error);
  const sw = $('#auth-switch');
  if (mode === 'login') sw.innerHTML = S.config.allowSignup ? 'No account yet? <a href="#" data-go="register">Create one</a>' : '';
  else if (mode === 'register') sw.innerHTML = setup ? '' : 'Already have an account? <a href="#" data-go="login">Sign in</a>';
  else sw.innerHTML = '';
  setTimeout(() => $(`#${mode === '2fa' ? 'twofa' : mode}-form input`)?.focus(), 0);
}

$('#auth-switch').addEventListener('click', (e) => {
  const a = e.target.closest('[data-go]');
  if (!a) return;
  e.preventDefault();
  showAuth(a.dataset.go);
});

function authSubmit(form, fn) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      await fn(Object.fromEntries(new FormData(form)));
    } catch (err) {
      $('#auth-error').textContent = err.message;
      $('#auth-error').classList.remove('hidden');
    } finally {
      btn.disabled = false;
    }
  });
}

const afterLogin = (r) => (r.twoFactorRequired ? showAuth('2fa') : startApp(r.user));
authSubmit($('#login-form'), async (d) => afterLogin(await post('/api/auth/login', d)));
authSubmit($('#register-form'), async (d) => {
  const r = await post('/api/auth/register', d);
  S.config.setupRequired = false;
  afterLogin(r);
});
authSubmit($('#twofa-form'), async (d) => startApp((await post('/api/auth/2fa', d)).user));
$('#twofa-cancel').addEventListener('click', async () => {
  await post('/api/auth/logout').catch(() => {});
  showAuth('login');
});

// ============================================================ app start
let appStarted = false;
async function startApp(user) {
  S.me = user;
  $('#auth').classList.add('hidden');
  $('#app').classList.remove('hidden');
  Object.assign(el, {
    app: $('#app'), title: $('#ed-title'), text: $('#ed-text'), preview: $('#ed-preview'),
    notebook: $('#ed-notebook'), body: $('#ed-body'), editor: $('#editor'), empty: $('#empty-state'), info: $('#info-pane'),
    banner: $('#ed-banner'), save: $('#st-save'),
  });
  renderMe();
  el.info.classList.toggle('collapsed', localStorage.getItem('allnote-info') === '0' || !isWide());
  el.app.classList.toggle('sb-collapsed', localStorage.getItem('allnote-sidebar') === '0');
  if (user.status !== 'active') return showLock(user);
  appStarted = true;
  await loadNotes();
  connectEvents();
  renderAll();
  route();
  if (!S.currentId && S.tabs.length) openNote(S.tabs[S.tabs.length - 1]);
  if (user.isAdmin) refreshAdminBadge();
  scheduleExpiryCheck();
  if (!user.isAdmin && user.expiresAt && user.expiresAt - Date.now() < 7 * 86_400_000) {
    toast(`Your account expires on ${new Date(user.expiresAt).toLocaleDateString()}. Redeem a license key in Settings to extend it.`);
  }
  if (!user.tourDone) setTimeout(() => runTour(), 400);
}

// ============================================================ locked accounts (pending approval / expired)
let lockPoll = null;
function showLock(user) {
  S.me = user;
  S.es?.close();
  S.es = null;
  closeAllModals();
  el.app.classList.add('locked');
  ['#sidebar', '#editor-pane', '#info-pane'].forEach((s) => $(s)?.setAttribute('inert', ''));
  const pending = user.status === 'pending';
  $('#lock-ico').innerHTML = icon(pending ? 'hourglass' : 'ban', 34);
  $('#lock-title').textContent = pending ? 'Waiting for approval' : 'Your account has expired';
  $('#lock-text').textContent = pending
    ? 'An administrator needs to approve your account before you can use the app. This page unlocks automatically once you are approved.'
    : `Your access ended on ${new Date(user.expiresAt).toLocaleDateString(undefined, { dateStyle: 'long' })}. Enter a license key to reactivate your account, or ask your administrator to renew it.`;
  $('#lock-license').classList.toggle('hidden', pending);
  $('#lock-user').textContent = user.email;
  $('#lock').classList.remove('hidden');
  clearInterval(lockPoll);
  lockPoll = setInterval(() => checkAccount({ quiet: true }), 20_000);
  setTimeout(() => (pending ? $('#lock-check') : $('#lock-license input')).focus(), 50);
}

function closeAllModals() {
  $('#modal-root').replaceChildren();
  document.querySelector('.tour')?.remove();
  document.querySelector('.menu')?.remove();
}

/** Re-read the account and lock or unlock the UI when an admin (or time) changed it. */
async function checkAccount({ quiet = false } = {}) {
  let me;
  try {
    me = await get('/api/auth/me');
  } catch {
    if (!quiet) toast('Could not reach the server', 'error');
    return;
  }
  if (!me.user) return location.replace('/');
  const wasLocked = el.app.classList.contains('locked');
  if (me.user.status === 'active') {
    if (wasLocked || !appStarted) return location.reload();
    S.me = me.user;
    renderMe();
    scheduleExpiryCheck();
  } else {
    showLock(me.user);
    if (!quiet && wasLocked) toast(me.user.status === 'pending' ? 'Still waiting for approval' : 'Account is still expired');
  }
}
window.addEventListener('allnote:account', () => checkAccount({ quiet: true }));

let expiryTimer = null;
function scheduleExpiryCheck() {
  clearTimeout(expiryTimer);
  const ms = S.me?.expiresAt ? S.me.expiresAt - Date.now() : Infinity;
  if (ms < 2 ** 31 - 1) expiryTimer = setTimeout(() => checkAccount({ quiet: true }), Math.max(0, ms) + 1000);
}

$('#lock-check').addEventListener('click', () => checkAccount());
$('#lock-logout').addEventListener('click', async () => {
  await post('/api/auth/logout').catch(() => {});
  location.href = '/';
});
$('#lock-license').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    const r = await post('/api/account/license', { key: e.target.key.value });
    toast(`License activated: valid until ${new Date(r.user.expiresAt).toLocaleDateString()}`);
    setTimeout(() => location.reload(), 900);
  } catch (err) {
    toast(err.message, 'error');
    btn.disabled = false;
  }
});

function renderMe() {
  $('#me-avatar').innerHTML = avatarHtml(S.me, 'sm');
  $('#me-name').textContent = S.me.name;
  $('#btn-admin').classList.toggle('hidden', !S.me.isAdmin);
}

async function refreshAdminBadge(pending) {
  if (!S.me?.isAdmin) return;
  if (pending === undefined) pending = (await get('/api/admin/summary').catch(() => ({ pending: 0 }))).pending;
  const b = $('#admin-badge');
  b.classList.toggle('hidden', !pending);
  $('#btn-admin').title = pending ? `Admin console (${pending} waiting for approval)` : 'Admin console';
}

// ============================================================ onboarding tour & help
function tourSteps() {
  const steps = [
    { title: `Welcome to ${S.config.appName}`, icon: 'compass', text: 'A quick tour of the essentials. It takes under a minute, and you can replay it any time from the Help button.' },
    { target: '#btn-new', icon: 'newnote', title: 'Create a note', text: 'Start a new note here (Alt+N). Notes are Markdown and save automatically as you type.' },
    { target: '#btn-new-folder', icon: 'newfolder', title: 'Organise with folders', text: 'Group notes into folders and sub-folders such as Work/Projects. Right-click a folder to rename it.' },
    { target: '#tree', icon: 'folder', title: 'Your notes', text: 'Pinned notes, folders, notes shared with you and the trash all live in this tree.' },
    { target: '[data-view="search"]', icon: 'search', title: 'Search everything', text: 'Full-text search with filters like tag:work or notebook:Projects. Press Ctrl+K to jump to any note.' },
    { target: '[data-view="tags"]', icon: 'hash', title: 'Tags', text: 'Write #tags anywhere in a note. They are collected here, including nested tags like #work/alpha.' },
    { target: '#btn-daily', icon: 'calendar', title: "Today's note", text: 'One click opens a daily note for journaling, meeting notes or a to-do list.' },
    { target: '#btn-graph', icon: 'graph', title: 'Graph view', text: 'Link notes with [[Note title]] and see how your ideas connect.' },
    { target: '#empty-state', icon: 'edit', title: 'The editor', text: 'Open a note to write in live preview. The toolbar above a note lets you share it, publish it to the web with an optional PIN and browse its version history.' },
    { target: '#btn-theme', icon: 'sun', title: 'Light or dark', text: 'Switch between light and dark mode. Your choice is remembered on this device.' },
    { target: '#btn-settings', icon: 'settings', title: 'Account and security', text: 'Change your password, turn on two-factor authentication with an authenticator app and export your notes.' },
  ];
  if (S.me.isAdmin) steps.push({ target: '#btn-admin', icon: 'admin', title: 'Admin console', text: 'Approve new users, set expiration dates, generate license keys and configure Google sign-in.' });
  steps.push({ target: '#btn-help', icon: 'help', title: 'Replay the tour any time', text: 'Open Help to replay this tour, see keyboard shortcuts and check the app version.' });
  return steps;
}

async function runTour() {
  closeAllModals();
  const mobile = isMobile();
  if (mobile) el.app.classList.add('nav-open');
  else if (el.app.classList.contains('sb-collapsed')) toggleSidebar();
  await startTour(tourSteps());
  if (mobile) el.app.classList.remove('nav-open');
  if (!S.me.tourDone) {
    S.me.tourDone = true;
    post('/api/account/tour', { done: true }).catch(() => {});
  }
}

function openShortcuts() {
  const rows = [
    ['Ctrl/Cmd + K', 'Quick switcher (find or create a note)'], ['Alt + N', 'New note'], ['Ctrl/Cmd + E', 'Toggle live preview / reading view'],
    ['Ctrl/Cmd + S', 'Save now'], ['Ctrl/Cmd + B / I', 'Bold / italic'], ['Ctrl/Cmd + Enter', 'Toggle checklist on line'],
    ['Tab / Shift + Tab', 'Indent / outdent'], ['[[', 'Link autocomplete'],
  ];
  modal({
    title: 'Keyboard shortcuts',
    body: `<table class="shortcuts">${rows.map(([k, d]) => `<tr><td>${k.split(' + ').map((x) => `<kbd>${esc(x)}</kbd>`).join(' + ')}</td><td>${esc(d)}</td></tr>`).join('')}</table>`,
    foot: '<button class="btn primary" data-close>Close</button>',
  });
}

$('#btn-help').addEventListener('click', (e) => {
  popupMenu(e.currentTarget, [
    { label: 'Take the tour', icon: 'compass', action: runTour },
    { label: 'Keyboard shortcuts', icon: 'keyboard', action: openShortcuts },
    'sep',
    { label: `${S.config.appName} v${S.config.version || ''}`, icon: 'info', action: () => toast(`${S.config.appName} v${S.config.version} (build ${S.config.build})`) },
  ]);
});
$('#btn-admin').addEventListener('click', () => {
  openAdmin({
    me: S.me,
    onChange: ({ pending, settings }) => {
      if (pending !== undefined) refreshAdminBadge(pending);
      if (settings) Object.assign(S.config, { allowSignup: settings.allowSignup, landing: settings.landingPage, google: settings.google.enabled });
    },
  });
});

async function loadNotes() {
  const { notes } = await get('/api/notes');
  const fresh = new Map(notes.map((n) => [n.id, n]));
  const s = S.sync;
  if (s) {
    const remote = fresh.get(s.id);
    if (!remote || (remote.trashed && remote.role !== 'owner')) {
      S.notes = fresh;
      closeEditor();
      toast('The open note is no longer available');
    } else {
      if (remote.version > s.version) applyRemote(remote);
      S.notes = fresh;
      upsert(remote);
      applyRoleUI();
    }
  } else {
    S.notes = fresh;
  }
  S.rev++;
}

// ============================================================ realtime (SSE)
function connectEvents() {
  const es = new EventSource(`/api/events?clientId=${clientId}`);
  S.es = es;
  let connectedOnce = false;
  es.addEventListener('open', () => {
    if (connectedOnce) {
      loadNotes().then(renderAll).catch(() => {}); // catch up after reconnects (e.g. app updates)
      S.checkUpdate?.();
    }
    connectedOnce = true;
  });
  es.addEventListener('account', () => {
    es.close();
    checkAccount({ quiet: true }).then(() => {
      if (!el.app.classList.contains('locked')) setTimeout(connectEvents, 500);
    });
  });
  es.addEventListener('error', async () => {
    if (es.readyState === EventSource.CLOSED) {
      const me = await get('/api/auth/me').catch(() => null);
      if (me && !me.user) location.reload();
      else if (me?.user && me.user.status !== 'active') showLock(me.user);
      else setTimeout(connectEvents, 5000);
    }
  });
  es.addEventListener('note', (e) => {
    const { note, clientId: cid } = JSON.parse(e.data);
    if (cid === clientId) return;
    const isCurrent = S.sync?.id === note.id;
    if (isCurrent && note.trashed && note.role !== 'owner') {
      S.notes.set(note.id, note);
      closeEditor();
      toast('This note was moved to the trash by its owner');
    } else if (isCurrent && note.version > S.sync.version) {
      applyRemote(note);
    }
    upsert(note);
    if (isCurrent) applyRoleUI();
  });
  es.addEventListener('note-removed', (e) => {
    const { id } = JSON.parse(e.data);
    S.notes.delete(id);
    S.rev++;
    if (S.currentId === id) {
      closeEditor();
      toast('This note is no longer shared with you');
    }
    scheduleRender();
  });
  es.addEventListener('presence', (e) => {
    const p = JSON.parse(e.data);
    if (p.clientId === clientId || p.user.id === S.me.id) return;
    if (!S.presence.has(p.noteId)) S.presence.set(p.noteId, new Map());
    const m = S.presence.get(p.noteId);
    if (p.state === 'left') m.delete(p.user.id);
    else m.set(p.user.id, { user: p.user, state: p.state, ts: Date.now() });
    if (p.noteId === S.currentId) renderPresence();
  });
}

setInterval(() => {
  const t = Date.now();
  for (const m of S.presence.values()) for (const [k, v] of m) if (t - v.ts > 70_000) m.delete(k);
  if (S.currentId) renderPresence();
}, 10_000);

let lastPresence = { state: '', at: 0 };
let editingIdle = null;
function sendPresence(id, state) {
  const n = S.notes.get(id);
  if (!n || (n.role === 'owner' && !n.shareCount)) return;
  lastPresence = { state, at: Date.now() };
  post(`/api/notes/${id}/presence`, { state }).catch(() => {});
}
function presenceEditing() {
  if (lastPresence.state !== 'editing' || Date.now() - lastPresence.at > 20_000) sendPresence(S.currentId, 'editing');
  clearTimeout(editingIdle);
  editingIdle = setTimeout(() => sendPresence(S.currentId, 'viewing'), 15_000);
}
setInterval(() => {
  if (S.currentId && !document.hidden) sendPresence(S.currentId, lastPresence.state || 'viewing');
}, 30_000);
window.addEventListener('beforeunload', () => {
  if (S.currentId) navigator.sendBeacon?.(`/api/notes/${S.currentId}/presence`, new Blob([JSON.stringify({ state: 'left' })], { type: 'application/json' }));
});

// ============================================================ derived index (client-side)
let idx = null;
function index() {
  if (idx && idx.rev === S.rev) return idx;
  const byTitle = new Map();
  const tags = new Map();
  const backlinks = new Map();
  const live = [...S.notes.values()].filter((n) => !n.trashed);
  for (const n of live) {
    const k = n.title.trim().toLowerCase();
    if (k && !byTitle.has(k)) byTitle.set(k, n);
  }
  for (const n of S.notes.values()) {
    if (n._src !== n.content) {
      n._src = n.content;
      n._tags = extractTags(n.content).map((t) => t.toLowerCase());
      n._links = extractLinks(n.content);
      n._plain = plainText(n.content);
    }
    if (n.trashed) continue;
    n._tags.forEach((t) => tags.set(t, (tags.get(t) || 0) + 1));
    for (const target of n._links) {
      const tn = byTitle.get(target.toLowerCase());
      if (tn && tn.id !== n.id) {
        if (!backlinks.has(tn.id)) backlinks.set(tn.id, new Set());
        backlinks.get(tn.id).add(n.id);
      }
    }
  }
  idx = { rev: S.rev, byTitle, tags, backlinks };
  return idx;
}
const resolveTitle = (t) => index().byTitle.get(String(t).trim().toLowerCase()) || null;

function upsert(note) {
  const s = S.sync;
  if (s && s.id === note.id) note = { ...note, content: el.text.value, title: el.title.value };
  S.notes.set(note.id, note);
  S.rev++;
  scheduleRender();
}

// ============================================================ rendering
let renderTimer = null;
function scheduleRender(delay = 120) {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(renderAll, delay);
}
function renderAll() {
  clearTimeout(renderTimer);
  renderPanel();
  renderTabs();
  renderInfo();
}

const SORTS = {
  title: (a, b) => (a.title || 'Untitled').localeCompare(b.title || 'Untitled', undefined, { numeric: true }),
  updated: (a, b) => b.updatedAt - a.updatedAt,
  created: (a, b) => b.createdAt - a.createdAt,
};
const saveExpanded = () => localStorage.setItem('allnote-expanded', JSON.stringify([...S.expanded]));

function setView(view) {
  S.view = view;
  localStorage.setItem('allnote-view', view);
  renderPanel();
  if (view === 'search') setTimeout(() => $('#search').focus(), 0);
}

function searchFor(query) {
  S.query = query;
  $('#search').value = query;
  el.app.classList.remove('sb-collapsed');
  el.app.classList.add('nav-open');
  setView('search');
}

function renderPanel() {
  $$('.sb-tabs [data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === S.view));
  ['files', 'search', 'tags'].forEach((v) => $(`#panel-${v}`).classList.toggle('hidden', v !== S.view));
  const nbs = [...new Set([...S.notes.values()].filter((n) => n.role === 'owner' && n.notebook).map((n) => n.notebook))].sort();
  $('#notebook-options').innerHTML = nbs.map((n) => `<option value="${esc(n)}">`).join('');
  if (S.view === 'files') renderTree();
  else if (S.view === 'search') renderSearch();
  else renderTags();
}

function noteRow(n, depth) {
  const marks = [];
  if (n.shareCount) marks.push(`<span title="Shared">${icon('users', 13)}</span>`);
  if (n.publication) marks.push(`<span title="Published">${icon(n.publication.hasPin ? 'lock' : 'globe', 13)}</span>`);
  return `<a href="#" class="row note ${n.id === S.currentId ? 'active' : ''}" data-id="${n.id}" style="--d:${depth}" title="${esc(n.title || 'Untitled')}">`
    + `<span class="label">${esc(n.title || 'Untitled')}</span>${marks.length ? `<span class="marks">${marks.join('')}</span>` : ''}</a>`;
}

function folderRow(key, label, depth, { ic, count } = {}) {
  const open = S.expanded.has(key);
  return `<a href="#" class="row folder ${open ? 'open' : ''} ${ic ? 'virtual' : ''}" data-folder="${esc(key)}" style="--d:${depth}">`
    + `${icon('chevron', 14)}${ic ? icon(ic, 14) : ''}<span class="label">${esc(label)}</span>${count ? `<em>${count}</em>` : ''}</a>`;
}

function renderTree() {
  index();
  const sort = SORTS[S.sort] || SORTS.title;
  const all = [...S.notes.values()];
  const live = all.filter((n) => !n.trashed);
  const root = { folders: {}, notes: [] };
  for (const n of live) {
    if (n.role !== 'owner') continue;
    let node = root;
    for (const part of n.notebook.split('/').filter(Boolean)) {
      node.folders[part] ??= { folders: {}, notes: [] };
      node = node.folders[part];
    }
    node.notes.push(n);
  }
  const out = [];
  const virtual = (key, label, ic, list) => {
    if (!list.length) return;
    out.push(folderRow(key, label, 0, { ic, count: list.length }));
    if (S.expanded.has(key)) list.sort(sort).forEach((n) => out.push(noteRow(n, 1)));
  };
  virtual('@pinned', 'Pinned', 'pin', live.filter((n) => n.pinned));
  const walk = (node, path, depth) => {
    for (const k of Object.keys(node.folders).sort((x, y) => x.localeCompare(y))) {
      const p = path ? `${path}/${k}` : k;
      out.push(folderRow(p, k, depth));
      if (S.expanded.has(p)) walk(node.folders[k], p, depth + 1);
    }
    node.notes.sort(sort).forEach((n) => out.push(noteRow(n, depth)));
  };
  walk(root, '', 0);
  virtual('@shared', 'Shared with me', 'users', live.filter((n) => n.role !== 'owner'));
  virtual('@trash', 'Trash', 'trash', all.filter((n) => n.trashed && n.role === 'owner'));
  $('#tree').innerHTML = out.join('') || '<div class="panel-empty">No notes yet.<br>Create one with the <b>New note</b> button.</div>';
}

function parseQuery(q) {
  const terms = [];
  const tags = [];
  const notebooks = [];
  for (const m of q.matchAll(/(\w+):("[^"]*"|\S+)|"([^"]+)"|(\S+)/g)) {
    if (m[1] && ['tag', 'notebook', 'nb'].includes(m[1].toLowerCase())) {
      const v = m[2].replace(/"/g, '').toLowerCase();
      if (m[1].toLowerCase() === 'tag') tags.push(v.replace(/^#/, ''));
      else notebooks.push(v);
    } else {
      const t = (m[3] || m[0]).toLowerCase();
      if (/^#[\p{L}_]/u.test(t)) tags.push(t.slice(1));
      else terms.push(t);
    }
  }
  return { terms, tags, notebooks };
}

function searchScore(n, q) {
  if (q.tags.some((t) => !n._tags.some((x) => x === t || x.startsWith(`${t}/`)))) return -1;
  if (q.notebooks.some((nb) => !n.notebook.toLowerCase().includes(nb))) return -1;
  const title = n.title.toLowerCase();
  const body = n.content.toLowerCase();
  let score = 1;
  for (const t of q.terms) {
    const inTitle = title.includes(t);
    if (!inTitle && !body.includes(t)) return -1;
    score += inTitle ? 10 : 1;
  }
  return score;
}

function snippet(n, q) {
  const text = n._plain || '';
  const term = q?.terms.find((t) => text.toLowerCase().includes(t));
  if (!term) return esc(text.slice(0, 180));
  const i = text.toLowerCase().indexOf(term);
  const start = Math.max(0, i - 50);
  let s = esc((start ? '…' : '') + text.slice(start, start + 180));
  for (const t of q.terms) {
    const re = new RegExp(esc(t).replace(/[.*+?^${}()|[\]\\]/g, '\\/*__SEARCH_HELPERS__*/'), 'gi');
    s = s.replace(re, (m) => `<mark>${m}</mark>`);
  }
  return s;
}

function renderSearch() {
  const qs = S.query.trim();
  const box = $('#search-results');
  if (!qs) {
    box.innerHTML = '<div class="panel-empty">Search titles and content.<br>Filters: <code>tag:work</code> <code>notebook:ideas</code></div>';
    return;
  }
  index();
  const q = parseQuery(qs);
  const res = [...S.notes.values()].filter((n) => !n.trashed)
    .map((n) => ({ n, s: searchScore(n, q) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s || b.n.updatedAt - a.n.updatedAt);
  box.innerHTML = `<div class="res-count">${res.length} result${res.length === 1 ? '' : 's'}</div>`
    + res.map(({ n }) => `<a href="#" class="result ${n.id === S.currentId ? 'active' : ''}" data-id="${n.id}">
        <b>${esc(n.title || 'Untitled')}</b>${n.notebook && n.role === 'owner' ? `<span class="path">${esc(n.notebook)}</span>` : ''}
        <small>${snippet(n, q) || 'Empty note'}</small></a>`).join('');
}

function renderTags() {
  const tags = [...index().tags.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  $('#tag-list').innerHTML = tags.map(([t, c]) => `<a href="#" class="row tagrow" data-tag="${esc(t)}" style="--d:0"><span class="label">#${esc(t)}</span><em>${c}</em></a>`).join('')
    || '<div class="panel-empty">No tags yet.<br>Type <code>#tag</code> in a note.</div>';
}

function renderTabs() {
  S.tabs = S.tabs.filter((id) => S.notes.has(id));
  localStorage.setItem('allnote-tabs', JSON.stringify(S.tabs));
  $('#tabs').innerHTML = S.tabs.map((id) => {
    const n = S.notes.get(id);
    const t = esc(n.title || 'Untitled');
    return `<div class="tab ${id === S.currentId ? 'active' : ''}" data-tab="${id}" title="${t}"><span>${t}</span><button class="tab-x" data-close-tab="${id}" title="Close">${icon('x', 13)}</button></div>`;
  }).join('');
  $('#tabs .tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

async function closeTab(id) {
  if (id === S.currentId) {
    await flushSave();
    closeEditor();
    return;
  }
  S.tabs = S.tabs.filter((t) => t !== id);
  renderTabs();
}

// ============================================================ editor
const canEdit = (n) => n && n.role !== 'viewer' && !n.trashed;

async function openNote(id, { focus } = {}) {
  if (!S.notes.has(id)) return;
  if (S.currentId !== id) {
    if (live.active) liveDeactivate();
    await flushSave();
    if (S.currentId) sendPresence(S.currentId, 'left');
    const n = S.notes.get(id);
    if (!S.tabs.includes(id)) {
      const at = S.tabs.indexOf(S.currentId);
      S.tabs.splice(at < 0 ? S.tabs.length : at + 1, 0, id);
    }
    if (n.role === 'owner' && n.notebook) {
      let p = '';
      for (const part of n.notebook.split('/').filter(Boolean)) {
        p = p ? `${p}/${part}` : part;
        S.expanded.add(p);
      }
      saveExpanded();
    }
    S.currentId = id;
    S.sync = { id, base: n.content, baseTitle: n.title, version: n.version, dirty: false, saving: false, timer: null };
    el.title.value = n.title;
    el.text.value = n.content;
    el.text.scrollTop = 0;
    el.preview.scrollTop = 0;
    el.empty.classList.add('hidden');
    el.editor.classList.remove('hidden');
    el.app.classList.add('has-note');
    history.replaceState(null, '', `#/note/${id}`);
    applyRoleUI();
    renderLive(true);
    renderPreview();
    renderPresence();
    setSaveStatus('saved');
    lastPresence = { state: '', at: 0 };
    sendPresence(id, 'viewing');
  }
  el.app.classList.remove('nav-open');
  renderAll();
  const n = S.notes.get(id);
  if (focus === 'title' && canEdit(n)) el.title.focus();
  else if (focus === 'text' && canEdit(n)) {
    if (S.mode === 'preview') setMode('live');
    if (S.mode === 'live') return liveActivateEnd();
    el.text.focus();
    el.text.setSelectionRange(el.text.value.length, el.text.value.length);
  }
}

function closeEditor() {
  const id = S.currentId;
  if (id) sendPresence(id, 'left');
  const at = S.tabs.indexOf(id);
  if (at >= 0) S.tabs.splice(at, 1);
  S.currentId = null;
  S.sync = null;
  const next = S.tabs[at] ?? S.tabs[at - 1];
  if (next && S.notes.has(next)) {
    openNote(next);
    return;
  }
  el.editor.classList.add('hidden');
  el.empty.classList.remove('hidden');
  el.app.classList.remove('has-note');
  history.replaceState(null, '', location.pathname);
  renderAll();
}

function effectiveMode(n) {
  return canEdit(n) ? S.mode : 'preview';
}

function applyRoleUI() {
  const n = S.notes.get(S.currentId);
  if (!n) return;
  const editable = canEdit(n);
  const owner = n.role === 'owner';
  el.text.readOnly = !editable;
  el.title.readOnly = !editable;
  el.notebook.disabled = !owner || n.trashed;
  el.notebook.value = owner ? n.notebook : `Shared by ${n.owner.name}`;
  $('#toolbar').classList.toggle('hidden', !editable || effectiveMode(n) === 'preview');
  $('#mode-seg').classList.toggle('hidden', !editable);
  $('#btn-pin').classList.toggle('hidden', !owner);
  $('#btn-pin').classList.toggle('active', n.pinned);
  $('#btn-publish').classList.toggle('hidden', !owner);
  $('#btn-publish').classList.toggle('active', Boolean(n.publication));
  $('#btn-share').classList.toggle('active', n.shareCount > 0 || !owner);
  const mode = effectiveMode(n);
  el.body.className = `ed-body mode-${mode}`;
  $$('#mode-seg button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));

  let banner = '';
  if (n.trashed) {
    banner = `<span>${icon('trash', 16)} This note is in the trash.</span><button class="btn sm" data-b="restore">${icon('restore', 14)} Restore</button><button class="btn sm danger" data-b="purge">Delete forever</button>`;
  } else if (n.role === 'viewer') {
    banner = `<span>${icon('eye', 16)} View only — shared by <b>${esc(n.owner.name)}</b></span>`;
  } else if (n.role === 'editor') {
    banner = `<span>${icon('users', 16)} Shared by <b>${esc(n.owner.name)}</b> — you can edit. Changes sync live.</span>`;
  }
  el.banner.innerHTML = banner;
  el.banner.className = `banner ${n.trashed ? 'warn' : ''} ${banner ? '' : 'hidden'}`;
  renderStatusMeta();
}

el.banner = $('#ed-banner');
el.banner.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-b]');
  if (!b) return;
  if (b.dataset.b === 'restore') await updateMeta({ trashed: false }, 'Note restored');
  if (b.dataset.b === 'purge') purgeNote(S.currentId);
});

let previewTimer = null;
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(renderPreview, 150);
}
function renderPreview() {
  const n = S.notes.get(S.currentId);
  if (!n || effectiveMode(n) === 'edit') return;
  if (effectiveMode(n) === 'live') {
    renderLive();
    return;
  }
  renderInto(el.preview, el.text.value, { resolve: resolveTitle, interactiveTasks: canEdit(n) });
}

function setMode(mode) {
  if (live.active) liveDeactivate();
  S.mode = mode;
  localStorage.setItem('allnote-mode', mode);
  applyRoleUI();
  renderLive(true);
  renderPreview();
}

function renderStatusMeta() {
  const n = S.notes.get(S.currentId);
  if (!n) return;
  const by = n.updatedBy && n.updatedBy.id !== S.me.id ? ` by ${n.updatedBy.name}` : '';
  $('#st-meta').textContent = `Edited ${timeAgo(n.updatedAt)}${by}`;
  const text = el.text.value;
  $('#st-words').textContent = `${wordCount(text)} words · ${text.length} chars`;
}

function setSaveStatus(state, msg = '') {
  const map = {
    saved: ['saved', 'check', 'Saved'],
    pending: ['saving', 'edit', 'Editing…'],
    saving: ['saving', 'clock', 'Saving…'],
    error: ['save-error', 'x', `Not saved: ${msg}`],
  };
  const [cls, ic, label] = map[state];
  el.save.className = cls;
  el.save.innerHTML = `${icon(ic, 13)} ${esc(label)}`;
}

function renderPresence() {
  const m = S.presence.get(S.currentId);
  const people = m ? [...m.values()] : [];
  $('#presence').innerHTML = people.map((p) => avatarHtml(p.user, p.state === 'editing' ? 'editing' : '')
    .replace('title="', `title="${p.state === 'editing' ? 'Editing: ' : 'Viewing: '}`)).join('');
}

// ---------------------------------------------------- saving & merging
function markDirty() {
  const s = S.sync;
  if (!s) return;
  s.dirty = true;
  const n = S.notes.get(s.id);
  if (n) {
    n.content = el.text.value;
    n.title = el.title.value;
  }
  S.rev++;
  scheduleSave();
  schedulePreview();
  scheduleRender(400);
  renderStatusMeta();
  presenceEditing();
}

function scheduleSave(delay = 700) {
  const s = S.sync;
  if (!s) return;
  clearTimeout(s.timer);
  setSaveStatus('pending');
  s.timer = setTimeout(() => save(s), delay);
}

async function save(s = S.sync) {
  if (!s || S.sync !== s || !s.dirty) return;
  if (s.saving) {
    s.again = true;
    return;
  }
  clearTimeout(s.timer);
  s.saving = true;
  const content = el.text.value;
  const title = el.title.value;
  setSaveStatus('saving');
  try {
    const { note } = await put(`/api/notes/${s.id}`, { title, content, baseVersion: s.version });
    if (S.sync === s) {
      s.version = note.version;
      s.base = note.content;
      s.baseTitle = note.title;
      s.dirty = el.text.value !== content || el.title.value !== title;
    }
    upsert(note);
    if (S.sync === s) setSaveStatus(s.dirty ? 'pending' : 'saved');
  } catch (err) {
    if (err.status === 409 && err.data?.note && S.sync === s) {
      applyRemote(err.data.note);
      upsert(err.data.note);
    } else if (S.sync === s) {
      setSaveStatus('error', err.message);
      s.timer = setTimeout(() => save(s), 5000);
    }
  } finally {
    s.saving = false;
    if (S.sync === s && s.dirty) {
      clearTimeout(s.timer);
      s.timer = setTimeout(() => save(s), s.again ? 0 : 400);
    }
    s.again = false;
  }
}

async function flushSave() {
  const s = S.sync;
  if (!s) return;
  clearTimeout(s.timer);
  if (s.dirty && !s.saving) await save(s);
  for (let i = 0; i < 50 && s.saving; i++) await new Promise((r) => setTimeout(r, 100));
}

// Merge a newer server version of the open note into the editor (3-way merge in the browser).
function applyRemote(note) {
  const s = S.sync;
  if (!s || s.id !== note.id) return;
  const mine = el.text.value;
  const myTitle = el.title.value;
  const merged = s.dirty ? merge3(s.base, mine, note.content) : note.content;
  const title = s.dirty && myTitle !== s.baseTitle ? myTitle : note.title;
  let liveSel = null;
  if (merged !== mine && live.active) {
    const cs = live.start + live.ta.selectionStart;
    const ce = live.start + live.ta.selectionEnd;
    liveSel = [mapOffset(mine, merged, cs), mapOffset(mine, merged, ce)];
    live.start = mapOffset(mine, merged, live.start);
    live.end = Math.max(live.start, mapOffset(mine, merged, live.end));
  }
  if (merged !== mine) {
    const focused = document.activeElement === el.text;
    const a = mapOffset(mine, merged, el.text.selectionStart);
    const b = mapOffset(mine, merged, el.text.selectionEnd);
    const scroll = el.text.scrollTop;
    el.text.value = merged;
    if (focused) el.text.setSelectionRange(a, b);
    el.text.scrollTop = scroll;
    if (liveSel) {
      live.ta.value = merged.slice(live.start, live.end);
      const clamp = (x) => Math.max(0, Math.min(x - live.start, live.ta.value.length));
      live.ta.setSelectionRange(clamp(liveSel[0]), clamp(liveSel[1]));
      liveAutosize();
    }
  }
  if (title !== myTitle) el.title.value = title;
  s.base = note.content;
  s.baseTitle = note.title;
  s.version = note.version;
  s.dirty = merged !== note.content || title !== note.title;
  if (s.dirty) scheduleSave(300);
  else setSaveStatus('saved');
  schedulePreview();
  renderStatusMeta();
}

async function updateMeta(fields, msg) {
  const id = S.currentId;
  try {
    const { note } = await put(`/api/notes/${id}`, fields);
    upsert(note);
    if (S.currentId === id) applyRoleUI();
    renderPreview();
    if (msg) toast(msg);
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ---------------------------------------------------- editor events
el.text = $('#ed-text');
el.title = $('#ed-title');
el.text.addEventListener('input', () => {
  markDirty();
  updateSuggest();
});
el.title.addEventListener('input', markDirty);
el.title.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    if (S.mode === 'preview') setMode('live');
    if (S.mode === 'live') {
      const first = splitBlocks(el.text.value)[0];
      if (first) liveActivate(first.start, first.end, 0);
      else liveActivateEnd();
    } else el.text.focus();
  }
});
$('#ed-notebook').addEventListener('change', (e) => updateMeta({ notebook: e.target.value.trim().replace(/^\/+|\/+$/g, '') }));
$('#mode-seg').addEventListener('click', (e) => {
  const b = e.target.closest('[data-mode]');
  if (b) setMode(b.dataset.mode);
});
$('#btn-pin').addEventListener('click', () => {
  const n = S.notes.get(S.currentId);
  updateMeta({ pinned: !n.pinned }, n.pinned ? 'Unpinned' : 'Pinned');
});
$('#btn-info').addEventListener('click', () => {
  const collapsed = el.info.classList.toggle('collapsed');
  localStorage.setItem('allnote-info', collapsed ? '0' : '1');
  renderInfo();
});
$('#btn-share').addEventListener('click', () => openShare(S.currentId));
$('#btn-publish').addEventListener('click', () => openPublish(S.currentId));
$('#btn-history').addEventListener('click', () => openHistory(S.currentId));
$('#btn-more').addEventListener('click', (e) => openMoreMenu(e.currentTarget));

// preview interactions: wikilinks, tags, tasks
document.addEventListener('click', (e) => {
  const wl = e.target.closest('.markdown a.wikilink, a.link-card[data-open]');
  if (wl) {
    e.preventDefault();
    if (wl.dataset.open) return openNote(wl.dataset.open);
    return openByTitle(wl.dataset.target, wl.dataset.heading);
  }
  const tg = e.target.closest('a.tag[data-tag], a.chip[data-tag], a.tagrow[data-tag]');
  if (tg) {
    e.preventDefault();
    searchFor(`tag:${tg.dataset.tag.toLowerCase()}`);
  }
});
el.preview = $('#ed-preview');
el.preview.addEventListener('change', (e) => {
  const cb = e.target.closest('input[data-task]');
  if (!cb || !canEdit(S.notes.get(S.currentId))) return;
  el.text.value = toggleTask(el.text.value, Number(cb.dataset.task));
  markDirty();
  renderPreview();
});

async function openByTitle(title, heading) {
  let n = resolveTitle(title);
  if (!n) {
    const cur = S.notes.get(S.currentId);
    n = await createNote({ title, notebook: cur?.role === 'owner' ? cur.notebook : '', open: false });
    toast(`Created “${title}”`);
  }
  await openNote(n.id);
  if (heading) {
    const target = $('h1,h2,h3,h4,h5,h6', viewEl()).find((x) => x.textContent.trim().toLowerCase() === heading.toLowerCase());
    target?.scrollIntoView({ behavior: 'smooth' });
  }
}

// ---------------------------------------------------- live preview
// Shows the note rendered; clicking a block swaps just that block for an editable textarea.
// el.text stays the single source of truth; the block editor writes its slice back into it.
const live = {
  root: $('#ed-live'),
  before: $('#ed-live .lp-before'),
  after: $('#ed-live .lp-after'),
  ta: $('#ed-live .lp-editor'),
  active: false,
  start: 0,
  end: 0,
  cache: '',
};
el.live = live.root;
const ed = () => (live.active ? live.ta : el.text);
const viewEl = () => (effectiveMode(S.notes.get(S.currentId)) === 'live' ? el.live : el.preview);

function fillBlocks(container, src, part) {
  container.textContent = '';
  const n = S.notes.get(S.currentId);
  const opts = { resolve: resolveTitle, interactiveTasks: canEdit(n) };
  for (const b of splitBlocks(src)) {
    const d = document.createElement('div');
    d.className = 'lp-block';
    d.dataset.part = part;
    d.dataset.s = b.start;
    d.dataset.e = b.end;
    renderInto(d, src.slice(b.start, b.end), opts);
    container.append(d);
  }
}

function renderLive(force = false) {
  const src = el.text.value;
  const head = live.active ? src.slice(0, live.start) : src;
  const tail = live.active ? src.slice(live.end) : '';
  const key = `${live.active}\u0000${head}\u0000${tail}\u0000${S.notes.size}`;
  if (!force && key === live.cache) return;
  live.cache = key;
  fillBlocks(live.before, head, 'before');
  fillBlocks(live.after, tail, 'after');
  live.root.classList.toggle('is-empty', !live.active && !src.trim());
  live.root.classList.toggle('readonly', !canEdit(S.notes.get(S.currentId)));
}

function liveAutosize() {
  live.ta.style.height = 'auto';
  live.ta.style.height = `${live.ta.scrollHeight}px`;
}

function liveActivate(start, end, caret) {
  if (!canEdit(S.notes.get(S.currentId))) return;
  live.active = true;
  live.start = start;
  live.end = end;
  live.ta.hidden = false;
  live.ta.value = el.text.value.slice(start, end);
  renderLive(true);
  liveAutosize();
  live.ta.focus({ preventScroll: true });
  const c = Math.max(0, Math.min(caret ?? live.ta.value.length, live.ta.value.length));
  live.ta.setSelectionRange(c, c);
  const r = live.ta.getBoundingClientRect();
  if (r.top < 80 || r.bottom > window.innerHeight - 40) live.ta.scrollIntoView({ block: 'nearest' });
}

// Returns [oldSource, newSource]; an emptied block is removed together with its surrounding blank lines.
function liveDeactivate() {
  const src = el.text.value;
  if (!live.active) return [src, src];
  let next = src;
  if (!live.ta.value.trim()) {
    const head = src.slice(0, live.start).replace(/\n+$/, '');
    const tail = src.slice(live.end).replace(/^\n+/, '');
    next = head && tail ? `${head}\n\n${tail}` : head || tail;
  }
  live.active = false;
  live.ta.hidden = true;
  hideSuggest();
  if (next !== src) {
    el.text.value = next;
    markDirty();
  }
  renderLive(true);
  return [src, next];
}

function liveActivateEnd() {
  if (live.active) liveDeactivate();
  const trimmed = el.text.value.replace(/\s+$/, '');
  const src = trimmed ? `${trimmed}\n\n` : '';
  if (src !== el.text.value) el.text.value = src;
  liveActivate(src.length, src.length, 0);
}

function liveRangeOf(blk) {
  const base = blk.dataset.part === 'after' ? live.end : 0;
  return [base + Number(blk.dataset.s), base + Number(blk.dataset.e)];
}

function liveGo(start, end, caret) {
  if (live.active) {
    const [o, n] = liveDeactivate();
    if (o !== n) {
      start = mapOffset(o, n, start);
      end = mapOffset(o, n, end);
    }
  }
  liveActivate(start, end, caret === 'end' ? end - start : caret);
}

function liveNeighbor(dir) {
  const blocks = splitBlocks(el.text.value);
  return dir < 0 ? blocks.filter((b) => b.end <= live.start).pop() : blocks.find((b) => b.start >= live.end);
}

// Map a click inside rendered HTML to an offset in the block's markdown (subsequence match of the visible text).
function caretFromPoint(blk, x, y, raw) {
  let range = null;
  if (document.caretPositionFromPoint) {
    const p = document.caretPositionFromPoint(x, y);
    if (p) {
      range = document.createRange();
      range.setStart(p.offsetNode, p.offset);
    }
  } else if (document.caretRangeFromPoint) range = document.caretRangeFromPoint(x, y);
  if (!range || !blk.contains(range.startContainer)) return raw.length;
  const pre = document.createRange();
  pre.selectNodeContents(blk);
  pre.setEnd(range.startContainer, range.startOffset);
  const want = pre.toString().replace(/\s/g, '');
  let j = 0;
  for (let i = 0; i < raw.length; i++) {
    if (j >= want.length) return i;
    if (raw[i] === want[j]) j++;
  }
  return raw.length;
}

live.root.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || e.target.closest('.lp-editor, a, input, button, summary')) return;
  if (!canEdit(S.notes.get(S.currentId))) return;
  const blk = e.target.closest('.lp-block');
  if (blk) {
    e.preventDefault();
    const [start, end] = liveRangeOf(blk);
    liveGo(start, end, caretFromPoint(blk, e.clientX, e.clientY, el.text.value.slice(start, end)));
    return;
  }
  const blocks = $$('.lp-block', live.root);
  const last = blocks[blocks.length - 1];
  if (!last || e.clientY > last.getBoundingClientRect().bottom) {
    e.preventDefault();
    liveActivateEnd();
  }
});

live.root.addEventListener('change', (e) => {
  const cb = e.target.closest('input[data-task]');
  const blk = cb?.closest('.lp-block');
  if (!blk || !canEdit(S.notes.get(S.currentId))) return;
  const [start, end] = liveRangeOf(blk);
  const src = el.text.value;
  el.text.value = src.slice(0, start) + toggleTask(src.slice(start, end), Number(cb.dataset.task)) + src.slice(end);
  markDirty();
  renderLive(true);
});

live.ta.addEventListener('input', () => {
  const src = el.text.value;
  el.text.value = src.slice(0, live.start) + live.ta.value + src.slice(live.end);
  live.end = live.start + live.ta.value.length;
  liveAutosize();
  markDirty();
  updateSuggest();
});
live.ta.addEventListener('click', updateSuggest);
live.ta.addEventListener('blur', () => {
  setTimeout(() => {
    if (live.active && document.activeElement !== live.ta && document.hasFocus()) liveDeactivate();
  }, 120);
});

live.ta.addEventListener('keydown', (e) => {
  if (!sug.el.classList.contains('hidden')) return editorKeydown(e);
  const ta = live.ta;
  const v = ta.value;
  const s = ta.selectionStart;
  const t = ta.selectionEnd;
  const plain = !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey;
  if (e.key === 'Escape') {
    e.preventDefault();
    ta.blur();
    liveDeactivate();
    return;
  }
  if (plain && ((e.key === 'ArrowUp' && !v.slice(0, s).includes('\n')) || (e.key === 'ArrowLeft' && s === 0 && t === 0))) {
    const prev = liveNeighbor(-1);
    if (prev) {
      e.preventDefault();
      liveGo(prev.start, prev.end, 'end');
    }
    return;
  }
  if (plain && ((e.key === 'ArrowDown' && !v.slice(t).includes('\n')) || (e.key === 'ArrowRight' && s === v.length && t === v.length))) {
    const next = liveNeighbor(1);
    if (next) {
      e.preventDefault();
      liveGo(next.start, next.end, 0);
    }
    return;
  }
  if (plain && e.key === 'Backspace' && s === 0 && t === 0) {
    const prev = liveNeighbor(-1);
    if (!prev) return;
    e.preventDefault();
    if (!v.trim()) return liveGo(prev.start, prev.end, 'end');
    // merge into the previous block (joined by a line break)
    const src = el.text.value;
    const len = live.end - live.start;
    el.text.value = `${src.slice(0, prev.end)}\n${src.slice(live.start)}`;
    live.active = false;
    live.ta.hidden = true;
    markDirty();
    const prevLen = prev.end - prev.start;
    liveActivate(prev.start, prev.start + prevLen + 1 + len, prevLen + 1);
    return;
  }
  editorKeydown(e);
  if (e.defaultPrevented) return;
  // Enter on an empty last line finishes this block and starts a new one below (not inside code fences).
  if (plain && e.key === 'Enter' && s === t && s === v.length && v.endsWith('\n') && !/^\s*(```|~~~)/.test(v)) {
    e.preventDefault();
    const src = el.text.value;
    const at = live.start + v.replace(/\n+$/, '').length;
    const rest = src.slice(live.end).replace(/^\n+/, '');
    el.text.value = `${src.slice(0, at)}\n\n${rest ? `\n\n${rest}` : ''}`;
    live.active = false;
    live.ta.hidden = true;
    markDirty();
    liveActivate(at + 2, at + 2, 0);
  }
});

// ---------------------------------------------------- formatting
function replaceRange(start, end, text, selStart, selEnd) {
  ed().focus();
  ed().setSelectionRange(start, end);
  // execCommand keeps the browser's native undo stack; fall back to setRangeText where unsupported.
  const ok = text ? document.execCommand('insertText', false, text) : start === end || document.execCommand('delete');
  if (!ok) {
    ed().setRangeText(text, start, end, 'end');
    ed().dispatchEvent(new Event('input'));
  }
  const caret = selStart ?? start + text.length;
  ed().setSelectionRange(caret, selEnd ?? caret);
}

function wrap(before, after = before, placeholder = 'text') {
  const { selectionStart: s, selectionEnd: e, value: v } = ed();
  if (v.slice(s - before.length, s) === before && v.slice(e, e + after.length) === after) {
    const inner = v.slice(s, e);
    return replaceRange(s - before.length, e + after.length, inner, s - before.length, e - before.length);
  }
  const sel = v.slice(s, e) || placeholder;
  replaceRange(s, e, before + sel + after, s + before.length, s + before.length + sel.length);
}

function lineRange() {
  const { selectionStart: s, selectionEnd: e, value: v } = ed();
  const start = v.lastIndexOf('\n', s - 1) + 1;
  let end = v.indexOf('\n', e === s ? e : e - 1);
  if (end < 0) end = v.length;
  return { start, end, lines: v.slice(start, end).split('\n') };
}

function transformLines(fn) {
  const { start, end, lines } = lineRange();
  const out = lines.map(fn).join('\n');
  replaceRange(start, end, out, start + out.length);
}

function togglePrefix(re, prefix) {
  const { lines } = lineRange();
  const all = lines.every((l) => re.test(l) || !l.trim());
  transformLines((l, i) => {
    if (!l.trim() && lines.length > 1) return l;
    const stripped = l.replace(/^(\s*)(?:[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+|>\s?)/, '$1');
    if (all) return stripped;
    const p = typeof prefix === 'function' ? prefix(i) : prefix;
    return stripped.replace(/^(\s*)/, `$1${p}`);
  });
}

const FORMATS = {
  bold: () => wrap('**'),
  italic: () => wrap('*'),
  strike: () => wrap('~~'),
  highlight: () => wrap('=='),
  heading: () => transformLines((l) => {
    const m = /^(#{1,6})\s/.exec(l);
    if (!m) return `# ${l}`;
    return m[1].length >= 3 ? l.replace(/^#{1,6}\s/, '') : `#${l}`;
  }),
  ul: () => togglePrefix(/^\s*[-*+]\s+(?!\[[ xX]\])/, '- '),
  ol: () => togglePrefix(/^\s*\d+[.)]\s+/, (i) => `${i + 1}. `),
  task: () => togglePrefix(/^\s*[-*+]\s+\[[ xX]\]\s+/, '- [ ] '),
  quote: () => togglePrefix(/^\s*>\s?/, '> '),
  callout: () => {
    const { selectionStart: s, selectionEnd: e, value: v } = ed();
    const body = v.slice(s, e) || 'Write something important';
    const pre = s > 0 && v[s - 1] !== '\n' ? '\n\n' : '';
    const text = `${pre}> [!note] Note\n${body.split('\n').map((l) => `> ${l}`).join('\n')}\n`;
    replaceRange(s, e, text, s + pre.length + 4, s + pre.length + 8);
  },
  code: () => {
    const { selectionStart: s, selectionEnd: e, value: v } = ed();
    const sel = v.slice(s, e);
    if (sel.includes('\n') || (!sel && (s === 0 || v[s - 1] === '\n'))) {
      replaceRange(s, e, `\`\`\`\n${sel}\n\`\`\`\n`, s + 4, s + 4 + sel.length);
    } else wrap('`', '`', 'code');
  },
  link: () => {
    const { selectionStart: s, selectionEnd: e, value: v } = ed();
    const sel = v.slice(s, e) || 'link text';
    const text = `[${sel}](https://)`;
    replaceRange(s, e, text, s + sel.length + 3, s + text.length - 1);
  },
  wikilink: () => {
    wrap('[[', ']]', '');
    updateSuggest();
  },
  table: () => {
    const s = ed().selectionStart;
    const pre = s > 0 && ed().value[s - 1] !== '\n' ? '\n\n' : '';
    replaceRange(s, ed().selectionEnd, `${pre}| Column 1 | Column 2 | Column 3 |\n| --- | --- | --- |\n| | | |\n`);
  },
  hr: () => {
    const s = ed().selectionStart;
    replaceRange(s, ed().selectionEnd, `${s > 0 && ed().value[s - 1] !== '\n' ? '\n' : ''}\n---\n`);
  },
};

$('#toolbar').addEventListener('mousedown', (e) => e.preventDefault());
$('#toolbar').addEventListener('click', (e) => {
  const b = e.target.closest('[data-fmt]');
  if (!b || el.text.readOnly) return;
  if (S.mode === 'live' && !live.active) liveActivateEnd();
  FORMATS[b.dataset.fmt]();
});

function editorKeydown(e) {
  if (suggestKey(e)) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'b') { e.preventDefault(); FORMATS.bold(); return; }
  if (mod && e.key.toLowerCase() === 'i') { e.preventDefault(); FORMATS.italic(); return; }
  if (mod && e.key === 'Enter') { e.preventDefault(); FORMATS.task(); return; }
  if (e.key === 'Tab') {
    e.preventDefault();
    const { lines } = lineRange();
    const multi = ed().selectionStart !== ed().selectionEnd || /^\s*([-*+]|\d+[.)])\s/.test(lines[0]);
    if (e.shiftKey) transformLines((l) => l.replace(/^( {1,2}|\t)/, ''));
    else if (multi) transformLines((l) => `  ${l}`);
    else replaceRange(ed().selectionStart, ed().selectionEnd, '  ');
    return;
  }
  if (e.key === 'Enter' && !e.shiftKey && !mod && ed().selectionStart === ed().selectionEnd) {
    const v = ed().value;
    const pos = ed().selectionStart;
    const ls = v.lastIndexOf('\n', pos - 1) + 1;
    const line = v.slice(ls, pos);
    const m = /^(\s*(?:>\s*)*)([-*+]|\d+)([.)])?(\s+\[[ xX]\])?\s+/.exec(line);
    if (!m || (!m[3] && /^\d+$/.test(m[2]))) return;
    e.preventDefault();
    if (line.trim() === m[0].trim()) {
      replaceRange(ls, pos, '');
      return;
    }
    const marker = /^\d+$/.test(m[2]) ? `${Number(m[2]) + 1}${m[3]}` : m[2];
    replaceRange(pos, pos, `\n${m[1]}${marker}${m[4] ? ' [ ]' : ''} `);
  }
}
el.text.addEventListener('keydown', editorKeydown);

// ---------------------------------------------------- [[ autocomplete
const sug = { el: $('#suggest'), items: [], active: 0, start: -1 };

function caretCoords(ta, pos) {
  const div = document.createElement('div');
  const cs = getComputedStyle(ta);
  for (const p of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'paddingTop', 'paddingLeft', 'paddingRight', 'tabSize']) div.style[p] = cs[p];
  Object.assign(div.style, { position: 'absolute', visibility: 'hidden', whiteSpace: 'pre-wrap', wordWrap: 'break-word', width: `${ta.clientWidth}px`, top: '0', left: '0' });
  div.textContent = ta.value.slice(0, pos);
  const span = document.createElement('span');
  span.textContent = '.';
  div.append(span);
  document.body.append(div);
  const r = ta.getBoundingClientRect();
  const out = { top: r.top + span.offsetTop - ta.scrollTop + parseFloat(cs.lineHeight), left: r.left + span.offsetLeft - ta.scrollLeft };
  div.remove();
  return out;
}

function updateSuggest() {
  const pos = ed().selectionStart;
  const before = ed().value.slice(0, pos);
  const m = /\[\[([^\]\n|#]*)$/.exec(before);
  if (!m || ed().selectionStart !== ed().selectionEnd) return hideSuggest();
  const q = m[1].toLowerCase();
  sug.start = pos - m[1].length;
  const notes = [...S.notes.values()].filter((n) => !n.trashed && n.id !== S.currentId && n.title);
  const scored = notes
    .map((n) => {
      const t = n.title.toLowerCase();
      const i = t.indexOf(q);
      return { n, s: !q ? 1 : i === 0 ? 3 : i > 0 ? 2 : 0 };
    })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || b.n.updatedAt - a.n.updatedAt)
    .slice(0, 8)
    .map((x) => ({ title: x.n.title, hint: x.n.notebook }));
  if (q && !notes.some((n) => n.title.toLowerCase() === q)) scored.push({ title: m[1], hint: 'create new note', create: true });
  sug.items = scored;
  if (!scored.length) return hideSuggest();
  sug.active = 0;
  renderSuggest();
  const c = caretCoords(ed(), pos);
  sug.el.style.top = `${Math.min(c.top + 4, window.innerHeight - 270)}px`;
  sug.el.style.left = `${Math.min(c.left, window.innerWidth - 370)}px`;
  sug.el.classList.remove('hidden');
}

function renderSuggest() {
  sug.el.innerHTML = sug.items.map((it, i) => `<a data-i="${i}" class="${i === sug.active ? 'active' : ''}">${it.create ? icon('plus', 14) : icon('notes', 14)} ${esc(it.title)}${it.hint ? `<small>${esc(it.hint)}</small>` : ''}</a>`).join('');
}
function hideSuggest() {
  sug.el.classList.add('hidden');
  sug.items = [];
}
function pickSuggest(i) {
  const it = sug.items[i];
  if (!it) return;
  const pos = ed().selectionStart;
  const after = ed().value.slice(pos, pos + 2) === ']]' ? '' : ']]';
  replaceRange(sug.start, pos, it.title + after);
  const end = sug.start + it.title.length + 2;
  ed().setSelectionRange(end, end);
  hideSuggest();
}
function suggestKey(e) {
  if (sug.el.classList.contains('hidden')) return false;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    sug.active = (sug.active + (e.key === 'ArrowDown' ? 1 : -1) + sug.items.length) % sug.items.length;
    renderSuggest();
    return true;
  }
  if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    pickSuggest(sug.active);
    return true;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    hideSuggest();
    return true;
  }
  return false;
}
sug.el.addEventListener('mousedown', (e) => {
  e.preventDefault();
  const a = e.target.closest('[data-i]');
  if (a) pickSuggest(Number(a.dataset.i));
});
el.text.addEventListener('blur', () => setTimeout(hideSuggest, 100));
el.text.addEventListener('click', updateSuggest);

// ============================================================ info pane
function renderInfo() {
  const n = S.notes.get(S.currentId);
  if (!n || el.info.classList.contains('collapsed')) return;
  const ix = index();
  const content = el.text.value;
  $('#outline').innerHTML = extractHeadings(content)
    .map((hd, i) => `<a href="#" data-h="${i}" data-line="${hd.line}" style="padding-left:${(hd.level - 1) * 12}px">${esc(hd.text)}</a>`).join('');

  const back = [...(ix.backlinks.get(n.id) || [])].map((id) => S.notes.get(id)).filter(Boolean);
  $('#backlinks').innerHTML = back.map((b) => {
    const line = b.content.split('\n').find((l) => l.toLowerCase().includes(`[[${n.title.toLowerCase()}`)) || '';
    return `<a href="#" class="link-card" data-open="${b.id}"><b>${esc(b.title || 'Untitled')}</b><small>${esc(plainText(line))}</small></a>`;
  }).join('');

  $('#outlinks').innerHTML = (n._links || []).map((t) => {
    const target = resolveTitle(t);
    return target
      ? `<a href="#" class="link-card" data-open="${target.id}"><b>${esc(target.title)}</b></a>`
      : `<a href="#" class="link-card missing wikilink" data-target="${esc(t)}"><b>${esc(t)}</b><small>Not created yet — click to create</small></a>`;
  }).join('');
  $('#note-tags').innerHTML = (n._tags || []).map((t) => `<a href="#" class="chip" data-tag="${esc(t)}">#${esc(t)}</a>`).join('');
  const pub = n.publication ? `<a href="/p/${esc(n.publication.slug)}" target="_blank">/p/${esc(n.publication.slug)}</a>${n.publication.hasPin ? ` <span title="PIN protected">${icon('lock', 13)}</span>` : ''}` : 'No';
  $('#note-info').innerHTML = `
    <dt>Owner</dt><dd>${esc(n.role === 'owner' ? 'You' : n.owner.name)}</dd>
    <dt>Created</dt><dd>${fmtDate(n.createdAt)}</dd>
    <dt>Modified</dt><dd>${fmtDate(n.updatedAt)}</dd>
    ${n.updatedBy ? `<dt>Last edit</dt><dd>${esc(n.updatedBy.id === S.me.id ? 'You' : n.updatedBy.name)}</dd>` : ''}
    <dt>Version</dt><dd>${n.version}</dd>
    <dt>Shared</dt><dd>${n.shareCount ? `${n.shareCount} people` : 'No'}</dd>
    <dt>Published</dt><dd>${pub}</dd>`;
}

// outline / link-card navigation inside the info pane
$('#info-pane').addEventListener('click', (e) => {
  const a = e.target.closest('#outline a');
  if (!a) return;
  e.preventDefault();
  const n = S.notes.get(S.currentId);
  if (effectiveMode(n) !== 'edit') {
    $('h1,h2,h3,h4,h5,h6', viewEl())[Number(a.dataset.h)]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else {
    const line = Number(a.dataset.line);
    const pos = el.text.value.split('\n').slice(0, line).join('\n').length + (line ? 1 : 0);
    el.text.focus();
    el.text.setSelectionRange(pos, pos);
    el.text.scrollTop = (line * parseFloat(getComputedStyle(el.text).lineHeight)) - 40;
  }
});

// ============================================================ notes CRUD
async function createNote({ title = '', content = '', notebook, open = true } = {}) {
  const nb = notebook ?? S.activeFolder;
  try {
    const { note } = await post('/api/notes', { title, content, notebook: nb });
    S.notes.set(note.id, note);
    S.rev++;
    if (open) await openNote(note.id, { focus: title ? 'text' : 'title' });
    else renderAll();
    return note;
  } catch (err) {
    toast(err.message, 'error');
    throw err;
  }
}

async function dailyNote() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  const title = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const existing = [...S.notes.values()].find((n) => n.role === 'owner' && !n.trashed && n.title === title);
  if (existing) return openNote(existing.id);
  const content = `## Tasks\n- [ ] \n\n## Notes\n\n\n---\n#daily`;
  const note = await createNote({ title, content, notebook: 'Daily', open: false });
  openNote(note.id, { focus: 'text' });
}

async function trashNote(id) {
  const n = S.notes.get(id);
  try {
    const { note } = await put(`/api/notes/${id}`, { trashed: true });
    upsert(note);
    if (S.currentId === id) closeEditor();
    toast(`Moved “${n.title || 'Untitled'}” to trash`);
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function purgeNote(id) {
  const n = S.notes.get(id);
  if (!(await confirmDialog(`Permanently delete “${n.title || 'Untitled'}”? This cannot be undone.`, { okText: 'Delete forever', danger: true }))) return;
  try {
    await del(`/api/notes/${id}`);
    S.notes.delete(id);
    S.rev++;
    if (S.currentId === id) closeEditor();
    else renderAll();
    toast('Note deleted');
  } catch (err) {
    toast(err.message, 'error');
  }
}

function openMoreMenu(anchor) {
  const n = S.notes.get(S.currentId);
  if (!n) return;
  const items = [];
  if (canEdit(n) || n.role === 'owner') {
    items.push({ label: 'Duplicate', icon: 'duplicate', action: () => createNote({ title: `${n.title || 'Untitled'} (copy)`, content: el.text.value, notebook: n.role === 'owner' ? n.notebook : '' }) });
  }
  if (n.role === 'owner' && !n.trashed) {
    if (isMobile()) {
      items.push({ label: n.pinned ? 'Unpin' : 'Pin', icon: 'pin', action: () => updateMeta({ pinned: !n.pinned }, n.pinned ? 'Unpinned' : 'Pinned') });
    }
    items.push({ label: n.publication ? 'Publish settings' : 'Publish to the web', icon: 'globe', action: () => openPublish(n.id) });
    if (!n.publication?.hasPin) items.push({ label: 'Publish with PIN', icon: 'lock', action: () => openPublish(n.id, { withPin: true }) });
  }
  if (isMobile()) items.push({ label: 'Version history', icon: 'clock', action: () => openHistory(n.id) });
  items.push('sep');
  items.push({ label: 'Export as Markdown', icon: 'download', action: () => download(`${(n.title || 'Untitled').replace(/[\\/:*?"<>|]/g, '_')}.md`, `# ${n.title}\n\n${el.text.value}`) });
  items.push({ label: 'Copy link to note', icon: 'link', action: () => copyText(`${location.origin}/#/note/${n.id}`) });
  items.push({ label: 'Copy [[wikilink]]', icon: 'wikilink', action: () => copyText(`[[${n.title}]]`) });
  items.push('sep');
  if (n.role === 'owner') {
    if (n.trashed) {
      items.push({ label: 'Restore from trash', icon: 'restore', action: () => updateMeta({ trashed: false }, 'Note restored') });
      items.push({ label: 'Delete forever', icon: 'trash', danger: true, action: () => purgeNote(n.id) });
    } else {
      items.push({ label: 'Move to trash', icon: 'trash', danger: true, action: () => trashNote(n.id) });
    }
  } else {
    items.push({ label: 'Leave shared note', icon: 'logout', danger: true, action: () => leaveNote(n.id) });
  }
  popupMenu(anchor, items);
}

async function leaveNote(id) {
  if (!(await confirmDialog('Remove yourself from this shared note?', { okText: 'Leave', danger: true }))) return;
  await del(`/api/notes/${id}/shares/${S.me.id}`).catch((e) => toast(e.message, 'error'));
  S.notes.delete(id);
  S.rev++;
  closeEditor();
}

// ============================================================ sidebar events
const isMobile = () => window.innerWidth <= 860;

$('.sb-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-view]');
  if (b) setView(b.dataset.view);
});
$('#btn-new').addEventListener('click', () => createNote());
$('#btn-tab-new').addEventListener('click', () => createNote());
$('#btn-daily').addEventListener('click', dailyNote);
$('#btn-graph').addEventListener('click', openGraph);
$('#btn-new-folder').addEventListener('click', async () => {
  const name = await promptDialog('New folder', { placeholder: 'e.g. Work or Work/Projects', okText: 'Create' });
  if (!name) return;
  const nb = name.replace(/^\/+|\/+$/g, '');
  S.activeFolder = nb;
  await createNote({ notebook: nb });
});
$('#btn-sort').addEventListener('click', (e) => {
  const opt = (key, label) => ({ label, icon: S.sort === key ? 'check' : 'minus', action: () => { S.sort = key; localStorage.setItem('allnote-sort', key); renderTree(); } });
  popupMenu(e.currentTarget, [opt('title', 'File name (A to Z)'), opt('updated', 'Modified time (new to old)'), opt('created', 'Created time (new to old)')]);
});
$('#btn-collapse-all').addEventListener('click', () => {
  S.expanded.clear();
  saveExpanded();
  renderTree();
});

$('#tree').addEventListener('click', (e) => {
  const row = e.target.closest('.row');
  if (!row) return;
  e.preventDefault();
  if (row.dataset.id) return openNote(row.dataset.id);
  const key = row.dataset.folder;
  if (S.expanded.has(key)) S.expanded.delete(key);
  else S.expanded.add(key);
  if (!key.startsWith('@')) S.activeFolder = key;
  saveExpanded();
  renderTree();
});
$('#tree').addEventListener('contextmenu', (e) => {
  const row = e.target.closest('.row');
  if (!row) return;
  e.preventDefault();
  const key = row.dataset.folder;
  if (key && !key.startsWith('@')) {
    popupMenu(row, [
      { label: 'New note here', icon: 'plus', action: () => { S.activeFolder = key; createNote({ notebook: key }); } },
      { label: 'Rename folder', icon: 'edit', action: () => renameNotebook(key) },
    ]);
  } else if (row.dataset.id) {
    const n = S.notes.get(row.dataset.id);
    const items = [{ label: 'Open', icon: 'notes', action: () => openNote(n.id) }, { label: 'Copy [[wikilink]]', icon: 'wikilink', action: () => copyText(`[[${n.title}]]`) }];
    if (n.role === 'owner' && !n.trashed) {
      items.push({ label: n.pinned ? 'Unpin' : 'Pin', icon: 'pin', action: async () => { const { note } = await put(`/api/notes/${n.id}`, { pinned: !n.pinned }); upsert(note); if (S.currentId === n.id) applyRoleUI(); } });
      items.push({ label: n.publication ? 'Publish settings' : 'Publish to the web', icon: 'globe', action: () => openPublish(n.id) });
      if (!n.publication?.hasPin) items.push({ label: 'Publish with PIN', icon: 'lock', action: () => openPublish(n.id, { withPin: true }) });
      items.push('sep', { label: 'Move to trash', icon: 'trash', danger: true, action: () => trashNote(n.id) });
    }
    popupMenu(row, items);
  }
});

$('#search').addEventListener('input', (e) => {
  S.query = e.target.value;
  renderSearch();
});
$('#search-results').addEventListener('click', (e) => {
  const r = e.target.closest('.result');
  if (!r) return;
  e.preventDefault();
  openNote(r.dataset.id);
});

$('#tabs').addEventListener('click', (e) => {
  const x = e.target.closest('[data-close-tab]');
  if (x) return closeTab(x.dataset.closeTab);
  const t = e.target.closest('.tab');
  if (t) openNote(t.dataset.tab);
});
$('#tabs').addEventListener('auxclick', (e) => {
  const t = e.target.closest('.tab');
  if (t && e.button === 1) closeTab(t.dataset.tab);
});

async function renameNotebook(path) {
  const name = await promptDialog('Rename folder', { value: path, okText: 'Rename' });
  if (!name || name === path) return;
  const target = name.replace(/^\/+|\/+$/g, '');
  const affected = [...S.notes.values()].filter((n) => n.role === 'owner' && (n.notebook === path || n.notebook.startsWith(`${path}/`)));
  await Promise.all(affected.map(async (n) => {
    const { note } = await put(`/api/notes/${n.id}`, { notebook: target + n.notebook.slice(path.length) });
    upsert(note);
  }));
  if (S.expanded.delete(path)) S.expanded.add(target);
  saveExpanded();
  if (S.activeFolder === path) S.activeFolder = target;
  if (S.currentId) applyRoleUI();
  renderAll();
  toast(`Renamed to ${target}`);
}

function toggleSidebar() {
  if (isMobile()) {
    el.app.classList.toggle('nav-open');
    return;
  }
  const collapsed = el.app.classList.toggle('sb-collapsed');
  localStorage.setItem('allnote-sidebar', collapsed ? '0' : '1');
}
$('#btn-collapse').addEventListener('click', toggleSidebar);
$('#btn-menu').addEventListener('click', toggleSidebar);
$('#scrim').addEventListener('click', () => $('#app').classList.remove('nav-open'));

$('#btn-logout').addEventListener('click', async () => {
  await flushSave();
  await post('/api/auth/logout').catch(() => {});
  location.href = '/';
});
$('#btn-account').addEventListener('click', openAccount);
$('#btn-settings').addEventListener('click', openAccount);
$('.empty-actions').addEventListener('click', (e) => {
  const a = e.target.closest('a');
  if (!a) return;
  e.preventDefault();
  if (a.id === 'empty-new') createNote();
  if (a.id === 'empty-switch') openSwitcher();
  if (a.id === 'empty-daily') dailyNote();
});

document.addEventListener('keydown', (e) => {
  if (!S.me || $('#modal-root').children.length) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (mod && (k === 'k' || k === 'p') && !e.shiftKey) { e.preventDefault(); openSwitcher(); }
  else if (e.altKey && k === 'n') { e.preventDefault(); createNote(); }
  else if (mod && k === 's') { e.preventDefault(); save(); }
  else if (mod && k === 'e' && S.currentId) { e.preventDefault(); setMode(S.mode === 'preview' ? 'live' : 'preview'); }
});

window.addEventListener('hashchange', route);
function route() {
  const m = /^#\/note\/([\w-]+)/.exec(location.hash);
  if (m && S.notes.has(m[1]) && S.currentId !== m[1]) openNote(m[1]);
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) save();
});
setInterval(() => {
  if (S.currentId) renderStatusMeta();
}, 30_000);

// ============================================================ quick switcher
function openSwitcher() {
  const m = modal({ cls: 'switcher', body: '<input placeholder="Find or create a note…" autofocus autocomplete="off"><div class="switcher-list"></div>' });
  m.el.querySelector('.modal-body').style.padding = '0';
  const input = m.el.querySelector('input');
  const listEl = m.el.querySelector('.switcher-list');
  let items = [];
  let active = 0;
  const score = (title, q) => {
    const t = title.toLowerCase();
    if (!q) return 1;
    if (t.startsWith(q)) return 100 - t.length / 100;
    if (t.includes(q)) return 50 - t.length / 100;
    let i = 0;
    for (const ch of t) if (ch === q[i]) i++;
    return i === q.length ? 10 : 0;
  };
  const render = () => {
    const q = input.value.trim().toLowerCase();
    items = [...S.notes.values()].filter((n) => !n.trashed)
      .map((n) => ({ n, s: score(n.title || 'Untitled', q) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || b.n.updatedAt - a.n.updatedAt)
      .slice(0, 30)
      .map((x) => ({ id: x.n.id, title: x.n.title || 'Untitled', hint: x.n.role === 'owner' ? x.n.notebook : `shared by ${x.n.owner.name}` }));
    if (q && !items.some((x) => x.title.toLowerCase() === q)) items.push({ create: input.value.trim(), title: `Create “${input.value.trim()}”`, hint: 'new note' });
    active = Math.min(active, Math.max(0, items.length - 1));
    listEl.innerHTML = items.map((it, i) => `<a data-i="${i}" class="${i === active ? 'active' : ''}">${icon(it.create ? 'plus' : 'notes', 16)}<span>${esc(it.title)}</span><small>${esc(it.hint || '')}</small></a>`).join('')
      || '<div class="list-empty">No notes yet</div>';
    listEl.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  };
  const pick = (i) => {
    const it = items[i];
    if (!it) return;
    m.close();
    if (it.create) createNote({ title: it.create });
    else openNote(it.id);
  };
  input.addEventListener('input', () => { active = 0; render(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % Math.max(1, items.length);
      render();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(active);
    }
  });
  listEl.addEventListener('click', (e) => {
    const a = e.target.closest('[data-i]');
    if (a) pick(Number(a.dataset.i));
  });
  render();
}

// ============================================================ graph view
function openGraph() {
  const m = modal({
    title: 'Graph view',
    cls: 'wide',
    body: `<div class="row" style="gap:18px;flex-wrap:wrap">
        <label class="switch"><input type="checkbox" id="g-tags"> Show tags</label>
        <label class="switch"><input type="checkbox" id="g-local" ${S.currentId ? '' : 'disabled'}> Only around current note</label>
        <span class="muted" style="margin-left:auto;font-size:12px">Drag to move · scroll to zoom · click a note to open</span>
      </div>`,
    onClose: () => destroy?.(),
  });
  m.el.querySelector('.modal-body').style.flex = '0 0 auto';
  const wrapEl = h('<div class="graph-wrap"><canvas></canvas></div>');
  m.el.append(wrapEl);
  let destroy = null;
  const build = () => {
    destroy?.();
    index();
    const showTags = $('#g-tags', m.el).checked;
    const local = $('#g-local', m.el).checked && S.currentId;
    let notes = [...S.notes.values()].filter((n) => !n.trashed);
    const edges = [];
    for (const n of notes) {
      for (const t of n._links) {
        const target = resolveTitle(t);
        if (target && target.id !== n.id) edges.push([n.id, target.id]);
      }
      if (showTags) n._tags.forEach((t) => edges.push([n.id, `tag:${t}`]));
    }
    let nodes = notes.map((n) => ({ id: n.id, label: n.title || 'Untitled', kind: 'note' }));
    if (showTags) nodes.push(...[...index().tags.keys()].map((t) => ({ id: `tag:${t}`, label: `#${t}`, kind: 'tag' })));
    if (local) {
      const keep = new Set([S.currentId]);
      for (let depth = 0; depth < 2; depth++) {
        for (const [a, b] of edges) {
          if (keep.has(a)) keep.add(b);
          else if (keep.has(b)) keep.add(a);
        }
      }
      nodes = nodes.filter((x) => keep.has(x.id));
    }
    destroy = createGraph(wrapEl.querySelector('canvas'), {
      nodes,
      edges: edges.filter(([a, b]) => nodes.some((x) => x.id === a) && nodes.some((x) => x.id === b)),
      currentId: S.currentId,
      onOpen: (id) => { m.close(); openNote(id); },
    });
  };
  m.el.querySelectorAll('input[type=checkbox]').forEach((c) => c.addEventListener('change', build));
  requestAnimationFrame(build);
}

// ============================================================ share
async function openShare(id) {
  const n = S.notes.get(id);
  const owner = n.role === 'owner';
  const m = modal({
    title: `Share “${n.title || 'Untitled'}”`,
    body: `${owner ? `<form class="row" id="share-form">
          <input name="email" type="email" placeholder="Invite by email" required autofocus>
          <select name="role"><option value="editor">Can edit</option><option value="viewer">Can view</option></select>
          <button class="btn primary">Invite</button></form>
          <p class="muted" style="font-size:12.5px;margin:8px 0 0">People must have an account. Everyone with access sees edits live and can edit at the same time.</p>` : ''}
        <div class="section-title">People with access</div><div class="people" id="people"><span class="muted">Loading…</span></div>`,
    foot: `${owner ? '' : '<button class="btn danger" id="leave">Leave note</button>'}<button class="btn" data-close>Done</button>`,
  });
  const load = async () => {
    try {
      const { owner: o, shares } = await get(`/api/notes/${id}/shares`);
      $('#people', m.el).innerHTML = `<div class="person">${avatarHtml(o)}<div class="who"><b>${esc(o.name)}${o.id === S.me.id ? ' (you)' : ''}</b><small>${esc(o.email)}</small></div><span class="muted">Owner</span></div>`
        + shares.map((s) => `<div class="person">${avatarHtml(s)}<div class="who"><b>${esc(s.name)}${s.id === S.me.id ? ' (you)' : ''}</b><small>${esc(s.email)}</small></div>
          ${owner ? `<select data-role="${s.id}" data-email="${esc(s.email)}"><option value="editor" ${s.role === 'editor' ? 'selected' : ''}>Can edit</option><option value="viewer" ${s.role === 'viewer' ? 'selected' : ''}>Can view</option></select>
          <button class="icon-btn" data-remove="${s.id}" title="Remove">${icon('x', 16)}</button>` : `<span class="muted">${s.role === 'editor' ? 'Can edit' : 'Can view'}</span>`}</div>`).join('');
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  $('#share-form', m.el)?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.target));
    try {
      await post(`/api/notes/${id}/shares`, d);
      e.target.reset();
      toast(`Shared with ${d.email}`);
      load();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  m.el.addEventListener('change', async (e) => {
    const sel = e.target.closest('[data-role]');
    if (!sel) return;
    await post(`/api/notes/${id}/shares`, { email: sel.dataset.email, role: sel.value }).catch((err) => toast(err.message, 'error'));
    toast('Permission updated');
  });
  m.el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-remove]');
    if (!b) return;
    await del(`/api/notes/${id}/shares/${b.dataset.remove}`).catch((err) => toast(err.message, 'error'));
    load();
  });
  $('#leave', m.el)?.addEventListener('click', () => { m.close(); leaveNote(id); });
  load();
}

// ============================================================ publish
const PIN_RE = /^[A-Za-z0-9]{4,12}$/;
const randomPin = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, '0');

function openPublish(id, { withPin = false } = {}) {
  const m = modal({ title: 'Publish to the web', cls: 'publish-modal', body: '<div id="pub"></div>', foot: '<div id="pub-foot" class="pub-foot"></div>' });
  let access = S.notes.get(id).publication?.hasPin || withPin ? 'pin' : 'public';
  let lastPin = '';

  const accessCards = (p) => `
    <div class="access" role="radiogroup" aria-label="Who can view">
      <label class="access-opt ${access === 'public' ? 'on' : ''}"><input type="radio" name="access" value="public" ${access === 'public' ? 'checked' : ''}>
        ${icon('globe', 20)}<span><b>Anyone with the link</b><small>No PIN needed</small></span></label>
      <label class="access-opt ${access === 'pin' ? 'on' : ''}"><input type="radio" name="access" value="pin" ${access === 'pin' ? 'checked' : ''}>
        ${icon('lock', 20)}<span><b>Protected with a PIN</b><small>${p?.hasPin ? 'PIN is set' : 'Visitors must enter a PIN'}</small></span></label>
    </div>`;

  const pinField = (p) => access !== 'pin' ? '' : `
    <form id="pub-pin" class="pin-field">
      <label for="pin-input">${p?.hasPin ? 'Change PIN' : 'PIN'} <small class="muted">4–12 letters or digits</small></label>
      <div class="pin-row">
        <input id="pin-input" name="pin" type="password" inputmode="text" autocomplete="new-password" value="${p ? '' : esc(lastPin)}" placeholder="${p?.hasPin ? '••••••' : 'e.g. 482915'}" ${p ? '' : 'autofocus'}>
        <button type="button" class="icon-btn" id="pin-show" title="Show PIN">${icon('eye', 18)}</button>
        <button type="button" class="btn sm" id="pin-gen">Generate</button>
      </div>
      ${p ? `<button class="btn primary block" id="pin-save">${p.hasPin ? 'Update PIN' : 'Turn on PIN'}</button>` : ''}
    </form>`;

  const render = () => {
    const n = S.notes.get(id);
    const p = n.publication;
    const url = p ? `${location.origin}/p/${p.slug}` : '';
    if (!p) {
      $('#pub', m.el).innerHTML = `
        <p class="muted pub-intro">Create a read-only web page of <b>${esc(n.title || 'Untitled')}</b>. It always shows the latest version.</p>
        <div class="section-title">Who can view</div>
        ${accessCards(null)}${pinField(null)}`;
      $('#pub-foot', m.el).innerHTML = `<button class="btn" data-close>Cancel</button><button class="btn primary" id="pub-go">${icon(access === 'pin' ? 'lock' : 'globe', 16)} ${access === 'pin' ? 'Publish with PIN' : 'Publish'}</button>`;
    } else {
      $('#pub', m.el).innerHTML = `
        <div class="pub-status">${icon(p.hasPin ? 'lock' : 'globe', 18)}<span><b>Published</b> · ${p.hasPin ? 'PIN protected' : 'anyone with the link can view'}</span></div>
        <div class="section-title">Link</div>
        <div class="copybox"><input readonly value="${esc(url)}" aria-label="Public link"><div class="copy-actions"><button class="btn" id="pub-copy">${icon('copy', 15)} Copy</button><a class="btn" href="${esc(url)}" target="_blank" rel="noopener">${icon('external', 15)} Open</a></div></div>
        ${lastPin ? `<div class="pin-share">${icon('lock', 16)}<span>PIN: <b class="mono">${esc(lastPin)}</b> — share it separately or</span><button class="btn sm" id="pub-copy-both">${icon('copy', 14)} Copy link + PIN</button></div>` : ''}
        <div class="section-title">Who can view</div>
        ${accessCards(p)}${pinField(p)}
        <details class="pub-more"><summary>Custom link</summary>
          <form class="row" id="pub-slug"><span class="muted">/p/</span><input name="slug" value="${esc(p.slug)}" pattern="[a-z0-9][a-z0-9-]{2,63}" title="3-64 lowercase letters, digits or dashes" autocapitalize="off"><button class="btn">Save</button></form>
        </details>`;
      $('#pub-foot', m.el).innerHTML = '<button class="btn danger" id="pub-off">Unpublish</button><button class="btn primary" data-close>Done</button>';
    }
    $$('[data-close]', m.el).forEach((b) => { b.onclick = m.close; });
  };

  const send = async (body, msg) => {
    try {
      const { note } = await put(`/api/notes/${id}/publish`, body);
      upsert(note);
      if (S.currentId === id) applyRoleUI();
      render();
      if (msg) toast(msg);
      return true;
    } catch (err) {
      toast(err.message, 'error');
      return false;
    }
  };

  const readPin = () => {
    const pin = ($('#pin-input', m.el)?.value || '').trim();
    if (!PIN_RE.test(pin)) {
      toast('PIN must be 4–12 letters or digits', 'error');
      $('#pin-input', m.el)?.focus();
      return null;
    }
    return pin;
  };

  m.el.addEventListener('change', async (e) => {
    if (e.target.name !== 'access') return;
    access = e.target.value;
    const p = S.notes.get(id).publication;
    if (p && access === 'public' && p.hasPin) {
      lastPin = '';
      await send({ published: true, pin: null }, 'PIN removed — the link is now public');
    } else {
      render();
      if (access === 'pin') $('#pin-input', m.el)?.focus();
    }
  });

  m.el.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (e.target.id === 'pub-slug') send({ published: true, slug: new FormData(e.target).get('slug') }, 'Link updated');
    if (e.target.id === 'pub-pin' && S.notes.get(id).publication) {
      const pin = readPin();
      if (pin && await send({ published: true, pin }, 'PIN saved — earlier visitors must enter it again')) {
        lastPin = pin;
        render();
      }
    }
  });

  m.el.addEventListener('click', async (e) => {
    const t = e.target.closest('button, a');
    if (!t) return;
    if (t.id === 'pin-gen') {
      const input = $('#pin-input', m.el);
      input.value = randomPin();
      input.type = 'text';
    }
    if (t.id === 'pin-show') {
      const input = $('#pin-input', m.el);
      input.type = input.type === 'password' ? 'text' : 'password';
    }
    if (t.id === 'pub-go') {
      const body = { published: true };
      if (access === 'pin') {
        const pin = readPin();
        if (!pin) return;
        body.pin = pin;
        lastPin = pin;
      }
      if (!(await send(body, access === 'pin' ? 'Published with PIN' : 'Published'))) lastPin = '';
      else render();
    }
    if (t.id === 'pub-copy') copyText($('.copybox input', m.el).value);
    if (t.id === 'pub-copy-both') copyText(`${$('.copybox input', m.el).value}\nPIN: ${lastPin}`);
    if (t.id === 'pub-off' && await confirmDialog('Unpublish this note? The public link will stop working.', { okText: 'Unpublish', danger: true })) {
      lastPin = '';
      access = 'public';
      send({ published: false }, 'Unpublished');
    }
  });
  render();
}

// ============================================================ history
async function openHistory(id) {
  const n = S.notes.get(id);
  const m = modal({ title: 'Version history', cls: 'wide', body: '' });
  m.el.querySelector('.modal-body').remove();
  const wrapEl = h(`<div class="history"><div class="history-list"></div><div class="history-view"><div class="row" style="padding:12px 20px;border-bottom:1px solid var(--border)"><b id="hv-title" style="flex:1"></b><button class="btn primary sm hidden" id="hv-restore">${icon('restore', 14)} Restore this version</button></div><article class="markdown" id="hv-body"></article></div></div>`);
  m.el.append(wrapEl);
  let versions = [];
  try {
    versions = (await get(`/api/notes/${id}/history`)).history;
  } catch (err) {
    toast(err.message, 'error');
  }
  const all = [{ id: 'current', title: el.title.value, content: el.text.value, createdAt: n.updatedAt, author: n.updatedBy?.name, version: n.version, current: true }, ...versions];
  const list = $('.history-list', wrapEl);
  list.innerHTML = all.map((v, i) => `<a data-i="${i}">${v.current ? '<b>Current version</b>' : `<b>${fmtDate(v.createdAt)}</b>`}<small>v${v.version}${v.author ? ` · ${esc(v.author)}` : ''}</small></a>`).join('');
  const show = (i) => {
    $$('a', list).forEach((a) => a.classList.toggle('active', Number(a.dataset.i) === i));
    const v = all[i];
    $('#hv-title', wrapEl).textContent = v.title || 'Untitled';
    renderInto($('#hv-body', wrapEl), v.content, { resolve: resolveTitle });
    const btn = $('#hv-restore', wrapEl);
    btn.classList.toggle('hidden', v.current || !canEdit(S.notes.get(id)));
    btn.onclick = () => {
      if (S.currentId !== id) return;
      el.title.value = v.title;
      el.text.value = v.content;
      markDirty();
      renderPreview();
      m.close();
      toast('Version restored');
    };
  };
  list.addEventListener('click', (e) => {
    const a = e.target.closest('[data-i]');
    if (a) show(Number(a.dataset.i));
  });
  show(versions.length ? 1 : 0);
  if (!versions.length) list.insertAdjacentHTML('beforeend', '<div class="list-empty">Older versions appear here as the note changes.</div>');
}

// ============================================================ account & 2FA
function openAccount() {
  const m = modal({ title: 'Account & security', body: '<div id="acct"></div>', foot: '<button class="btn" data-close>Close</button>' });
  const render = () => {
    const u = S.me;
    $('#acct', m.el).innerHTML = `
      <div class="row" style="gap:14px;margin-bottom:6px">${avatarHtml(u)}<div><b>${esc(u.email)}</b><br><small class="muted">Sign-in: ${[u.hasPassword && 'password', u.google && 'Google'].filter(Boolean).join(' + ') || '—'}</small></div></div>
      <div class="section-title">Profile</div>
      <form class="row" id="f-name"><input name="name" value="${esc(u.name)}" required maxlength="80"><button class="btn">Save</button></form>
      <div class="section-title">${u.hasPassword ? 'Change password' : 'Set a password'}</div>
      <form class="stack" id="f-pass">
        ${u.hasPassword ? '<input name="currentPassword" type="password" placeholder="Current password" autocomplete="current-password" required>' : ''}
        <div class="row"><input name="newPassword" type="password" placeholder="New password (min 8 characters)" minlength="8" autocomplete="new-password" required><button class="btn">${u.hasPassword ? 'Change' : 'Set'}</button></div>
      </form>
      <div class="section-title">${icon('shield', 18)} Two-factor authentication</div>
      <div id="tfa">${u.twoFactorEnabled
        ? `<div class="card"><p style="margin:0 0 10px"><b style="color:var(--ok)">Enabled.</b> A code from your authenticator app is required at sign-in.</p>
           <form class="row" id="f-2fa-off"><input name="code" inputmode="numeric" placeholder="Current 6-digit code" required autocomplete="one-time-code"><button class="btn danger">Disable 2FA</button></form></div>`
        : `<div class="card"><p style="margin:0 0 10px">Protect your account with an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Authy…).</p><button class="btn primary" id="tfa-start">Enable 2FA</button></div>`}</div>
      <div class="section-title">Data</div>
      <div class="row" style="flex-wrap:wrap">
        <button class="btn" id="exp-all">${icon('download', 15)} Export all notes (JSON)</button>
        <label class="btn">${icon('upload', 15)} Import Markdown files<input type="file" id="imp" accept=".md,.markdown,.txt" multiple hidden></label>
      </div>
      ${!u.isAdmin && u.expiresAt ? `<div class="section-title">${icon('ticket', 18)} Account validity</div>
      <div class="card stack"><p style="margin:0">Your account is valid until <b>${esc(new Date(u.expiresAt).toLocaleDateString(undefined, { dateStyle: 'long' }))}</b>${u.expiresAt - Date.now() < 7 * 86400000 ? ' <span class="status warn">expires soon</span>' : ''}. Redeem a license key to extend it.</p>
        <form class="row" id="f-license"><input name="key" placeholder="XXXXX-XXXXX-XXXXX-XXXXX" required autocomplete="off" spellcheck="false"><button class="btn">${icon('ticket', 15)} Redeem</button></form></div>` : ''}
      <div class="section-title">${icon('help', 18)} Help</div>
      <div class="row" style="flex-wrap:wrap">
        <button class="btn" id="acct-tour">${icon('compass', 15)} Take the tour again</button>
        <button class="btn" id="acct-keys">${icon('keyboard', 15)} Keyboard shortcuts</button>
        ${u.isAdmin ? `<button class="btn" id="acct-admin">${icon('admin', 15)} Open admin console</button>` : ''}
      </div>
      <p class="muted small" style="margin:16px 0 0">${esc(S.config.appName)} v${esc(S.config.version || '')}</p>`;
  };
  const updateMe = (user) => {
    S.me = user;
    renderMe();
    render();
  };
  m.el.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const d = Object.fromEntries(new FormData(f));
    try {
      if (f.id === 'f-name') { updateMe((await put('/api/account', d)).user); toast('Name updated'); }
      if (f.id === 'f-pass') { updateMe((await post('/api/account/password', d)).user); toast('Password saved; other sessions were signed out'); }
      if (f.id === 'f-2fa-off') { updateMe((await post('/api/account/2fa/disable', d)).user); toast('Two-factor authentication disabled'); }
      if (f.id === 'f-license') {
        const r = await post('/api/account/license', d);
        updateMe(r.user);
        scheduleExpiryCheck();
        toast(`License redeemed: valid until ${new Date(r.user.expiresAt).toLocaleDateString()}`);
      }      if (f.id === 'f-2fa-on') {
        const r = await post('/api/account/2fa/enable', d);
        S.me = r.user;
        renderMe();
        $('#tfa', m.el).innerHTML = `<div class="card"><p style="margin:0 0 10px"><b style="color:var(--ok)">2FA is now enabled.</b> Save these one-time recovery codes somewhere safe — each can be used once if you lose your phone.</p>
          <div class="codes">${r.recoveryCodes.map((c) => `<span>${esc(c)}</span>`).join('')}</div>
          <div class="row" style="margin-top:10px"><button class="btn" id="codes-dl">${icon('download', 15)} Download</button><button class="btn" id="codes-cp">${icon('copy', 15)} Copy</button></div></div>`;
        m.el.querySelector('#codes-dl').onclick = () => download('allnote-recovery-codes.txt', r.recoveryCodes.join('\n'), 'text/plain');
        m.el.querySelector('#codes-cp').onclick = () => copyText(r.recoveryCodes.join('\n'));
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  m.el.addEventListener('click', async (e) => {
    if (e.target.closest('#acct-tour')) { m.close(); runTour(); return; }
    if (e.target.closest('#acct-keys')) { openShortcuts(); return; }
    if (e.target.closest('#acct-admin')) { m.close(); $('#btn-admin').click(); return; }    if (e.target.closest('#tfa-start')) {
      try {
        const r = await post('/api/account/2fa/setup');
        $('#tfa', m.el).innerHTML = `<div class="card stack">
          <div class="qr"><img src="${r.qr}" alt="QR code"><div><b>1.</b> Scan this QR code with your authenticator app.<br><br><small class="muted">Can't scan? Enter this key:</small><br><code style="word-break:break-all">${esc(r.secret)}</code></div></div>
          <form class="row" id="f-2fa-on"><input name="code" inputmode="numeric" placeholder="2. Enter the 6-digit code" required autocomplete="one-time-code" autofocus><button class="btn primary">Verify & enable</button></form></div>`;
        m.el.querySelector('#f-2fa-on input').focus();
      } catch (err) {
        toast(err.message, 'error');
      }
    }
    if (e.target.closest('#exp-all')) {
      const data = [...S.notes.values()].filter((n) => n.role === 'owner').map(({ id, title, content, notebook, pinned, trashed, createdAt, updatedAt }) => ({ id, title, content, notebook, pinned, trashed, createdAt, updatedAt }));
      download(`allnote-export-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 2), 'application/json');
    }
  });
  m.el.addEventListener('change', async (e) => {
    if (e.target.id !== 'imp') return;
    const files = [...e.target.files];
    for (const f of files) {
      let content = await f.text();
      let title = f.name.replace(/\.(md|markdown|txt)$/i, '');
      const hm = /^#\s+(.+)\n+/.exec(content);
      if (hm) { title = hm[1].trim(); content = content.slice(hm[0].length); }
      await createNote({ title, content, notebook: 'Imported', open: false });
    }
    toast(`Imported ${files.length} note(s) into “Imported”`);
  });
  render();
}
