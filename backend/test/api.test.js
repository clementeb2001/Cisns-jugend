// End-to-End-API-Tests mit dem eingebauten Node-Test-Runner (node --test).
// Startet den Express-Server mit einer temporären SQLite-DB und prüft die
// wichtigsten Abläufe – besonders die Offline-Sync-Logik (Last-Write-Wins)
// und die Rollen-Autorisierung.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import zlib from 'node:zlib';

// DB-Pfad + Secret setzen, BEVOR db.js/app.js importiert werden
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jf-test-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.JWT_SECRET = 'test-secret';
process.env.EDIT_WINDOW_HOURS = '24';

let server, base, db, hashPin;
let adminToken, helperToken, helperId, eventId, memberId;

const api = (method, p, { token, body } = {}) => fetch(base + p, {
  method,
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
  body: body !== undefined ? JSON.stringify(body) : undefined,
});
const uuid = () => crypto.randomUUID();

before(async () => {
  db = (await import('../src/db.js')).default;
  ({ hashPin } = await import('../src/auth.js'));
  // Admin + Helfer direkt in der DB anlegen
  db.prepare("INSERT INTO users (username, pin_hash, role, display_name) VALUES ('admin', ?, 'admin', 'Admin')").run(hashPin('1234'));
  helperId = db.prepare("INSERT INTO users (username, pin_hash, role, display_name) VALUES ('helfer1', ?, 'helper', 'Helfer Eins')").run(hashPin('1111')).lastInsertRowid;

  const app = (await import('../src/app.js')).default;
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://localhost:${server.address().port}`;
});

