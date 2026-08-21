import crypto from 'node:crypto';

const COOKIE_NAME = 'bylt_session';
const MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // 7 days

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('hex');
}

export function getSecret() {
  // SESSION_SECRET is preferred (set it to any long random string in Netlify env vars).
  // Falls back to SITE_PASSWORD so this still works with only one env var configured.
  return process.env.SESSION_SECRET || process.env.SITE_PASSWORD || '';
}

export function createSessionCookie(secret) {
  const expiry = Date.now() + MAX_AGE_SECONDS * 1000;
  const payload = `${expiry}`;
  const sig = sign(payload, secret);
  const value = `${payload}.${sig}`;
  return `${COOKIE_NAME}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${MAX_AGE_SECONDS}`;
}

export function clearSessionCookie() {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

export function isAuthorized(req, secret) {
  if (!secret) return false;
  const cookieHeader = req.headers.get('cookie') || '';
  const match = cookieHeader
    .split(';')
    .map(c => c.trim())
    .find(c => c.startsWith(`${COOKIE_NAME}=`));
  if (!match) return false;

  const value = match.slice(COOKIE_NAME.length + 1);
  const [payload, sig] = value.split('.');
  if (!payload || !sig) return false;
  if (sign(payload, secret) !== sig) return false;
  if (Number(payload) < Date.now()) return false;

  return true;
}
