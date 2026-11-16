import { hydrateIcons, icon } from './icons.js';
import { renderInto } from './markdown.js';

hydrateIcons();
const $ = (s) => document.querySelector(s);
const slug = decodeURIComponent(location.pathname.split('/').filter(Boolean)[1] || '');

$('#btn-theme').addEventListener('click', () => {
  const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
  localStorage.setItem('allnote-theme', t);
});

fetch('/api/config').then((r) => r.json()).then((c) => {
  document.querySelectorAll('.app-name').forEach((n) => { n.textContent = c.appName; });
}).catch(() => {});

async function load() {
  const res = await fetch(`/api/public/${encodeURIComponent(slug)}`, { credentials: 'same-origin' });
  const data = await res.json().catch(() => ({}));
  $('#pub-loading').classList.add('hidden');
  if (res.status === 401 && data.pinRequired) {
    $('#pin-form').classList.remove('hidden');
    $('#pin-form input').focus();
    return;
  }
  if (!res.ok) {
    $('#pub-error-msg').textContent = data.error || 'This page does not exist.';
    $('#pub-error').classList.remove('hidden');
    return;
  }
  $('#pin-form').classList.add('hidden');
  document.title = data.title || 'Untitled';
  $('#pub-title').textContent = data.title || 'Untitled';
  $('#pub-meta').innerHTML = `<span>${data.author ? `By ${escapeText(data.author)} · ` : ''}Updated ${new Date(data.updatedAt).toLocaleString()}</span>${data.protected ? `<span title="PIN protected">${icon('lock', 14)}</span>` : ''}`;
  renderInto($('#pub-body'), data.content, { publicMode: true });
  $('#pub-note').classList.remove('hidden');
}

function escapeText(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

$('#pin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pin = e.target.pin.value;
  const res = await fetch(`/api/public/${encodeURIComponent(slug)}/unlock`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    $('#pin-error').textContent = data.error || 'Wrong PIN';
    $('#pin-error').classList.remove('hidden');
    e.target.pin.select();
    return;
  }
  load();
});

load();
