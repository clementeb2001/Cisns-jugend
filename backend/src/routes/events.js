import { Router } from 'express';
import db from '../db.js';
import { requireAuth, requireAdmin } from '../auth.js';

const router = Router();

// Zeitfenster (Stunden), in dem ein Helfer eigene Termine noch bearbeiten darf
const EDIT_WINDOW_HOURS = Number(process.env.EDIT_WINDOW_HOURS || 24);
const EVENT_TYPES = ['Praktische Übung', 'Theorie', 'Freizeit', 'Sonstiges'];

const mapEvent = (e) => ({
  id: e.id, date: e.date, end_date: e.end_date || null,
  start_time: e.start_time, end_time: e.end_time,
  type: e.type, type_detail: e.type_detail || null,
  location: e.location, note: e.note, closed: !!e.closed,
  created_by: e.created_by, created_by_name: e.created_by_name || null,
  created_at: e.created_at,
});

// Enddatum nur bei "Sonstiges" und nur wenn nach dem Startdatum sinnvoll.
function normalizeEndDate(type, date, endDate) {
  if (type !== 'Sonstiges') return null;
  const v = String(endDate || '').trim();
  return v && v > date ? v : null;
}

// Prüft, ob der Nutzer die Termin-Stammdaten bearbeiten darf
function canEdit(user, event) {
  if (user.role === 'admin') return true;
  if (event.closed) return false;                 // abgeschlossen -> nur Admin
  if (event.created_by !== user.id) return false;
  const created = new Date(event.created_at + 'Z').getTime();
  return Date.now() - created <= EDIT_WINDOW_HOURS * 3600 * 1000;
}

// Bei "Sonstiges" ist eine Beschreibung Pflicht
function validateType(type, detail) {
  if (type && !EVENT_TYPES.includes(type)) return 'Ungültige Terminart';
  if (type === 'Sonstiges' && !String(detail || '').trim()) {
    return 'Bei "Sonstiges" bitte kurz beschreiben, was gemacht wurde';
  }
  return null;
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
  const { date, end_date, start_time, end_time, type, type_detail, location, note } = req.body || {};
  if (!date) return res.status(400).json({ error: 'Datum erforderlich' });
  const evType = type || 'Praktische Übung';
  const typeErr = validateType(evType, type_detail);
  if (typeErr) return res.status(400).json({ error: typeErr });
  const info = db.prepare(`
    INSERT INTO events (date, end_date, start_time, end_time, type, type_detail, location, note, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(date, normalizeEndDate(evType, date, end_date), start_time || null, end_time || null, evType,
    evType === 'Sonstiges' ? (type_detail || null) : null, location || null, note || null, req.user.id);
  const e = db.prepare('SELECT * FROM events WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(mapEvent(e));
});

// PUT /api/events/:id  (Admin immer; Helfer nur eigene innerhalb Zeitfenster, nicht abgeschlossen)
router.put('/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const e = db.prepare('SELECT * FROM events WHERE id = ?').get(id);
  if (!e) return res.status(404).json({ error: 'Termin nicht gefunden' });
  if (!canEdit(req.user, e)) return res.status(403).json({ error: 'Keine Berechtigung zum Bearbeiten dieses Termins' });

  const { date, end_date, start_time, end_time, type, type_detail, location, note } = req.body || {};
  const nextType = type ?? e.type;
  const nextDetail = type_detail === undefined ? e.type_detail : type_detail;
  const nextDate = date ?? e.date;
  const nextEndDate = end_date === undefined ? e.end_date : end_date;
  const typeErr = validateType(nextType, nextDetail);
  if (typeErr) return res.status(400).json({ error: typeErr });

  db.prepare(`UPDATE events SET
      date = COALESCE(?, date), end_date = ?, start_time = ?, end_time = ?,
      type = COALESCE(?, type), type_detail = ?, location = ?, note = ?, updated_at = datetime('now')
    WHERE id = ?`).run(
    date ?? null,
    normalizeEndDate(nextType, nextDate, nextEndDate),
    start_time === undefined ? e.start_time : (start_time || null),
    end_time === undefined ? e.end_time : (end_time || null),
    type ?? null,
    nextType === 'Sonstiges' ? (nextDetail || null) : null,
    location === undefined ? e.location : (location || null),
    note === undefined ? e.note : (note || null),
    id
  );
  res.json(mapEvent(db.prepare('SELECT * FROM events WHERE id = ?').get(id)));
});

// POST /api/events/:id/close  bzw. /reopen  (nur Admin)
// Abschließen sperrt alle Helfer-Änderungen (auch nachträgliche Stunden).
router.post('/:id/close', requireAuth, requireAdmin, (req, res) => setClosed(req, res, 1));
router.post('/:id/reopen', requireAuth, requireAdmin, (req, res) => setClosed(req, res, 0));
function setClosed(req, res, value) {
  const id = Number(req.params.id);
  const e = db.prepare('SELECT * FROM events WHERE id = ?').get(id);
  if (!e) return res.status(404).json({ error: 'Termin nicht gefunden' });
  // Abschließen erst ab dem Termintag erlauben (kein Abschließen künftiger Termine)
  if (value === 1) {
    const today = new Date().toISOString().slice(0, 10);
    if (e.date > today) {
      return res.status(400).json({ error: 'Der Termin kann erst ab dem Termintag abgeschlossen werden' });
    }
  }
  db.prepare("UPDATE events SET closed = ?, updated_at = datetime('now') WHERE id = ?").run(value, id);
  res.json(mapEvent(db.prepare('SELECT * FROM events WHERE id = ?').get(id)));
}

// DELETE /api/events/:id  (nur Admin)
router.delete('/:id', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  db.prepare('DELETE FROM events WHERE id = ?').run(id);
  res.json({ deleted: true });
});

export default router;
