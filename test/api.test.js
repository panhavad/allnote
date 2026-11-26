import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'allnote-test-'));
let server;

before(async () => {
  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, PUBLIC_URL: BASE },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});

after(async () => {
  if (server && server.exitCode === null) {
    const exited = new Promise((r) => server.once('exit', r));
    server.kill();
    await exited;
  }
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function client() {
  const jar = new Map();
  return async (method, url, body, headers = {}) => {
    const res = await fetch(BASE + url, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      const v = kv.slice(i + 1);
      if (v) jar.set(kv.slice(0, i), v);
      else jar.delete(kv.slice(0, i));
    }
    const text = await res.text();
    return { status: res.status, data: text ? JSON.parse(text) : null };
  };
}

function totp(secret, t = Date.now()) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let val = 0;
  const out = [];
  for (const ch of secret) {
    val = (val << 5) | A.indexOf(ch);
    bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(t / 30000)));
  const h = crypto.createHmac('sha1', Buffer.from(out)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}

test('server TOTP matches the RFC 6238 SHA-1 test vector', async () => {
  process.env.DATA_DIR = dataDir;
  const { totpCode, base32Encode } = await import('../server/security.js');
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(totpCode(secret, 59_000), '287082');
  assert.equal(totpCode(secret, 1111111109_000), '081804');
});

test('first account becomes admin and manages sign-up and Google SSO in settings', async () => {
  const anon = client();
  assert.equal((await anon('GET', '/api/config')).data.setupRequired, true);
  const admin = client();
  assert.equal((await admin('POST', '/api/auth/register', { email: 'admin@x.io', password: 'password123' })).data.user.isAdmin, true);
  const user = client();
  assert.equal((await user('POST', '/api/auth/register', { email: 'user@x.io', password: 'password123' })).data.user.isAdmin, false);
  assert.equal((await anon('GET', '/api/config')).data.setupRequired, false);
  assert.equal((await user('GET', '/api/admin/settings')).status, 403);
  assert.equal((await user('PUT', '/api/admin/settings', { allowSignup: false })).status, 403);

  assert.equal((await fetch(`${BASE}/auth/google`, { redirect: 'manual' })).status, 404);
  const saved = await admin('PUT', '/api/admin/settings', { google: { clientId: 'cid.apps.googleusercontent.com', clientSecret: 'GOCSPX-test' } });
  assert.equal(saved.data.google.enabled, true);
  assert.ok(!JSON.stringify(saved.data).includes('GOCSPX-test'), 'secret is never sent back');
  assert.equal((await anon('GET', '/api/config')).data.google, true);
  const go = await fetch(`${BASE}/auth/google`, { redirect: 'manual' });
  const loc = new URL(go.headers.get('location'));
  assert.equal(loc.searchParams.get('client_id'), 'cid.apps.googleusercontent.com');
  assert.equal(loc.searchParams.get('redirect_uri'), `${BASE}/auth/google/callback`);
  const kept = await admin('PUT', '/api/admin/settings', { google: { clientId: 'cid2', clientSecret: '' } });
  assert.equal(kept.data.google.enabled, true, 'empty secret keeps the stored one');
  assert.equal((await admin('PUT', '/api/admin/settings', { google: null })).data.google.enabled, false);

  await admin('PUT', '/api/admin/settings', { allowSignup: false });
  assert.equal((await client()('POST', '/api/auth/register', { email: 'late@x.io', password: 'password123' })).status, 403);
  await admin('PUT', '/api/admin/settings', { allowSignup: true });
});

test('auth, two-factor login and recovery codes', async () => {
  const a = client();
  assert.equal((await a('POST', '/api/auth/register', { email: 'a@x.io', password: 'password123', name: 'A' })).status, 200);
  const { data: setup } = await a('POST', '/api/account/2fa/setup');
  assert.equal((await a('POST', '/api/account/2fa/enable', { code: '000000' })).status, 400);
  const { data: enabled } = await a('POST', '/api/account/2fa/enable', { code: totp(setup.secret) });
  assert.equal(enabled.recoveryCodes.length, 8);

  const b = client();
  const login = await b('POST', '/api/auth/login', { email: 'a@x.io', password: 'password123' });
  assert.equal(login.data.twoFactorRequired, true);
  assert.equal((await b('GET', '/api/notes')).status, 401, 'pending 2FA session must not access data');
  assert.equal((await b('POST', '/api/auth/2fa', { code: '123456' })).status, 401);
  assert.equal((await b('POST', '/api/auth/2fa', { code: enabled.recoveryCodes[0] })).status, 200);
  assert.equal((await b('GET', '/api/notes')).status, 200);

  const c = client();
  await c('POST', '/api/auth/login', { email: 'a@x.io', password: 'password123' });
  assert.equal((await c('POST', '/api/auth/2fa', { code: enabled.recoveryCodes[0] })).status, 401, 'recovery codes are single use');
  assert.equal((await c('POST', '/api/auth/2fa', { code: totp(setup.secret) })).status, 200);
});

test('notes: optimistic versioning, sharing roles and history', async () => {
  const owner = client();
  const guest = client();
  await owner('POST', '/api/auth/register', { email: 'o@x.io', password: 'password123', name: 'Owner' });
  await guest('POST', '/api/auth/register', { email: 'g@x.io', password: 'password123', name: 'Guest' });

  const { data: { note } } = await owner('POST', '/api/notes', { title: 'T', content: 'one' });
  const v2 = await owner('PUT', `/api/notes/${note.id}`, { content: 'two', baseVersion: note.version });
  assert.equal(v2.data.note.version, note.version + 1);
  const stale = await owner('PUT', `/api/notes/${note.id}`, { content: 'stale', baseVersion: note.version });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.note.content, 'two');

  assert.equal((await guest('PUT', `/api/notes/${note.id}`, { content: 'x', baseVersion: 2 })).status, 404, 'not shared yet');
  await owner('POST', `/api/notes/${note.id}/shares`, { email: 'g@x.io', role: 'viewer' });
  assert.equal((await guest('PUT', `/api/notes/${note.id}`, { content: 'x', baseVersion: 2 })).status, 403, 'viewer cannot edit');
  await owner('POST', `/api/notes/${note.id}/shares`, { email: 'g@x.io', role: 'editor' });
  assert.equal((await guest('PUT', `/api/notes/${note.id}`, { content: 'by guest', baseVersion: 2 })).status, 200);
  assert.equal((await guest('PUT', `/api/notes/${note.id}`, { trashed: true })).status, 403, 'only owner can trash');
  assert.equal((await guest('DELETE', `/api/notes/${note.id}`)).status, 403);

  const { data: { history } } = await owner('GET', `/api/notes/${note.id}/history`);
  assert.ok(history.some((h) => h.content === 'two'), 'previous version kept when another user edits');
});

