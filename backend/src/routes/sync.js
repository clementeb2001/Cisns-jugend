import { Router } from 'express';
import db from '../db.js';
import { requireAuth, requireAdmin } from '../auth.js';

const router = Router();

const VALID_STATUS = ['present', 'excused', 'unexcused'];

// Ermittelt den Helfer, der die Mitglieder-Präsenz eines Termins zuerst erfasst
// hat ("Erfasser"). Solange der Termin offen ist, dürfen nur dieser Helfer und
// der Admin die Mitglieder-Präsenz ändern.
function memberRecorder(eventId) {
  const row = db.prepare(
    'SELECT entered_by FROM attendance_members WHERE event_id = ? ORDER BY entered_at ASC, rowid ASC LIMIT 1'
  ).get(eventId);
  return row ? row.entered_by : null;
}

function getEvent(id) {
  return db.prepare('SELECT id, closed, date FROM events WHERE id = ?').get(id);
}

// Präsenz darf erst ab dem Termintag erfasst werden (kein Vor-Eintragen künftiger Termine)
function beforeEventDay(ev) {
  return ev.date > new Date().toISOString().slice(0, 10);
}

// Upsert eines Mitglieder-Präsenz-Eintrags mit Last-Write-Wins + Rechteprüfung
function upsertMember(user, rec) {
  if (!rec.id || !rec.event_id || !rec.member_id || !VALID_STATUS.includes(rec.status)) {
    return { id: rec.id, ok: false, error: 'Ungültiger Datensatz' };
  }
  const ev = getEvent(rec.event_id);
  if (!ev) return { id: rec.id, ok: false, error: 'Termin nicht gefunden' };
  if (beforeEventDay(ev)) return { id: rec.id, ok: false, error: 'Präsenz kann erst ab dem Termintag eingetragen werden' };

  const existing = db.prepare('SELECT * FROM attendance_members WHERE id = ? OR (event_id = ? AND member_id = ?)')
    .get(rec.id, rec.event_id, rec.member_id);
  const updated_at = rec.updated_at || new Date().toISOString();

  // Last-Write-Wins: neuere Änderung gewinnt (ältere ohne Wirkung überspringen)
  if (existing && existing.updated_at && updated_at < existing.updated_at) {
    return { id: existing.id, ok: true, skipped: 'älterer Stand', server: existing };
  }

  // Rechte: Admin immer. Helfer nur wenn Termin offen UND (noch niemand erfasst
  // hat ODER er selbst der Erfasser ist).
  if (user.role !== 'admin') {
    if (ev.closed) return { id: rec.id, ok: false, error: 'Termin ist abgeschlossen – Änderung nur durch Admin' };
    const recorder = memberRecorder(rec.event_id);
    if (recorder !== null && recorder !== user.id) {
      return { id: rec.id, ok: false, error: 'Mitglieder-Präsenz wurde bereits von einem anderen Helfer erfasst' };
    }
  }

  if (existing) {
    db.prepare(`UPDATE attendance_members
      SET status = ?, comment = ?, entered_by = ?, entered_at = ?, updated_at = ?
      WHERE id = ?`).run(
      rec.status, rec.comment || null, user.id,
      rec.entered_at || updated_at, updated_at, existing.id);
    return { id: existing.id, ok: true, server: db.prepare('SELECT * FROM attendance_members WHERE id = ?').get(existing.id) };
  }
  db.prepare(`INSERT INTO attendance_members (id, event_id, member_id, status, comment, entered_by, entered_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    rec.id, rec.event_id, rec.member_id, rec.status, rec.comment || null,
    user.id, rec.entered_at || updated_at, updated_at);
  return { id: rec.id, ok: true, server: db.prepare('SELECT * FROM attendance_members WHERE id = ?').get(rec.id) };
}

// Upsert eines Helfer-Präsenz-Eintrags (mit Stunden)
function upsertHelper(user, rec) {
  if (!rec.id || !rec.event_id || !rec.helper_id || !VALID_STATUS.includes(rec.status)) {
    return { id: rec.id, ok: false, error: 'Ungültiger Datensatz' };
  }
  const ev = getEvent(rec.event_id);
  if (!ev) return { id: rec.id, ok: false, error: 'Termin nicht gefunden' };
  if (beforeEventDay(ev)) return { id: rec.id, ok: false, error: 'Präsenz kann erst ab dem Termintag eingetragen werden' };
  // Helfer dürfen nur die EIGENE Präsenz erfassen; Admin darf für alle eintragen.
  if (user.role !== 'admin') {
    if (rec.helper_id !== user.id) {
      return { id: rec.id, ok: false, error: 'Helfer dürfen nur die eigene Präsenz eintragen' };
    }
    if (ev.closed) {
      return { id: rec.id, ok: false, error: 'Termin ist abgeschlossen – Stundenänderung nur durch Admin' };
    }
  }
  const existing = db.prepare('SELECT * FROM attendance_helpers WHERE id = ? OR (event_id = ? AND helper_id = ?)')
    .get(rec.id, rec.event_id, rec.helper_id);
  const updated_at = rec.updated_at || new Date().toISOString();
  const hours = Number.isFinite(Number(rec.hours)) ? Number(rec.hours) : 0;

  if (existing && existing.updated_at && updated_at < existing.updated_at) {
    return { id: existing.id, ok: true, skipped: 'älterer Stand', server: existing };
  }

  if (existing) {
    db.prepare(`UPDATE attendance_helpers
      SET status = ?, hours = ?, comment = ?, entered_by = ?, entered_at = ?, updated_at = ?
      WHERE id = ?`).run(
      rec.status, hours, rec.comment || null, user.id,
      rec.entered_at || updated_at, updated_at, existing.id);
    return { id: existing.id, ok: true, server: db.prepare('SELECT * FROM attendance_helpers WHERE id = ?').get(existing.id) };
  }
  db.prepare(`INSERT INTO attendance_helpers (id, event_id, helper_id, status, hours, comment, entered_by, entered_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    rec.id, rec.event_id, rec.helper_id, rec.status, hours, rec.comment || null,
    user.id, rec.entered_at || updated_at, updated_at);
  return { id: rec.id, ok: true, server: db.prepare('SELECT * FROM attendance_helpers WHERE id = ?').get(rec.id) };
}

// POST /api/sync/push  { attendance_members: [], attendance_helpers: [] }
// Verarbeitet eine Offline-Queue in einer Transaktion und liefert pro Datensatz ein Ergebnis.
router.post('/push', requireAuth, (req, res) => {
  const memberRecs = Array.isArray(req.body?.attendance_members) ? req.body.attendance_members : [];
  const helperRecs = Array.isArray(req.body?.attendance_helpers) ? req.body.attendance_helpers : [];

  // Obergrenze pro Sync-Push, um übergroße Transaktionen (leichter DoS) zu vermeiden
  const MAX_BATCH = 1000;
  if (memberRecs.length > MAX_BATCH || helperRecs.length > MAX_BATCH) {
    return res.status(413).json({ error: 'Zu viele Einträge pro Sync (max. 1000 je Liste)' });
  }

  const results = { attendance_members: [], attendance_helpers: [] };
  const tx = db.transaction(() => {
    for (const r of memberRecs) results.attendance_members.push(upsertMember(req.user, r));
    for (const r of helperRecs) results.attendance_helpers.push(upsertHelper(req.user, r));
  });
  tx();
  res.json({ ...results, server_time: new Date().toISOString() });
});

// GET /api/sync/bootstrap  — vollständiger Datenstand zum lokalen Cachen (offline)
router.get('/bootstrap', requireAuth, (req, res) => {
  const members = db.prepare('SELECT * FROM members WHERE active = 1 ORDER BY last_name, first_name').all();
  // Betreuer = Jugendhelfer UND Jugendleiter (Admin) – beide erfassen eigene Präsenz + Stunden
  const helpers = db.prepare("SELECT id, username, role, display_name, active FROM users WHERE role IN ('helper','admin') ORDER BY display_name").all();
  const events = db.prepare(`
    SELECT e.*, u.display_name AS created_by_name
    FROM events e LEFT JOIN users u ON u.id = e.created_by
    ORDER BY e.date DESC`).all();
  const attendance_members = db.prepare('SELECT * FROM attendance_members').all();
  const attendance_helpers = db.prepare('SELECT * FROM attendance_helpers').all();
  res.json({
    server_time: new Date().toISOString(),
    members, helpers, events, attendance_members, attendance_helpers,
  });
});

// GET /api/sync/status  — Übersicht für den Admin (letzte Erfassung pro Helfer)
router.get('/status', requireAuth, requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT u.id, u.display_name,
      (SELECT MAX(entered_at) FROM attendance_members WHERE entered_by = u.id) AS last_member_entry,
      (SELECT MAX(entered_at) FROM attendance_helpers WHERE entered_by = u.id) AS last_helper_entry,
      (SELECT COUNT(*) FROM attendance_members WHERE entered_by = u.id) AS member_entries,
      (SELECT COUNT(*) FROM attendance_helpers WHERE entered_by = u.id) AS helper_entries
    FROM users u WHERE u.role IN ('helper','admin') ORDER BY u.display_name`).all();
  res.json(rows);
});

export default router;
