// Security tests: access control, locked accounts, brute force limits, CSRF, headers, secrets and input validation.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, setupAdmin, addUser } from './helpers.js';

let srv;
let admin;
let user;
let userId;
before(async () => {
  srv = await startServer();
  admin = await setupAdmin(srv);
  ({ c: user, user: { id: userId } } = await addUser(srv, admin, { email: 'user@x.io' }));
});
after(() => srv?.stop());

const ADMIN_ENDPOINTS = [
  ['GET', '/api/admin/settings'], ['PUT', '/api/admin/settings', { allowSignup: false }], ['GET', '/api/admin/summary'],
  ['GET', '/api/admin/users'], ['POST', '/api/admin/users', { email: 'z@x.io', password: 'password123' }],
  ['PUT', '/api/admin/users/ID', { approved: true }], ['DELETE', '/api/admin/users/ID'],
  ['POST', '/api/admin/users/ID/password', { password: 'password123' }], ['POST', '/api/admin/users/ID/reset-2fa'],
  ['GET', '/api/admin/licenses'], ['POST', '/api/admin/licenses', { days: 30 }], ['DELETE', '/api/admin/licenses/KEY'],
];

test('admin API: anonymous gets 401, normal users get 403 on every endpoint', async () => {
  const anon = srv.client();
  for (const [method, url, body] of ADMIN_ENDPOINTS) {
    const u = url.replace('ID', userId);
    assert.equal((await anon(method, u, body)).status, 401, `${method} ${u} anonymous`);
    assert.equal((await user(method, u, body)).status, 403, `${method} ${u} as normal user`);
  }
  assert.equal((await admin('GET', '/api/auth/me')).data.user.isAdmin, true);
  assert.equal((await user('GET', '/api/auth/me')).data.user.status, 'active', 'user was not modified by the attempts');
});

test('users cannot make themselves admin or approve themselves through account endpoints', async () => {
  await user('PUT', '/api/account', { name: 'Me', isAdmin: true, is_admin: 1, approved: 1, expires_at: null });
  const me = (await user('GET', '/api/auth/me')).data.user;
  assert.equal(me.isAdmin, false);
  const reg = await srv.client()('POST', '/api/auth/register', { email: 'sneaky@x.io', password: 'password123', isAdmin: true, approved: true });
  assert.equal(reg.data.user.isAdmin, false);
  assert.equal(reg.data.user.status, 'pending');
});

test('admins cannot lock out, expire or delete themselves or other admins', async () => {
  const adminId = (await admin('GET', '/api/auth/me')).data.user.id;
  assert.equal((await admin('DELETE', `/api/admin/users/${adminId}`)).status, 400);
  assert.equal((await admin('PUT', `/api/admin/users/${adminId}`, { expiresAt: 1 })).status, 400);
  assert.equal((await admin('PUT', `/api/admin/users/${adminId}`, { approved: false })).status, 400);
  assert.equal((await admin('POST', `/api/admin/users/${adminId}/password`, { password: 'password999' })).status, 400);
  assert.equal((await admin('GET', '/api/notes')).status, 200);
  assert.equal((await admin('PUT', '/api/admin/users/does-not-exist', { approved: true })).status, 404);
});

