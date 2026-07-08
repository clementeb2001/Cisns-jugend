import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'CHANGE_ME_INSECURE_DEV_SECRET';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '30d';

if (JWT_SECRET === 'CHANGE_ME_INSECURE_DEV_SECRET') {
  console.warn('[auth] WARNUNG: Es wird ein unsicheres Standard-JWT_SECRET verwendet. Bitte JWT_SECRET in der Umgebung setzen!');
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
    { expiresIn: JWT_EXPIRES_IN }
  );
}

export function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

// Middleware: gültiges JWT erforderlich
export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Nicht angemeldet' });
  try {
    const payload = verifyToken(token);
    req.user = { id: payload.sub, username: payload.username, role: payload.role, name: payload.name };
    next();
  } catch {
    return res.status(401).json({ error: 'Ungültiges oder abgelaufenes Token' });
  }
}

// Middleware: nur Administratoren
export function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Nur für Administratoren' });
  }
  next();
}
