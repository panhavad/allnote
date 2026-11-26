import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const env = process.env;

export const DATA_DIR = path.resolve(env.DATA_DIR || './data');
fs.mkdirSync(DATA_DIR, { recursive: true });

function loadSessionSecret() {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  const file = path.join(DATA_DIR, '.session_secret');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

const port = Number(env.PORT || 3000);
const publicUrl = (env.PUBLIC_URL || '').replace(/\/+$/, '');

export const config = {
  appName: env.APP_NAME || 'AllNote',
  port,
  // Empty = derive from each request (Host + X-Forwarded-Proto), e.g. behind a tunnel.
  publicUrl,
  sessionSecret: loadSessionSecret(),
  sessionDays: Number(env.SESSION_DAYS || 30),
  // null = decide per request (HTTPS, including X-Forwarded-Proto from a trusted proxy/tunnel).
  cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : (publicUrl ? publicUrl.startsWith('https://') : null),
  trustProxy: env.TRUST_PROXY || 'loopback, linklocal, uniquelocal',
  // Initial default only; the admin can change it in the UI (stored in the settings table).
  allowSignup: env.ALLOW_SIGNUP !== 'false',
  // Comma separated list of emails and/or "@domain.com" entries. Empty = everyone.
  allowedEmails: (env.ALLOWED_EMAILS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
};

export function baseUrl(req) {
  return config.publicUrl || `${req.protocol}://${req.get('host')}`;
}

export function emailAllowed(email) {
  if (!config.allowedEmails.length) return true;
  const e = String(email || '').toLowerCase();
  return config.allowedEmails.some((rule) => (rule.startsWith('@') ? e.endsWith(rule) : e === rule));
}
