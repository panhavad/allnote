import express from 'express';
import { db, tx } from './db.js';
import { newId, now, hashSecret } from './security.js';
import { requireAuth } from './sessions.js';
import { subscribe, sendToUser } from './events.js';

export const notesRouter = express.Router();
notesRouter.use('/api/notes', requireAuth);

const NOTE_SELECT = `
  SELECT n.*, o.name AS owner_name, o.email AS owner_email, ub.name AS updated_by_name,
         p.slug AS pub_slug, (p.pin_hash IS NOT NULL) AS pub_has_pin,
         CASE WHEN n.owner_id = :uid THEN 'owner' ELSE s.role END AS role,
         (SELECT COUNT(*) FROM note_shares x WHERE x.note_id = n.id) AS share_count
  FROM notes n
  JOIN users o ON o.id = n.owner_id
  LEFT JOIN users ub ON ub.id = n.updated_by
  LEFT JOIN note_shares s ON s.note_id = n.id AND s.user_id = :uid
  LEFT JOIN publications p ON p.note_id = n.id`;

const qList = db.prepare(`${NOTE_SELECT} WHERE n.owner_id = :uid OR s.user_id IS NOT NULL`);
const qOne = db.prepare(`${NOTE_SELECT} WHERE n.id = :id AND (n.owner_id = :uid OR s.user_id IS NOT NULL)`);
const qAudience = db.prepare('SELECT owner_id AS uid FROM notes WHERE id = ? UNION SELECT user_id FROM note_shares WHERE note_id = ?');

function serialize(r) {
  return {
    id: r.id,
    title: r.title,
    content: r.content,
    notebook: r.notebook,
    pinned: Boolean(r.pinned),
    trashed: Boolean(r.trashed),
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by ? { id: r.updated_by, name: r.updated_by_name } : null,
    owner: { id: r.owner_id, name: r.owner_name, email: r.owner_email },
    role: r.role,
    shareCount: r.share_count,
    publication: r.pub_slug ? { slug: r.pub_slug, hasPin: Boolean(r.pub_has_pin) } : null,
  };
}

export const noteForUser = (id, uid) => {
  const row = qOne.get({ id, uid });
  return row ? serialize(row) : null;
};

const audience = (noteId) => qAudience.all(noteId, noteId).map((r) => r.uid);

function broadcast(noteId, clientId) {
  for (const uid of audience(noteId)) {
    const note = noteForUser(noteId, uid);
    if (note) sendToUser(uid, 'note', { note, clientId });
  }
}

const clientIdOf = (req) => String(req.get('X-Client-Id') || '');

function loadNote(req, res, { write = false, owner = false } = {}) {
  const note = noteForUser(req.params.id, req.user.id);
  if (!note) {
    res.status(404).json({ error: 'Note not found' });
    return null;
  }
  if ((owner && note.role !== 'owner') || (write && note.role === 'viewer')) {
    res.status(403).json({ error: 'You do not have permission for this action' });
    return null;
  }
  return note;
}

const str = (v, max) => String(v ?? '').slice(0, max);

notesRouter.get('/api/events', requireAuth, subscribe);

notesRouter.get('/api/notes', (req, res) => {
  res.json({ notes: qList.all({ uid: req.user.id }).map(serialize) });
});

