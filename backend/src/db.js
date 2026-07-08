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

export default db;
