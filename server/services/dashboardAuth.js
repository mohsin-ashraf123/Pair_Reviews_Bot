import { createHmac, timingSafeEqual } from 'node:crypto';

const equal = (a, b) => {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && timingSafeEqual(left, right);
};
const secret = () => process.env.ADMIN_SESSION_SECRET || process.env.ADMIN_PASSWORD;
export const authConfigured = () => Boolean(process.env.ADMIN_PASSWORD?.length >= 16);
export const issueToken = (username, now = Date.now()) => {
  const payload = Buffer.from(JSON.stringify({ username, expires: now + 12 * 60 * 60 * 1000 })).toString('base64url');
  return `${payload}.${createHmac('sha256', secret()).update(payload).digest('base64url')}`;
};
export const verifyToken = (token, now = Date.now()) => {
  if (!authConfigured() || typeof token !== 'string' || token.length > 2048) return null;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra) return null;
  const expected = createHmac('sha256', secret()).update(payload).digest('base64url');
  if (!equal(signature, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return data.username === (process.env.ADMIN_USERNAME || 'Admin') && data.expires > now ? data : null;
  } catch { return null; }
};
export const requireDashboardAuth = (req, res, next) => {
  if (!authConfigured()) return res.status(503).json({ message: 'Configure ADMIN_PASSWORD (at least 16 characters) on the server.' });
  if (!verifyToken(req.headers.authorization?.replace(/^Bearer /, ''))) {
    return res.status(401).json({ code: 'AUTH_REQUIRED', message: 'Please sign in.' });
  }
  next();
};
const attempts = new Map();
export const loginDashboard = (req, res) => {
  if (!authConfigured()) return res.status(503).json({ message: 'Dashboard login is not configured on the server.' });
  const now = Date.now();
  for (const [key, entry] of attempts) if (entry.until <= now) attempts.delete(key);
  const key = req.ip;
  const entry = attempts.get(key) || { count: 0, until: now + 15 * 60 * 1000 };
  if (entry.count >= 10 || attempts.size >= 10000) return res.status(429).json({ message: 'Too many attempts. Try again later.' });
  const username = process.env.ADMIN_USERNAME || 'Admin';
  if (!equal(req.body?.username, username) || !equal(req.body?.password, process.env.ADMIN_PASSWORD)) {
    entry.count++;
    attempts.set(key, entry);
    return res.status(401).json({ message: 'Invalid username or password' });
  }
  attempts.delete(key);
  return res.json({ username, token: issueToken(username) });
};
