// Core features (unchanged behaviour from v1.0, kept as a backward-compatibility suite).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, setupAdmin, totp } from './helpers.js';

let srv;
before(async () => {
  srv = await startServer();
  const admin = await setupAdmin(srv);
  // These suites cover self-service sign up, so let new accounts in without manual approval.
  await admin('PUT', '/api/admin/settings', { requireApproval: false });
});
after(() => srv?.stop());

test('server TOTP matches the RFC 6238 SHA-1 test vector', async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'allnote-unit-'));
  const { totpCode, base32Encode } = await import('../server/security.js');
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(totpCode(secret, 59_000), '287082');
  assert.equal(totpCode(secret, 1111111109_000), '081804');
});

test('auth, two-factor login and recovery codes', async () => {
  const a = srv.client();
  assert.equal((await a('POST', '/api/auth/register', { email: 'a@x.io', password: 'password123', name: 'A' })).status, 200);
  const { data: setup } = await a('POST', '/api/account/2fa/setup');
  assert.equal((await a('POST', '/api/account/2fa/enable', { code: '000000' })).status, 400);
  const { data: enabled } = await a('POST', '/api/account/2fa/enable', { code: totp(setup.secret) });
  assert.equal(enabled.recoveryCodes.length, 8);

  const b = srv.client();
  const login = await b('POST', '/api/auth/login', { email: 'a@x.io', password: 'password123' });
  assert.equal(login.data.twoFactorRequired, true);
  assert.equal((await b('GET', '/api/notes')).status, 401, 'pending 2FA session must not access data');
  assert.equal((await b('POST', '/api/auth/2fa', { code: '123456' })).status, 401);
  assert.equal((await b('POST', '/api/auth/2fa', { code: enabled.recoveryCodes[0] })).status, 200);
  assert.equal((await b('GET', '/api/notes')).status, 200);

  const c = srv.client();
  await c('POST', '/api/auth/login', { email: 'a@x.io', password: 'password123' });
  assert.equal((await c('POST', '/api/auth/2fa', { code: enabled.recoveryCodes[0] })).status, 401, 'recovery codes are single use');
  assert.equal((await c('POST', '/api/auth/2fa', { code: totp(setup.secret) })).status, 200);
});

test('notes: optimistic versioning, sharing roles and history', async () => {
  const owner = srv.client();
  const guest = srv.client();
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
  const owner = srv.client();
  await owner('POST', '/api/auth/register', { email: 'p@x.io', password: 'password123', name: 'P' });
  const { data: { note } } = await owner('POST', '/api/notes', { title: 'Public', content: 'hello world' });
  const { data } = await owner('PUT', `/api/notes/${note.id}/publish`, { published: true, pin: '2468' });
  const slug = data.note.publication.slug;

  const visitor = srv.client();
  const locked = await visitor('GET', `/api/public/${slug}`);
  assert.equal(locked.status, 401);
  assert.equal(locked.data.pinRequired, true);
  assert.equal(locked.data.content, undefined, 'content not leaked before unlock');
  assert.equal((await visitor('POST', `/api/public/${slug}/unlock`, { pin: '1111' })).status, 401);
  assert.equal((await visitor('POST', `/api/public/${slug}/unlock`, { pin: '2468' })).status, 200);
  assert.equal((await visitor('GET', `/api/public/${slug}`)).data.content, 'hello world');

  await owner('PUT', `/api/notes/${note.id}/publish`, { published: true, pin: '9999' });
  assert.equal((await visitor('GET', `/api/public/${slug}`)).status, 401, 'changing the PIN revokes earlier unlocks');

  const brute = srv.client();
  for (let i = 0; i < 5; i++) await brute('POST', `/api/public/${slug}/unlock`, { pin: `000${i}` });
  assert.equal((await brute('POST', `/api/public/${slug}/unlock`, { pin: '9999' })).status, 429, 'PIN attempts are rate limited');

  await owner('PUT', `/api/notes/${note.id}/publish`, { published: false });
  assert.equal((await visitor('GET', `/api/public/${slug}`)).status, 404);
});

