import app from './app.js';
import db from './db.js';
import { assertJwtSecret, hashPin } from './auth.js';
import { startBackupSchedule } from './backup.js';

// Ohne sicheres JWT_SECRET nicht starten
assertJwtSecret();

// Erst-Admin beim allerersten Start automatisch anlegen (nur wenn noch KEIN
// Benutzer existiert). Erspart einen manuellen Seed-Schritt beim Deployment.
function ensureFirstAdmin() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (count > 0) return;
  const username = process.env.ADMIN_USERNAME || 'admin';
  const pin = process.env.ADMIN_PIN || '1234';
  db.prepare("INSERT INTO users (username, pin_hash, role, display_name) VALUES (?, ?, 'admin', 'Administrator')")
    .run(username, hashPin(pin));
  console.log(`[start] Erst-Admin angelegt: "${username}" (PIN ${pin}) — bitte nach dem ersten Login ändern!`);
}
ensureFirstAdmin();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Jugendfeuerwehr-Backend läuft auf Port ${PORT}`);
  startBackupSchedule(); // automatische tägliche Datensicherung
});
