import express from 'express';
import crypto from 'node:crypto';
import { db, tx } from './db.js';
import { config } from './config.js';
import { now, hashSecret } from './security.js';
import { publicUser, requireAdmin, destroyAllSessions } from './sessions.js';
import { kickUser } from './events.js';
import {
  getSetting, setSetting, googleSettings, googleRedirectUri, approvalRequired, landingEnabled,
} from './settings.js';
import { EMAIL_RE, MIN_PASSWORD, getUserByEmail, getUserById, createUser } from './users.js';
import { BUILD_ID } from './build.js';

export const adminRouter = express.Router();
adminRouter.use('/api/admin', requireAdmin);

const DAY = 86_400_000;
const MAX_DAYS = 3650;
const intIn = (v, min, max) => Number.isInteger(Number(v)) && Number(v) >= min && Number(v) <= max;
const validTimestamp = (v) => Number.isFinite(v) && v > 0 && v < 253_402_300_799_000; // before year 10000

// ---------- settings ----------
function adminSettings(req) {
  const g = googleSettings();
  return {
    allowSignup: getSetting('allow_signup', String(config.allowSignup)) === 'true',
    requireApproval: approvalRequired(),
    landingPage: landingEnabled(),
    version: config.version,
    build: BUILD_ID,
    google: { clientId: g.clientId, hasSecret: Boolean(g.clientSecret), enabled: g.enabled, redirectUri: googleRedirectUri(req) },
  };
}

adminRouter.get('/api/admin/settings', (req, res) => res.json(adminSettings(req)));

adminRouter.put('/api/admin/settings', (req, res) => {
  const { allowSignup, requireApproval, landingPage, google } = req.body || {};
  if (allowSignup !== undefined) setSetting('allow_signup', allowSignup ? 'true' : 'false');
  if (requireApproval !== undefined) setSetting('require_approval', requireApproval ? 'true' : 'false');
  if (landingPage !== undefined) setSetting('landing_page', landingPage ? 'true' : 'false');
  if (google === null) {
    setSetting('google_client_id', '');
    setSetting('google_client_secret', '');
  } else if (google && typeof google === 'object') {
    const clientId = String(google.clientId ?? '').trim();
    const clientSecret = String(google.clientSecret ?? '').trim();
    if (clientId.length > 300 || clientSecret.length > 300) return res.status(400).json({ error: 'Value is too long' });
    setSetting('google_client_id', clientId);
    // Empty secret keeps the stored one, so the admin doesn't have to re-enter it.
    if (clientSecret) setSetting('google_client_secret', clientSecret);
    else if (!clientId) setSetting('google_client_secret', '');
  }
  res.json(adminSettings(req));
});

adminRouter.get('/api/admin/summary', (_req, res) => {
  const pending = db.prepare('SELECT COUNT(*) AS n FROM users WHERE approved = 0 AND is_admin = 0').get().n;
  res.json({ pending });
});

// ---------- users ----------
function adminUser(u) {
  return {
    ...publicUser(u),
    approved: Boolean(u.approved),
    noteCount: db.prepare('SELECT COUNT(*) AS n FROM notes WHERE owner_id = ?').get(u.id).n,
  };
}

function loadTarget(req, res) {
  const u = getUserById(req.params.id);
  if (!u) {
    res.status(404).json({ error: 'User not found' });
    return null;
  }
  if (u.id === req.user.id || u.is_admin) {
    res.status(400).json({ error: 'Administrator accounts are managed from their own Settings' });
    return null;
  }
  return u;
}

adminRouter.get('/api/admin/users', (_req, res) => {
  const users = db.prepare('SELECT * FROM users ORDER BY is_admin DESC, approved ASC, created_at DESC').all();
  res.json({ users: users.map(adminUser) });
});

