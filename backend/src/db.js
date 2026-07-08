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

export default db;
