import { hydrateIcons } from './icons.js';
import { escapeHtml as esc } from './markdown.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  hydrateIcons(t.content);
  return t.content.firstElementChild;
}

export function toast(msg, type = '') {
  const el = h(`<div class="toast ${type}">${esc(msg)}</div>`);
  $('#toast-root').append(el);
  setTimeout(() => el.remove(), type === 'error' ? 5000 : 2600);
}

/** Open a modal. Returns { el, close }. body is an HTML string. */
export function modal({ title, body = '', foot = '', cls = '', onClose } = {}) {
  const backdrop = h(`<div class="modal-backdrop"><div class="modal ${cls}" role="dialog" aria-modal="true">
      ${title !== undefined ? `<div class="modal-head"><h3>${esc(title)}</h3><button class="icon-btn" data-close title="Close"><i data-icon="x"></i></button></div>` : ''}
      <div class="modal-body">${body}</div>
      ${foot ? `<div class="modal-foot">${foot}</div>` : ''}
    </div></div>`);
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey, true);
    onClose?.();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close();
  });
  backdrop.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
  document.addEventListener('keydown', onKey, true);
  $('#modal-root').append(backdrop);
  const el = backdrop.querySelector('.modal');
  setTimeout(() => el.querySelector('[autofocus]')?.focus(), 0);
  return { el, close };
}

export function confirmDialog(message, { okText = 'OK', danger = false } = {}) {
  return new Promise((resolve) => {
    let ok = false;
    const m = modal({
      title: 'Please confirm',
      body: `<p>${esc(message)}</p>`,
      foot: `<button class="btn" data-close>Cancel</button><button class="btn ${danger ? 'danger solid' : 'primary'}" data-ok autofocus>${esc(okText)}</button>`,
      onClose: () => resolve(ok),
    });
    m.el.querySelector('[data-ok]').addEventListener('click', () => {
      ok = true;
      m.close();
    });
  });
}

export function promptDialog(title, { value = '', placeholder = '', okText = 'OK' } = {}) {
  return new Promise((resolve) => {
    let result = null;
    const m = modal({
      title,
      body: `<form class="form"><input name="v" value="${esc(value)}" placeholder="${esc(placeholder)}" autofocus autocomplete="off"></form>`,
      foot: `<button class="btn" data-close>Cancel</button><button class="btn primary" data-ok>${esc(okText)}</button>`,
      onClose: () => resolve(result),
    });
    const submit = (e) => {
      e?.preventDefault();
      result = m.el.querySelector('input').value.trim();
      m.close();
    };
    m.el.querySelector('form').addEventListener('submit', submit);
    m.el.querySelector('[data-ok]').addEventListener('click', submit);
    setTimeout(() => m.el.querySelector('input').select(), 0);
  });
}

/** Small dropdown menu anchored to an element. items: [{label, icon, action, danger}] or 'sep'. */
export function popupMenu(anchor, items) {
  document.querySelector('.menu')?.remove();
  const menu = h(`<div class="menu">${items
    .map((it, i) => (it === 'sep' ? '<hr>' : `<button data-i="${i}" class="${it.danger ? 'danger' : ''}"><i data-icon="${it.icon || 'chevron'}" data-size="16"></i>${esc(it.label)}</button>`))
    .join('')}</div>`);
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth;
  menu.style.top = `${Math.min(r.bottom + 4, window.innerHeight - menu.offsetHeight - 8)}px`;
  menu.style.left = `${Math.max(8, Math.min(r.right - mw, window.innerWidth - mw - 8))}px`;
  const close = () => {
    menu.remove();
    document.removeEventListener('mousedown', outside, true);
  };
  const outside = (e) => {
    if (!menu.contains(e.target)) close();
  };
  setTimeout(() => document.addEventListener('mousedown', outside, true), 0);
  menu.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-i]');
    if (!b) return;
    close();
    items[Number(b.dataset.i)].action();
  });
}

export function initials(name = '') {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
}

export function avatarHtml(user, cls = '') {
  const shade = 18 + ([...(user.id || user.name || '')].reduce((a, c) => a + c.charCodeAt(0), 0) % 6) * 6;
  const color = `hsl(0 0% ${shade}%)`;
  if (user.avatar) return `<span class="avatar ${cls}" title="${esc(user.name)}" style="background-image:url('${esc(user.avatar)}')"></span>`;
  return `<span class="avatar ${cls}" title="${esc(user.name)}" style="background:${color};color:#fff">${esc(initials(user.name))}</span>`;
}

export function timeAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)} d ago`;
  return new Date(ts).toLocaleDateString();
}

export const fmtDate = (ts) => new Date(ts).toLocaleString();

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h('<textarea style="position:fixed;opacity:0"></textarea>');
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('Copied to clipboard');
}

export function download(filename, text, type = 'text/markdown') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
