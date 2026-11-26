// Shared by the app, the landing page and published pages.
import { icon } from './icons.js';

// ---------- theme ----------
export function toggleTheme() {
  const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
  localStorage.setItem('allnote-theme', t);
  syncThemeButtons();
}

/** Theme buttons show the mode you switch TO: a sun in dark mode, a moon in light mode. */
export function syncThemeButtons() {
  const dark = document.documentElement.dataset.theme === 'dark';
  document.querySelectorAll('[data-theme-toggle]').forEach((b) => {
    b.innerHTML = icon(dark ? 'sun' : 'moon', Number(b.dataset.size) || 18);
    b.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
    b.setAttribute('aria-label', b.title);
  });
}

export function bindThemeToggles(root = document) {
  root.addEventListener('click', (e) => {
    if (e.target.closest('[data-theme-toggle]')) toggleTheme();
  });
  syncThemeButtons();
}

// ---------- icons inside every input field ----------
const SKIP_TYPES = new Set(['checkbox', 'radio', 'file', 'hidden', 'range', 'color', 'submit', 'button', 'image', 'reset']);
const NAME_ICONS = {
  name: 'user', email: 'mail', code: 'shield', pin: 'lock', slug: 'link', clientid: 'key', clientsecret: 'lock',
  password: 'lock', newpassword: 'lock', currentpassword: 'lock',
  key: 'ticket', license: 'ticket', label: 'tag', days: 'hourglass', count: 'layers', role: 'users', expires: 'calendar',
  q: 'search', filter: 'search', duration: 'hourglass',
};

export function fieldIconFor(el) {
  if (el.dataset.fieldIcon) return el.dataset.fieldIcon;
  const type = (el.getAttribute('type') || '').toLowerCase();
  const name = (el.getAttribute('name') || '').toLowerCase();
  if (NAME_ICONS[name]) return NAME_ICONS[name];
  if (type === 'email') return 'mail';
  if (type === 'password') return 'lock';
  if (type === 'search') return 'search';
  if (type === 'date' || type === 'datetime-local') return 'calendar';
  if (type === 'number') return 'hash';
  if (type === 'url' || /^https?:\/\//.test(el.value || '')) return 'link';
  if (el.tagName === 'SELECT') return 'list2';
  if (/find|search/i.test(el.placeholder || '')) return 'search';
  return 'edit';
}

function decorate(el) {
  if (el.dataset.bare !== undefined || el.closest('.field, [data-bare-fields]')) return;
  if (el.tagName === 'INPUT' && SKIP_TYPES.has((el.getAttribute('type') || '').toLowerCase())) return;
  const focused = document.activeElement === el;
  const wrap = document.createElement('span');
  wrap.className = 'field';
  wrap.innerHTML = icon(fieldIconFor(el), 16).replace('class="ico"', 'class="ico field-ico"');
  el.replaceWith(wrap);
  wrap.append(el);
  if (focused) el.focus();
}

/** Puts a domain icon inside every form input/select, including ones rendered later (modals, dialogs). */
export function autoFieldIcons(root = document.body) {
  const scan = (node) => {
    if (node.nodeType !== 1) return;
    if (node.matches('input, select')) decorate(node);
    node.querySelectorAll?.('input, select').forEach(decorate);
  };
  scan(root);
  new MutationObserver((records) => {
    for (const r of records) r.addedNodes.forEach(scan);
  }).observe(root, { childList: true, subtree: true });
}

// ---------- version ----------
export function showVersion(cfg) {
  document.querySelectorAll('.app-version').forEach((n) => {
    n.textContent = cfg?.version ? `v${cfg.version}` : '';
    n.title = cfg?.build ? `Build ${cfg.build}` : '';
  });
}

/**
 * Reload open pages after a deploy so nobody keeps running stale code.
 * Checks when the tab becomes visible, every few minutes, and whenever `check()` is called.
 */
export function watchForUpdates(currentBuild, { beforeReload } = {}) {
  let busy = false;
  const check = async () => {
    if (busy || !currentBuild) return;
    busy = true;
    try {
      const res = await fetch('/api/config', { cache: 'no-store', credentials: 'same-origin' });
      const cfg = await res.json();
      if (cfg.build && cfg.build !== currentBuild) {
        await beforeReload?.(cfg);
        location.reload();
      }
    } catch { /* offline, try again later */ }
    busy = false;
  };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  setInterval(check, 5 * 60_000);
  return check;
}
