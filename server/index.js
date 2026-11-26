import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { db } from './db.js';
import { sessionMiddleware } from './sessions.js';
import { authRouter } from './auth.js';
import { notesRouter } from './notes.js';
import { publicRouter } from './public.js';
import { googleSettings } from './settings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', config.trustProxy);

app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "object-src 'none'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
  });
  next();
});

// CSRF defence in depth (cookies are SameSite=Lax): reject cross-origin state-changing API calls.
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('Origin');
  if (origin) {
    try {
      if (new URL(origin).host !== req.get('Host')) return res.status(403).json({ error: 'Cross-origin request blocked' });
    } catch {
      return res.status(403).json({ error: 'Bad origin' });
    }
  }
  next();
});

app.use(express.json({ limit: '5mb' }));
app.use(sessionMiddleware);

app.get('/healthz', (_req, res) => {
  db.prepare('SELECT 1').get();
  res.json({ ok: true });
});

// Client-side libraries served from node_modules (no CDN, works offline / behind firewalls).
const NODE_MODULES = path.join(__dirname, '..', 'node_modules');
const vendor = {
  'marked.js': () => fs.readFileSync(path.join(NODE_MODULES, 'marked', 'lib', 'marked.esm.js'), 'utf8'),
  'purify.js': () => fs.readFileSync(path.join(NODE_MODULES, 'dompurify', 'dist', 'purify.es.mjs'), 'utf8'),
  'diff-match-patch.js': () =>
    `const module = { exports: {} };\n${fs.readFileSync(path.join(NODE_MODULES, 'diff-match-patch', 'index.js'), 'utf8')}\nexport default module.exports;\n`,
};
const vendorCache = {};
app.get('/vendor/:file', (req, res, next) => {
  const load = vendor[req.params.file];
  if (!load) return next();
  vendorCache[req.params.file] ??= load();
  res.type('application/javascript').set('Cache-Control', 'no-cache').send(vendorCache[req.params.file]);
});

app.use(authRouter);
app.use(notesRouter);
app.use(publicRouter);

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

// no-cache + ETag: browsers revalidate (cheap 304s) so auto-deployed updates show up immediately.
app.use(express.static(PUBLIC_DIR, { index: false, cacheControl: true, maxAge: 0, setHeaders: (res) => res.set('Cache-Control', 'no-cache') }));
app.get('/p/:slug', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'publish.html')));
app.get('/{*splat}', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

app.use((err, _req, res, _next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Note is too large' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(config.port, () => {
  console.log(`${config.appName} listening on :${config.port} (public URL ${config.publicUrl || 'derived from requests'})`);
  console.log(`Google SSO: ${googleSettings().enabled ? 'enabled' : 'disabled (admin can configure it in Settings > Administration)'}`);
});
