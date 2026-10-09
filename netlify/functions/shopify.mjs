// Shopify orders from an uploaded Shopify export, until the Shopify API is
// connected. The page reads the export and sends a compact list:
//   POST /api/shopify { lines: "name\tday\tstatus\n...", files: [...] }
// Saved for every automatic refresh to use, and matched right away against the
// saved NetSuite copy so the Systems page updates without waiting.
//   GET /api/shopify  -> what's saved (uploadedAt, through, count)
import { getStore } from '@netlify/blobs';
import { isAuthorized, getSecret } from './lib/auth.mjs';
import { readTable } from './lib/refresh-engine.mjs';
import * as compute from './lib/compute.mjs';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const STATUS = { f: 'fulfilled', u: 'unfulfilled', p: 'partial', r: 'restocked' };

export default async (req) => {
  if (!isAuthorized(req, getSecret())) return json(401, { ok: false, error: 'Not signed in. Log out and back in.' });
  const store = getStore({ name: 'bylt-refresh', consistency: 'strong' });
  const results = getStore({ name: 'bylt-reconciliation', consistency: 'strong' });

  if (req.method === 'GET') {
    const saved = await store.get('shopify:orders', { type: 'json' });
    return json(200, { ok: true, saved: saved ? { uploadedAt: saved.uploadedAt, through: saved.through, count: saved.rows.length, files: saved.files } : null });
  }
  if (req.method !== 'POST') return json(405, { ok: false, error: 'GET or POST only' });

  let body;
  try { body = await req.json(); } catch { return json(400, { ok: false, error: 'Bad request body' }); }
  const rows = [];
  const seen = new Set();
  let through = null;
  // Format: "@YYYY-MM-DD" lines start a day; each following line is "name<TAB>f|u|p|r".
  let day = null;
  for (const line of String(body.lines || '').split('\n')) {
    if (line.startsWith('@')) { day = /^@\d{4}-\d{2}-\d{2}$/.test(line) ? line.slice(1) : null; continue; }
    const [name, st] = line.split('\t');
    if (!day || !name || seen.has(name)) continue;
    seen.add(name);
    rows.push([name.slice(0, 60), day, STATUS[st] || 'unfulfilled']);
    if (!through || day > through) through = day;
  }
  if (!rows.length) return json(400, { ok: false, error: 'No orders found in the upload.' });

  const shopify = { uploadedAt: new Date().toISOString(), through, files: (body.files || []).slice(0, 10).map(String), rows };
  await store.setJSON('shopify:orders', shopify);

  // Match against the saved NetSuite copy now, so the page doesn't wait for a refresh.
  let note = 'Saved. It will be matched at the next refresh.';
  try {
    const nsSo = await readTable(store, 'ns-so');
    const saved = await results.get('integrations', { type: 'json' });
    if (nsSo && saved && saved.result) {
      saved.result.shopify = compute.computeShopify(nsSo, shopify);
      await results.setJSON('integrations', saved);
      note = 'Saved and matched against NetSuite.';
    }
  } catch (err) {
    note = `Saved. Matching will happen at the next refresh (${err.message}).`;
  }
  return json(200, { ok: true, count: rows.length, through, note });
};

export const config = { path: '/api/shopify' };
