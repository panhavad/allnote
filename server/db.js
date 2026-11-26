import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR } from './config.js';

export const db = new DatabaseSync(path.join(DATA_DIR, 'allnote.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  avatar TEXT,
  password_hash TEXT,
  google_id TEXT UNIQUE,
  totp_secret TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  recovery_codes TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  notebook TEXT NOT NULL DEFAULT '',
  pinned INTEGER NOT NULL DEFAULT 0,
  trashed INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);
CREATE INDEX IF NOT EXISTS notes_owner ON notes(owner_id);

CREATE TABLE IF NOT EXISTS note_shares (
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('viewer', 'editor')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (note_id, user_id)
);
CREATE INDEX IF NOT EXISTS note_shares_user ON note_shares(user_id);

CREATE TABLE IF NOT EXISTS note_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  version INTEGER NOT NULL,
  author_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS note_history_note ON note_history(note_id, id);

CREATE TABLE IF NOT EXISTS publications (
  note_id TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
  slug TEXT UNIQUE NOT NULL,
  pin_hash TEXT,
  pin_version INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS licenses (
  key TEXT PRIMARY KEY,
  days INTEGER NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  redeemed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  redeemed_email TEXT,
  redeemed_at INTEGER,
  revoked INTEGER NOT NULL DEFAULT 0
);
`);

// Backward-compatible migrations: only ever ADD columns, with defaults that keep existing accounts working.
const userCols = new Set(db.prepare('PRAGMA table_info(users)').all().map((c) => c.name));
const addUserCol = (name, def) => {
  if (!userCols.has(name)) db.exec(`ALTER TABLE users ADD COLUMN ${name} ${def}`);
};
addUserCol('is_admin', 'INTEGER NOT NULL DEFAULT 0');
addUserCol('approved', 'INTEGER NOT NULL DEFAULT 1'); // accounts that existed before approvals stay approved
addUserCol('expires_at', 'INTEGER'); // NULL = never expires
addUserCol('tour_done', 'INTEGER NOT NULL DEFAULT 1'); // existing users skip the onboarding tour; new users get 0
addUserCol('folder_order', 'TEXT'); // JSON array of folder paths in the user's custom order

// Manual note order inside a folder (drag and drop). NULL = not placed yet, sorted after placed notes.
if (!db.prepare('PRAGMA table_info(notes)').all().some((c) => c.name === 'position')) {
  db.exec('ALTER TABLE notes ADD COLUMN position REAL');
}

// Existing installs without an admin: the earliest account becomes the admin.
if (!db.prepare('SELECT 1 FROM users WHERE is_admin = 1').get()) {
  db.prepare('UPDATE users SET is_admin = 1, approved = 1 WHERE id = (SELECT id FROM users ORDER BY created_at, rowid LIMIT 1)').run();
}

export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
