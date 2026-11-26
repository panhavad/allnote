import { db } from './db.js';
import { config, baseUrl } from './config.js';

const qGet = db.prepare('SELECT value FROM settings WHERE key = ?');
const qSet = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
const qDel = db.prepare('DELETE FROM settings WHERE key = ?');

export function getSetting(key, fallback = '') {
  const row = qGet.get(key);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  if (value === null || value === undefined || value === '') qDel.run(key);
  else qSet.run(key, String(value));
}

const flag = (key, fallback) => getSetting(key, String(fallback)) === 'true';

export function googleSettings() {
  const clientId = getSetting('google_client_id');
  const clientSecret = getSetting('google_client_secret');
  return { clientId, clientSecret, enabled: Boolean(clientId && clientSecret) };
}

export const googleRedirectUri = (req) => `${baseUrl(req)}/auth/google/callback`;

export const hasUsers = () => Boolean(db.prepare('SELECT 1 FROM users LIMIT 1').get());

// The very first account can always be created (it becomes the admin).
export function signupAllowed() {
  if (!hasUsers()) return true;
  return flag('allow_signup', config.allowSignup);
}

// New self-registered accounts wait for an administrator unless this is turned off.
export const approvalRequired = () => flag('require_approval', true);

export const landingEnabled = () => flag('landing_page', true);
