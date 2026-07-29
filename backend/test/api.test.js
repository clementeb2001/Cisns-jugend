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
    body: { date: '2026-03-01', start_time: '18:00', end_time: '20:00', type: 'Praktische Übung' },
  });
  assert.equal(res.status, 201);
  eventId = (await res.json()).id;
});

test('Termin "Sonstiges" ohne Beschreibung wird abgelehnt', async () => {
  const bad = await api('POST', '/api/events', { token: helperToken, body: { date: '2026-03-05', type: 'Sonstiges' } });
  assert.equal(bad.status, 400);
  const ok = await api('POST', '/api/events', { token: helperToken, body: { date: '2026-03-05', type: 'Sonstiges', type_detail: 'Grillfest' } });
  assert.equal(ok.status, 201);
  assert.equal((await ok.json()).type_detail, 'Grillfest');
});

test('Mehrtägiges "Sonstiges": Enddatum wird gespeichert, sonst ignoriert', async () => {
  // Sonstiges mit gültigem Enddatum -> gespeichert
  const camp = await api('POST', '/api/events', { token: helperToken,
    body: { date: '2026-07-10', end_date: '2026-07-13', type: 'Sonstiges', type_detail: 'JugendCamp' } });
  assert.equal((await camp.json()).end_date, '2026-07-13');
  // Enddatum vor/gleich Startdatum -> ignoriert (null)
  const bad = await api('POST', '/api/events', { token: helperToken,
    body: { date: '2026-07-10', end_date: '2026-07-09', type: 'Sonstiges', type_detail: 'X' } });
  assert.equal((await bad.json()).end_date, null);
  // Andere Terminart -> Enddatum wird nicht übernommen
  const other = await api('POST', '/api/events', { token: helperToken,
    body: { date: '2026-07-10', end_date: '2026-07-13', type: 'Theorie' } });
  assert.equal((await other.json()).end_date, null);
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
  assert.ok(data.events.length >= 1);
  assert.equal(data.attendance_members.length, 1);
  assert.equal(data.attendance_helpers.length, 1);
});

test('Statistik zählt Status korrekt', async () => {
  const m = await (await api('GET', '/api/stats/members?from=2026-01-01&to=2026-12-31', { token: adminToken })).json();
  assert.equal(m[0].excused, 1);
  assert.equal(m[0].present, 0);
  // Betreuer-Statistik enthält Helfer UND Admin -> gezielt den Helfer prüfen
  const h = await (await api('GET', '/api/stats/helpers?from=2026-01-01&to=2026-12-31', { token: adminToken })).json();
  const h1 = h.find((x) => x.name === 'Helfer Eins');
  assert.equal(h1.hours, 3);
  assert.equal(h1.present, 1);
  // Der Admin taucht in der Betreuer-Statistik ebenfalls auf
  assert.ok(h.some((x) => x.name === 'Admin'));
});

test('Statistik-Zeitraumfilter schließt Termine außerhalb des Zeitraums aus', async () => {
  // Alle Testtermine liegen in 2026 -> ein Filter ab 2030 muss überall 0 ergeben
  const m = await (await api('GET', '/api/stats/members?from=2030-01-01&to=2030-12-31', { token: adminToken })).json();
  assert.ok(m.every((r) => r.total === 0), 'Mitglieder-Total außerhalb des Zeitraums muss 0 sein');
  const h = await (await api('GET', '/api/stats/helpers?from=2030-01-01&to=2030-12-31', { token: adminToken })).json();
  assert.ok(h.every((r) => r.total === 0 && r.hours === 0), 'Betreuer-Total/Stunden außerhalb des Zeitraums müssen 0 sein');
});

test('Admin kann eigene Präsenz + Stunden erfassen (als Betreuer)', async () => {
  // Admin trägt für sich selbst (helper_id = eigene id) Präsenz mit Stunden ein
  const adminId = db.prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
  const res = await api('POST', '/api/sync/push', {
    token: adminToken,
    body: { attendance_helpers: [{ id: crypto.randomUUID(), event_id: eventId, helper_id: adminId, status: 'present', hours: 2.5, updated_at: new Date().toISOString() }] },
  });
  assert.equal((await res.json()).attendance_helpers[0].server.hours, 2.5);
  // erscheint in der Betreuer-Statistik mit Stunden
  const h = await (await api('GET', '/api/stats/helpers?from=2026-01-01&to=2026-12-31', { token: adminToken })).json();
  assert.equal(h.find((x) => x.name === 'Admin').hours, 2.5);
});

