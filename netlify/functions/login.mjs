import { createSessionCookie, getSecret } from './lib/auth.mjs';

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, error: 'Invalid request.' }), {
      status: 400,
      headers: { 'content-type': 'application/json' }
    });
  }

  const correctPassword = process.env.SITE_PASSWORD;
  if (!correctPassword) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: 'This site has no SITE_PASSWORD configured yet. Set it in Netlify → Site settings → Environment variables, then redeploy.'
      }),
      { status: 500, headers: { 'content-type': 'application/json' } }
    );
  }

  if (body.password !== correctPassword) {
    return new Response(JSON.stringify({ ok: false, error: 'Incorrect password.' }), {
      status: 401,
      headers: { 'content-type': 'application/json' }
    });
  }

  const cookie = createSessionCookie(getSecret());
  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'content-type': 'application/json', 'Set-Cookie': cookie }
  });
};

export const config = { path: '/api/login' };
