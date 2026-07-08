import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './db.js'; // initialisiert Schema

import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import memberRoutes from './routes/members.js';
import eventRoutes from './routes/events.js';
import syncRoutes from './routes/sync.js';
import statsRoutes from './routes/stats.js';
import exportRoutes from './routes/export.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(cors());
app.use(express.json({ limit: '5mb' }));

// Health-Check für Reverse-Proxy / Docker
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// API-Routen
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/members', memberRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/sync', syncRoutes);
app.use('/api/stats', statsRoutes);
app.use('/api/export', exportRoutes);

// Statisches Frontend ausliefern (PWA)
const frontendDir = process.env.FRONTEND_DIR || path.join(__dirname, '..', '..', 'frontend');
app.use(express.static(frontendDir, {
  setHeaders(res, filePath) {
    // Service Worker darf nicht aggressiv gecacht werden
    if (filePath.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache');
  },
}));

// SPA-Fallback: alle Nicht-API-Routen liefern index.html
app.get(/^(?!\/api\/).*/, (req, res) => {
  res.sendFile(path.join(frontendDir, 'index.html'));
});

// Zentrale Fehlerbehandlung
app.use((err, req, res, next) => {
  console.error('[error]', err);
  res.status(500).json({ error: 'Interner Serverfehler' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Jugendfeuerwehr-Backend läuft auf Port ${PORT}`);
});