test('locked accounts are blocked from every feature endpoint, including the live event stream', async () => {
  const { c, user: u } = await addUser(srv, admin, { email: 'locked@x.io' });
  const { data: { note } } = await c('POST', '/api/notes', { title: 'n' });
  await admin('PUT', `/api/admin/users/${u.id}`, { expiresAt: Date.now() - 1 });
  const calls = [
    ['GET', '/api/notes'], ['POST', '/api/notes', { title: 'x' }], ['PUT', `/api/notes/${note.id}`, { title: 'y', baseVersion: 1 }],
    ['DELETE', `/api/notes/${note.id}`], ['GET', `/api/notes/${note.id}/history`], ['GET', `/api/notes/${note.id}/shares`],
    ['POST', `/api/notes/${note.id}/shares`, { email: 'user@x.io' }], ['POST', `/api/notes/${note.id}/presence`, { state: 'viewing' }],
    ['PUT', `/api/notes/${note.id}/publish`, { published: true }], ['GET', '/api/events'],
    ['PUT', '/api/account', { name: 'z' }], ['POST', '/api/account/password', { currentPassword: 'password123', newPassword: 'password456' }],
    ['POST', '/api/account/2fa/setup'],
  ];
  for (const [method, url, body] of calls) {
    const r = await c(method, url, body);
    assert.equal(r.status, 403, `${method} ${url}`);
    assert.equal(r.data.code, 'account_expired');
  }
  assert.equal((await c('GET', '/api/auth/me')).status, 200, 'can still see their status');
  assert.equal((await c('POST', '/api/auth/logout')).status, 200, 'can still sign out');
});

test('an open event stream stops delivering notes once the account expires', async () => {
  const { c: owner } = await addUser(srv, admin, { email: 'stream-owner@x.io' });
  const { c: guest } = await addUser(srv, admin, { email: 'stream-guest@x.io', expiresAt: Date.now() + 1500 });
  const { data: { note } } = await owner('POST', '/api/notes', { title: 'shared', content: 'v1' });
  await owner('POST', `/api/notes/${note.id}/shares`, { email: 'stream-guest@x.io', role: 'viewer' });

  const ctrl = new AbortController();
  const res = await fetch(`${srv.base}/api/events`, { headers: { Cookie: [...guest.jar].map(([k, v]) => `${k}=${v}`).join('; ') }, signal: ctrl.signal });
  assert.equal(res.status, 200, 'stream opens while the account is active');
  let received = '';
  const reading = (async () => {
    const dec = new TextDecoder();
    try {
      for await (const chunk of res.body) received += dec.decode(chunk);
    } catch { /* aborted */ }
  })();

  await new Promise((r) => setTimeout(r, 1800)); // the guest's account expires
  await owner('PUT', `/api/notes/${note.id}`, { content: 'SECRET AFTER EXPIRY', baseVersion: note.version });
  await Promise.race([reading, new Promise((r) => setTimeout(r, 1000))]);
  ctrl.abort();
  assert.ok(!received.includes('SECRET AFTER EXPIRY'), 'no note content is pushed to an expired account');
  assert.match(received, /event: account/, 'the client is told to re-check its account');
});

test('brute force limits: license keys and passwords', async () => {
  const { c } = await addUser(srv, admin, { email: 'brute@x.io', expiresAt: Date.now() - 1 });
  for (let i = 0; i < 10; i++) assert.equal((await c('POST', '/api/account/license', { key: `AAAAA-AAAAA-AAAAA-AAA${String(i).padStart(2, '0')}` })).status, 400);
  assert.equal((await c('POST', '/api/account/license', { key: 'AAAAA' })).status, 429, 'license guessing is rate limited');

  const anon = srv.client();
  for (let i = 0; i < 10; i++) await anon('POST', '/api/auth/login', { email: 'user@x.io', password: `wrong${i}` });
  assert.equal((await anon('POST', '/api/auth/login', { email: 'user@x.io', password: 'password123' })).status, 429, 'login is rate limited');
});

test('CSRF: cross-origin state-changing requests are rejected, including admin actions', async () => {
  const evil = { Origin: 'https://evil.example' };
  assert.equal((await user('POST', '/api/notes', { title: 'x' }, evil)).status, 403);
  assert.equal((await admin('PUT', '/api/admin/settings', { allowSignup: false }, evil)).status, 403);
  assert.equal((await admin('POST', '/api/admin/licenses', { days: 1 }, evil)).status, 403);
  assert.equal((await admin('DELETE', `/api/admin/users/${userId}`, undefined, evil)).status, 403);
  assert.equal((await admin('GET', '/api/admin/settings')).data.allowSignup, true, 'settings unchanged');
});

