import { Router } from 'express';
import db from '../db.js';
import { requireAuth } from '../auth.js';

const router = Router();

// Baut die WHERE-Bedingung + Parameter für Zeitraum/Terminart auf events auf.
// Die Bedingung wird in einer Unterabfrage angewandt, die die Präsenz-Einträge
// bereits auf die passenden Termine einschränkt (siehe unten). So filtern
// Zeitraum/Terminart tatsächlich – Mitglieder/Betreuer ohne Treffer bleiben mit 0
// erhalten (LEFT JOIN).
function eventFilter(query) {
  const clauses = [];
  const params = {};
  if (query.from) { clauses.push('e.date >= @from'); params.from = query.from; }
  if (query.to) { clauses.push('e.date <= @to'); params.to = query.to; }
  if (query.type) { clauses.push('e.type = @type'); params.type = query.type; }
  return { cond: clauses.length ? 'WHERE ' + clauses.join(' AND ') : '', params };
}

function pct(present, total) {
  return total > 0 ? Math.round((present / total) * 1000) / 10 : 0;
}

// GET /api/stats/members?from=&to=&type=
router.get('/members', requireAuth, (req, res) => {
  const { cond, params } = eventFilter(req.query);
  const rows = db.prepare(`
    SELECT m.id, m.first_name, m.last_name, m.active,
      SUM(CASE WHEN a.status = 'present'   THEN 1 ELSE 0 END) AS present,
      SUM(CASE WHEN a.status = 'excused'   THEN 1 ELSE 0 END) AS excused,
      SUM(CASE WHEN a.status = 'unexcused' THEN 1 ELSE 0 END) AS unexcused,
      COUNT(a.id) AS total
    FROM members m
    LEFT JOIN (
      SELECT a.id, a.member_id, a.status
      FROM attendance_members a JOIN events e ON e.id = a.event_id
      ${cond}
    ) a ON a.member_id = m.id
    GROUP BY m.id
    ORDER BY m.last_name, m.first_name
  `).all(params).map((r) => ({
    id: r.id, name: `${r.last_name}, ${r.first_name}`, active: !!r.active,
    present: r.present || 0, excused: r.excused || 0, unexcused: r.unexcused || 0,
    total: r.total || 0, quote: pct(r.present || 0, r.total || 0),
  }));
  res.json(rows);
});

// GET /api/stats/helpers?from=&to=&type=
router.get('/helpers', requireAuth, (req, res) => {
  const { cond, params } = eventFilter(req.query);
  const rows = db.prepare(`
    SELECT u.id, u.display_name,
      SUM(CASE WHEN a.status = 'present'   THEN 1 ELSE 0 END) AS present,
      SUM(CASE WHEN a.status = 'excused'   THEN 1 ELSE 0 END) AS excused,
      SUM(CASE WHEN a.status = 'unexcused' THEN 1 ELSE 0 END) AS unexcused,
      COUNT(a.id) AS total,
      COALESCE(SUM(CASE WHEN a.status = 'present' THEN a.hours ELSE 0 END), 0) AS hours
    FROM users u
    LEFT JOIN (
      SELECT a.id, a.helper_id, a.status, a.hours
      FROM attendance_helpers a JOIN events e ON e.id = a.event_id
      ${cond}
    ) a ON a.helper_id = u.id
    WHERE u.role IN ('helper','admin')
    GROUP BY u.id
    ORDER BY u.display_name
  `).all(params).map((r) => ({
    id: r.id, name: r.display_name,
    present: r.present || 0, excused: r.excused || 0, unexcused: r.unexcused || 0,
    total: r.total || 0, hours: Math.round((r.hours || 0) * 100) / 100,
    quote: pct(r.present || 0, r.total || 0),
  }));
  res.json(rows);
});

// GET /api/stats/event/:id  — Übersicht pro Termin (Mitglieder + Helfer getrennt)
router.get('/event/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const members = db.prepare(`
    SELECT m.first_name, m.last_name, a.status, a.comment
    FROM attendance_members a JOIN members m ON m.id = a.member_id
    WHERE a.event_id = ? ORDER BY m.last_name`).all(id);
  const helpers = db.prepare(`
    SELECT u.display_name, a.status, a.hours, a.comment
    FROM attendance_helpers a JOIN users u ON u.id = a.helper_id
    WHERE a.event_id = ? ORDER BY u.display_name`).all(id);
  res.json({ members, helpers });
});

export default router;
