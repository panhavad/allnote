import express from 'express';
import { db } from './db.js';
import { verifySecret, rateLimit, resetRateLimit, signToken, verifyToken, setCookie } from './security.js';

export const publicRouter = express.Router();

const qPub = db.prepare(`SELECT p.*, n.title, n.content, n.updated_at, n.trashed, u.name AS author
                         FROM publications p JOIN notes n ON n.id = p.note_id JOIN users u ON u.id = n.owner_id
                         WHERE p.slug = ?`);

const cookieName = (slug) => `an_pub_${slug.replace(/[^a-z0-9-]/g, '')}`;
const UNLOCK_TTL = 12 * 3600_000;

function findPub(req, res) {
  const pub = qPub.get(String(req.params.slug || '').toLowerCase());
  if (!pub || pub.trashed) {
    res.status(404).json({ error: 'This page does not exist or is no longer published' });
    return null;
  }
  return pub;
}

function unlocked(req, pub) {
  if (!pub.pin_hash) return true;
  const t = verifyToken(req.cookies[cookieName(pub.slug)]);
  return Boolean(t && t.slug === pub.slug && t.v === pub.pin_version);
}

publicRouter.get('/api/public/:slug', (req, res) => {
  const pub = findPub(req, res);
  if (!pub) return;
  res.set('Cache-Control', 'no-store');
  if (!unlocked(req, pub)) return res.status(401).json({ pinRequired: true });
  res.json({ title: pub.title, content: pub.content, updatedAt: pub.updated_at, author: pub.author, protected: Boolean(pub.pin_hash) });
});

publicRouter.post('/api/public/:slug/unlock', (req, res) => {
  const pub = findPub(req, res);
  if (!pub) return;
  const key = `pin:${req.ip}:${pub.slug}`;
  if (!rateLimit(key, 5, 15 * 60_000)) return res.status(429).json({ error: 'Too many wrong PINs. Try again in 15 minutes.' });
  if (!pub.pin_hash || !verifySecret(String(req.body?.pin || ''), pub.pin_hash)) {
    return res.status(401).json({ error: 'Wrong PIN' });
  }
  resetRateLimit(key);
  setCookie(res, cookieName(pub.slug), signToken({ slug: pub.slug, v: pub.pin_version }, UNLOCK_TTL), { maxAgeMs: UNLOCK_TTL });
  res.json({ ok: true });
});
