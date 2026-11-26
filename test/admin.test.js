// Administration, approval, expiration, license keys, landing page, tour and versioning.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, setupAdmin, addUser, totp } from './helpers.js';

const DAY = 86_400_000;
let srv;
let admin;
before(async () => {
  srv = await startServer();
});
after(() => srv?.stop());

test('fresh install: setup screen, first account becomes the approved admin', async () => {
  const anon = srv.client();
  const cfg = (await anon('GET', '/api/config')).data;
  assert.equal(cfg.setupRequired, true);
  assert.equal(cfg.approvalRequired, true);
  assert.match(cfg.version, /^\d+\.\d+\.\d+$/);
  assert.match(cfg.build, /^[0-9a-f]{12}$/);
  const home = await fetch(`${srv.base}/`);
  assert.match(await home.text(), /id="auth"/, 'no landing page before the admin exists');
  admin = await setupAdmin(srv);
  const me = (await admin('GET', '/api/auth/me')).data.user;
  assert.deepEqual([me.isAdmin, me.status, me.tourDone], [true, 'active', false]);
  assert.equal((await anon('GET', '/api/config')).data.setupRequired, false);
});

test('new sign ups wait for approval: they can sign in but every feature is blocked', async () => {
  const u = srv.client();
  const reg = await u('POST', '/api/auth/register', { email: 'new@x.io', password: 'password123', name: 'New' });
  assert.equal(reg.status, 200);
  assert.equal(reg.data.user.status, 'pending');
  assert.equal(reg.data.user.isAdmin, false);
  assert.equal((await u('GET', '/api/auth/me')).data.user.status, 'pending', 'pending users stay signed in');
  const blocked = await u('GET', '/api/notes');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.code, 'account_pending');
  assert.equal((await u('POST', '/api/notes', { title: 'x' })).status, 403);
  assert.equal((await u('PUT', '/api/account', { name: 'Hacker' })).status, 403);
  assert.equal((await u('POST', '/api/account/2fa/setup')).status, 403);
  assert.equal((await u('GET', '/api/events')).status, 403);
  assert.equal((await admin('GET', '/api/admin/summary')).data.pending, 1);

  const id = reg.data.user.id;
  const ok = await admin('PUT', `/api/admin/users/${id}`, { approved: true });
  assert.equal(ok.data.user.status, 'active');
  assert.equal((await u('GET', '/api/notes')).status, 200, 'approval unlocks the same session');
  assert.equal((await admin('GET', '/api/admin/summary')).data.pending, 0);

  await admin('PUT', `/api/admin/users/${id}`, { approved: false });
  assert.equal((await u('GET', '/api/notes')).status, 403, 'suspending locks again');
  await admin('PUT', `/api/admin/users/${id}`, { approved: true });
});

test('approval can be turned off; sign up can be closed', async () => {
  await admin('PUT', '/api/admin/settings', { requireApproval: false });
  const u = srv.client();
  assert.equal((await u('POST', '/api/auth/register', { email: 'auto@x.io', password: 'password123' })).data.user.status, 'active');
  await admin('PUT', '/api/admin/settings', { requireApproval: true, allowSignup: false });
  assert.equal((await srv.client()('GET', '/api/config')).data.allowSignup, false);
  assert.equal((await srv.client()('POST', '/api/auth/register', { email: 'late@x.io', password: 'password123' })).status, 403);
  await admin('PUT', '/api/admin/settings', { allowSignup: true });
});