adminRouter.post('/api/admin/users', (req, res) => {
  const b = req.body || {};
  const email = String(b.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Invalid email' });
  if (typeof b.password !== 'string' || b.password.length < MIN_PASSWORD) return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD} characters` });
  if (b.expiresAt != null && !validTimestamp(b.expiresAt)) return res.status(400).json({ error: 'Invalid expiration date' });
  if (getUserByEmail(email)) return res.status(409).json({ error: 'An account with this email already exists' });
  const user = createUser({ email, name: b.name, passwordHash: hashSecret(b.password), approved: true, expiresAt: b.expiresAt ?? null });
  res.status(201).json({ user: adminUser(user) });
});

adminRouter.put('/api/admin/users/:id', (req, res) => {
  const u = loadTarget(req, res);
  if (!u) return;
  const b = req.body || {};
  if ('expiresAt' in b && b.expiresAt !== null && !validTimestamp(b.expiresAt)) return res.status(400).json({ error: 'Invalid expiration date' });
  if ('extendDays' in b && !intIn(b.extendDays, 1, MAX_DAYS)) return res.status(400).json({ error: `Days must be between 1 and ${MAX_DAYS}` });
  tx(() => {
    if ('approved' in b) db.prepare('UPDATE users SET approved = ? WHERE id = ?').run(b.approved ? 1 : 0, u.id);
    if ('expiresAt' in b) db.prepare('UPDATE users SET expires_at = ? WHERE id = ?').run(b.expiresAt, u.id);
    if ('extendDays' in b) {
      const base = Math.max(now(), u.expires_at || now());
      db.prepare('UPDATE users SET expires_at = ? WHERE id = ?').run(base + Number(b.extendDays) * DAY, u.id);
    }
  });
  kickUser(u.id);
  res.json({ user: adminUser(getUserById(u.id)) });
});

adminRouter.delete('/api/admin/users/:id', (req, res) => {
  const u = loadTarget(req, res);
  if (!u) return;
  db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
  kickUser(u.id);
  res.json({ ok: true });
});

adminRouter.post('/api/admin/users/:id/password', (req, res) => {
  const u = loadTarget(req, res);
  if (!u) return;
  const password = req.body?.password;
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD} characters` });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashSecret(password), u.id);
  destroyAllSessions(u.id);
  kickUser(u.id);
  res.json({ user: adminUser(getUserById(u.id)) });
});

adminRouter.post('/api/admin/users/:id/reset-2fa', (req, res) => {
  const u = loadTarget(req, res);
  if (!u) return;
  db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL, recovery_codes = NULL WHERE id = ?').run(u.id);
  res.json({ user: adminUser(getUserById(u.id)) });
});

// ---------- license keys ----------
const KEY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const newLicenseKey = () => Array.from({ length: 4 }, () => Array.from({ length: 5 }, () => KEY_ALPHABET[crypto.randomInt(KEY_ALPHABET.length)]).join('')).join('-');

const licenseJson = (l) => ({
  key: l.key,
  days: l.days,
  label: l.label,
  createdAt: l.created_at,
  status: l.revoked ? 'revoked' : l.redeemed_at ? 'redeemed' : 'available',
  redeemedBy: l.redeemed_email || null,
  redeemedAt: l.redeemed_at || null,
});

adminRouter.get('/api/admin/licenses', (_req, res) => {
  res.json({ licenses: db.prepare('SELECT * FROM licenses ORDER BY created_at DESC, rowid DESC').all().map(licenseJson) });
});

adminRouter.post('/api/admin/licenses', (req, res) => {
  const { days, count = 1, label = '' } = req.body || {};
  if (!intIn(days, 1, MAX_DAYS)) return res.status(400).json({ error: `Duration must be between 1 and ${MAX_DAYS} days` });
  if (!intIn(count, 1, 100)) return res.status(400).json({ error: 'You can generate 1 to 100 keys at a time' });
  const keys = [];
  tx(() => {
    const ins = db.prepare('INSERT INTO licenses (key, days, label, created_by, created_at) VALUES (?, ?, ?, ?, ?)');
    for (let i = 0; i < Number(count); i++) {
      const key = newLicenseKey();
      ins.run(key, Number(days), String(label).trim().slice(0, 80), req.user.id, now());
      keys.push(key);
    }
  });
  res.status(201).json({ keys, licenses: keys.map((k) => licenseJson(db.prepare('SELECT * FROM licenses WHERE key = ?').get(k))) });
});

adminRouter.delete('/api/admin/licenses/:key', (req, res) => {
  const lic = db.prepare('SELECT * FROM licenses WHERE key = ?').get(String(req.params.key));
  if (!lic) return res.status(404).json({ error: 'License not found' });
  if (lic.redeemed_at) return res.status(400).json({ error: 'This key was already redeemed' });
  db.prepare('UPDATE licenses SET revoked = 1 WHERE key = ?').run(lic.key);
  res.json({ license: licenseJson(db.prepare('SELECT * FROM licenses WHERE key = ?').get(lic.key)) });
});
