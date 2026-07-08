import { Router } from 'express';
import db from '../db.js';
import { requireAuth, requireAdmin } from '../auth.js';

const router = Router();

// Zeitfenster (Stunden), in dem ein Helfer eigene Termine noch bearbeiten darf
const EDIT_WINDOW_HOURS = Number(process.env.EDIT_WINDOW_HOURS || 24);

const mapEvent = (e) => ({
  id: e.id, date: e.date, start_time: e.start_time, end_time: e.end_time,
  type: e.type, location: e.location, note: e.note,
  created_by: e.created_by, created_by_name: e.created_by_name || null,
  created_at: e.created_at,
});

// Prüft, ob der Nutzer den Termin bearbeiten darf
function canEdit(user, event) {
  if (user.role === 'admin') return true;
  if (event.created_by !== user.id) return false;
  const created = new Date(event.created_at + 'Z').getTime();
  return Date.now() - created <= EDIT_WINDOW_HOURS * 3600 * 1000;
}

// GET /api/events  (alle authentifizierten Nutzer)
router.get('/', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT e.*, u.display_name AS created_by_name
    FROM events e LEFT JOIN users u ON u.id = e.created_by
    ORDER BY e.date DESC, e.start_time DESC
  `).all();
  res.json(rows.map(mapEvent));
});

// GET /api/events/:id  inkl. Präsenz-Einträge
router.get('/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const e = db.prepare(`
    SELECT e.*, u.display_name AS created_by_name
    FROM events e LEFT JOIN users u ON u.id = e.created_by WHERE e.id = ?
  `).get(id);
  if (!e) return res.status(404).json({ error: 'Termin nicht gefunden' });
  const members = db.prepare('SELECT * FROM attendance_members WHERE event_id = ?').all(id);
  const helpers = db.prepare('SELECT * FROM attendance_helpers WHERE event_id = ?').all(id);
  res.json({ ...mapEvent(e), attendance_members: members, attendance_helpers: helpers });
});

// POST /api/events  (Helfer + Admin)
router.post('/', requireAuth, (req, res) => {
  const { date, start_time, end_time, type, location, note } = req.body || {};
  if (!date) return res.status(400).json({ error: 'Datum erforderlich' });
  const info = db.prepare(`
    INSERT INTO events (date, start_time, end_time, type, location, note, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(date, start_time || null, end_time || null, type || 'Übung', location || null, note || null, req.user.id);
  const e = db.prepare('SELECT * FROM events WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(mapEvent(e));
});

// PUT /api/events/:id  (Admin immer; Helfer nur eigene innerhalb Zeitfenster)
router.put('/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const e = db.prepare('SELECT * FROM events WHERE id = ?').get(id);
  if (!e) return res.status(404).json({ error: 'Termin nicht gefunden' });
  if (!canEdit(req.user, e)) return res.status(403).json({ error: 'Keine Berechtigung zum Bearbeiten dieses Termins' });

  const { date, start_time, end_time, type, location, note } = req.body || {};
  db.prepare(`UPDATE events SET
      date = COALESCE(?, date), start_time = ?, end_time = ?,
      type = COALESCE(?, type), location = ?, note = ?, updated_at = datetime('now')
    WHERE id = ?`).run(
    date ?? null,
    start_time === undefined ? e.start_time : (start_time || null),
    end_time === undefined ? e.end_time : (end_time || null),
    type ?? null,
    location === undefined ? e.location : (location || null),
    note === undefined ? e.note : (note || null),
    id
  );
  res.json(mapEvent(db.prepare('SELECT * FROM events WHERE id = ?').get(id)));
});

// DELETE /api/events/:id  (nur Admin)
router.delete('/:id', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  db.prepare('DELETE FROM events WHERE id = ?').run(id);
  res.json({ deleted: true });
});

export default router;
