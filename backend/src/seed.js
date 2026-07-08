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
    ['Anna', 'Beispiel', '2012-04-11', 'Mutter (Sabine)', '0170 1234567'],
    ['Ben', 'Muster', '2011-09-02', 'Vater (Thomas)', '0171 2345678'],
    ['Clara', 'Test', '2013-01-20', 'Mutter (Petra)', '0172 3456789'],
    ['David', 'Probe', '2010-12-05', 'Eltern', '0173 4567890'],
  ];
  const mIds = members.map(([f, l, b, ec, ep]) =>
    db.prepare('INSERT INTO members (first_name, last_name, birth_date, emergency_contact, emergency_phone) VALUES (?, ?, ?, ?, ?)')
      .run(f, l, b, ec, ep).lastInsertRowid);

  const eventId = db.prepare(
    "INSERT INTO events (date, start_time, end_time, type, location, created_by) VALUES (?, '18:00', '19:30', 'Übung', 'Feuerwehrhaus', ?)"
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