test('security headers and cookie flags', async () => {
  for (const url of ['/', '/login', '/api/config', '/css/app.css']) {
    const r = await fetch(srv.base + url);
    assert.match(r.headers.get('content-security-policy'), /default-src 'self'; script-src 'self'/, url);
    assert.equal(r.headers.get('x-frame-options'), 'DENY', url);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff', url);
    assert.ok(r.headers.get('referrer-policy'), url);
    assert.equal(r.headers.get('x-powered-by'), null, url);
  }
  const r = await srv.client()('POST', '/api/auth/login', { email: 'admin@x.io', password: 'password123' });
  const cookie = r.headers.getSetCookie().find((c) => c.startsWith('an_sid='));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
});

test('secrets: Google client secret, password hashes and TOTP secrets are never exposed', async () => {
  await admin('PUT', '/api/admin/settings', { google: { clientId: 'cid', clientSecret: 'TOP-SECRET-VALUE' } });
  const payloads = [
    await admin('GET', '/api/admin/settings'), await admin('GET', '/api/admin/users'), await srv.client()('GET', '/api/config'),
    await admin('GET', '/api/auth/me'), await user('GET', '/api/auth/me'),
  ];
  for (const p of payloads) {
    const s = JSON.stringify(p.data);
    assert.ok(!s.includes('TOP-SECRET-VALUE'));
    assert.ok(!/password_hash|scrypt\$|totp_secret|recovery_codes/.test(s));
  }
  await admin('PUT', '/api/admin/settings', { google: null });
});

test('input validation and injection attempts are rejected cleanly', async () => {
  const bad = [
    ['POST', '/api/admin/users', { email: 'not-an-email', password: 'password123' }],
    ['POST', '/api/admin/users', { email: 'short@x.io', password: '123' }],
    ['POST', '/api/admin/users', { email: 'ts@x.io', password: 'password123', expiresAt: 'tomorrow' }],
    ['PUT', `/api/admin/users/${userId}`, { expiresAt: -5 }],
    ['PUT', `/api/admin/users/${userId}`, { extendDays: 0 }],
    ['PUT', `/api/admin/users/${userId}`, { extendDays: 99999 }],
    ['POST', '/api/admin/licenses', { days: 0 }],
    ['POST', '/api/admin/licenses', { days: 30, count: 1000 }],
    ['POST', '/api/admin/licenses', { days: 'DROP TABLE users' }],
    ['PUT', '/api/admin/settings', { google: { clientId: 'x'.repeat(400) } }],
  ];
  for (const [m, u, b] of bad) assert.equal((await admin(m, u, b)).status, 400, `${m} ${u} ${JSON.stringify(b).slice(0, 60)}`);
  const inj = await srv.client()('POST', '/api/auth/login', { email: "' OR 1=1 --", password: "' OR '1'='1" });
  assert.equal(inj.status, 401);
  const lic = await user('POST', '/api/account/license', { key: "' OR 1=1 --" });
  assert.ok([400, 429].includes(lic.status));
  assert.equal((await admin('GET', '/api/admin/users')).data.users.length >= 2, true, 'users table intact');
  const html = await admin('POST', '/api/admin/users', { email: 'xss@x.io', name: '<img src=x onerror=alert(1)>', password: 'password123' });
  assert.equal(html.data.user.name, '<img src=x onerror=alert(1)>', 'stored verbatim as data; the UI escapes it on render');
});

test('path traversal and unknown routes do not leak files', async () => {
  for (const url of ['/vendor/..%2f..%2fpackage.json', '/%2e%2e/server/config.js', '/css/..%2f..%2fdata%2fallnote.db', '/.session_secret']) {
    const r = await fetch(srv.base + url);
    const body = await r.text();
    assert.ok(!/"dependencies"|sessionSecret|SQLite format/.test(body), url);
  }
  assert.equal((await fetch(`${srv.base}/api/does-not-exist`)).status, 404);
});
