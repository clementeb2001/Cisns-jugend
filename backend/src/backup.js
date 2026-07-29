// Automatische Datensicherung der SQLite-Datenbank.
// - Beim Serverstart und danach täglich wird eine konsistente Kopie (Online-Backup)
//   im Ordner <DB-Ordner>/backups abgelegt (eine Datei je Tag).
// - Es werden die letzten BACKUP_KEEP_DAYS Sicherungen behalten (Standard 14).
// Hinweis: Diese Sicherungen liegen im selben Volume – sie schützen vor
// versehentlichem Löschen/Fehlern, NICHT vor Plattendefekt. Für Off-Device-Schutz
// zusätzlich Synology Hyper Backup einrichten (sichert das Volume extern/Cloud).
import fs from 'node:fs';
import path from 'node:path';
import db from './db.js';
import { todayLocal } from './util.js';

const BACKUP_DIR = process.env.BACKUP_DIR || path.join(path.dirname(db.name), 'backups');
const KEEP = Number(process.env.BACKUP_KEEP_DAYS || 14);
const PREFIX = 'jugend-cisns-';

export async function makeBackup(destPath) {
  await db.backup(destPath);
  return destPath;
}

function rotate() {
  try {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter((f) => f.startsWith(PREFIX) && f.endsWith('.db'))
      .sort();
    while (files.length > KEEP) {
      fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
    }
  } catch (e) { console.warn('[backup] Rotation fehlgeschlagen:', e.message); }
}

export async function scheduledBackup() {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const dest = path.join(BACKUP_DIR, `${PREFIX}${todayLocal()}.db`);
    await makeBackup(dest);
    rotate();
    console.log('[backup] Sicherung erstellt:', dest);
  } catch (e) { console.error('[backup] Sicherung fehlgeschlagen:', e.message); }
}

export function startBackupSchedule() {
  setTimeout(scheduledBackup, 10_000);                 // kurz nach dem Start
  setInterval(scheduledBackup, 24 * 60 * 60 * 1000);   // danach täglich
}

export { BACKUP_DIR };