test('expiration: expired users can sign in but are locked until renewed', async () => {
  const { c, user } = await addUser(srv, admin, { email: 'exp@x.io', expiresAt: Date.now() + 30 * DAY });
  assert.equal(user.status, 'active');
  assert.equal((await c('POST', '/api/notes', { title: 'mine' })).status, 201);

  await admin('PUT', `/api/admin/users/${user.id}`, { expiresAt: Date.now() - 1000 });
  const me = (await c('GET', '/api/auth/me')).data.user;
  assert.equal(me.status, 'expired');
  const r = await c('GET', '/api/notes');
  assert.equal(r.status, 403);
  assert.equal(r.data.code, 'account_expired');

  const fresh = srv.client();
  const login = await fresh('POST', '/api/auth/login', { email: 'exp@x.io', password: 'password123' });
  assert.equal(login.data.user.status, 'expired', 'expired users can still sign in');

  const before = Date.now();
  const renewed = await admin('PUT', `/api/admin/users/${user.id}`, { extendDays: 30 });
  assert.equal(renewed.data.user.status, 'active');
  assert.ok(Math.abs(renewed.data.user.expiresAt - (before + 30 * DAY)) < 5000, 'renewing an expired account counts from today');
  const again = await admin('PUT', `/api/admin/users/${user.id}`, { extendDays: 10 });
  assert.ok(Math.abs(again.data.user.expiresAt - (renewed.data.user.expiresAt + 10 * DAY)) < 5, 'renewing an active account extends its current date');
  assert.equal((await c('GET', '/api/notes')).data.notes.length, 1, 'notes survive expiration');
  assert.equal((await admin('PUT', `/api/admin/users/${user.id}`, { expiresAt: null })).data.user.expiresAt, null);
});

test('license keys: generate, redeem once, extend, revoke', async () => {
  const gen = await admin('POST', '/api/admin/licenses', { days: 45, count: 3, label: 'Order 7' });
  assert.equal(gen.status, 201);
  assert.equal(gen.data.keys.length, 3);
  for (const k of gen.data.keys) assert.match(k, /^[A-HJ-NP-Z2-9]{5}(-[A-HJ-NP-Z2-9]{5}){3}$/);
  const [k1, k2, k3] = gen.data.keys;

  const { c, user } = await addUser(srv, admin, { email: 'lic@x.io', expiresAt: Date.now() - DAY });
  assert.equal((await c('GET', '/api/notes')).status, 403);
  const t0 = Date.now();
  const red = await c('POST', '/api/account/license', { key: ` ${k1.toLowerCase().replaceAll('-', ' ')} ` });
  assert.equal(red.status, 200, JSON.stringify(red.data));
  assert.equal(red.data.days, 45);
  assert.equal(red.data.user.status, 'active');
  assert.ok(Math.abs(red.data.user.expiresAt - (t0 + 45 * DAY)) < 5000);
  assert.equal((await c('GET', '/api/notes')).status, 200, 'license unlocks the account');

  const reuse = await c('POST', '/api/account/license', { key: k1 });
  assert.equal(reuse.status, 400, 'a key can only be redeemed once');
  const ext = await c('POST', '/api/account/license', { key: k2 });
  assert.ok(Math.abs(ext.data.user.expiresAt - (red.data.user.expiresAt + 45 * DAY)) < 5, 'stacks on top of the current expiry');

  assert.equal((await admin('DELETE', `/api/admin/licenses/${k3}`)).data.license.status, 'revoked');
  assert.equal((await c('POST', '/api/account/license', { key: k3 })).status, 400, 'revoked keys are rejected');
  assert.equal((await admin('DELETE', `/api/admin/licenses/${k1}`)).status, 400, 'redeemed keys cannot be revoked');

  const list = (await admin('GET', '/api/admin/licenses')).data.licenses;
  const byKey = Object.fromEntries(list.map((l) => [l.key, l]));
  assert.equal(byKey[k1].status, 'redeemed');
  assert.equal(byKey[k1].redeemedBy, 'lic@x.io');
  assert.equal(byKey[k3].status, 'revoked');
  assert.equal(byKey[k1].label, 'Order 7');

  const neverExpires = (await addUser(srv, admin, { email: 'forever@x.io' })).c;
  const k4 = (await admin('POST', '/api/admin/licenses', { days: 7 })).data.keys[0];
  assert.equal((await neverExpires('POST', '/api/account/license', { key: k4 })).status, 400, 'no license needed for accounts without expiry');
  assert.equal((await admin('POST', '/api/account/license', { key: k4 })).status, 400, 'admins never expire');
  assert.ok(user.id);
});