notesRouter.post('/api/notes', (req, res) => {
  const id = newId();
  const t = now();
  const b = req.body || {};
  db.prepare(`INSERT INTO notes (id, owner_id, title, content, notebook, pinned, created_at, updated_at, updated_by)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, req.user.id, str(b.title, 300), str(b.content, 2_000_000), str(b.notebook, 200), b.pinned ? 1 : 0, t, t, req.user.id);
  const note = noteForUser(id, req.user.id);
  sendToUser(req.user.id, 'note', { note, clientId: clientIdOf(req) });
  res.status(201).json({ note });
});

notesRouter.put('/api/notes/:id', (req, res) => {
  const note = loadNote(req, res, { write: true });
  if (!note) return;
  const b = req.body || {};
  const ownerFields = ['notebook', 'pinned', 'trashed'].filter((k) => k in b);
  if (ownerFields.length && note.role !== 'owner') return res.status(403).json({ error: 'Only the owner can change this' });

  const contentChange = 'title' in b || 'content' in b;
  if (contentChange && b.baseVersion !== note.version) {
    return res.status(409).json({ error: 'Note was changed by someone else', note });
  }

  tx(() => {
    if (contentChange) {
      const title = 'title' in b ? str(b.title, 300) : note.title;
      const content = 'content' in b ? str(b.content, 2_000_000) : note.content;
      if (title !== note.title || content !== note.content) {
        const last = db.prepare('SELECT author_id, created_at FROM note_history WHERE note_id = ? ORDER BY id DESC LIMIT 1').get(note.id);
        const prevAuthor = note.updatedBy?.id;
        if (!last || now() - last.created_at > 10 * 60_000 || prevAuthor !== req.user.id) {
          db.prepare('INSERT INTO note_history (note_id, title, content, version, author_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run(note.id, note.title, note.content, note.version, prevAuthor || note.owner.id, note.updatedAt);
          db.prepare(`DELETE FROM note_history WHERE note_id = ? AND id NOT IN
                      (SELECT id FROM note_history WHERE note_id = ? ORDER BY id DESC LIMIT 100)`).run(note.id, note.id);
        }
        db.prepare('UPDATE notes SET title = ?, content = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE id = ?')
          .run(title, content, now(), req.user.id, note.id);
      }
    }
    if ('notebook' in b) db.prepare('UPDATE notes SET notebook = ? WHERE id = ?').run(str(b.notebook, 200).trim(), note.id);
    if ('pinned' in b) db.prepare('UPDATE notes SET pinned = ? WHERE id = ?').run(b.pinned ? 1 : 0, note.id);
    if ('trashed' in b) db.prepare('UPDATE notes SET trashed = ? WHERE id = ?').run(b.trashed ? 1 : 0, note.id);
  });

  broadcast(note.id, clientIdOf(req));
  res.json({ note: noteForUser(note.id, req.user.id) });
});

notesRouter.delete('/api/notes/:id', (req, res) => {
  const note = loadNote(req, res, { owner: true });
  if (!note) return;
  const users = audience(note.id);
  db.prepare('DELETE FROM notes WHERE id = ?').run(note.id);
  for (const uid of users) sendToUser(uid, 'note-removed', { id: note.id, clientId: clientIdOf(req) });
  res.json({ ok: true });
});

notesRouter.get('/api/notes/:id/history', (req, res) => {
  const note = loadNote(req, res);
  if (!note) return;
  const rows = db.prepare(`SELECT h.id, h.title, h.content, h.version, h.created_at, u.name AS author
                           FROM note_history h LEFT JOIN users u ON u.id = h.author_id
                           WHERE h.note_id = ? ORDER BY h.id DESC`).all(note.id);
  res.json({ history: rows.map((r) => ({ id: r.id, title: r.title, content: r.content, version: r.version, createdAt: r.created_at, author: r.author })) });
});

// ---------- collaboration ----------
notesRouter.get('/api/notes/:id/shares', (req, res) => {
  const note = loadNote(req, res);
  if (!note) return;
  const shares = db.prepare(`SELECT u.id, u.email, u.name, u.avatar, s.role FROM note_shares s
                             JOIN users u ON u.id = s.user_id WHERE s.note_id = ? ORDER BY s.created_at`).all(note.id);
  res.json({ owner: note.owner, shares });
});

notesRouter.post('/api/notes/:id/shares', (req, res) => {
  const note = loadNote(req, res, { owner: true });
  if (!note) return;
  const email = String(req.body?.email || '').trim().toLowerCase();
  const role = req.body?.role === 'viewer' ? 'viewer' : 'editor';
  const target = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (!target) return res.status(404).json({ error: 'No user with that email. Ask them to sign up first.' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'You already own this note' });
  db.prepare(`INSERT INTO note_shares (note_id, user_id, role, created_at) VALUES (?, ?, ?, ?)
              ON CONFLICT (note_id, user_id) DO UPDATE SET role = excluded.role`).run(note.id, target.id, role, now());
  broadcast(note.id, clientIdOf(req));
  res.json({ ok: true });
});

notesRouter.delete('/api/notes/:id/shares/:userId', (req, res) => {
  const note = loadNote(req, res);
  if (!note) return;
  const self = req.params.userId === req.user.id;
  if (note.role !== 'owner' && !self) return res.status(403).json({ error: 'Only the owner can remove collaborators' });
  db.prepare('DELETE FROM note_shares WHERE note_id = ? AND user_id = ?').run(note.id, req.params.userId);
  sendToUser(req.params.userId, 'note-removed', { id: note.id });
  broadcast(note.id, clientIdOf(req));
  res.json({ ok: true });
});

notesRouter.post('/api/notes/:id/presence', (req, res) => {
  const note = loadNote(req, res);
  if (!note) return;
  const state = ['viewing', 'editing', 'left'].includes(req.body?.state) ? req.body.state : 'viewing';
  const user = { id: req.user.id, name: req.user.name, avatar: req.user.avatar };
  for (const uid of audience(note.id)) sendToUser(uid, 'presence', { noteId: note.id, user, state, clientId: clientIdOf(req) });
  res.json({ ok: true });
});

// ---------- publishing ----------
const slugify = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_-]+/g, '-').slice(0, 40);

notesRouter.put('/api/notes/:id/publish', (req, res) => {
  const note = loadNote(req, res, { owner: true });
  if (!note) return;
  const b = req.body || {};
  if (!b.published) {
    db.prepare('DELETE FROM publications WHERE note_id = ?').run(note.id);
  } else {
    const existing = db.prepare('SELECT * FROM publications WHERE note_id = ?').get(note.id);
    let slug = existing?.slug;
    if (b.slug && b.slug !== slug) {
      slug = String(b.slug).toLowerCase();
      if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(slug)) return res.status(400).json({ error: 'Link must be 3-64 characters: a-z, 0-9 and dashes' });
      const taken = db.prepare('SELECT note_id FROM publications WHERE slug = ?').get(slug);
      if (taken && taken.note_id !== note.id) return res.status(409).json({ error: 'That link is already taken' });
    }
    if (!slug) slug = `${slugify(note.title) || 'note'}-${newId(4).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
    let pinHash = existing?.pin_hash ?? null;
    let pinVersion = existing?.pin_version ?? 0;
    if ('pin' in b) {
      if (b.pin === null || b.pin === '') {
        pinHash = null;
      } else {
        const pin = String(b.pin);
        if (!/^[A-Za-z0-9]{4,12}$/.test(pin)) return res.status(400).json({ error: 'PIN must be 4-12 letters or digits' });
        pinHash = hashSecret(pin);
      }
      pinVersion += 1;
    }
    db.prepare(`INSERT INTO publications (note_id, slug, pin_hash, pin_version, created_at) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT (note_id) DO UPDATE SET slug = excluded.slug, pin_hash = excluded.pin_hash, pin_version = excluded.pin_version`)
      .run(note.id, slug, pinHash, pinVersion, now());
  }
  broadcast(note.id, clientIdOf(req));
  res.json({ note: noteForUser(note.id, req.user.id) });
});
