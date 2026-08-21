import { isAuthorized, getSecret } from './lib/auth.mjs';

export default async (req) => {
  const authorized = isAuthorized(req, getSecret());
  return new Response(JSON.stringify({ authorized }), {
    headers: { 'content-type': 'application/json' }
  });
};

export const config = { path: '/api/check-auth' };