test('Mitglieder-Präsenz: fremder Helfer gesperrt, Erfasser + Admin erlaubt', async () => {
  // helfer1 ist Erfasser (aus vorherigen Tests). Ein zweiter Helfer darf die
  // Mitglieder-Präsenz dieses Termins NICHT ändern.
  db.prepare("INSERT INTO users (username, pin_hash, role, display_name) VALUES ('helfer2', ?, 'helper', 'Helfer Zwei')").run(hashPin('2222'));
  const otherToken = (await (await api('POST', '/api/auth/login', { body: { username: 'helfer2', pin: '2222' } })).json()).token;
  const existing = db.prepare('SELECT id FROM attendance_members WHERE event_id = ? AND member_id = ?').get(eventId, memberId);

  const res = await api('POST', '/api/sync/push', {
    token: otherToken,
    body: { attendance_members: [{ id: existing.id, event_id: eventId, member_id: memberId, status: 'present', updated_at: new Date(Date.now() + 7200000).toISOString() }] },
  });
  const d = await res.json();
  assert.equal(d.attendance_members[0].ok, false);
  assert.match(d.attendance_members[0].error, /anderen Helfer|erfasst/i);

  // Erfasser (helfer1) darf weiter korrigieren
  const own = await api('POST', '/api/sync/push', {
    token: helperToken,
    body: { attendance_members: [{ id: existing.id, event_id: eventId, member_id: memberId, status: 'present', updated_at: new Date(Date.now() + 7200001).toISOString() }] },
  });
  assert.equal((await own.json()).attendance_members[0].server.status, 'present');

  // Admin darf immer
  const adminRes = await api('POST', '/api/sync/push', {
    token: adminToken,
    body: { attendance_members: [{ id: existing.id, event_id: eventId, member_id: memberId, status: 'excused', updated_at: new Date(Date.now() + 7200002).toISOString() }] },
  });
  assert.equal((await adminRes.json()).attendance_members[0].server.status, 'excused');
});

test('Termin abschließen sperrt Helfer (Präsenz + Stunden), Admin bleibt', async () => {
  await api('POST', `/api/events/${eventId}/close`, { token: adminToken });

  // Helfer darf eigene Stunden nicht mehr ändern
  const h = await api('POST', '/api/sync/push', {
    token: helperToken,
    body: { attendance_helpers: [{ id: uuid(), event_id: eventId, helper_id: helperId, status: 'present', hours: 5, updated_at: new Date().toISOString() }] },
  });
  assert.equal((await h.json()).attendance_helpers[0].ok, false);

  // Erfasser darf Mitglieder-Präsenz nicht mehr ändern
  // (Zeitstempel klar neuer als frühere Tests, sonst greift schon Last-Write-Wins)
  const existing = db.prepare('SELECT id FROM attendance_members WHERE event_id = ? AND member_id = ?').get(eventId, memberId);
  const m = await api('POST', '/api/sync/push', {
    token: helperToken,
    body: { attendance_members: [{ id: existing.id, event_id: eventId, member_id: memberId, status: 'present', updated_at: new Date(Date.now() + 7300000).toISOString() }] },
  });
  assert.equal((await m.json()).attendance_members[0].ok, false);

  // Admin darf weiterhin
  const a = await api('POST', '/api/sync/push', {
    token: adminToken,
    body: { attendance_members: [{ id: existing.id, event_id: eventId, member_id: memberId, status: 'present', updated_at: new Date(Date.now() + 7300001).toISOString() }] },
  });
  assert.equal((await a.json()).attendance_members[0].ok, true);

  // Wieder öffnen -> Helfer darf wieder eigene Stunden
  await api('POST', `/api/events/${eventId}/reopen`, { token: adminToken });
  const reopened = await api('POST', '/api/sync/push', {
    token: helperToken,
    body: { attendance_helpers: [{ id: uuid(), event_id: eventId, helper_id: helperId, status: 'present', hours: 4, updated_at: new Date().toISOString() }] },
  });
  assert.equal((await reopened.json()).attendance_helpers[0].server.hours, 4);
});

