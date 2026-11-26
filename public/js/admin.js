// Admin console: users (approve, expire/renew, reset password/2FA, add, remove), license keys, sign-in and site settings.
import { get, post, put, del } from './api.js';
import { icon } from './icons.js';
import { escapeHtml as esc } from './markdown.js';
import {
  $, modal, toast, confirmDialog, popupMenu, avatarHtml, copyText, download,
} from './ui.js';

const DAY = 86_400_000;
const fmtDay = (ts) => new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const dateInput = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
/** A date picked in the UI means "valid through the end of that day" in the admin's time zone. */
const endOfDay = (value) => {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
};
export const fmtDuration = (days) => {
  if (days % 365 === 0) return `${days / 365} year${days === 365 ? '' : 's'}`;
  if (days % 30 === 0 && days >= 30) return `${days / 30} month${days === 30 ? '' : 's'}`;
  return `${days} day${days === 1 ? '' : 's'}`;
};
const relDays = (ts) => {
  const d = Math.round((ts - Date.now()) / DAY);
  if (d === 0) return 'today';
  return d > 0 ? `in ${d} day${d === 1 ? '' : 's'}` : `${-d} day${d === -1 ? '' : 's'} ago`;
};
export function randomPassword(len = 14) {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  return Array.from(crypto.getRandomValues(new Uint32Array(len)), (n) => a[n % a.length]).join('');
}

const STATUS = {
  active: { label: 'Active', icon: 'checkCircle', cls: 'ok' },
  pending: { label: 'Pending approval', icon: 'hourglass', cls: 'warn' },
  expired: { label: 'Expired', icon: 'ban', cls: 'bad' },
};
const statusChip = (s) => `<span class="status ${STATUS[s].cls}">${icon(STATUS[s].icon, 14)}${STATUS[s].label}</span>`;

