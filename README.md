# Jugendfeuerwehr Präsenz-Management-App

Eine **offline-fähige PWA** zur Erfassung der Anwesenheit von
Jugendfeuerwehr-Mitgliedern und Jugendhelfern durch Jugendhelfer, mit
zentralem Backend zur Synchronisation und Auswertung. Selbst gehostet auf
einem Synology-NAS (Docker), DSGVO-konform ohne Weitergabe an Dritte.

## Funktionen

- **Offline-Erfassung**: Präsenz kann ohne Internetverbindung eingetragen
  werden (IndexedDB + Service Worker). Einträge werden bei Wiederverbindung
  automatisch synchronisiert (Offline-Queue, Last-Write-Wins).
- **Zwei Rollen**: Administrator (Leiter) mit Vollzugriff, Jugendhelfer mit
  eingeschränkten Rechten. Login mit Benutzername + PIN (bcrypt, JWT).
- **Drei Präsenz-Status**: Anwesend, Entschuldigt abgemeldet, Unentschuldigt
  gefehlt – als große, schnell antippbare Buttons (mobile-first).
- **Mitglieder** (ohne Stunden) und **Jugendhelfer** (mit manuellem
  Stunden-Feld, vorbefüllt mit der Termindauer) werden getrennt ausgewertet.
- **Statistik**: Anwesenheitsquote, Fehltage, Stunden – filterbar nach
  Zeitraum und Terminart, Ranking für Ehrungen.
- **Excel-Export**: getrennte Tabellenblätter für Mitglieder und Helfer
  (abhängigkeitsfreier XLSX-Writer, kein anfälliges Drittpaket).
- **Installierbar** als App auf dem Smartphone (PWA-Manifest + Icons).

## Projektstruktur

```
backend/            Node.js + Express + SQLite (better-sqlite3)
  src/
    server.js       Einstiegspunkt (startet den HTTP-Server)
    app.js          Express-App (API + statisches Frontend), testbar
    schema.sql      Datenbankschema (idempotent)
    auth.js         JWT + bcrypt, Middleware requireAuth/requireAdmin
    xlsx.js         Abhängigkeitsfreier XLSX-Writer
    seed.js         Legt Admin (+ optional Demodaten) an
    routes/         auth, users, members, events, sync, stats, export
  test/api.test.js  API-/Sync-Tests (node --test)
frontend/           Vanilla-JS-PWA (kein Build-Schritt nötig)
  index.html        App-Shell
  manifest.webmanifest, sw.js
  js/
    db.js           IndexedDB-Wrapper (Offline-Cache)
    api.js          API-Client (JWT)
    sync.js         Offline-Queue + Sync-Layer
    app.js          Routing + alle Ansichten
  css/style.css     Mobile-first Styles
  icons/            App-Icons (PNG + SVG)
scripts/
  gen-icons.mjs     Erzeugt die PNG-Icons
  backup.sh         Tägliches SQLite-Backup (eigener Container)
docker-compose.yml  Deployment (App + Backup)
backend/Dockerfile
```

## Schnellstart (lokal)

```bash
cd backend
npm install
# Admin + Demodaten anlegen (Admin: admin / 1234, Helfer: helfer1 / 1111)
JWT_SECRET=dev SEED_DEMO=1 npm run seed
JWT_SECRET=dev npm start
# App öffnen: http://localhost:3000
```

Der Server liefert sowohl die API (`/api/...`) als auch das Frontend aus.

### Tests

```bash
cd backend
npm test   # node --test: Auth, Rollen, Sync/Last-Write-Wins, Statistik, Export
```

Die Tests laufen gegen eine temporäre SQLite-DB und benötigen keine externen
Dienste.

## Deployment auf dem Synology DS225+

1. `.env.example` nach `.env` kopieren und **`JWT_SECRET` setzen**
   (`openssl rand -hex 32`), Admin-Zugangsdaten anpassen.