test('Zukünftiger Termin kann nicht abgeschlossen werden', async () => {
  const future = await (await api('POST', '/api/events', { token: adminToken,
    body: { date: '2999-12-31', type: 'Theorie' } })).json();
  const res = await api('POST', `/api/events/${future.id}/close`, { token: adminToken });
  assert.equal(res.status, 400);
  // bleibt offen
  const still = db.prepare('SELECT closed FROM events WHERE id = ?').get(future.id);
  assert.equal(still.closed, 0);
});

test('Präsenz für zukünftigen Termin wird abgelehnt (Mitglied + Betreuer)', async () => {
  const future = await (await api('POST', '/api/events', { token: adminToken,
    body: { date: '2999-11-11', type: 'Theorie' } })).json();
  const adminId = db.prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
  const res = await api('POST', '/api/sync/push', {
    token: adminToken,
    body: {
      attendance_members: [{ id: crypto.randomUUID(), event_id: future.id, member_id: memberId, status: 'present', updated_at: new Date().toISOString() }],
      attendance_helpers: [{ id: crypto.randomUUID(), event_id: future.id, helper_id: adminId, status: 'present', hours: 2, updated_at: new Date().toISOString() }],
    },
  });
  const j = await res.json();
  assert.equal(j.attendance_members[0].ok, false);
  assert.equal(j.attendance_helpers[0].ok, false);
  // nichts gespeichert
  assert.equal(db.prepare('SELECT COUNT(*) c FROM attendance_members WHERE event_id = ?').get(future.id).c, 0);
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
  // 4 Blätter: Mitglieder (Übersicht/nach Art) + Betreuer (Übersicht/nach Art)
  for (let i = 1; i <= 4; i++) assert.ok(text.includes(`xl/worksheets/sheet${i}.xml`), `sheet${i} fehlt`);
  assert.ok(!text.includes('xl/worksheets/sheet5.xml'), 'kein 5. Blatt mehr');
  assert.ok(text.includes('Mitglieder'));
  assert.ok(text.includes('Betreuer'));
});

test('Backup-Download: nur Admin, liefert gültige SQLite-Datei', async () => {
  const forbidden = await api('GET', '/api/backup', { token: helperToken });
  assert.equal(forbidden.status, 403);
  const res = await api('GET', '/api/backup', { token: adminToken });
  assert.equal(res.status, 200);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.slice(0, 15).toString('latin1'), 'SQLite format 3');
});

test('Passwort-Regel: unter 8 Zeichen abgelehnt, echtes Passwort akzeptiert + Login', async () => {
  const short = await api('POST', '/api/users', { token: adminToken,
    body: { username: 'pwtest1', pin: 'abc12', display_name: 'PW Kurz', role: 'helper' } });
  assert.equal(short.status, 400);
  const ok = await api('POST', '/api/users', { token: adminToken,
    body: { username: 'pwtest2', pin: 'Feuerwehr2026!', display_name: 'PW Stark', role: 'helper' } });
  assert.equal(ok.status, 201);
  const login = await api('POST', '/api/auth/login', { body: { username: 'pwtest2', pin: 'Feuerwehr2026!' } });
  assert.equal(login.status, 200);
});

test('Helfer darf keine fremde Helfer-Präsenz eintragen (nur eigene)', async () => {
  const otherId = db.prepare('SELECT id FROM users WHERE username = ?').get('helfer2').id;
  // helfer1 versucht, die Präsenz von helfer2 einzutragen -> abgelehnt
  const res = await api('POST', '/api/sync/push', {
    token: helperToken,
    body: { attendance_helpers: [{ id: crypto.randomUUID(), event_id: eventId, helper_id: otherId, status: 'present', hours: 1, updated_at: new Date().toISOString() }] },
  });
  const d = await res.json();
  assert.equal(d.attendance_helpers[0].ok, false);
  assert.match(d.attendance_helpers[0].error, /eigene/i);

  // Admin darf für andere Helfer eintragen
  const adminRes = await api('POST', '/api/sync/push', {
    token: adminToken,
    body: { attendance_helpers: [{ id: crypto.randomUUID(), event_id: eventId, helper_id: otherId, status: 'present', hours: 1.5, updated_at: new Date().toISOString() }] },
  });
  assert.equal((await adminRes.json()).attendance_helpers[0].server.hours, 1.5);
});

