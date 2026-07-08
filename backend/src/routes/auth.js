import { Router } from 'express';
import db from '../db.js';
import { verifyPin, signToken, requireAuth } from '../auth.js';

const router = Router();

// POST /api/auth/login  { username, pin }
router.post('/login', (req, res) => {
  const { username, pin } = req.body || {};
  if (!username || !pin) {
    return res.status(400).json({ error: 'Benutzername und PIN erforderlich' });
  }
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(String(username).trim());
  if (!user || !verifyPin(pin, user.pin_hash)) {
    return res.status(401).json({ error: 'Benutzername oder PIN falsch' });
  }
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
