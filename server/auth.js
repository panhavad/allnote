import express from 'express';
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { db, tx } from './db.js';
import { config, emailAllowed } from './config.js';
import {
  now, hashSecret, verifySecret, generateTotpSecret, verifyTotp, generateRecoveryCodes,
  rateLimit, resetRateLimit, setCookie, clearCookie,
} from './security.js';
import {
  createSession, destroySession, destroyOtherSessions, publicUser, requireAuth, requireActive, accountStatus,
} from './sessions.js';
import {
  googleSettings, googleRedirectUri, hasUsers, signupAllowed, approvalRequired, landingEnabled,
} from './settings.js';
import { EMAIL_RE, MIN_PASSWORD, getUserByEmail, getUserById, createUser } from './users.js';
import { BUILD_ID } from './build.js';

export const authRouter = express.Router();

function loginResponse(res, user) {
  if (user.totp_enabled) {
    createSession(res, user.id, '2fa');
    return { twoFactorRequired: true };
  }
  createSession(res, user.id, 'full');
  return { user: publicUser(user) };
}

authRouter.get('/api/config', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    appName: config.appName,
    version: config.version,
    build: BUILD_ID,
    google: googleSettings().enabled,
    allowSignup: signupAllowed(),
    approvalRequired: approvalRequired(),
    setupRequired: !hasUsers(),
    landing: landingEnabled(),
  });
});

authRouter.post('/api/auth/register', (req, res) => {
  const { email: rawEmail, password, name } = req.body || {};
  const email = String(rawEmail || '').trim().toLowerCase();
  if (!signupAllowed()) return res.status(403).json({ error: 'Sign up is disabled' });
  if (!rateLimit(`reg:${req.ip}`, 10, 3600_000)) return res.status(429).json({ error: 'Too many attempts, try later' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Invalid email' });
  if (!emailAllowed(email)) return res.status(403).json({ error: 'This email is not allowed' });
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD} characters` });
  if (getUserByEmail(email)) return res.status(409).json({ error: 'An account with this email already exists' });
  const user = createUser({ email, name, passwordHash: hashSecret(password), approved: !approvalRequired() });
  res.json(loginResponse(res, user));
});

authRouter.post('/api/auth/login', (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = req.body?.password;
  const key = `login:${req.ip}:${email}`;
  if (!rateLimit(key, 10, 15 * 60_000)) return res.status(429).json({ error: 'Too many attempts, try again in 15 minutes' });
  const user = getUserByEmail(email);
  if (!user || !verifySecret(String(password || ''), user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  resetRateLimit(key);
  res.json(loginResponse(res, user));
});

authRouter.post('/api/auth/2fa', (req, res) => {
  const user = req.pendingUser;
  if (!user) return res.status(401).json({ error: 'No pending sign-in. Please sign in again.' });
  if (!rateLimit(`2fa:${user.id}`, 10, 15 * 60_000)) return res.status(429).json({ error: 'Too many attempts, try later' });
  const code = String(req.body?.code || '').trim();
  let ok = verifyTotp(user.totp_secret, code);
  if (!ok && code) {
    const codes = JSON.parse(user.recovery_codes || '[]');
    const idx = codes.findIndex((h) => verifySecret(code.toLowerCase(), h));
    if (idx >= 0) {
      codes.splice(idx, 1);
      db.prepare('UPDATE users SET recovery_codes = ? WHERE id = ?').run(JSON.stringify(codes), user.id);
      ok = true;
    }
  }
  if (!ok) return res.status(401).json({ error: 'Invalid code' });
  resetRateLimit(`2fa:${user.id}`);
  destroySession(req, res);
  createSession(res, user.id, 'full');
  res.json({ user: publicUser(getUserById(user.id)) });
});

authRouter.post('/api/auth/logout', (req, res) => {
  destroySession(req, res);
  res.json({ ok: true });
});

authRouter.get('/api/auth/me', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (req.user) return res.json({ user: publicUser(req.user) });
  if (req.pendingUser) return res.json({ user: null, twoFactorRequired: true });
  res.json({ user: null });
});

// ---------- account (locked accounts can only redeem a license or sign out) ----------
authRouter.put('/api/account', requireActive, (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: 'Name is required' });
  db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, req.user.id);
  res.json({ user: publicUser(getUserById(req.user.id)) });
});

authRouter.post('/api/account/password', requireActive, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (req.user.password_hash && !verifySecret(String(currentPassword || ''), req.user.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD) return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD} characters` });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashSecret(newPassword), req.user.id);
  destroyOtherSessions(req.user.id, req.sessionId);
  res.json({ user: publicUser(getUserById(req.user.id)) });
});

