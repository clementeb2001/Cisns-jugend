import { Router } from 'express';
import bcrypt from 'bcryptjs';
import db from '../db.js';
import { verifyPin, signToken, requireAuth } from '../auth.js';

const router = Router();

// Einfaches In-Memory-Rate-Limiting gegen PIN-Brute-Force (kein externes Paket nötig).
// Zählt Fehlversuche pro (IP + Benutzername); sperrt nach zu vielen Versuchen kurz.
const MAX_FAILS = 8;
const LOCK_MS = 15 * 60 * 1000;   // 15 Minuten Sperre
const RESET_MS = 15 * 60 * 1000;  // Zähler nach 15 Min Inaktivität zurücksetzen
const attempts = new Map();
// Dummy-Hash, um die Antwortzeit bei unbekanntem Benutzer anzugleichen (kein Timing-Leak)
const DUMMY_HASH = bcrypt.hashSync('dummy-password-für-timing', 10);

// Echte Client-IP ermitteln: hinter Cloudflare steht sie im Header
// CF-Connecting-IP (vom Cloudflare-Edge gesetzt, nicht fälschbar). Fällt sonst
// auf req.ip zurück (dank 'trust proxy' die vorderste X-Forwarded-For-Adresse).
function clientIp(req) {
  return req.headers['cf-connecting-ip'] || req.ip || req.socket?.remoteAddress || '';
}
function attemptKey(req, username) {
  return clientIp(req) + '|' + String(username || '').toLowerCase();
}
function checkLock(key) {
  const rec = attempts.get(key);
  if (!rec) return false;
  if (rec.lockUntil && rec.lockUntil > Date.now()) return true;
  if (rec.lockUntil && rec.lockUntil <= Date.now()) { attempts.delete(key); return false; }
  return false;
}
function registerFail(key) {
  const now = Date.now();
  const rec = attempts.get(key) || { fails: 0, first: now };
  if (now - rec.first > RESET_MS) { rec.fails = 0; rec.first = now; }
  rec.fails += 1;
  if (rec.fails >= MAX_FAILS) rec.lockUntil = now + LOCK_MS;
  attempts.set(key, rec);
}

// POST /api/auth/login  { username, pin }
router.post('/login', (req, res) => {
  const { username, pin } = req.body || {};
  if (!username || !pin) {
    return res.status(400).json({ error: 'Benutzername und PIN erforderlich' });
  }
  const key = attemptKey(req, username);
  if (checkLock(key)) {
    return res.status(429).json({ error: 'Zu viele Fehlversuche. Bitte in einigen Minuten erneut versuchen.' });
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(String(username).trim());
  // Immer einen bcrypt-Vergleich rechnen (auch bei unbekanntem Nutzer) -> keine Timing-Unterschiede
  const ok = user ? verifyPin(pin, user.pin_hash) : (bcrypt.compareSync(String(pin), DUMMY_HASH) && false);
  if (!user || !ok) {
    registerFail(key);
    return res.status(401).json({ error: 'Benutzername oder PIN falsch' });
  }
  attempts.delete(key); // erfolgreicher Login -> Zähler zurücksetzen
  const token = signToken(user);
  res.json({
    token,
    user: { id: user.id, username: user.username, role: user.role, name: user.display_name },
  });
});

// GET /api/auth/me
router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

export default router;