test('publishing with PIN protection', async () => {
  const owner = client();
  await owner('POST', '/api/auth/register', { email: 'p@x.io', password: 'password123', name: 'P' });
  const { data: { note } } = await owner('POST', '/api/notes', { title: 'Public', content: 'hello world' });
  const { data } = await owner('PUT', `/api/notes/${note.id}/publish`, { published: true, pin: '2468' });
  const slug = data.note.publication.slug;

  const visitor = client();
  const locked = await visitor('GET', `/api/public/${slug}`);
  assert.equal(locked.status, 401);
  assert.equal(locked.data.pinRequired, true);
  assert.equal(locked.data.content, undefined, 'content not leaked before unlock');
  assert.equal((await visitor('POST', `/api/public/${slug}/unlock`, { pin: '1111' })).status, 401);
  assert.equal((await visitor('POST', `/api/public/${slug}/unlock`, { pin: '2468' })).status, 200);
  assert.equal((await visitor('GET', `/api/public/${slug}`)).data.content, 'hello world');

  await owner('PUT', `/api/notes/${note.id}/publish`, { published: true, pin: '9999' });
  assert.equal((await visitor('GET', `/api/public/${slug}`)).status, 401, 'changing the PIN revokes earlier unlocks');

  const brute = client();
  for (let i = 0; i < 5; i++) await brute('POST', `/api/public/${slug}/unlock`, { pin: `000${i}` });
  assert.equal((await brute('POST', `/api/public/${slug}/unlock`, { pin: '9999' })).status, 429, 'PIN attempts are rate limited');

  await owner('PUT', `/api/notes/${note.id}/publish`, { published: false });
  assert.equal((await visitor('GET', `/api/public/${slug}`)).status, 404);
});

test('cross-origin state-changing requests are rejected', async () => {
  const c = client();
  await c('POST', '/api/auth/register', { email: 'csrf@x.io', password: 'password123' });
  const r = await c('POST', '/api/notes', { title: 'x' }, { Origin: 'https://evil.example' });
  assert.equal(r.status, 403);
});
