import { clearSessionCookie } from './lib/auth.mjs';

export default async () => {
  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'content-type': 'application/json', 'Set-Cookie': clearSessionCookie() }
  });
};

export const config = { path: '/api/logout' };
