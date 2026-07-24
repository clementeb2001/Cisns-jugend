import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Datenbank-Datei liegt im Volume (per DB_PATH konfigurierbar, Default: ./data)
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'jugendfeuerwehr.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Schema idempotent anwenden
const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// Leichte Migrationen für bereits bestehende Datenbanken:
// fehlende Spalten nachrüsten (SQLite kennt kein "ADD COLUMN IF NOT EXISTS").
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
ensureColumn('members', 'emergency_contact', 'TEXT');
ensureColumn('members', 'emergency_phone', 'TEXT');
ensureColumn('members', 'medal', 'TEXT');
ensureColumn('members', 'mother_name', 'TEXT');
ensureColumn('members', 'mother_phone', 'TEXT');
ensureColumn('members', 'father_name', 'TEXT');
ensureColumn('members', 'father_phone', 'TEXT');
ensureColumn('members', 'matricule_cgdis', 'TEXT');
ensureColumn('members', 'matricule_cns', 'TEXT');
ensureColumn('members', 'address', 'TEXT');
ensureColumn('members', 'street', 'TEXT');
ensureColumn('members', 'house_number', 'TEXT');
ensureColumn('members', 'postal_code', 'TEXT');
ensureColumn('members', 'city', 'TEXT');
ensureColumn('members', 'allergies', 'TEXT');
ensureColumn('members', 'medical_notes', 'TEXT');
ensureColumn('events', 'type_detail', 'TEXT');
ensureColumn('events', 'closed', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('events', 'end_date', 'TEXT');

export default db;
