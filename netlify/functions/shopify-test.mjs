// GET /api/shopify-test: runs Jordan's Steps 1-4 against the BYLT Reporting app
// and reports pass/fail for each. Never returns the token or the secret.
import { getStore } from '@netlify/blobs';
import { isAuthorized, getSecret } from './lib/auth.mjs';
import { shopifyToken, shopifyGraphQL } from './lib/clients.mjs';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const NEEDED = ['read_reports', 'read_orders', 'read_all_orders', 'read_merchant_managed_fulfillment_orders'];

export default async (req) => {
  if (!isAuthorized(req, getSecret())) return json(401, { ok: false, error: 'Not signed in. Log out and back in.' });
  const store = getStore({ name: 'bylt-refresh', consistency: 'strong' });
  const steps = [];

  // Step 1: token (always fetch a fresh one for the test)
  let tok;
  try {
    tok = await shopifyToken(store, { force: true });
    steps.push({ step: 1, name: 'Get a token', ok: true, detail: `Token received, valid about ${Math.round((tok.expiresAt - Date.now()) / 3600000)} hours.` });
  } catch (err) {
    steps.push({ step: 1, name: 'Get a token', ok: false, detail: err.message });
    return json(200, { ok: false, steps });
  }

  // Step 2: scopes
  const granted = String(tok.scope || '').split(',').map(s => s.trim()).filter(Boolean);
  const missing = NEEDED.filter(s => !granted.includes(s));
  steps.push({ step: 2, name: 'Check the scopes', ok: !missing.length, detail: missing.length ? `Missing: ${missing.join(', ')}. Scope text received: "${tok.scope}"` : `All four granted (${granted.join(', ')}).` });

  const run = async (step, name, query, check) => {
    try {
      const r = await shopifyGraphQL(store, query);
      if (r.errors && r.errors.length) return steps.push({ step, name, ok: false, detail: r.errors.map(e => e.message).join('; ') });
      const [ok, detail] = check(r.data || {});
      steps.push({ step, name, ok, detail });
    } catch (err) { steps.push({ step, name, ok: false, detail: err.message }); }
  };

  // Step 3: first call
  await run(3, 'First test call', '{ shop { name myshopifyDomain } }',
    d => [!!(d.shop && d.shop.name), d.shop ? `${d.shop.name} (${d.shop.myshopifyDomain})` : 'No shop returned']);

  // Step 4a-d: each scope
  await run('4a', 'Orders older than 60 days (read_all_orders)', '{ orders(first: 1, query: "created_at:<2026-08-06") { nodes { name createdAt } } }',
    d => { const n = d.orders && d.orders.nodes || []; return [n.length > 0, n.length ? `${n[0].name}, ${n[0].createdAt.slice(0, 10)}` : 'Zero results: read_all_orders is not working']; });
  await run('4b', 'Recent orders (read_orders)', '{ orders(first: 1, reverse: true) { nodes { name createdAt } } }',
    d => { const n = d.orders && d.orders.nodes || []; return [n.length > 0, n.length ? `${n[0].name}, ${n[0].createdAt.slice(0, 16).replace('T', ' ')}` : 'No orders returned']; });
  await run('4c', 'Shipped vs in-store (read_merchant_managed_fulfillment_orders)', '{ fulfillmentOrders(first: 5) { nodes { status deliveryMethod { methodType } } } }',
    d => { const n = d.fulfillmentOrders && d.fulfillmentOrders.nodes || []; return [n.length > 0, n.length ? n.map(x => `${x.status}/${x.deliveryMethod && x.deliveryMethod.methodType}`).join(', ') : 'No fulfillment orders returned']; });
  await run('4d', 'Reporting / ShopifyQL (read_reports)', '{ shopifyqlQuery(query: "FROM sales SHOW total_sales SINCE -7d") { tableData { columns { name } rows } parseErrors } }',
    d => { const q = d.shopifyqlQuery; if (!q) return [false, 'No result']; if (q.parseErrors && q.parseErrors.length) return [false, `Query text issue: ${JSON.stringify(q.parseErrors).slice(0, 200)}`]; return [true, `Report returned (${(q.tableData && q.tableData.rows || []).length} row).`]; });

  return json(200, { ok: steps.every(s => s.ok), steps });
};

export const config = { path: '/api/shopify-test' };