test('Mitglied: Eltern-Kontakte, Medaille und Zusatzfelder werden gespeichert', async () => {
  const create = await api('POST', '/api/members', {
    token: adminToken,
    body: {
      first_name: 'Nina', last_name: 'Zart', birth_date: '2012-05-06', medal: 'Gold',
      mother_name: 'Sabine Zart', mother_phone: '0170 1234567',
      father_name: 'Tom Zart', father_phone: '0171 7654321',
      matricule_cgdis: 'CG-123', matricule_cns: 'CN-456',
      street: 'rue Test', house_number: '1', postal_code: '5370', city: 'Schuttrange',
      allergies: 'Nüsse', medical_notes: 'Asthma',
    },
  });
  assert.equal(create.status, 201);
  const created = await create.json();
  assert.equal(created.medal, 'gold');            // normalisiert (klein)
  assert.equal(created.mother_phone, '0170 1234567');
  assert.equal(created.father_name, 'Tom Zart');
  assert.equal(created.matricule_cgdis, 'CG-123');
  assert.equal(created.street, 'rue Test');
  assert.equal(created.house_number, '1');
  assert.equal(created.postal_code, '5370');
  assert.equal(created.city, 'Schuttrange');
  assert.equal(created.allergies, 'Nüsse');

  // Ungültige Medaille -> null
  const bad = await (await api('POST', '/api/members', { token: adminToken,
    body: { first_name: 'X', last_name: 'Y', medal: 'platin' } })).json();
  assert.equal(bad.medal, null);

  // Helfer darf die Einzelansicht lesen (inkl. Gesundheitsdaten)
  const one = await api('GET', '/api/members/' + created.id, { token: helperToken });
  assert.equal(one.status, 200);
  const found = await one.json();
  assert.equal(found.father_phone, '0171 7654321');
  assert.equal(found.medical_notes, 'Asthma');
});

test('Login-Rate-Limit: nach zu vielen Fehlversuchen 429', async () => {
  // Bewusst ein nicht existierender Nutzer, damit echte Konten nicht gesperrt werden
  let last;
  for (let i = 0; i < 8; i++) {
    last = await api('POST', '/api/auth/login', { body: { username: 'brute-target', pin: '0000' } });
    assert.equal(last.status, 401);
  }
  const blocked = await api('POST', '/api/auth/login', { body: { username: 'brute-target', pin: '0000' } });
  assert.equal(blocked.status, 429);
});

test('Deaktiviertes Konto: bestehendes Token wird sofort abgewiesen', async () => {
  db.prepare("INSERT INTO users (username, pin_hash, role, display_name) VALUES ('temp', ?, 'helper', 'Temp')").run(hashPin('4321'));
  const token = (await (await api('POST', '/api/auth/login', { body: { username: 'temp', pin: '4321' } })).json()).token;
  assert.equal((await api('GET', '/api/members', { token })).status, 200);
  // Konto deaktivieren -> Token muss ab sofort ungültig sein (Prüfung pro Anfrage)
  db.prepare("UPDATE users SET active = 0 WHERE username = 'temp'").run();
  assert.equal((await api('GET', '/api/members', { token })).status, 401);
});

test('XLSX-Writer neutralisiert Formel-Injection', async () => {
  const { buildXlsx } = await import('../src/xlsx.js');
  const buf = buildXlsx([{ name: 'T', rows: [['Kommentar'], ['=HYPERLINK("http://evil")'], ['+1'], ['harmlos']] }]);
  const sheet = Buffer.from(buf).toString('utf8');
  // Das vorangestellte ' wird XML-escaped zu &apos; (Excel zeigt es als Text-Präfix)
  assert.ok(sheet.includes('&apos;=HYPERLINK'), 'führendes = muss neutralisiert werden');
  assert.ok(sheet.includes('&apos;+1'), 'führendes + muss neutralisiert werden');
  assert.ok(sheet.includes('harmlos'), 'normaler Text bleibt erhalten');
  assert.ok(!sheet.includes('&apos;harmlos'), 'harmloser Text wird NICHT neutralisiert');
});
