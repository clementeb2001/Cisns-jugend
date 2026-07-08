import { Router } from 'express';
import db from '../db.js';
import { buildXlsx } from '../xlsx.js';
import { requireAuth, requireAdmin } from '../auth.js';

const router = Router();

const STATUS_LABEL = { present: 'Anwesend', excused: 'Entschuldigt', unexcused: 'Unentschuldigt' };
const pct = (present, total) => (total > 0 ? Math.round((present / total) * 1000) / 10 : 0);
const typeText = (type, detail) => (type === 'Sonstiges' && detail ? `Sonstiges: ${detail}` : type);
const fmtDate = (iso) => { if (!iso) return ''; const [y, m, d] = iso.split('-'); return `${d}.${m}.${y}`; };

// GET /api/export?from=&to=&type=  — Excel mit 6 Blättern (nur Admin):
//   Mitglieder: Übersicht, nach Terminart, Detail
//   Helfer:     Übersicht (mit Stunden), nach Terminart, Detail
router.get('/', requireAuth, requireAdmin, (req, res) => {
  const { from, to, type } = req.query;
  const clauses = [];
  const params = {};
  if (from) { clauses.push('e.date >= @from'); params.from = from; }
  if (to) { clauses.push('e.date <= @to'); params.to = to; }
  if (type) { clauses.push('e.type = @type'); params.type = type; }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';

  // ---- Rohdaten Mitglieder ----
  const mData = db.prepare(`
    SELECT e.date, e.type, e.type_detail,
           m.last_name || ', ' || m.first_name AS name,
           a.status, a.comment
    FROM attendance_members a
    JOIN events e ON e.id = a.event_id
    JOIN members m ON m.id = a.member_id
    ${where}
    ORDER BY m.last_name, m.first_name, e.date
  `).all(params);

  // ---- Rohdaten Helfer ----
  const hData = db.prepare(`
    SELECT e.date, e.type, e.type_detail,
           u.display_name AS name,
           a.status, a.hours, a.comment
    FROM attendance_helpers a
    JOIN events e ON e.id = a.event_id
    JOIN users u ON u.id = a.helper_id
    ${where}
    ORDER BY u.display_name, e.date
  `).all(params);

  const buf = buildXlsx([
    { name: 'Mitglieder Übersicht', rows: overviewSheet(mData, false) },
    { name: 'Mitglieder nach Art', rows: byTypeSheet(mData, false) },
    { name: 'Mitglieder Detail', rows: detailSheet(mData, false) },
    { name: 'Helfer Übersicht', rows: overviewSheet(hData, true) },
    { name: 'Helfer nach Art', rows: byTypeSheet(hData, true) },
    { name: 'Helfer Detail', rows: detailSheet(hData, true) },
  ]);

  const fname = `praesenz_${from || 'alle'}_${to || 'alle'}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
  res.send(buf);
});

// Übersicht pro Person: Gesamtzahlen (+ Stunden bei Helfern)
function overviewSheet(data, withHours) {
  const map = new Map();
  for (const r of data) {
    if (!map.has(r.name)) map.set(r.name, { present: 0, excused: 0, unexcused: 0, hours: 0 });
    const o = map.get(r.name);
    o[r.status] = (o[r.status] || 0) + 1;
    if (withHours && r.status === 'present') o.hours += Number(r.hours) || 0;
  }
  const header = withHours
    ? ['Helfer', 'Stunden gesamt', 'Anwesend', 'Entschuldigt', 'Unentschuldigt', 'Termine gesamt', 'Quote %']
    : ['Mitglied', 'Anwesend', 'Entschuldigt', 'Unentschuldigt', 'Termine gesamt', 'Quote %'];
  const rows = [header];
  for (const [name, o] of [...map].sort((a, b) => a[0].localeCompare(b[0]))) {
    const total = o.present + o.excused + o.unexcused;
    rows.push(withHours
      ? [name, Math.round(o.hours * 100) / 100, o.present, o.excused, o.unexcused, total, pct(o.present, total)]
      : [name, o.present, o.excused, o.unexcused, total, pct(o.present, total)]);
  }
  return rows.length > 1 ? rows : [header, []];
}

// Aufschlüsselung pro Person und Terminart
function byTypeSheet(data, withHours) {
  const map = new Map(); // key: name|type
  for (const r of data) {
    const key = r.name + '|' + r.type;
    if (!map.has(key)) map.set(key, { name: r.name, type: r.type, present: 0, excused: 0, unexcused: 0, hours: 0 });
    const o = map.get(key);
    o[r.status] = (o[r.status] || 0) + 1;
    if (withHours && r.status === 'present') o.hours += Number(r.hours) || 0;
  }
  const header = withHours
    ? ['Helfer', 'Terminart', 'Anwesend', 'Entschuldigt', 'Unentschuldigt', 'Stunden']
    : ['Mitglied', 'Terminart', 'Anwesend', 'Entschuldigt', 'Unentschuldigt'];
  const rows = [header];
  for (const o of [...map.values()].sort((a, b) => a.name.localeCompare(b.name) || a.type.localeCompare(b.type))) {
    rows.push(withHours
      ? [o.name, o.type, o.present, o.excused, o.unexcused, Math.round(o.hours * 100) / 100]
      : [o.name, o.type, o.present, o.excused, o.unexcused]);
  }
  return rows.length > 1 ? rows : [header, []];
}

// Detailliste: jede einzelne Teilnahme
function detailSheet(data, withHours) {
  const header = withHours
    ? ['Datum', 'Terminart', 'Helfer', 'Status', 'Stunden', 'Kommentar']
    : ['Datum', 'Terminart', 'Mitglied', 'Status', 'Kommentar'];
  const rows = [header];
  // nach Datum sortiert
  for (const r of [...data].sort((a, b) => (a.date || '').localeCompare(b.date || '') || a.name.localeCompare(b.name))) {
    rows.push(withHours
      ? [fmtDate(r.date), typeText(r.type, r.type_detail), r.name, STATUS_LABEL[r.status] || r.status, Number(r.hours) || 0, r.comment || '']
      : [fmtDate(r.date), typeText(r.type, r.type_detail), r.name, STATUS_LABEL[r.status] || r.status, r.comment || '']);
  }
  return rows.length > 1 ? rows : [header, []];
}

export default router;
