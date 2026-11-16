import { get, post, put, del, clientId } from './api.js';
import { hydrateIcons, icon } from './icons.js';
import {
  renderInto, extractTags, extractLinks, extractHeadings, plainText, wordCount, toggleTask, escapeHtml as esc,
} from './markdown.js';
import { merge3, mapOffset } from './merge.js';
import { createGraph } from './graph.js';
import {
  $, $$, h, toast, modal, confirmDialog, promptDialog, popupMenu, avatarHtml, timeAgo, fmtDate, copyText, download,
} from './ui.js';

// ============================================================ state
const S = {
  config: {},
  me: null,
  notes: new Map(),
  filter: { type: 'all', value: null },
  query: '',
  sort: localStorage.getItem('allnote-sort') || 'updated',
  mode: localStorage.getItem('allnote-mode') || 'split',
  currentId: null,
  sync: null, // { id, base, baseTitle, version, dirty, saving, timer }
  presence: new Map(), // noteId -> Map(key -> { user, state, ts })
  rev: 0,
};

const el = {};
const isWide = () => window.innerWidth > 1440;

// ============================================================ boot
hydrateIcons();
boot();

async function boot() {
  S.config = await get('/api/config').catch(() => ({ appName: 'AllNote' }));
  document.title = S.config.appName;
  $$('.app-name').forEach((n) => { n.textContent = S.config.appName; });
  const me = await get('/api/auth/me').catch(() => ({ user: null }));
  const err = new URLSearchParams(location.search).get('error');
  if (err) history.replaceState(null, '', location.pathname + location.hash);
  if (me.user) return startApp(me.user);
  showAuth(me.twoFactorRequired ? '2fa' : 'login', err);
}

