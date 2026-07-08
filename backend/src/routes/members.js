import { Router } from 'express';
import db from '../db.js';
import { requireAuth, requireAdmin } from '../auth.js';

const router = Router();

const mapMember = (m) => ({
  id: m.id, first_name: m.first_name, last_name: m.last_name,
  birth_date: m.birth_date, active: !!m.active,
  emergency_contact: m.emergency_contact || null,
  emergency_phone: m.emergency_phone || null,
});

// GET /api/members?includeInactive=1  (alle authentifizierten Nutzer)
router.get('/', requireAuth, (req, res) => {
  const includeInactive = req.query.includeInactive === '1' && req.user.role === 'admin';
  const rows = includeInactive
    ? db.prepare('SELECT * FROM members ORDER BY last_name, first_name').all()
    : db.prepare('SELECT * FROM members WHERE active = 1 ORDER BY last_name, first_name').all();
  res.json(rows.map(mapMember));
});

// Ab hier nur Admin
router.use(requireAuth, requireAdmin);

// POST /api/members
router.post('/', (req, res) => {
  const { first_name, last_name, birth_date, emergency_contact, emergency_phone } = req.body || {};
  if (!first_name || !last_name) {
    return res.status(400).json({ error: 'Vor- und Nachname erforderlich' });
  }
  const info = db.prepare(
    'INSERT INTO members (first_name, last_name, birth_date, emergency_contact, emergency_phone) VALUES (?, ?, ?, ?, ?)'
  ).run(String(first_name).trim(), String(last_name).trim(), birth_date || null,
    emergency_contact || null, emergency_phone || null);
  res.status(201).json(mapMember(db.prepare('SELECT * FROM members WHERE id = ?').get(info.lastInsertRowid)));
});

// PUT /api/members/:id
router.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const m = db.prepare('SELECT * FROM members WHERE id = ?').get(id);
  if (!m) return res.status(404).json({ error: 'Mitglied nicht gefunden' });
  const { first_name, last_name, birth_date, emergency_contact, emergency_phone, active } = req.body || {};
  db.prepare(`UPDATE members SET
      first_name = COALESCE(?, first_name),
      last_name = COALESCE(?, last_name),
      birth_date = ?,
      emergency_contact = ?,
      emergency_phone = ?,
      active = COALESCE(?, active),
      updated_at = datetime('now')
    WHERE id = ?`).run(
    first_name ?? null, last_name ?? null,
    birth_date === undefined ? m.birth_date : (birth_date || null),
    emergency_contact === undefined ? m.emergency_contact : (emergency_contact || null),
    emergency_phone === undefined ? m.emergency_phone : (emergency_phone || null),
    active === undefined ? null : (active ? 1 : 0),
    id
  );
  res.json(mapMember(db.prepare('SELECT * FROM members WHERE id = ?').get(id)));
});

// DELETE /api/members/:id  (inaktiv setzen bei vorhandenen Einträgen, sonst löschen)
router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const used = db.prepare('SELECT COUNT(*) c FROM attendance_members WHERE member_id = ?').get(id).c;
  if (used > 0) {
    db.prepare("UPDATE members SET active = 0, updated_at = datetime('now') WHERE id = ?").run(id);
    return res.json({ deactivated: true });
  }
  db.prepare('DELETE FROM members WHERE id = ?').run(id);
  res.json({ deleted: true });
});

export default router;