test('admin user management: add, reset password, reset 2FA, remove', async () => {
  const add = await admin('POST', '/api/admin/users', { email: 'Added@X.io', name: 'Added', password: 'password123' });
  assert.equal(add.status, 201);
  assert.equal(add.data.user.email, 'added@x.io');
  assert.equal(add.data.user.status, 'active', 'admin-created users are approved');
  assert.equal((await admin('POST', '/api/admin/users', { email: 'added@x.io', password: 'password123' })).status, 409);
  const id = add.data.user.id;

  const u = srv.client();
  await u('POST', '/api/auth/login', { email: 'added@x.io', password: 'password123' });
  const { data: setup } = await u('POST', '/api/account/2fa/setup');
  await u('POST', '/api/account/2fa/enable', { code: totp(setup.secret) });
  await u('POST', '/api/notes', { title: 'to be deleted' });

  const reset = await admin('POST', `/api/admin/users/${id}/password`, { password: 'newpass456' });
  assert.equal(reset.status, 200);
  assert.equal((await u('GET', '/api/auth/me')).data.user, null, 'password reset signs the user out everywhere');
  const old = await srv.client()('POST', '/api/auth/login', { email: 'added@x.io', password: 'password123' });
  assert.equal(old.status, 401);

  assert.equal((await admin('POST', `/api/admin/users/${id}/reset-2fa`)).data.user.twoFactorEnabled, false);
  const u2 = srv.client();
  const login = await u2('POST', '/api/auth/login', { email: 'added@x.io', password: 'newpass456' });
  assert.equal(login.data.user.email, 'added@x.io', 'after 2FA reset the password alone signs in');

  assert.equal((await admin('DELETE', `/api/admin/users/${id}`)).status, 200);
  assert.equal((await u2('GET', '/api/auth/me')).data.user, null, 'removed users lose their sessions');
  const users = (await admin('GET', '/api/admin/users')).data.users;
  assert.ok(!users.some((x) => x.id === id));
});

test('tour flag, landing page toggle, version and cache headers', async () => {
  const { c } = await addUser(srv, admin, { email: 'tour@x.io' });
  assert.equal((await c('GET', '/api/auth/me')).data.user.tourDone, false, 'new users get the onboarding tour');
  assert.equal((await c('POST', '/api/account/tour', { done: true })).data.user.tourDone, true);
  assert.equal((await c('POST', '/api/account/tour', { done: false })).data.user.tourDone, false, 'tour can be replayed');

  const landing = await fetch(`${srv.base}/`);
  assert.match(await landing.text(), /class="landing"/, 'anonymous visitors see the landing page by default');
  assert.equal(landing.headers.get('cache-control'), 'no-store');
  assert.match(landing.headers.get('x-app-build'), /^[0-9a-f]{12}$/);
  const signedIn = await fetch(`${srv.base}/`, { headers: { Cookie: [...c.jar].map(([k, v]) => `${k}=${v}`).join('; ') } });
  assert.match(await signedIn.text(), /id="app"/, 'signed-in users get the app');
  assert.match(await (await fetch(`${srv.base}/login`)).text(), /id="auth"/);

  await admin('PUT', '/api/admin/settings', { landingPage: false });
  assert.equal((await srv.client()('GET', '/api/config')).data.landing, false);
  assert.match(await (await fetch(`${srv.base}/`)).text(), /id="auth"/, 'landing disabled: straight to sign in');
  assert.match(await (await fetch(`${srv.base}/welcome`)).text(), /class="landing"/, 'admins can still preview it');
  await admin('PUT', '/api/admin/settings', { landingPage: true });

  const css = await fetch(`${srv.base}/css/app.css`);
  assert.equal(css.headers.get('cache-control'), 'no-cache', 'assets are revalidated on every load');
  assert.ok(css.headers.get('etag'));
  assert.equal((await srv.client()('GET', '/api/config')).headers.get('cache-control'), 'no-store');
});
