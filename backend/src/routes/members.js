import { Router } from 'express';
import db from '../db.js';
import { requireAuth, requireAdmin } from '../auth.js';

const router = Router();

const MEDALS = ['bronze', 'silber', 'gold'];
const normMedal = (v) => (MEDALS.includes(String(v || '').toLowerCase()) ? String(v).toLowerCase() : null);

const mapMember = (m) => ({
  id: m.id, first_name: m.first_name, last_name: m.last_name,
  birth_date: m.birth_date, active: !!m.active,
  medal: m.medal || null,
  mother_name: m.mother_name || null, mother_phone: m.mother_phone || null,
  father_name: m.father_name || null, father_phone: m.father_phone || null,
  matricule_cgdis: m.matricule_cgdis || null, matricule_cns: m.matricule_cns || null,
  address: m.address || null, allergies: m.allergies || null, medical_notes: m.medical_notes || null,
});

// Optionale Textfelder aus dem Request holen (leer -> null)
const optFields = (b) => ({
  medal: normMedal(b.medal),
  mother_name: b.mother_name?.trim() || null, mother_phone: b.mother_phone?.trim() || null,
  father_name: b.father_name?.trim() || null, father_phone: b.father_phone?.trim() || null,
  matricule_cgdis: b.matricule_cgdis?.trim() || null, matricule_cns: b.matricule_cns?.trim() || null,
  address: b.address?.trim() || null, allergies: b.allergies?.trim() || null,
  medical_notes: b.medical_notes?.trim() || null,
});

// GET /api/members?includeInactive=1  (alle authentifizierten Nutzer)
router.get('/', requireAuth, (req, res) => {
  const includeInactive = req.query.includeInactive === '1' && req.user.role === 'admin';
  const rows = includeInactive
    ? db.prepare('SELECT * FROM members ORDER BY last_name, first_name').all()
    : db.prepare('SELECT * FROM members WHERE active = 1 ORDER BY last_name, first_name').all();
  res.json(rows.map(mapMember));
});

// GET /api/members/:id  — Einzelansicht (auch Helfer dürfen lesen)
router.get('/:id', requireAuth, (req, res) => {
  const m = db.prepare('SELECT * FROM members WHERE id = ?').get(Number(req.params.id));
  if (!m) return res.status(404).json({ error: 'Mitglied nicht gefunden' });
  res.json(mapMember(m));
});

// Ab hier nur Admin
router.use(requireAuth, requireAdmin);

// POST /api/members
router.post('/', (req, res) => {
  const b = req.body || {};
  const { first_name, last_name, birth_date } = b;
  if (!first_name || !last_name) {
    return res.status(400).json({ error: 'Vor- und Nachname erforderlich' });
  }
  const f = optFields(b);
  const info = db.prepare(`INSERT INTO members
      (first_name, last_name, birth_date, medal, mother_name, mother_phone, father_name, father_phone,
       matricule_cgdis, matricule_cns, address, allergies, medical_notes)
      VALUES (@first_name, @last_name, @birth_date, @medal, @mother_name, @mother_phone, @father_name, @father_phone,
       @matricule_cgdis, @matricule_cns, @address, @allergies, @medical_notes)`)
    .run({ first_name: String(first_name).trim(), last_name: String(last_name).trim(), birth_date: birth_date || null, ...f });
  res.status(201).json(mapMember(db.prepare('SELECT * FROM members WHERE id = ?').get(info.lastInsertRowid)));
});

// PUT /api/members/:id
router.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const m = db.prepare('SELECT * FROM members WHERE id = ?').get(id);
  if (!m) return res.status(404).json({ error: 'Mitglied nicht gefunden' });
  const b = req.body || {};
  const { first_name, last_name, birth_date, active } = b;
  const f = optFields(b);
  db.prepare(`UPDATE members SET
      first_name = COALESCE(@first_name, first_name),
      last_name = COALESCE(@last_name, last_name),
      birth_date = @birth_date,
      medal = @medal,
      mother_name = @mother_name, mother_phone = @mother_phone,
      father_name = @father_name, father_phone = @father_phone,
      matricule_cgdis = @matricule_cgdis, matricule_cns = @matricule_cns,
      address = @address, allergies = @allergies, medical_notes = @medical_notes,
      active = COALESCE(@active, active),
      updated_at = datetime('now')
    WHERE id = @id`).run({
    first_name: first_name ?? null, last_name: last_name ?? null,
    birth_date: birth_date === undefined ? m.birth_date : (birth_date || null),
    active: active === undefined ? null : (active ? 1 : 0),
    id, ...f,
  });
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
