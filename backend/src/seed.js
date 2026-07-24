// Seed-Skript: legt einen Admin-Account (und optional Demodaten) an.
// Aufruf:  npm run seed
// Der initiale Admin wird aus ENV gelesen (ADMIN_USERNAME / ADMIN_PIN) oder
// fällt auf "admin" / "1234" zurück. Bitte danach die PIN in der App ändern!
import db from './db.js';
import { hashPin } from './auth.js';

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PIN = process.env.ADMIN_PIN || '1234';
const SEED_DEMO = process.env.SEED_DEMO === '1';

function ensureAdmin() {
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(ADMIN_USERNAME);
  if (existing) {
    console.log(`Admin "${ADMIN_USERNAME}" existiert bereits (id=${existing.id}).`);
    return existing.id;
  }
  const info = db.prepare(
    "INSERT INTO users (username, pin_hash, role, display_name) VALUES (?, ?, 'admin', ?)"
  ).run(ADMIN_USERNAME, hashPin(ADMIN_PIN), 'Administrator');
  console.log(`Admin "${ADMIN_USERNAME}" angelegt (PIN: ${ADMIN_PIN}) — bitte PIN ändern!`);
  return info.lastInsertRowid;
}

function seedDemo(adminId) {
  const helperCount = db.prepare("SELECT COUNT(*) c FROM users WHERE role='helper'").get().c;
  if (helperCount > 0) { console.log('Demodaten übersprungen (Helfer existieren bereits).'); return; }

  const helperId = db.prepare(
    "INSERT INTO users (username, pin_hash, role, display_name) VALUES ('helfer1', ?, 'helper', 'Max Helfer')"
  ).run(hashPin('1111')).lastInsertRowid;

  const members = [
    // first, last, birth, medal, mother, motherTel, father, fatherTel, cgdis, cns, street, houseNo, plz, city, allergies, medical
    ['Anna', 'Beispiel', '2012-04-11', 'gold', 'Sabine Beispiel', '0170 1234567', 'Thomas Beispiel', '0171 9876543', '2012-04-1123', '2012041112345', "rue de l'École", '12', '5370', 'Schuttrange', 'Erdnüsse, Pollen', 'Asthma – Notfallspray (Salbutamol)'],
    ['Ben', 'Muster', '2011-09-02', 'silber', 'Petra Muster', '0172 2223344', '', '', '', '', 'Cité Im Bruch', '5', '5316', 'Contern', '', ''],
    ['Clara', 'Test', '2013-01-20', 'bronze', 'Nadine Test', '0691 445566', 'Marc Test', '0691 778899', '', '', 'Op der Gëll', '8', '5335', 'Moutfort', 'Laktose', ''],
    ['David', 'Probe', '2010-12-05', null, 'Eltern Probe', '0661 102030', '', '', '', '', '', '', '', '', '', ''],
  ];
  const mIds = members.map(([f, l, b, medal, mn, mt, fn, ft, cg, cn, st, hn, plz, city, al, med]) =>
    db.prepare(`INSERT INTO members
      (first_name, last_name, birth_date, medal, mother_name, mother_phone, father_name, father_phone,
       matricule_cgdis, matricule_cns, street, house_number, postal_code, city, allergies, medical_notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(f, l, b, medal, mn, mt, fn, ft, cg, cn, st, hn, plz, city, al, med).lastInsertRowid);

  const eventId = db.prepare(
    "INSERT INTO events (date, start_time, end_time, type, location, created_by) VALUES (?, '18:00', '19:30', 'Praktische Übung', 'Feuerwehrhaus', ?)"
  ).run(new Date().toISOString().slice(0, 10), helperId).lastInsertRowid;

  const uuid = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));
  const statuses = ['present', 'present', 'excused', 'unexcused'];
  mIds.forEach((mid, i) => {
    db.prepare(`INSERT INTO attendance_members (id, event_id, member_id, status, entered_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(uuid(), eventId, mid, statuses[i], helperId, new Date().toISOString());
  });
  db.prepare(`INSERT INTO attendance_helpers (id, event_id, helper_id, status, hours, entered_by, updated_at)
    VALUES (?, ?, ?, 'present', 2.5, ?, ?)`).run(uuid(), eventId, helperId, helperId, new Date().toISOString());

  console.log('Demodaten angelegt: 1 Helfer (helfer1/1111), 4 Mitglieder, 1 Termin mit Präsenz.');
}

const adminId = ensureAdmin();
if (SEED_DEMO) seedDemo(adminId);
console.log('Seed abgeschlossen.');