authRouter.post('/api/account/2fa/setup', requireActive, async (req, res) => {
  if (req.user.totp_enabled) return res.status(400).json({ error: 'Two-factor authentication is already enabled' });
  const secret = generateTotpSecret();
  db.prepare('UPDATE users SET totp_secret = ? WHERE id = ?').run(secret, req.user.id);
  const label = encodeURIComponent(`${config.appName}:${req.user.email}`);
  const otpauthUrl = `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(config.appName)}&algorithm=SHA1&digits=6&period=30`;
  const qr = await QRCode.toDataURL(otpauthUrl, { margin: 1, width: 220 });
  res.json({ secret, otpauthUrl, qr });
});

authRouter.post('/api/account/2fa/enable', requireActive, (req, res) => {
  if (req.user.totp_enabled) return res.status(400).json({ error: 'Already enabled' });
  if (!verifyTotp(req.user.totp_secret, req.body?.code)) return res.status(400).json({ error: 'Invalid code, check your authenticator app time' });
  const codes = generateRecoveryCodes();
  db.prepare('UPDATE users SET totp_enabled = 1, recovery_codes = ? WHERE id = ?')
    .run(JSON.stringify(codes.map((c) => hashSecret(c))), req.user.id);
  destroyOtherSessions(req.user.id, req.sessionId);
  res.json({ user: publicUser(getUserById(req.user.id)), recoveryCodes: codes });
});

authRouter.post('/api/account/2fa/disable', requireActive, (req, res) => {
  if (!req.user.totp_enabled) return res.status(400).json({ error: 'Not enabled' });
  if (!rateLimit(`2fadis:${req.user.id}`, 10, 15 * 60_000)) return res.status(429).json({ error: 'Too many attempts' });
  if (!verifyTotp(req.user.totp_secret, req.body?.code)) return res.status(400).json({ error: 'Invalid code' });
  db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL, recovery_codes = NULL WHERE id = ?').run(req.user.id);
  res.json({ user: publicUser(getUserById(req.user.id)) });
});

authRouter.put('/api/account/folder-order', requireActive, (req, res) => {
  const order = req.body?.order;
  if (!Array.isArray(order) || order.length > 2000 || !order.every((p) => typeof p === 'string' && p.length <= 200)) {
    return res.status(400).json({ error: 'Invalid folder order' });
  }
  db.prepare('UPDATE users SET folder_order = ? WHERE id = ?').run(JSON.stringify([...new Set(order)]), req.user.id);
  res.json({ user: publicUser(getUserById(req.user.id)) });
});

authRouter.post('/api/account/tour', requireAuth, (req, res) => {
  db.prepare('UPDATE users SET tour_done = ? WHERE id = ?').run(req.body?.done === false ? 0 : 1, req.user.id);
  res.json({ user: publicUser(getUserById(req.user.id)) });
});

