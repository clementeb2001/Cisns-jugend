import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { requireAuth, requireAdmin } from '../auth.js';
import { makeBackup, BACKUP_DIR } from '../backup.js';
import { todayLocal } from '../util.js';

const router = Router();

// GET /api/backup — Admin lädt eine konsistente Kopie der Datenbank herunter
// (z. B. um sie extern/auf dem Computer zu sichern).
router.get('/', requireAuth, requireAdmin, async (req, res) => {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const tmp = path.join(BACKUP_DIR, `download-${Date.now()}.db`);
    await makeBackup(tmp);
    res.download(tmp, `jugend-cisns-backup-${todayLocal()}.db`, () => {
      fs.unlink(tmp, () => {});
    });
  } catch (e) {
    console.error('[backup] Download fehlgeschlagen:', e.message);
    res.status(500).json({ error: 'Backup fehlgeschlagen' });
  }
});

export default router;