export function openAdmin({ me, onChange = () => {}, tab = 'users' } = {}) {
  const m = modal({
    title: 'Admin console',
    cls: 'wide admin-modal',
    body: `<div class="admin">
      <nav class="admin-tabs" role="tablist">
        <button role="tab" data-tab="users">${icon('users', 17)}<span>Users</span><span class="badge hidden" id="adm-badge"></span></button>
        <button role="tab" data-tab="licenses">${icon('ticket', 17)}<span>License keys</span></button>
        <button role="tab" data-tab="signin">${icon('key', 17)}<span>Sign-in</span></button>
        <button role="tab" data-tab="site">${icon('globe', 17)}<span>Site</span></button>
      </nav>
      <section class="admin-panel" id="adm-panel" role="tabpanel"></section>
    </div>`,
  });
  const panel = $('#adm-panel', m.el);
  const state = { tab, users: [], licenses: [], settings: null, filter: '', licFilter: 'all', newKeys: [] };

  const setBadge = () => {
    const n = state.users.filter((u) => u.status === 'pending').length;
    const b = $('#adm-badge', m.el);
    b.textContent = n;
    b.classList.toggle('hidden', !n);
    onChange({ pending: n });
  };

  // ---------------------------------------------------------------- users
  const loadUsers = async () => {
    state.users = (await get('/api/admin/users')).users;
    setBadge();
  };

  const userRow = (u) => {
    const self = u.id === me.id;
    const tags = [u.isAdmin && '<span class="badge">Admin</span>', u.twoFactorEnabled && `<span class="badge" title="Two-factor authentication on">${icon('shield', 11)} 2FA</span>`, u.google && '<span class="badge">Google</span>'].filter(Boolean).join(' ');
    const expires = u.isAdmin ? '<span class="muted">Never</span>'
      : u.expiresAt ? `<span class="${u.expiresAt < Date.now() ? 'danger-text' : ''}">${fmtDay(u.expiresAt)}</span><small class="muted">${relDays(u.expiresAt)}</small>` : '<span class="muted">Never</span>';
    return `<tr data-id="${u.id}" class="${u.status}">
      <td><div class="adm-user">${avatarHtml(u)}<div><b>${esc(u.name)}${self ? ' <span class="muted">(you)</span>' : ''}</b><small>${esc(u.email)}</small></div></div></td>
      <td>${statusChip(u.status)} ${tags}</td>
      <td class="adm-exp">${expires}</td>
      <td class="num">${u.noteCount}</td>
      <td class="muted">${fmtDay(u.createdAt)}</td>
      <td class="adm-actions">${u.isAdmin ? '' : `${u.status === 'pending' ? `<button class="btn primary sm" data-act="approve">${icon('userCheck', 14)} Approve</button>` : ''}
        ${u.status === 'expired' ? `<button class="btn sm" data-act="renew-menu">${icon('refresh', 14)} Renew</button>` : ''}
        <button class="icon-btn" data-act="menu" title="More actions" aria-label="More actions for ${esc(u.email)}">${icon('more', 18)}</button>`}</td>
    </tr>`;
  };

  const renderUsers = () => {
    const count = (s) => state.users.filter((u) => u.status === s).length;
    panel.innerHTML = `
      <div class="adm-toolbar">
        <input name="filter" type="search" placeholder="Filter by name or email" value="${esc(state.filter)}" autocomplete="off" id="adm-filter">
        <button class="btn primary" id="adm-add">${icon('userPlus', 16)} Add user</button>
      </div>
      <div class="adm-stats">
        <span>${icon('users', 15)} <b>${state.users.length}</b> users</span>
        <span>${icon('checkCircle', 15)} <b>${count('active')}</b> active</span>
        <span>${icon('hourglass', 15)} <b>${count('pending')}</b> pending</span>
        <span>${icon('ban', 15)} <b>${count('expired')}</b> expired</span>
      </div>
      <div class="table-wrap"><table class="adm-table">
        <thead><tr><th>User</th><th>Status</th><th>Expires</th><th class="num">Notes</th><th>Joined</th><th></th></tr></thead>
        <tbody id="adm-users"></tbody>
      </table></div>`;
    renderUserRows();
  };
  const renderUserRows = () => {
    const q = state.filter.trim().toLowerCase();
    const list = state.users.filter((u) => !q || u.name.toLowerCase().includes(q) || u.email.includes(q));
    $('#adm-users', m.el).innerHTML = list.map(userRow).join('') || '<tr><td colspan="6" class="list-empty">No users match the filter.</td></tr>';
  };

  const updateUser = async (u, body, msg) => {
    try {
      const { user } = await put(`/api/admin/users/${u.id}`, body);
      Object.assign(state.users.find((x) => x.id === u.id), user);
      setBadge();
      renderUsers();
      toast(msg);
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  const renewItems = (u) => [30, 90, 365].map((d) => ({
    label: `Renew for ${fmtDuration(d)}`, icon: 'refresh', action: () => updateUser(u, { extendDays: d }, `${u.name}: renewed for ${fmtDuration(d)}`),
  }));

  const userMenu = (anchor, u) => {
    const items = [];
    if (u.status === 'pending') items.push({ label: 'Approve', icon: 'userCheck', action: () => updateUser(u, { approved: true }, `${u.name} can now use the app`) });
    else items.push({ label: 'Suspend (require approval)', icon: 'ban', action: () => updateUser(u, { approved: false }, `${u.name} is suspended`) });
    items.push('sep', { label: 'Set expiration date', icon: 'calendar', action: () => expiryDialog(u) }, ...renewItems(u));
    if (u.expiresAt) items.push({ label: 'Remove expiration', icon: 'x', action: () => updateUser(u, { expiresAt: null }, `${u.name} no longer expires`) });
    items.push('sep', { label: 'Reset password', icon: 'key', action: () => passwordDialog(u) });
    if (u.twoFactorEnabled) items.push({ label: 'Reset two-factor', icon: 'shield', action: () => reset2fa(u) });
    items.push('sep', { label: 'Remove user', icon: 'userX', danger: true, action: () => removeUser(u) });
    popupMenu(anchor, items);
  };

  function expiryDialog(u) {
    const base = Math.max(Date.now(), u.expiresAt || Date.now());
    const d = modal({
      title: `Expiration for ${u.name}`,
      body: `<form class="form" id="f-exp">
        <label>Account valid through<input name="expires" type="date" required value="${dateInput(u.expiresAt || Date.now() + 30 * DAY)}"></label>
        <div class="quick">${[30, 90, 180, 365].map((n) => `<button type="button" class="btn sm" data-days="${n}">+ ${fmtDuration(n)}</button>`).join('')}</div>
        <p class="muted small">${icon('info', 14)} After this day the user can still sign in, but every feature is locked until the account is renewed or a license key is redeemed.</p>
      </form>`,
      foot: `<button class="btn" data-close>Cancel</button>${u.expiresAt ? '<button class="btn" id="exp-never">Never expires</button>' : ''}<button class="btn primary" id="exp-save">${icon('check', 15)} Save</button>`,
    });
    const input = d.el.querySelector('input[name=expires]');
    d.el.addEventListener('click', async (e) => {
      const q = e.target.closest('[data-days]');
      if (q) input.value = dateInput(base + Number(q.dataset.days) * DAY);
      if (e.target.closest('#exp-never')) { d.close(); updateUser(u, { expiresAt: null }, `${u.name} no longer expires`); }
      if (e.target.closest('#exp-save')) {
        if (!input.value) return input.reportValidity();
        d.close();
        updateUser(u, { expiresAt: endOfDay(input.value) }, `${u.name}: valid through ${fmtDay(endOfDay(input.value))}`);
      }
    });
    d.el.querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); d.el.querySelector('#exp-save').click(); });
  }

  function passwordDialog(u) {
    const d = modal({
      title: `Reset password for ${u.name}`,
      body: `<form class="form" id="f-pw">
        <label>New password<span class="pw-row"><input name="password" type="text" minlength="8" required autocomplete="new-password" spellcheck="false" value="${randomPassword()}"><button type="button" class="btn sm" id="pw-gen">${icon('refresh', 14)} Generate</button></span></label>
        <p class="muted small">${icon('info', 14)} The user is signed out everywhere. Share the new password over a secure channel.</p>
      </form>`,
      foot: `<button class="btn" data-close>Cancel</button><button class="btn primary" id="pw-save">${icon('key', 15)} Reset password</button>`,
    });
    const input = d.el.querySelector('input[name=password]');
    const save = async (e) => {
      e?.preventDefault();
      if (!input.reportValidity()) return;
      try {
        await post(`/api/admin/users/${u.id}/password`, { password: input.value });
        const pw = input.value;
        d.close();
        const done = modal({
          title: 'Password reset',
          body: `<p>New password for <b>${esc(u.email)}</b>:</p><div class="copybox"><input readonly value="${esc(pw)}" data-field-icon="key" aria-label="New password"><button class="btn" id="pw-copy">${icon('copy', 15)} Copy</button></div>`,
          foot: '<button class="btn primary" data-close>Done</button>',
        });
        done.el.querySelector('#pw-copy').onclick = () => copyText(pw);
      } catch (err) {
        toast(err.message, 'error');
      }
    };
    d.el.querySelector('#pw-gen').onclick = () => { input.value = randomPassword(); };
    d.el.querySelector('form').addEventListener('submit', save);
    d.el.querySelector('#pw-save').onclick = save;
  }

  async function reset2fa(u) {
    if (!(await confirmDialog(`Turn off two-factor authentication for ${u.email}? They can sign in with only their password and set it up again.`, { okText: 'Reset two-factor', danger: true }))) return;
    try {
      const { user } = await post(`/api/admin/users/${u.id}/reset-2fa`);
      Object.assign(state.users.find((x) => x.id === u.id), user);
      renderUsers();
      toast('Two-factor authentication reset');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function removeUser(u) {
    if (!(await confirmDialog(`Remove ${u.email}? Their account and the ${u.noteCount} note(s) they own are deleted permanently. This cannot be undone.`, { okText: 'Remove user', danger: true }))) return;
    try {
      await del(`/api/admin/users/${u.id}`);
      state.users = state.users.filter((x) => x.id !== u.id);
      setBadge();
      renderUsers();
      toast(`${u.email} removed`);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function addUserDialog() {
    const d = modal({
      title: 'Add user',
      body: `<form class="form" id="f-add">
        <label>Name<input name="name" required maxlength="80" autocomplete="off"></label>
        <label>Email<input name="email" type="email" required autocomplete="off"></label>
        <label>Password<span class="pw-row"><input name="password" type="text" minlength="8" required autocomplete="new-password" spellcheck="false" value="${randomPassword()}"><button type="button" class="btn sm" id="add-gen">${icon('refresh', 14)} Generate</button></span></label>
        <label>Expires (optional)<input name="expires" type="date" min="${dateInput(Date.now())}"></label>
        <p class="muted small">${icon('info', 14)} Accounts you add are approved right away. Leave the date empty for an account that never expires.</p>
      </form>`,
      foot: `<button class="btn" data-close>Cancel</button><button class="btn primary" id="add-save">${icon('userPlus', 15)} Add user</button>`,
    });
    const form = d.el.querySelector('form');
    d.el.querySelector('#add-gen').onclick = () => { form.password.value = randomPassword(); };
    const save = async (e) => {
      e?.preventDefault();
      if (!form.reportValidity()) return;
      const f = Object.fromEntries(new FormData(form));
      try {
        const { user } = await post('/api/admin/users', { name: f.name, email: f.email, password: f.password, expiresAt: f.expires ? endOfDay(f.expires) : null });
        state.users.unshift(user);
        d.close();
        renderUsers();
        const done = modal({
          title: 'User added',
          body: `<p>Share these sign-in details with <b>${esc(user.name)}</b> over a secure channel:</p>
            <div class="codes single"><span>${esc(user.email)}</span><span>${esc(f.password)}</span></div>`,
          foot: `<button class="btn" id="add-copy">${icon('copy', 15)} Copy</button><button class="btn primary" data-close>Done</button>`,
        });
        done.el.querySelector('#add-copy').onclick = () => copyText(`${location.origin}\nEmail: ${user.email}\nPassword: ${f.password}`);
      } catch (err) {
        toast(err.message, 'error');
      }
    };
    form.addEventListener('submit', save);
    d.el.querySelector('#add-save').onclick = save;
  }

  // ---------------------------------------------------------------- licenses
  const loadLicenses = async () => { state.licenses = (await get('/api/admin/licenses')).licenses; };

  const licStatus = (l) => (l.status === 'available' ? `<span class="status ok">${icon('checkCircle', 14)}Available</span>`
    : l.status === 'redeemed' ? `<span class="status">${icon('userCheck', 14)}Redeemed</span><small class="muted">${esc(l.redeemedBy || 'deleted user')}, ${fmtDay(l.redeemedAt)}</small>`
      : `<span class="status bad">${icon('ban', 14)}Revoked</span>`);

  const renderLicenses = () => {
    const list = state.licenses.filter((l) => state.licFilter === 'all' || l.status === state.licFilter);
    const n = (s) => state.licenses.filter((l) => l.status === s).length;
    panel.innerHTML = `
      <form class="card lic-gen" id="f-lic">
        <div class="lic-grid">
          <label>Duration<select name="duration">
            ${[7, 30, 90, 180, 365, 730].map((d) => `<option value="${d}" ${d === 30 ? 'selected' : ''}>${fmtDuration(d)}</option>`).join('')}
            <option value="custom">Custom number of days</option></select></label>
          <label class="hidden" id="lic-custom">Days<input name="days" type="number" min="1" max="3650" placeholder="e.g. 45"></label>
          <label>Quantity<input name="count" type="number" min="1" max="100" value="1" required></label>
          <label class="grow">Label (optional)<input name="label" maxlength="80" placeholder="Customer, order number, team..."></label>
        </div>
        <div class="row"><button class="btn primary">${icon('ticket', 16)} Generate keys</button><span class="muted small">Each key can be redeemed once. It extends an account from its current expiration date, or from today if already expired.</span></div>
      </form>
      ${state.newKeys.length ? `<div class="card lic-new">
        <div class="row"><b>${icon('checkCircle', 16)} ${state.newKeys.length} new key${state.newKeys.length > 1 ? 's' : ''}</b><span class="spacer"></span>
          <button class="btn sm" id="lic-copy-new">${icon('copy', 14)} Copy all</button><button class="btn sm" id="lic-dl-new">${icon('download', 14)} Download</button></div>
        <div class="codes">${state.newKeys.map((k) => `<span>${esc(k)}</span>`).join('')}</div></div>` : ''}
      <div class="adm-toolbar">
        <div class="seg-tabs" id="lic-filter">${[['all', 'All', state.licenses.length], ['available', 'Available', n('available')], ['redeemed', 'Redeemed', n('redeemed')], ['revoked', 'Revoked', n('revoked')]]
    .map(([v, l, c]) => `<button type="button" data-f="${v}" class="${state.licFilter === v ? 'active' : ''}">${l} <span class="muted">${c}</span></button>`).join('')}</div>
      </div>
      <div class="table-wrap"><table class="adm-table">
        <thead><tr><th>Key</th><th>Duration</th><th>Label</th><th>Status</th><th>Created</th><th></th></tr></thead>
        <tbody>${list.map((l) => `<tr data-key="${esc(l.key)}" class="lic-${l.status}">
          <td><code class="lic-key">${esc(l.key)}</code></td><td>${fmtDuration(l.days)}</td><td>${esc(l.label) || '<span class="muted">-</span>'}</td>
          <td class="adm-exp">${licStatus(l)}</td><td class="muted">${fmtDay(l.createdAt)}</td>
          <td class="adm-actions">${l.status === 'available' ? `<button class="icon-btn" data-act="copy-key" title="Copy key">${icon('copy', 16)}</button><button class="icon-btn danger" data-act="revoke" title="Revoke key">${icon('ban', 16)}</button>` : ''}</td>
        </tr>`).join('') || '<tr><td colspan="6" class="list-empty">No license keys yet. Generate one above.</td></tr>'}</tbody>
      </table></div>`;
  };

  // ---------------------------------------------------------------- sign-in & site settings
  const loadSettings = async () => { state.settings = await get('/api/admin/settings'); };
  const saveSettings = async (body, msg) => {
    try {
      state.settings = await put('/api/admin/settings', body);
      onChange({ settings: state.settings });
      if (msg) toast(msg);
      return true;
    } catch (err) {
      toast(err.message, 'error');
      return false;
    }
  };

  const renderSignin = () => {
    const s = state.settings;
    const g = s.google;
    panel.innerHTML = `
      <div class="stack">
        <div class="card stack">
          <label class="switch"><input type="checkbox" data-setting="allowSignup" ${s.allowSignup ? 'checked' : ''}> Allow new users to create accounts</label>
          <label class="switch"><input type="checkbox" data-setting="requireApproval" ${s.requireApproval ? 'checked' : ''}> Require administrator approval for new accounts</label>
          <p class="muted small">${icon('info', 14)} Users waiting for approval can sign in, but every feature stays locked until you approve them in <b>Users</b>.</p>
        </div>
        <form class="card form" id="f-google" autocomplete="off">
          <div><b>Google single sign-on</b> ${g.enabled ? '<span class="badge">Enabled</span>' : '<small class="muted">(not configured)</small>'}<br>
          <small class="muted">Google Cloud Console, APIs &amp; Services, Credentials, <i>OAuth client ID</i> (Web application). Add this <b>Authorized redirect URI</b>:</small></div>
          <div class="copybox"><input readonly value="${esc(g.redirectUri)}" id="adm-redirect" aria-label="Redirect URI"><button type="button" class="btn" id="adm-copy">${icon('copy', 15)} Copy</button></div>
          <label>Client ID<input name="clientId" value="${esc(g.clientId)}" placeholder="1234567890-abc.apps.googleusercontent.com" spellcheck="false"></label>
          <label>Client secret<input name="clientSecret" type="password" placeholder="${g.hasSecret ? 'Saved, leave empty to keep it' : 'GOCSPX-...'}" autocomplete="new-password" spellcheck="false"></label>
          <div class="row"><button class="btn primary">${icon('check', 15)} Save Google settings</button>${g.enabled || g.clientId ? '<button type="button" class="btn danger" id="adm-google-off">Remove</button>' : ''}</div>
        </form>
      </div>`;
  };

  const renderSite = () => {
    const s = state.settings;
    panel.innerHTML = `
      <div class="stack">
        <div class="card stack">
          <label class="switch"><input type="checkbox" data-setting="landingPage" ${s.landingPage ? 'checked' : ''}> Show the landing page to visitors who are not signed in</label>
          <p class="muted small">${icon('info', 14)} When off, visitors go straight to the sign-in page. <a href="/welcome" target="_blank" rel="noopener">${icon('external', 13)} Preview landing page</a></p>
        </div>
        <div class="card">
          <dl class="note-info">
            <dt>Version</dt><dd>v${esc(s.version)}</dd>
            <dt>Build</dt><dd><code>${esc(s.build)}</code></dd>
          </dl>
          <p class="muted small" style="margin-bottom:0">${icon('refresh', 14)} After a deploy, open tabs detect the new build and reload automatically, so nobody keeps a stale version.</p>
        </div>
      </div>`;
  };

  // ---------------------------------------------------------------- tabs & events
  const TABS = {
    users: async () => { await loadUsers(); renderUsers(); },
    licenses: async () => { await loadLicenses(); renderLicenses(); },
    signin: async () => { await loadSettings(); renderSignin(); },
    site: async () => { await loadSettings(); renderSite(); },
  };
  const show = async (t) => {
    state.tab = t;
    m.el.querySelectorAll('[data-tab]').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === t);
      b.setAttribute('aria-selected', String(b.dataset.tab === t));
    });
    panel.innerHTML = '<div class="list-empty">Loading...</div>';
    try {
      await TABS[t]();
    } catch (err) {
      panel.innerHTML = `<div class="list-empty">${esc(err.message)}</div>`;
    }
  };

  m.el.addEventListener('click', async (e) => {
    const tabBtn = e.target.closest('[data-tab]');
    if (tabBtn) return show(tabBtn.dataset.tab);
    if (e.target.closest('#adm-add')) return addUserDialog();
    if (e.target.closest('#adm-copy')) return copyText($('#adm-redirect', m.el).value);
    if (e.target.closest('#lic-copy-new')) return copyText(state.newKeys.join('\n'));
    if (e.target.closest('#lic-dl-new')) return download(`license-keys-${dateInput(Date.now())}.txt`, state.newKeys.join('\n'), 'text/plain');
    const f = e.target.closest('[data-f]');
    if (f) { state.licFilter = f.dataset.f; return renderLicenses(); }
    if (e.target.closest('#adm-google-off')) {
      if (!(await confirmDialog('Remove Google sign-in? Users can no longer sign in with Google until it is configured again. Accounts with a password are not affected.', { okText: 'Remove', danger: true }))) return;
      if (await saveSettings({ google: null }, 'Google sign-in removed')) renderSignin();
      return;
    }
    const act = e.target.closest('[data-act]');
    if (!act) return;
    const row = act.closest('tr');
    if (row?.dataset.id) {
      const u = state.users.find((x) => x.id === row.dataset.id);
      if (act.dataset.act === 'approve') updateUser(u, { approved: true }, `${u.name} can now use the app`);
      if (act.dataset.act === 'menu') userMenu(act, u);
      if (act.dataset.act === 'renew-menu') popupMenu(act, renewItems(u).concat({ label: 'Set expiration date', icon: 'calendar', action: () => expiryDialog(u) }));
    } else if (row?.dataset.key) {
      const key = row.dataset.key;
      if (act.dataset.act === 'copy-key') copyText(key);
      if (act.dataset.act === 'revoke') {
        if (!(await confirmDialog(`Revoke license key ${key}? It can no longer be redeemed.`, { okText: 'Revoke', danger: true }))) return;
        try {
          const { license } = await del(`/api/admin/licenses/${encodeURIComponent(key)}`);
          Object.assign(state.licenses.find((l) => l.key === key), license);
          state.newKeys = state.newKeys.filter((k) => k !== key);
          renderLicenses();
          toast('License key revoked');
        } catch (err) {
          toast(err.message, 'error');
        }
      }
    }
  });

  m.el.addEventListener('input', (e) => {
    if (e.target.id !== 'adm-filter') return;
    state.filter = e.target.value;
    renderUserRows();
  });

  m.el.addEventListener('change', async (e) => {
    const key = e.target.dataset.setting;
    if (key) {
      const on = e.target.checked;
      const labels = {
        allowSignup: on ? 'Sign up enabled' : 'Sign up disabled',
        requireApproval: on ? 'New accounts need approval' : 'New accounts are approved automatically',
        landingPage: on ? 'Landing page enabled' : 'Landing page disabled',
      };
      if (!(await saveSettings({ [key]: on }, labels[key]))) e.target.checked = !on;
    }
    if (e.target.name === 'duration') $('#lic-custom', m.el).classList.toggle('hidden', e.target.value !== 'custom');
  });

  m.el.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const d = Object.fromEntries(new FormData(form));
    if (form.id === 'f-google') {
      if (d.clientId.trim() && !d.clientSecret.trim() && !state.settings.google.hasSecret) return toast('Enter the client secret', 'error');
      if (await saveSettings({ google: d })) {
        toast(state.settings.google.enabled ? 'Google sign-in enabled' : 'Google settings saved');
        renderSignin();
      }
    }
    if (form.id === 'f-lic') {
      const days = d.duration === 'custom' ? Number(d.days) : Number(d.duration);
      if (!Number.isInteger(days) || days < 1 || days > 3650) return toast('Enter a duration between 1 and 3650 days', 'error');
      try {
        const r = await post('/api/admin/licenses', { days, count: Number(d.count), label: d.label });
        state.newKeys = r.keys;
        state.licenses = r.licenses.concat(state.licenses);
        state.licFilter = 'all';
        renderLicenses();
        toast(`${r.keys.length} license key${r.keys.length > 1 ? 's' : ''} generated`);
      } catch (err) {
        toast(err.message, 'error');
      }
    }
  });

  show(tab);
  return m;
}