after(() => {
  server?.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('Login mit falscher PIN wird abgelehnt', async () => {
  const res = await api('POST', '/api/auth/login', { body: { username: 'admin', pin: '9999' } });
  assert.equal(res.status, 401);
});

test('Login als Admin und Helfer liefert Token', async () => {
  const a = await api('POST', '/api/auth/login', { body: { username: 'admin', pin: '1234' } });
  assert.equal(a.status, 200);
  adminToken = (await a.json()).token;
  assert.ok(adminToken);

  const h = await api('POST', '/api/auth/login', { body: { username: 'helfer1', pin: '1111' } });
  const hd = await h.json();
  helperToken = hd.token;
  assert.equal(hd.user.role, 'helper');
});

test('Ohne Token -> 401', async () => {
  const res = await api('GET', '/api/members');
  assert.equal(res.status, 401);
});

test('Admin legt Mitglied an, Helfer darf das nicht', async () => {
  const ok = await api('POST', '/api/members', { token: adminToken, body: { first_name: 'Anna', last_name: 'Test' } });
  assert.equal(ok.status, 201);
  memberId = (await ok.json()).id;

  const forbidden = await api('POST', '/api/members', { token: helperToken, body: { first_name: 'X', last_name: 'Y' } });
  assert.equal(forbidden.status, 403);
});

test('Helfer darf Termine anlegen', async () => {
  const res = await api('POST', '/api/events', {
    token: helperToken,
    body: { date: '2026-03-01', start_time: '18:00', end_time: '20:00', type: 'Übung' },
  });
  assert.equal(res.status, 201);
  eventId = (await res.json()).id;
});

test('Sync-Push legt Präsenz an (Offline-Queue)', async () => {
  const id = uuid();
  // entered_at/updated_at aktuell -> Eintrag liegt im Bearbeitungsfenster
  const now = new Date().toISOString();
  const res = await api('POST', '/api/sync/push', {
    token: helperToken,
    body: {
      attendance_members: [{ id, event_id: eventId, member_id: memberId, status: 'present', updated_at: now }],
      attendance_helpers: [{ id: uuid(), event_id: eventId, helper_id: helperId, status: 'present', hours: 3, updated_at: now }],
    },
  });
  const data = await res.json();
  assert.equal(data.attendance_members[0].ok, true);
  assert.equal(data.attendance_members[0].server.status, 'present');
  assert.equal(data.attendance_helpers[0].server.hours, 3);
});

test('Last-Write-Wins: älterer Zeitstempel wird verworfen', async () => {
  // vorhandenen Eintrag ermitteln
  const existing = db.prepare('SELECT id FROM attendance_members WHERE event_id = ? AND member_id = ?').get(eventId, memberId);
  // älterer Push (1h in der Vergangenheit) soll NICHT überschreiben
  const older = await api('POST', '/api/sync/push', {
    token: helperToken,
    body: { attendance_members: [{ id: existing.id, event_id: eventId, member_id: memberId, status: 'unexcused', updated_at: new Date(Date.now() - 3600000).toISOString() }] },
  });
  const od = await older.json();
  assert.equal(od.attendance_members[0].skipped, 'älterer Stand');
  assert.equal(od.attendance_members[0].server.status, 'present');

  // neuerer Push (1h in der Zukunft) SOLL überschreiben; Eintrag noch im Fenster
  const newer = await api('POST', '/api/sync/push', {
    token: helperToken,
    body: { attendance_members: [{ id: existing.id, event_id: eventId, member_id: memberId, status: 'excused', updated_at: new Date(Date.now() + 3600000).toISOString() }] },
  });
  const nd = await newer.json();
  assert.equal(nd.attendance_members[0].server.status, 'excused');

  // keine Duplikate
  const count = db.prepare('SELECT COUNT(*) c FROM attendance_members WHERE event_id = ? AND member_id = ?').get(eventId, memberId).c;
  assert.equal(count, 1);
});

test('Bootstrap liefert kompletten Datenstand', async () => {
  const res = await api('GET', '/api/sync/bootstrap', { token: helperToken });
  const data = await res.json();
  assert.equal(data.members.length, 1);
  assert.equal(data.events.length, 1);
  assert.equal(data.attendance_members.length, 1);
  assert.equal(data.attendance_helpers.length, 1);
});

test('Statistik zählt Status korrekt', async () => {
  const m = await (await api('GET', '/api/stats/members?from=2026-01-01&to=2026-12-31', { token: adminToken })).json();
  assert.equal(m[0].excused, 1);
  assert.equal(m[0].present, 0);
  const h = await (await api('GET', '/api/stats/helpers?from=2026-01-01&to=2026-12-31', { token: adminToken })).json();
  assert.equal(h[0].hours, 3);
  assert.equal(h[0].present, 1);
});

test('Helfer-Editierfenster: fremder alter Eintrag nur von Admin änderbar', async () => {
  // Ein zweiter Helfer versucht, einen bereits synchronisierten Eintrag ausserhalb
  // seines Fensters zu ändern -> abgelehnt (entered_by != user, kein Admin).
  const other = db.prepare("INSERT INTO users (username, pin_hash, role, display_name) VALUES ('helfer2', ?, 'helper', 'Helfer Zwei')").run(hashPin('2222')).lastInsertRowid;
  const otherToken = (await (await api('POST', '/api/auth/login', { body: { username: 'helfer2', pin: '2222' } })).json()).token;
  const existing = db.prepare('SELECT id FROM attendance_members WHERE event_id = ? AND member_id = ?').get(eventId, memberId);
  // entered_at künstlich alt setzen, damit es ausserhalb des Fensters liegt
  db.prepare("UPDATE attendance_members SET entered_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(existing.id);

  // updated_at klar neuer als der gespeicherte Stand, damit die Prüfung nicht
  // schon an der Last-Write-Wins-Logik (älterer Stand) endet, sondern das
  // Bearbeitungsfenster greift.
  const res = await api('POST', '/api/sync/push', {
    token: otherToken,
    body: { attendance_members: [{ id: existing.id, event_id: eventId, member_id: memberId, status: 'present', updated_at: new Date(Date.now() + 7200000).toISOString() }] },
  });
  const d = await res.json();
  assert.equal(d.attendance_members[0].ok, false);
  assert.match(d.attendance_members[0].error, /fenster/i);

  // Admin darf denselben Eintrag ändern
  const adminRes = await api('POST', '/api/sync/push', {
    token: adminToken,
    body: { attendance_members: [{ id: existing.id, event_id: eventId, member_id: memberId, status: 'present', updated_at: new Date(Date.now() + 7200000).toISOString() }] },
  });
  assert.equal((await adminRes.json()).attendance_members[0].server.status, 'present');
});

test('Excel-Export: nur Admin, valides XLSX (ZIP mit erwarteten Teilen)', async () => {
  const forbidden = await api('GET', '/api/export', { token: helperToken });
  assert.equal(forbidden.status, 403);

  const res = await api('GET', '/api/export', { token: adminToken });
  assert.equal(res.status, 200);
  const buf = Buffer.from(await res.arrayBuffer());
  // ZIP-Signatur
  assert.equal(buf.readUInt32LE(0), 0x04034b50);
  // dekomprimierbare Central Directory vorhanden -> Namen prüfen
  const text = buf.toString('latin1');
  assert.ok(text.includes('[Content_Types].xml'));
  assert.ok(text.includes('xl/worksheets/sheet1.xml'));
  assert.ok(text.includes('xl/worksheets/sheet2.xml'));
});