test('drag and drop: reorder notes, move them in and out of folders, move folders', async () => {
  const me = srv.client();
  await me('POST', '/api/auth/register', { email: 'dnd@x.io', password: 'password123', name: 'Dnd' });
  const mk = async (title, notebook) => (await me('POST', '/api/notes', { title, notebook })).data.note;
  const a = await mk('A', 'Work');
  const b = await mk('B', 'Work');
  const c = await mk('C', '');

  const r = await me('POST', '/api/notes/reorder', { notebook: 'Work', ids: [c.id, b.id, a.id] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.notes.map((n) => [n.title, n.notebook, n.position]), [['C', 'Work', 0], ['B', 'Work', 1], ['A', 'Work', 2]]);
  assert.equal(r.data.notes[2].version, a.version, 'arranging never creates a new content version');

  await me('POST', '/api/notes/reorder', { notebook: '', ids: [a.id] });
  const byId = async () => Object.fromEntries((await me('GET', '/api/notes')).data.notes.map((n) => [n.id, n]));
  assert.equal((await byId())[a.id].notebook, '', 'dragged out of the folder');

  const d = await mk('D', 'Work/Sub');
  const mv = await me('POST', '/api/notes/move-folder', { from: 'Work', to: 'Archive/Work' });
  assert.equal(mv.status, 200);
  const after = await byId();
  assert.deepEqual([after[b.id].notebook, after[c.id].notebook, after[d.id].notebook], ['Archive/Work', 'Archive/Work', 'Archive/Work/Sub']);
  assert.equal(after[a.id].notebook, '', 'notes outside the folder are untouched');
  assert.equal((await me('POST', '/api/notes/move-folder', { from: 'Archive', to: 'Archive/Work/Deeper' })).status, 400, 'no folder inside itself');
  assert.equal((await me('POST', '/api/notes/move-folder', { from: 'Nope', to: 'X' })).status, 404);
  assert.equal((await me('POST', '/api/notes/reorder', { notebook: 'X', ids: [a.id, a.id] })).status, 400, 'duplicate ids rejected');

  const fo = await me('PUT', '/api/account/folder-order', { order: ['Archive', 'Daily'] });
  assert.deepEqual(fo.data.user.folderOrder, ['Archive', 'Daily']);
  assert.deepEqual((await me('GET', '/api/auth/me')).data.user.folderOrder, ['Archive', 'Daily']);

  const other = srv.client();
  await other('POST', '/api/auth/register', { email: 'dnd2@x.io', password: 'password123' });
  await me('POST', `/api/notes/${b.id}/shares`, { email: 'dnd2@x.io', role: 'editor' });
  assert.equal((await other('POST', '/api/notes/reorder', { notebook: 'Mine', ids: [b.id] })).status, 403, 'collaborators cannot move the owner notes');
  assert.equal((await other('POST', '/api/notes/move-folder', { from: 'Archive', to: 'Stolen' })).status, 404, 'folders are per owner');
  assert.equal((await byId())[b.id].notebook, 'Archive/Work');
});

test('Google SSO is configured by the admin in the UI and the secret never leaves the server', async () => {
  const admin = srv.client();
  await admin('POST', '/api/auth/login', { email: 'admin@x.io', password: 'password123' });
  const anon = srv.client();
  assert.equal((await fetch(`${srv.base}/auth/google`, { redirect: 'manual' })).status, 404);
  const saved = await admin('PUT', '/api/admin/settings', { google: { clientId: 'cid.apps.googleusercontent.com', clientSecret: 'GOCSPX-test' } });
  assert.equal(saved.data.google.enabled, true);
  assert.ok(!JSON.stringify(saved.data).includes('GOCSPX-test'), 'secret is never sent back');
  assert.equal((await anon('GET', '/api/config')).data.google, true);
  const go = await fetch(`${srv.base}/auth/google`, { redirect: 'manual' });
  const loc = new URL(go.headers.get('location'));
  assert.equal(loc.searchParams.get('client_id'), 'cid.apps.googleusercontent.com');
  assert.equal(loc.searchParams.get('redirect_uri'), `${srv.base}/auth/google/callback`);
  const kept = await admin('PUT', '/api/admin/settings', { google: { clientId: 'cid2', clientSecret: '' } });
  assert.equal(kept.data.google.enabled, true, 'empty secret keeps the stored one');
  assert.equal((await admin('PUT', '/api/admin/settings', { google: null })).data.google.enabled, false);
});