// ============================================================ auth screen
function showAuth(mode = 'login', error = '') {
  $('#app').classList.add('hidden');
  $('#auth').classList.remove('hidden');
  ['login', 'register', 'twofa'].forEach((m) => $(`#${m}-form`).classList.toggle('hidden', m !== (mode === '2fa' ? 'twofa' : mode)));
  $('#google-block').classList.toggle('hidden', !S.config.google || mode === '2fa');
  const errBox = $('#auth-error');
  errBox.textContent = error || '';
  errBox.classList.toggle('hidden', !error);
  const sw = $('#auth-switch');
  if (mode === 'login') sw.innerHTML = S.config.allowSignup ? 'No account yet? <a href="#" data-go="register">Create one</a>' : '';
  else if (mode === 'register') sw.innerHTML = 'Already have an account? <a href="#" data-go="login">Sign in</a>';
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
authSubmit($('#register-form'), async (d) => afterLogin(await post('/api/auth/register', d)));
authSubmit($('#twofa-form'), async (d) => startApp((await post('/api/auth/2fa', d)).user));
$('#twofa-cancel').addEventListener('click', async () => {
  await post('/api/auth/logout').catch(() => {});
  showAuth('login');
});

// ============================================================ app start
async function startApp(user) {
  S.me = user;
  $('#auth').classList.add('hidden');
  $('#app').classList.remove('hidden');
  Object.assign(el, {
    app: $('#app'), list: $('#note-list'), title: $('#ed-title'), text: $('#ed-text'), preview: $('#ed-preview'),
    notebook: $('#ed-notebook'), body: $('#ed-body'), editor: $('#editor'), empty: $('#empty-state'), info: $('#info-pane'),
    search: $('#search'), banner: $('#ed-banner'), save: $('#st-save'),
  });
  renderMe();
  el.info.classList.toggle('collapsed', localStorage.getItem('allnote-info') === '0' || !isWide());
  $('#sort').value = S.sort;
  await loadNotes();
  connectEvents();
  renderAll();
  route();
}

function renderMe() {
  $('#me-avatar').outerHTML = `<span id="me-avatar">${avatarHtml(S.me)}</span>`;
  $('#me-name').textContent = S.me.name;
}

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
  let connectedOnce = false;
  es.addEventListener('open', () => {
    if (connectedOnce) loadNotes().then(renderAll).catch(() => {}); // catch up after reconnects (e.g. app updates)
    connectedOnce = true;
  });
  es.addEventListener('error', async () => {
    if (es.readyState === EventSource.CLOSED) {
      const me = await get('/api/auth/me').catch(() => null);
      if (me && !me.user) location.reload();
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
  renderSidebar();
  renderList();
  renderInfo();
}

const FILTER_NAMES = { all: 'All notes', pinned: 'Pinned', shared: 'Shared with me', published: 'Published', trash: 'Trash' };

function inFilter(n, f = S.filter) {
  if (f.type === 'trash') return n.trashed && n.role === 'owner';
  if (n.trashed) return false;
  switch (f.type) {
    case 'pinned': return n.pinned;
    case 'shared': return n.role !== 'owner';
    case 'published': return Boolean(n.publication);
    case 'notebook': return n.role === 'owner' && (n.notebook === f.value || n.notebook.startsWith(`${f.value}/`));
    case 'tag': return (n._tags || extractTags(n.content).map((t) => t.toLowerCase())).some((t) => t === f.value || t.startsWith(`${f.value}/`));
    default: return true;
  }
}

function renderSidebar() {
  const ix = index();
  const all = [...S.notes.values()];
  const counts = {
    all: all.filter((n) => inFilter(n, { type: 'all' })).length,
    pinned: all.filter((n) => inFilter(n, { type: 'pinned' })).length,
    shared: all.filter((n) => inFilter(n, { type: 'shared' })).length,
    published: all.filter((n) => inFilter(n, { type: 'published' })).length,
    trash: all.filter((n) => inFilter(n, { type: 'trash' })).length,
  };
  $$('#nav-main [data-count]').forEach((e) => { e.textContent = counts[e.dataset.count] || ''; });
  $$('#nav-main [data-filter]').forEach((a) => a.classList.toggle('active', S.filter.type === a.dataset.filter));

  // notebook tree
  const tree = {};
  for (const n of all) {
    if (n.trashed || n.role !== 'owner' || !n.notebook) continue;
    let node = tree;
    let path = '';
    for (const part of n.notebook.split('/').filter(Boolean)) {
      path = path ? `${path}/${part}` : part;
      node[part] ??= { path, count: 0, children: {} };
      node[part].count++;
      node = node[part].children;
    }
  }
  const nbHtml = (node, depth) => Object.keys(node).sort((a, b) => a.localeCompare(b)).map((k) => {
    const it = node[k];
    const active = S.filter.type === 'notebook' && S.filter.value === it.path;
    return `<a href="#" data-notebook="${esc(it.path)}" class="${active ? 'active' : ''}" style="padding-left:${8 + depth * 14}px">${icon('folder', 16)}<span>${esc(k)}</span><button class="icon-btn xs tree-act" data-rename="${esc(it.path)}" title="Rename notebook">${icon('edit', 13)}</button><em>${it.count}</em></a>${nbHtml(it.children, depth + 1)}`;
  }).join('');
  $('#nav-notebooks').innerHTML = nbHtml(tree, 0) || '<div class="muted" style="padding:2px 10px;font-size:13px">No notebooks yet</div>';
  const nbs = [...new Set(all.filter((n) => n.role === 'owner' && n.notebook).map((n) => n.notebook))].sort();
  $('#notebook-options').innerHTML = nbs.map((n) => `<option value="${esc(n)}">`).join('');

  const tags = [...ix.tags.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  $('#nav-tags').innerHTML = tags.map(([t, c]) => `<a href="#" class="chip ${S.filter.type === 'tag' && S.filter.value === t ? 'active' : ''}" data-tag="${esc(t)}">#${esc(t)} <em>${c}</em></a>`).join('')
    || '<div class="muted" style="font-size:13px;padding:0 2px">Type #tag in a note</div>';
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
    const re = new RegExp(esc(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    s = s.replace(re, (m) => `<mark>${m}</mark>`);
  }
  return s;
}

function visibleNotes() {
  index();
  const q = S.query.trim() ? parseQuery(S.query.trim()) : null;
  const list = [];
  for (const n of S.notes.values()) {
    if (!inFilter(n)) continue;
    const score = q ? searchScore(n, q) : 0;
    if (score < 0) continue;
    list.push({ n, score });
  }
  const cmp = {
    updated: (a, b) => b.n.updatedAt - a.n.updatedAt,
    created: (a, b) => b.n.createdAt - a.n.createdAt,
    title: (a, b) => (a.n.title || 'Untitled').localeCompare(b.n.title || 'Untitled'),
  }[S.sort];
  list.sort((a, b) => (q ? b.score - a.score : 0) || (b.n.pinned && !q) - (a.n.pinned && !q) || cmp(a, b));
  return { list: list.map((x) => x.n), q };
}

function renderList() {
  const { list, q } = visibleNotes();
  let title = FILTER_NAMES[S.filter.type];
  if (S.filter.type === 'notebook') title = S.filter.value.split('/').pop();
  if (S.filter.type === 'tag') title = `#${S.filter.value}`;
  $('#list-title').textContent = title;
  $('#list-count').textContent = list.length ? `${list.length}` : '';
  if (!list.length) {
    el.list.innerHTML = `<div class="list-empty">${S.query ? 'No notes match your search.' : S.filter.type === 'trash' ? 'Trash is empty.' : 'No notes here yet.'}</div>`;
    return;
  }
  el.list.innerHTML = list.map((n) => {
    const meta = [`<span>${timeAgo(n.updatedAt)}</span>`];
    if (n.notebook && n.role === 'owner') meta.push(`<span class="nb">${icon('folder', 13)} ${esc(n.notebook)}</span>`);
    if (n.shareCount) meta.push(`<span title="Shared with ${n.shareCount}">${icon('users', 13)}</span>`);
    if (n.publication) meta.push(`<span title="Published">${icon(n.publication.hasPin ? 'lock' : 'globe', 13)}</span>`);
    if (n.role !== 'owner') meta.push(`<span class="badge" title="Shared by ${esc(n.owner.name)}">${n.role === 'editor' ? 'can edit' : 'view only'}</span>`);
    return `<div class="note-item ${n.id === S.currentId ? 'active' : ''}" data-id="${n.id}">
      <h3>${n.pinned ? icon('pin', 14) : ''}<span>${esc(n.title || 'Untitled')}</span></h3>
      <p>${snippet(n, q) || '<span class="muted">Empty note</span>'}</p>
      <div class="meta">${meta.join('')}</div></div>`;
  }).join('');
}

function setFilter(type, value = null) {
  S.filter = { type, value };
  S.query = '';
  el.search.value = '';
  el.app.classList.remove('nav-open', 'show-editor');
  renderAll();
}

// ============================================================ editor
const canEdit = (n) => n && n.role !== 'viewer' && !n.trashed;

async function openNote(id, { focus } = {}) {
  if (!S.notes.has(id)) return;
  if (S.currentId !== id) {
    await flushSave();
    if (S.currentId) sendPresence(S.currentId, 'left');
    const n = S.notes.get(id);
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
    renderPreview();
    renderPresence();
    setSaveStatus('saved');
    lastPresence = { state: '', at: 0 };
    sendPresence(id, 'viewing');
  }
  el.app.classList.add('show-editor');
  el.app.classList.remove('nav-open');
  renderAll();
  const n = S.notes.get(id);
  if (focus === 'title' && canEdit(n)) el.title.focus();
  else if (focus === 'text' && canEdit(n)) {
    if (S.mode === 'preview') setMode('split');
    el.text.focus();
    el.text.setSelectionRange(el.text.value.length, el.text.value.length);
  }
}

function closeEditor() {
  if (S.currentId) sendPresence(S.currentId, 'left');
  S.currentId = null;
  S.sync = null;
  el.editor.classList.add('hidden');
  el.empty.classList.remove('hidden');
  el.app.classList.remove('show-editor', 'has-note');
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
  renderInto(el.preview, el.text.value, { resolve: resolveTitle, interactiveTasks: canEdit(n) });
}

function setMode(mode) {
  S.mode = mode;
  localStorage.setItem('allnote-mode', mode);
  applyRoleUI();
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
  if (merged !== mine) {
    const focused = document.activeElement === el.text;
    const a = mapOffset(mine, merged, el.text.selectionStart);
    const b = mapOffset(mine, merged, el.text.selectionEnd);
    const scroll = el.text.scrollTop;
    el.text.value = merged;
    if (focused) el.text.setSelectionRange(a, b);
    el.text.scrollTop = scroll;
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
    if (S.mode === 'preview') setMode('split');
    el.text.focus();
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
$('#btn-back').addEventListener('click', () => el.app.classList.remove('show-editor'));

// preview interactions: wikilinks, tags, tasks
document.addEventListener('click', (e) => {
  const wl = e.target.closest('.markdown a.wikilink, a.link-card[data-open]');
  if (wl) {
    e.preventDefault();
    if (wl.dataset.open) return openNote(wl.dataset.open);
    return openByTitle(wl.dataset.target, wl.dataset.heading);
  }
  const tg = e.target.closest('a.tag[data-tag], a.chip[data-tag]');
  if (tg) {
    e.preventDefault();
    setFilter('tag', tg.dataset.tag.toLowerCase());
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
    const target = $$('h1,h2,h3,h4,h5,h6', el.preview).find((x) => x.textContent.trim().toLowerCase() === heading.toLowerCase());
    target?.scrollIntoView({ behavior: 'smooth' });
  }
}

// ---------------------------------------------------- formatting
function replaceRange(start, end, text, selStart, selEnd) {
  el.text.focus();
  el.text.setSelectionRange(start, end);
  // execCommand keeps the browser's native undo stack; fall back to setRangeText where unsupported.
  const ok = text ? document.execCommand('insertText', false, text) : start === end || document.execCommand('delete');
  if (!ok) {
    el.text.setRangeText(text, start, end, 'end');
    el.text.dispatchEvent(new Event('input'));
  }
  const caret = selStart ?? start + text.length;
  el.text.setSelectionRange(caret, selEnd ?? caret);
}

function wrap(before, after = before, placeholder = 'text') {
  const { selectionStart: s, selectionEnd: e, value: v } = el.text;
  if (v.slice(s - before.length, s) === before && v.slice(e, e + after.length) === after) {
    const inner = v.slice(s, e);
    return replaceRange(s - before.length, e + after.length, inner, s - before.length, e - before.length);
  }
  const sel = v.slice(s, e) || placeholder;
  replaceRange(s, e, before + sel + after, s + before.length, s + before.length + sel.length);
}

function lineRange() {
  const { selectionStart: s, selectionEnd: e, value: v } = el.text;
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
    const { selectionStart: s, selectionEnd: e, value: v } = el.text;
    const body = v.slice(s, e) || 'Write something important';
    const pre = s > 0 && v[s - 1] !== '\n' ? '\n\n' : '';
    const text = `${pre}> [!note] Note\n${body.split('\n').map((l) => `> ${l}`).join('\n')}\n`;
    replaceRange(s, e, text, s + pre.length + 4, s + pre.length + 8);
  },
  code: () => {
    const { selectionStart: s, selectionEnd: e, value: v } = el.text;
    const sel = v.slice(s, e);
    if (sel.includes('\n') || (!sel && (s === 0 || v[s - 1] === '\n'))) {
      replaceRange(s, e, `\`\`\`\n${sel}\n\`\`\`\n`, s + 4, s + 4 + sel.length);
    } else wrap('`', '`', 'code');
  },
  link: () => {
    const { selectionStart: s, selectionEnd: e, value: v } = el.text;
    const sel = v.slice(s, e) || 'link text';
    const text = `[${sel}](https://)`;
    replaceRange(s, e, text, s + sel.length + 3, s + text.length - 1);
  },
  wikilink: () => {
    wrap('[[', ']]', '');
    updateSuggest();
  },
  table: () => {
    const s = el.text.selectionStart;
    const pre = s > 0 && el.text.value[s - 1] !== '\n' ? '\n\n' : '';
    replaceRange(s, el.text.selectionEnd, `${pre}| Column 1 | Column 2 | Column 3 |\n| --- | --- | --- |\n| | | |\n`);
  },
  hr: () => {
    const s = el.text.selectionStart;
    replaceRange(s, el.text.selectionEnd, `${s > 0 && el.text.value[s - 1] !== '\n' ? '\n' : ''}\n---\n`);
  },
};

$('#toolbar').addEventListener('mousedown', (e) => e.preventDefault());
$('#toolbar').addEventListener('click', (e) => {
  const b = e.target.closest('[data-fmt]');
  if (b && !el.text.readOnly) FORMATS[b.dataset.fmt]();
});

el.text.addEventListener('keydown', (e) => {
  if (suggestKey(e)) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'b') { e.preventDefault(); FORMATS.bold(); return; }
  if (mod && e.key.toLowerCase() === 'i') { e.preventDefault(); FORMATS.italic(); return; }
  if (mod && e.key === 'Enter') { e.preventDefault(); FORMATS.task(); return; }
  if (e.key === 'Tab') {
    e.preventDefault();
    const { lines } = lineRange();
    const multi = el.text.selectionStart !== el.text.selectionEnd || /^\s*([-*+]|\d+[.)])\s/.test(lines[0]);
    if (e.shiftKey) transformLines((l) => l.replace(/^( {1,2}|\t)/, ''));
    else if (multi) transformLines((l) => `  ${l}`);
    else replaceRange(el.text.selectionStart, el.text.selectionEnd, '  ');
    return;
  }
  if (e.key === 'Enter' && !e.shiftKey && !mod && el.text.selectionStart === el.text.selectionEnd) {
    const v = el.text.value;
    const pos = el.text.selectionStart;
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
});

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
  const pos = el.text.selectionStart;
  const before = el.text.value.slice(0, pos);
  const m = /\[\[([^\]\n|#]*)$/.exec(before);
  if (!m || el.text.selectionStart !== el.text.selectionEnd) return hideSuggest();
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
  const c = caretCoords(el.text, pos);
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
  const pos = el.text.selectionStart;
  const after = el.text.value.slice(pos, pos + 2) === ']]' ? '' : ']]';
  replaceRange(sug.start, pos, it.title + after);
  const end = sug.start + it.title.length + 2;
  el.text.setSelectionRange(end, end);
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
  const pub = n.publication ? `<a href="/p/${esc(n.publication.slug)}" target="_blank">/p/${esc(n.publication.slug)}</a>${n.publication.hasPin ? ' 🔒' : ''}` : 'No';
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
    $$('h1,h2,h3,h4,h5,h6', el.preview)[Number(a.dataset.h)]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
  const nb = notebook ?? (S.filter.type === 'notebook' ? S.filter.value : '');
  if (!content && S.filter.type === 'tag') content = `#${S.filter.value}\n\n`;
  try {
    const { note } = await post('/api/notes', { title, content, notebook: nb });
    S.notes.set(note.id, note);
    S.rev++;
    if (!inFilter(note) && ['pinned', 'shared', 'published', 'trash'].includes(S.filter.type)) S.filter = { type: 'all', value: null };
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

// ============================================================ sidebar / list events
$('#btn-new').addEventListener('click', () => createNote());
$('#btn-switcher').addEventListener('click', openSwitcher);
$('#nav-main').addEventListener('click', (e) => {
  const a = e.target.closest('a');
  if (!a) return;
  e.preventDefault();
  if (a.dataset.filter) setFilter(a.dataset.filter);
  if (a.dataset.action === 'daily') dailyNote();
  if (a.dataset.action === 'graph') openGraph();
});
$('#nav-notebooks').addEventListener('click', async (e) => {
  const rn = e.target.closest('[data-rename]');
  if (rn) {
    e.preventDefault();
    e.stopPropagation();
    return renameNotebook(rn.dataset.rename);
  }
  const a = e.target.closest('[data-notebook]');
  if (a) {
    e.preventDefault();
    setFilter('notebook', a.dataset.notebook);
  }
});
$('#btn-new-notebook').addEventListener('click', async () => {
  const name = await promptDialog('New notebook', { placeholder: 'e.g. Work or Work/Projects', okText: 'Create' });
  if (!name) return;
  const nb = name.replace(/^\/+|\/+$/g, '');
  S.filter = { type: 'notebook', value: nb };
  await createNote({ notebook: nb });
});

async function renameNotebook(path) {
  const name = await promptDialog('Rename notebook', { value: path, okText: 'Rename' });
  if (!name || name === path) return;
  const target = name.replace(/^\/+|\/+$/g, '');
  const affected = [...S.notes.values()].filter((n) => n.role === 'owner' && (n.notebook === path || n.notebook.startsWith(`${path}/`)));
  await Promise.all(affected.map(async (n) => {
    const { note } = await put(`/api/notes/${n.id}`, { notebook: target + n.notebook.slice(path.length) });
    upsert(note);
  }));
  if (S.filter.type === 'notebook' && S.filter.value === path) S.filter.value = target;
  if (S.currentId) applyRoleUI();
  renderAll();
  toast(`Renamed to ${target}`);
}

el.list = $('#note-list');
el.list.addEventListener('click', (e) => {
  const it = e.target.closest('.note-item');
  if (it) openNote(it.dataset.id);
});
el.search = $('#search');
el.search.addEventListener('input', () => {
  S.query = el.search.value;
  renderList();
});
$('#sort').addEventListener('change', (e) => {
  S.sort = e.target.value;
  localStorage.setItem('allnote-sort', S.sort);
  renderList();
});
$('#btn-theme').addEventListener('click', () => {
  const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
  localStorage.setItem('allnote-theme', t);
});
$('#btn-logout').addEventListener('click', async () => {
  await flushSave();
  await post('/api/auth/logout').catch(() => {});
  location.href = '/';
});
$('#btn-account').addEventListener('click', openAccount);
$('#btn-menu').addEventListener('click', () => $('#app').classList.add('nav-open'));
$('#scrim').addEventListener('click', () => $('#app').classList.remove('nav-open'));

document.addEventListener('keydown', (e) => {
  if (!S.me || $('#modal-root').children.length) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (mod && (k === 'k' || k === 'p') && !e.shiftKey) { e.preventDefault(); openSwitcher(); }
  else if (e.altKey && k === 'n') { e.preventDefault(); createNote(); }
  else if (mod && k === 's') { e.preventDefault(); save(); }
  else if (mod && k === 'e' && S.currentId) { e.preventDefault(); setMode(S.mode === 'preview' ? 'split' : 'preview'); }
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
function openPublish(id) {
  const m = modal({ title: 'Publish to the web', body: '<div id="pub"></div>', foot: '<button class="btn" data-close>Done</button>' });
  const render = () => {
    const n = S.notes.get(id);
    const p = n.publication;
    const url = p ? `${location.origin}/p/${p.slug}` : '';
    $('#pub', m.el).innerHTML = `
      <div class="card"><label class="switch"><input type="checkbox" id="pub-on" ${p ? 'checked' : ''}> ${p ? 'Published — anyone with the link can open it' : 'Not published'}</label></div>
      ${p ? `
      <div class="section-title">${icon('link', 16)} Public link</div>
      <div class="copybox"><input readonly value="${esc(url)}"><button class="btn" id="pub-copy">${icon('copy', 15)} Copy</button><a class="btn" href="${esc(url)}" target="_blank">${icon('external', 15)} Open</a></div>
      <form class="row" id="pub-slug" style="margin-top:8px"><span class="muted">/p/</span><input name="slug" value="${esc(p.slug)}" pattern="[a-z0-9][a-z0-9-]{2,63}" title="3-64 lowercase letters, digits or dashes"><button class="btn">Change link</button></form>
      <div class="section-title">${icon('lock', 16)} PIN protection</div>
      <p class="muted" style="margin:0 0 8px">${p.hasPin ? '<b style="color:var(--ok)">On</b> — visitors must enter the PIN to read this page.' : 'Off — anyone with the link can read this page.'}</p>
      <form class="row" id="pub-pin"><input name="pin" type="password" placeholder="${p.hasPin ? 'New PIN' : 'Set a PIN (4–12 letters/digits)'}" pattern="[A-Za-z0-9]{4,12}" required autocomplete="new-password"><button class="btn primary">${p.hasPin ? 'Change PIN' : 'Set PIN'}</button>${p.hasPin ? '<button class="btn danger" type="button" id="pub-nopin">Remove</button>' : ''}</form>
      <p class="muted" style="font-size:12.5px;margin-top:14px">The published page always shows the latest version of this note. Links to other notes are shown as plain text.</p>` : ''}`;
  };
  const send = async (body, msg) => {
    try {
      const { note } = await put(`/api/notes/${id}/publish`, body);
      upsert(note);
      if (S.currentId === id) applyRoleUI();
      render();
      if (msg) toast(msg);
    } catch (err) {
      toast(err.message, 'error');
      render();
    }
  };
  m.el.addEventListener('change', (e) => {
    if (e.target.id === 'pub-on') send({ published: e.target.checked }, e.target.checked ? 'Published' : 'Unpublished');
  });
  m.el.addEventListener('submit', (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.target));
    if (e.target.id === 'pub-slug') send({ published: true, slug: d.slug }, 'Link updated');
    if (e.target.id === 'pub-pin') send({ published: true, pin: d.pin }, 'PIN set — previous visitors must re-enter it');
  });
  m.el.addEventListener('click', (e) => {
    if (e.target.closest('#pub-copy')) copyText(m.el.querySelector('.copybox input').value);
    if (e.target.closest('#pub-nopin')) send({ published: true, pin: null }, 'PIN removed');
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
      </div>`;
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
      if (f.id === 'f-2fa-on') {
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
    if (e.target.closest('#tfa-start')) {
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
