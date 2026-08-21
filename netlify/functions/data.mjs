import { getStore } from '@netlify/blobs';
import { isAuthorized, getSecret } from './lib/auth.mjs';

const STORE_NAME = 'bylt-reconciliation';

function errorResponse(status, message, extra) {
  return new Response(JSON.stringify({ ok: false, error: message, ...extra }), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

export default async (req) => {
  try {
    if (!isAuthorized(req, getSecret())) {
      return errorResponse(401, 'Not signed in — your session may have expired. Try logging out and back in.');
    }

    // Matches the pattern from the known-working avectous-dashboard project:
    // no manual siteID/token, consistency: "strong" for immediate read-after-write.
    const store = getStore({ name: STORE_NAME, consistency: 'strong' });

    if (req.method === 'POST') {
      let body;
      try {
        body = await req.json();
      } catch (err) {
        return errorResponse(400, `Could not parse the request body as JSON: ${err.message}`);
      }

      const { sectionId, result, ranBy } = body || {};
      if (!sectionId || !result) {
        return errorResponse(400, 'sectionId and result are required');
      }

      const payload = { result, savedAt: new Date().toISOString(), ranBy: ranBy || '' };

      try {
        await store.setJSON(sectionId, payload);
      } catch (err) {
        return errorResponse(500, `Failed to save to shared storage: ${err.message}`);
      }

      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' }
      });
    }

    if (req.method === 'GET') {
      try {
        const { blobs } = await store.list();
        const out = {};
        for (const b of blobs) {
          out[b.key] = await store.get(b.key, { type: 'json' });
        }
        return new Response(JSON.stringify(out), {
          headers: { 'content-type': 'application/json' }
        });
      } catch (err) {
        return errorResponse(500, `Failed to read from shared storage: ${err.message}`);
      }
    }

    if (req.method === 'DELETE') {
      let body;
      try {
        body = await req.json();
      } catch (err) {
        return errorResponse(400, `Could not parse the request body as JSON: ${err.message}`);
      }

      const { sectionId } = body || {};
      if (!sectionId) {
        return errorResponse(400, 'sectionId is required');
      }

      try {
        await store.delete(sectionId);
      } catch (err) {
        return errorResponse(500, `Failed to clear shared storage: ${err.message}`);
      }

      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' }
      });
    }

    return errorResponse(405, 'Method not allowed');
  } catch (err) {
    return errorResponse(500, `Unexpected error: ${err.message}`);
  }
};

export const config = { path: '/api/data' };