export const normalizeLicenseKey = (k) => String(k || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

authRouter.post('/api/account/license', requireAuth, (req, res) => {
  const u = req.user;
  if (!rateLimit(`lic:${u.id}`, 10, 15 * 60_000) || !rateLimit(`lic-ip:${req.ip}`, 30, 15 * 60_000)) {
    return res.status(429).json({ error: 'Too many attempts, try again in 15 minutes' });
  }
  if (u.is_admin) return res.status(400).json({ error: 'Administrator accounts never expire' });
  if (accountStatus(u) === 'pending') return res.status(403).json({ error: 'Your account must be approved by an administrator first' });
  if (!u.expires_at) return res.status(400).json({ error: 'Your account does not expire, no license is needed' });
  const key = normalizeLicenseKey(req.body?.key);
  const lic = key && db.prepare("SELECT * FROM licenses WHERE replace(key, '-', '') = ?").get(key);
  if (!lic || lic.revoked || lic.redeemed_at) return res.status(400).json({ error: 'This license key is invalid or has already been used' });
  const expiresAt = Math.max(now(), u.expires_at) + lic.days * 86_400_000;
  let claimed = false;
  tx(() => {
    claimed = db.prepare('UPDATE licenses SET redeemed_by = ?, redeemed_email = ?, redeemed_at = ? WHERE key = ? AND redeemed_at IS NULL AND revoked = 0')
      .run(u.id, u.email, now(), lic.key).changes > 0;
    if (claimed) db.prepare('UPDATE users SET expires_at = ? WHERE id = ?').run(expiresAt, u.id);
  });
  if (!claimed) return res.status(400).json({ error: 'This license key is invalid or has already been used' });
  resetRateLimit(`lic:${u.id}`);
  res.json({ user: publicUser(getUserById(u.id)), days: lic.days });
});

// ---------- Google single sign-on (OpenID Connect authorization code flow) ----------
authRouter.get('/auth/google', (req, res) => {
  const google = googleSettings();
  if (!google.enabled) return res.status(404).send('Google sign-in is not configured');
  const state = crypto.randomBytes(16).toString('hex');
  const nonce = crypto.randomBytes(16).toString('hex');
  setCookie(res, 'an_oauth', `${state}.${nonce}`, { maxAgeMs: 10 * 60_000 });
  const params = new URLSearchParams({
    client_id: google.clientId,
    redirect_uri: googleRedirectUri(req),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    nonce,
    prompt: 'select_account',
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

authRouter.get('/auth/google/callback', async (req, res) => {
  const fail = (msg) => res.redirect(`/login?error=${encodeURIComponent(msg)}`);
  try {
    const google = googleSettings();
    if (!google.enabled) return fail('Google sign-in is not configured');
    const [state, nonce] = String(req.cookies.an_oauth || '').split('.');
    clearCookie(res, 'an_oauth');
    if (req.query.error) return fail(`Google: ${req.query.error}`);
    if (!state || state !== req.query.state) return fail('Sign-in expired, please try again');

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: String(req.query.code || ''),
        client_id: google.clientId,
        client_secret: google.clientSecret,
        redirect_uri: googleRedirectUri(req),
        grant_type: 'authorization_code',
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokenRes.ok || !tokens.id_token) return fail('Google sign-in failed');

    // The ID token came straight from Google's token endpoint over TLS, so its claims can be trusted
    // after checking audience, issuer, expiry and nonce (OIDC Core 3.1.3.7).
    const claims = JSON.parse(Buffer.from(tokens.id_token.split('.')[1], 'base64url').toString('utf8'));
    if (claims.aud !== google.clientId) return fail('Invalid token audience');
    if (!['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss)) return fail('Invalid token issuer');
    if (claims.exp * 1000 < Date.now()) return fail('Token expired');
    if (claims.nonce !== nonce) return fail('Invalid nonce');
    if (!claims.email || !claims.email_verified) return fail('Your Google email is not verified');

    const email = claims.email.toLowerCase();
    if (!emailAllowed(email)) return fail('This email is not allowed');

    let user = db.prepare('SELECT * FROM users WHERE google_id = ?').get(claims.sub) || getUserByEmail(email);
    if (user) {
      db.prepare('UPDATE users SET google_id = ?, avatar = COALESCE(?, avatar) WHERE id = ?').run(claims.sub, claims.picture || null, user.id);
    } else {
      if (!signupAllowed()) return fail('Sign up is disabled');
      user = createUser({ email, name: claims.name, avatar: claims.picture || null, googleId: claims.sub, approved: !approvalRequired() });
    }
    loginResponse(res, getUserById(user.id));
    res.redirect('/');
  } catch (err) {
    console.error('Google callback error', err);
    fail('Google sign-in failed');
  }
});