2. Image bauen und starten:
   ```bash
   docker compose build
   docker compose run --rm app node src/seed.js   # einmalig: Admin anlegen
   docker compose up -d
   ```
3. Den **bereits vorhandenen Reverse Proxy** (Web Station, Let's Encrypt) auf
   `http://<nas>:3000` weiterleiten. Die App ist dann per HTTPS erreichbar –
   Voraussetzung für Service Worker / PWA-Installation.
4. Backups landen täglich im Ordner `./backups` (Aufbewahrung konfigurierbar
   über `BACKUP_KEEP_DAYS`). Für Redundanz kann dieser Ordner zusätzlich in
   eine private Cloud (z.B. Backblaze B2) gespiegelt werden.

## Umgebungsvariablen

| Variable            | Bedeutung                                             | Default |
|---------------------|-------------------------------------------------------|---------|
| `JWT_SECRET`        | Secret für die Token-Signierung (**Pflicht!**)        | –       |
| `JWT_EXPIRES_IN`    | Token-Gültigkeit                                      | `30d`   |
| `EDIT_WINDOW_HOURS` | Zeitfenster für Helfer-Korrekturen eigener Einträge   | `24`    |
| `DB_PATH`           | Pfad zur SQLite-Datei                                 | `data/` |
| `PORT`              | HTTP-Port                                             | `3000`  |
| `ADMIN_USERNAME` / `ADMIN_PIN` | Initialer Admin beim Seed                  | admin/1234 |
| `SEED_DEMO`         | `1` = Demodaten beim Seed anlegen                     | `0`     |

## API-Überblick

| Methode & Pfad                  | Rolle    | Zweck                                  |
|---------------------------------|----------|----------------------------------------|
| `POST /api/auth/login`          | –        | Login, liefert JWT                     |
| `GET  /api/sync/bootstrap`      | auth     | Vollständiger Datenstand (Offline-Cache) |
| `POST /api/sync/push`           | auth     | Offline-Queue hochladen (Upsert, LWW)  |
| `GET  /api/sync/status`         | admin    | Erfassungs-Übersicht pro Helfer        |
| `GET/POST/PUT/DELETE /api/members` | auth/admin | Mitglieder                         |
| `GET/POST/PUT/DELETE /api/events`  | auth/admin | Termine (Helfer dürfen anlegen)    |
| `GET/POST/PUT/DELETE /api/users`   | admin  | Benutzer/Helfer verwalten            |
| `GET  /api/stats/members`       | auth     | Statistik Mitglieder                   |
| `GET  /api/stats/helpers`       | auth     | Statistik Helfer (mit Stunden)         |
| `GET  /api/export`              | admin    | Excel-Export (.xlsx)                    |

## Offline- & Sync-Verhalten

1. Beim Online-Zugriff werden Termine, Mitglieder und bestehende Einträge in
   IndexedDB gecacht (`/api/sync/bootstrap`).
2. Offline erfasste Präsenz landet lokal mit Markierung „nicht synchronisiert“
   (gelber Punkt an der Zeile) und einem Offline-Banner.
3. Bei Wiederverbindung synchronisiert die App automatisch (Background Sync API
   bzw. Retry beim Reconnect); das Sync-Badge oben zeigt den Status.
4. Konflikte werden per Zeitstempel aufgelöst (Last-Write-Wins). Der Admin kann
   Einträge jederzeit nachträglich korrigieren; Helfer nur eigene Einträge
   innerhalb des `EDIT_WINDOW_HOURS`-Fensters.

## Datenschutz (DSGVO)

- Alle Daten liegen ausschließlich auf der eigenen NAS-Infrastruktur.
- Ausgeschiedene Mitglieder werden **inaktiv** gesetzt (Statistik-Historie),
  können vom Admin bei fehlenden Einträgen aber auch hart gelöscht werden.
- Keine externen Dienste, keine Weitergabe an Dritte.
