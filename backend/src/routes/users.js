import { Router } from 'express';
import db from '../db.js';
import { requireAuth, requireAdmin, hashPin } from '../auth.js';

const router = Router();

const publicUser = (u) => ({
  id: u.id, username: u.username, role: u.role,
  display_name: u.display_name, active: !!u.active, created_at: u.created_at,
});

// Liste aller Jugendhelfer (für Helfer-Präsenz und Statistik sichtbar)
// GET /api/users/helpers
router.get('/helpers', requireAuth, (req, res) => {
  const rows = db.prepare("SELECT * FROM users WHERE role IN ('helper','admin') ORDER BY display_name").all();
  res.json(rows.map(publicUser));
});

// Ab hier: nur Administratoren
router.use(requireAuth, requireAdmin);

// GET /api/users
router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM users ORDER BY role, display_name').all();
  res.json(rows.map(publicUser));
});

// POST /api/users  { username, pin, role, display_name }
router.post('/', (req, res) => {
  const { username, pin, role, display_name } = req.body || {};
  if (!username || !pin || !display_name || !['admin', 'helper'].includes(role)) {
    return res.status(400).json({ error: 'username, pin, display_name und gültige role erforderlich' });
  }
  if (String(pin).length < 8) {
    return res.status(400).json({ error: 'Passwort muss mindestens 8 Zeichen haben' });
  }
  try {
    const info = db.prepare(
      'INSERT INTO users (username, pin_hash, role, display_name) VALUES (?, ?, ?, ?)'
    ).run(String(username).trim(), hashPin(pin), role, String(display_name).trim());
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json(publicUser(u));
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'Benutzername bereits vergeben' });
    }
    throw e;
  }
});

// PUT /api/users/:id  { display_name?, role?, active?, pin? }
router.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'Benutzer nicht gefunden' });

  const { display_name, role, active, pin } = req.body || {};
  if (pin !== undefined && pin !== '' && String(pin).length < 8) {
    return res.status(400).json({ error: 'Passwort muss mindestens 8 Zeichen haben' });
  }
  db.prepare(`UPDATE users SET
      display_name = COALESCE(?, display_name),
      role = COALESCE(?, role),
      active = COALESCE(?, active),
      pin_hash = COALESCE(?, pin_hash),
      updated_at = datetime('now')
    WHERE id = ?`).run(
    display_name ?? null,
    role && ['admin', 'helper'].includes(role) ? role : null,
    active === undefined ? null : (active ? 1 : 0),
    pin ? hashPin(pin) : null,
    id
  );
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  res.json(publicUser(u));
});

// DELETE /api/users/:id  (inaktiv setzen, wenn bereits Einträge existieren; sonst hart löschen)
router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'Eigener Account kann nicht gelöscht werden' });
  const used = db.prepare('SELECT COUNT(*) c FROM attendance_helpers WHERE helper_id = ?').get(id).c;
  if (used > 0) {
    db.prepare("UPDATE users SET active = 0, updated_at = datetime('now') WHERE id = ?").run(id);
    return res.json({ deactivated: true });
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ deleted: true });
});

export default router;
