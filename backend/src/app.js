import express from 'express';
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
import backupRoutes from './routes/backup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// Die App läuft hinter einem Reverse Proxy / Cloudflare Tunnel. Damit req.ip die
// echte Besucher-Adresse liefert (statt der immer gleichen Proxy-Adresse), dem
// Proxy vertrauen. Die App ist selbst nicht direkt aus dem Internet erreichbar,
// daher ist das Vertrauen unbedenklich.
app.set('trust proxy', true);

// Sicherheits-Header (ohne externes Paket). Frontend wird same-origin ausgeliefert,
// daher kein CORS nötig. CSP erlaubt nur eigene Ressourcen.
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
    "script-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; " +
    "object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  // Nur über HTTPS wirksam; der Reverse-Proxy terminiert TLS.
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

app.use(express.json({ limit: '1mb' }));

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
app.use('/api/backup', backupRoutes);

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

export default app;
