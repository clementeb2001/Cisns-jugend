import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import db from './db.js';

const DEFAULT_SECRET = 'CHANGE_ME_INSECURE_DEV_SECRET';
const JWT_SECRET = process.env.JWT_SECRET || DEFAULT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '30d';

// Beim Serverstart aufrufen: bricht hart ab, wenn kein echtes Secret gesetzt ist.
// (Verhindert, dass mit dem im Code stehenden Default-Secret Tokens fälschbar sind.)
export function assertJwtSecret() {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET === DEFAULT_SECRET) {
    console.error('[auth] FATAL: JWT_SECRET ist nicht (sicher) gesetzt. Bitte ein starkes, zufälliges JWT_SECRET in der Umgebung setzen (z.B. `openssl rand -hex 32`).');
    process.exit(1);
  }
}

export function hashPin(pin) {
  return bcrypt.hashSync(String(pin), 10);
}

export function verifyPin(pin, hash) {
  return bcrypt.compareSync(String(pin), hash);
}

export function signToken(user) {
  return jwt.sign(
    { sub: user.id, username: user.username, role: user.role, name: user.display_name },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN, algorithm: 'HS256' }
  );
}

export function verifyToken(token) {
  // Algorithmus fest vorgeben (Defense-in-Depth gegen Algorithmus-Verwirrung)
  return jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
}

// Middleware: gültiges JWT erforderlich; zusätzlich wird bei jeder Anfrage geprüft,
// ob das Konto noch existiert und aktiv ist (deaktivierte Nutzer verlieren sofort Zugriff).
export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Nicht angemeldet' });
  let payload;
  try {
    payload = verifyToken(token);
  } catch {
    return res.status(401).json({ error: 'Ungültiges oder abgelaufenes Token' });
  }
  const user = db.prepare('SELECT id, username, role, display_name, active FROM users WHERE id = ?').get(payload.sub);
  if (!user || !user.active) {
    return res.status(401).json({ error: 'Konto nicht mehr aktiv' });
  }
  // Rolle/Name frisch aus der DB (falls der Admin sie zwischenzeitlich geändert hat)
  req.user = { id: user.id, username: user.username, role: user.role, name: user.display_name };
  next();
}

// Middleware: nur Administratoren
export function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Nur für Administratoren' });
  }
  next();
}
