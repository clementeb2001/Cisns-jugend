-- Datenbankschema für die Jugendfeuerwehr Präsenz-Management-App
-- SQLite. Wird beim Start idempotent angewendet (CREATE TABLE IF NOT EXISTS).

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Benutzer: Administratoren (Leiter) und Jugendhelfer
CREATE TABLE IF NOT EXISTS users (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  username     TEXT    NOT NULL UNIQUE,
  pin_hash     TEXT    NOT NULL,
  role         TEXT    NOT NULL CHECK (role IN ('admin', 'helper')),
  display_name TEXT    NOT NULL,
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Jugendfeuerwehr-Mitglieder
CREATE TABLE IF NOT EXISTS members (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  first_name        TEXT    NOT NULL,
  last_name         TEXT    NOT NULL,
  birth_date        TEXT,            -- ISO-Datum, optional (Altersgruppen-Auswertung)
  medal             TEXT,            -- Wissenstest-Medaille: bronze | silber | gold
  emergency_contact TEXT,            -- (Alt/Legacy) früherer einzelner Notfallkontakt
  emergency_phone   TEXT,            -- (Alt/Legacy)
  mother_name       TEXT,            -- Kontakt Mutter (Name)
  mother_phone      TEXT,            -- Telefon Mutter
  father_name       TEXT,            -- Kontakt Vater (Name)
  father_phone      TEXT,            -- Telefon Vater
  matricule_cgdis   TEXT,            -- Matricule CGDIS
  matricule_cns     TEXT,            -- Matricule CNS
  address           TEXT,            -- Adresse
  allergies         TEXT,            -- Allergien
  medical_notes     TEXT,            -- Vorerkrankungen und Medikamente
  active            INTEGER NOT NULL DEFAULT 1,  -- inaktiv statt löschen (Statistik-Historie)
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Termine
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  date        TEXT    NOT NULL,           -- ISO-Datum YYYY-MM-DD (Startdatum)
  end_date    TEXT,                       -- optionales Enddatum (mehrtägige "Sonstiges"-Termine)
  start_time  TEXT,                       -- HH:MM
  end_time    TEXT,                       -- HH:MM
  type        TEXT    NOT NULL DEFAULT 'Praktische Übung',  -- Praktische Übung, Theorie, Freizeit, Sonstiges
  type_detail TEXT,                       -- freie Beschreibung, v.a. bei "Sonstiges"
  location    TEXT,
  note        TEXT,
  closed      INTEGER NOT NULL DEFAULT 0, -- vom Admin abgeschlossen -> keine Helfer-Änderungen mehr
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Präsenz-Einträge für Mitglieder (ohne Stunden)
-- id ist eine client-generierte UUID, damit Offline-Erfassung idempotent
-- synchronisiert werden kann (Upsert per updated_at, last-write-wins).
CREATE TABLE IF NOT EXISTS attendance_members (
  id         TEXT    PRIMARY KEY,
  event_id   INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  member_id  INTEGER NOT NULL REFERENCES members(id),
  status     TEXT    NOT NULL CHECK (status IN ('present', 'excused', 'unexcused')),
  comment    TEXT,
  entered_by INTEGER REFERENCES users(id),
  entered_at TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (event_id, member_id)
);

-- Präsenz-Einträge für Jugendhelfer (mit manuellem Stunden-Feld)
CREATE TABLE IF NOT EXISTS attendance_helpers (
  id         TEXT    PRIMARY KEY,
  event_id   INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  helper_id  INTEGER NOT NULL REFERENCES users(id),
  status     TEXT    NOT NULL CHECK (status IN ('present', 'excused', 'unexcused')),
  hours      REAL    NOT NULL DEFAULT 0,
  comment    TEXT,
  entered_by INTEGER REFERENCES users(id),
  entered_at TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (event_id, helper_id)
);

CREATE INDEX IF NOT EXISTS idx_att_members_event ON attendance_members(event_id);
CREATE INDEX IF NOT EXISTS idx_att_members_member ON attendance_members(member_id);
CREATE INDEX IF NOT EXISTS idx_att_helpers_event ON attendance_helpers(event_id);
CREATE INDEX IF NOT EXISTS idx_att_helpers_helper ON attendance_helpers(helper_id);
CREATE INDEX IF NOT EXISTS idx_events_date ON events(date);
