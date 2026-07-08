import { Router } from 'express';
import db from '../db.js';
import { buildXlsx } from '../xlsx.js';
import { requireAuth, requireAdmin } from '../auth.js';

const router = Router();

const STATUS_LABEL = {
  present: 'Anwesend',
  excused: 'Entschuldigt',
  unexcused: 'Unentschuldigt',
};

// GET /api/export?from=&to=&type=  — Excel mit getrennten Tabellenblättern (nur Admin)
router.get('/', requireAuth, requireAdmin, (req, res) => {
  const { from, to, type } = req.query;
  const clauses = [];
  const params = {};
  if (from) { clauses.push('e.date >= @from'); params.from = from; }
  if (to) { clauses.push('e.date <= @to'); params.to = to; }
  if (type) { clauses.push('e.type = @type'); params.type = type; }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';

  // Mitglieder-Tabelle: Datum, Terminart, Name, Status, Kommentar
  const memberData = db.prepare(`
    SELECT e.date, e.type,
           m.last_name || ', ' || m.first_name AS name,
           a.status, a.comment
    FROM attendance_members a
    JOIN events e ON e.id = a.event_id
    JOIN members m ON m.id = a.member_id
    ${where}
    ORDER BY e.date, m.last_name
  `).all(params);

  const memberRows = [['Datum', 'Terminart', 'Mitglied', 'Status', 'Kommentar']];
  for (const r of memberData) {
    memberRows.push([r.date, r.type, r.name, STATUS_LABEL[r.status] || r.status, r.comment || '']);
  }

  // Helfer-Tabelle: zusätzlich Stunden
  const helperData = db.prepare(`
    SELECT e.date, e.type, u.display_name AS name,
           a.status, a.hours, a.comment
    FROM attendance_helpers a
    JOIN events e ON e.id = a.event_id
    JOIN users u ON u.id = a.helper_id
    ${where}
    ORDER BY e.date, u.display_name
  `).all(params);

  const helperRows = [['Datum', 'Terminart', 'Helfer', 'Status', 'Stunden', 'Kommentar']];
  for (const r of helperData) {
    helperRows.push([r.date, r.type, r.name, STATUS_LABEL[r.status] || r.status, Number(r.hours) || 0, r.comment || '']);
  }

  const buf = buildXlsx([
    { name: 'Mitglieder', rows: memberRows },
    { name: 'Jugendhelfer', rows: helperRows },
  ]);

  const fname = `praesenz_${from || 'alle'}_${to || 'alle'}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
  res.send(buf);
});

export default router;
