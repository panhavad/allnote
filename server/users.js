import { db } from './db.js';
import { newId, now } from './security.js';

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MIN_PASSWORD = 8;

export const getUserByEmail = (email) => db.prepare('SELECT * FROM users WHERE email = ?').get(email);
export const getUserById = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);

// The first account ever created becomes the (approved) admin; this is decided atomically inside the INSERT.
const qInsert = db.prepare(`INSERT INTO users
  (id, email, name, avatar, password_hash, google_id, created_at, is_admin, approved, tour_done, expires_at)
  VALUES (:id, :email, :name, :avatar, :hash, :gid, :t,
          NOT EXISTS (SELECT 1 FROM users), (NOT EXISTS (SELECT 1 FROM users)) OR :approved, 0, :exp)`);

export function createUser({ email, name, avatar = null, passwordHash = null, googleId = null, approved = true, expiresAt = null }) {
  const id = newId();
  qInsert.run({
    id,
    email,
    name: String(name || email.split('@')[0]).trim().slice(0, 80) || email.split('@')[0],
    avatar,
    hash: passwordHash,
    gid: googleId,
    t: now(),
    approved: approved ? 1 : 0,
    exp: expiresAt ?? null,
  });
  return getUserById(id);
}
