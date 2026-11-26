// Backward compatibility: a database created by v1.0 (before admins, approvals, expiry and licenses) upgrades in place.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startServer } from './helpers.js';

const hash = (plain) => {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${crypto.scryptSync(plain, salt, 32, { N: 16384, r: 8, p: 1 }).toString('hex')}`;
};

let srv;
before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'allnote-legacy-'));
  const db = new DatabaseSync(path.join(dir, 'allnote.db'));
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL DEFAULT '', avatar TEXT,
      password_hash TEXT, google_id TEXT UNIQUE, totp_secret TEXT, totp_enabled INTEGER NOT NULL DEFAULT 0, recovery_codes TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, stage TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE notes (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, title TEXT NOT NULL DEFAULT '', content TEXT NOT NULL DEFAULT '',
      notebook TEXT NOT NULL DEFAULT '', pinned INTEGER NOT NULL DEFAULT 0, trashed INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT);
  `);
  const ins = db.prepare('INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)');
  ins.run('u-old', 'first@x.io', 'First', hash('password123'), 1000);
  ins.run('u-new', 'second@x.io', 'Second', hash('password123'), 2000);
  db.prepare('INSERT INTO notes (id, owner_id, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('n1', 'u-new', 'Legacy note', 'kept', 3000, 3000);
  db.prepare('INSERT INTO sessions (id, user_id, stage, expires_at, created_at) VALUES (?, ?, ?, ?, ?)').run('legacy-session', 'u-new', 'full', Date.now() + 86_400_000, Date.now());
  db.close();
  srv = await startServer({ dataDir: dir });
});
after(() => srv?.stop());

test('v1.0 database upgrades without losing accounts, sessions or notes', async () => {
  const first = srv.client();
  const a = await first('POST', '/api/auth/login', { email: 'first@x.io', password: 'password123' });
  assert.equal(a.status, 200);
  assert.equal(a.data.user.isAdmin, true, 'the earliest existing account becomes the admin');
  assert.equal(a.data.user.tourDone, true, 'existing users are not forced through the tour');

  const second = srv.client();
  const b = await second('POST', '/api/auth/login', { email: 'second@x.io', password: 'password123' });
  assert.deepEqual([b.data.user.isAdmin, b.data.user.status, b.data.user.expiresAt], [false, 'active', null], 'existing users stay approved and never expire');
  const notes = (await second('GET', '/api/notes')).data.notes;
  assert.equal(notes.length, 1);
  assert.equal(notes[0].content, 'kept');
  assert.equal(notes[0].position, null, 'existing notes get no manual position until they are dragged');
  assert.deepEqual(b.data.user.folderOrder, []);

  const old = srv.client();
  old.jar.set('an_sid', 'legacy-session');
  assert.equal((await old('GET', '/api/auth/me')).data.user?.email, 'second@x.io', 'sessions issued before the upgrade stay valid');
  assert.equal((await srv.client()('GET', '/api/config')).data.setupRequired, false);
});
