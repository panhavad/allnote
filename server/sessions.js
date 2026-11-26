import { db } from './db.js';
import { config } from './config.js';
import { newId, now, parseCookies, setCookie, clearCookie } from './security.js';

export const SESSION_COOKIE = 'an_sid';
const PENDING_TTL = 10 * 60 * 1000;

// Session columns are aliased so they never collide with users.* (e.g. users.expires_at = account expiry).
const qGet = db.prepare(`
  SELECT u.*, s.id AS sid, s.stage AS session_stage, s.expires_at AS session_expires_at
  FROM sessions s JOIN users u ON u.id = s.user_id
  WHERE s.id = ?`);
const qInsert = db.prepare('INSERT INTO sessions (id, user_id, stage, expires_at, created_at) VALUES (?, ?, ?, ?, ?)');
const qDelete = db.prepare('DELETE FROM sessions WHERE id = ?');

export function createSession(res, userId, stage = 'full') {
  const id = newId(32);
  const ttl = stage === 'full' ? config.sessionDays * 86400_000 : PENDING_TTL;
  qInsert.run(id, userId, stage, now() + ttl, now());
  setCookie(res, SESSION_COOKIE, id, { maxAgeMs: ttl });
  return id;
}

export function destroySession(req, res) {
  if (req.sessionId) qDelete.run(req.sessionId);
  clearCookie(res, SESSION_COOKIE);
}

export function destroyOtherSessions(userId, keepId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND id <> ?').run(userId, keepId || '');
}

export const destroyAllSessions = (userId) => db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);

export function publicUser(u) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    avatar: u.avatar || null,
    hasPassword: Boolean(u.password_hash),
    google: Boolean(u.google_id),
    twoFactorEnabled: Boolean(u.totp_enabled),
    isAdmin: Boolean(u.is_admin),
    status: accountStatus(u),
    expiresAt: u.expires_at ?? null,
    tourDone: Boolean(u.tour_done),
    createdAt: u.created_at,
  };
}

/** 'active' | 'pending' (waiting for admin approval) | 'expired'. Administrators are always active. */
export function accountStatus(u) {
  if (u.is_admin) return 'active';
  if (!u.approved) return 'pending';
  if (u.expires_at && u.expires_at <= now()) return 'expired';
  return 'active';
}

export function sessionMiddleware(req, _res, next) {
  req.cookies = parseCookies(req.headers.cookie);
  const sid = req.cookies[SESSION_COOKIE];
  if (sid) {
    const row = qGet.get(sid);
    if (row && row.session_expires_at > now()) {
      req.sessionId = row.sid;
      if (row.session_stage === 'full') req.user = row;
      else if (row.session_stage === '2fa') req.pendingUser = row;
    } else if (row) {
      qDelete.run(sid);
    }
  }
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  next();
}

const LOCKED_MESSAGES = {
  pending: 'Your account is waiting for administrator approval',
  expired: 'Your account has expired. Enter a license key or contact your administrator.',
};

/** Signed in AND approved AND not expired. Locked users can sign in but every feature is blocked. */
export function requireActive(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  const status = accountStatus(req.user);
  if (status !== 'active') return res.status(403).json({ error: LOCKED_MESSAGES[status], code: `account_${status}` });
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  if (!req.user.is_admin) return res.status(403).json({ error: 'Admin only' });
  next();
}

setInterval(() => db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now()), 3600_000).unref();
