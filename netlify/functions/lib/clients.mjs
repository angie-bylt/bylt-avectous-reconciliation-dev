// Request helpers used by the automatic refresh. Same calls the browser pull
// buttons make through /api/netsuite and /api/avectous, without the browser.

import crypto from 'node:crypto';

export const NS_SEARCHES = {
  so: '4875', to: '4872', shop: 'customsearch5055',
  // Flow check (every 15 minutes), small searches straight against NetSuite:
  waiting: 'customsearch_dash_orders_waiting',          // SOs pending fulfillment, no WMS export date, created in the last 2 days
  recentIf: 'customsearch_dash_recent_fulfillments'     // item fulfillments created in the last 2 days
};  // shop: Sales Orders + Cash Sales, for the Shopify check

export const AV_REPORTS = {
  orders: { PageId: 6, PageName: 'Orders', PanelName: 'Orders' },
  shipments: { PageId: 11900, PageName: 'Shipments by Order/Tracking', PanelName: 'Shipments by Order/Tracking' },
  interface: { PageId: 122, PageName: 'Interface - Order', PanelName: 'Interface - Order' },
  confirmations: { PageId: 11910, PageName: 'Shipment Confirmations', PanelName: 'Shipment Header' }
};

const AV_ENDPOINT = 'https://bylt.avectous.com/API/MessageGateway/v1/MessageGateway/json';

const enc = s => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

function nsAuthHeader(method, fullUrl) {
  const url = new URL(fullUrl);
  const baseUrl = `${url.protocol}//${url.host}${url.pathname}`;
  const oauth = {
    oauth_consumer_key: process.env.NS_CONSUMER_KEY,
    oauth_token: process.env.NS_TOKEN_ID,
    oauth_signature_method: 'HMAC-SHA256',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_version: '1.0'
  };
  const all = { ...oauth };
  url.searchParams.forEach((v, k) => { all[k] = v; });
  const paramString = Object.keys(all).sort().map(k => `${enc(k)}=${enc(all[k])}`).join('&');
  const baseString = [method.toUpperCase(), enc(baseUrl), enc(paramString)].join('&');
  const key = `${enc(process.env.NS_CONSUMER_SECRET)}&${enc(process.env.NS_TOKEN_SECRET)}`;
  oauth.oauth_signature = crypto.createHmac('sha256', key).update(baseString).digest('base64');
  const realm = String(process.env.NS_ACCOUNT_ID).toUpperCase().replace('-', '_');
  return 'OAuth realm="' + realm + '", ' + Object.keys(oauth).map(k => `${k}="${enc(oauth[k])}"`).join(', ');
}

async function fetchWithTimeout(url, opts, timeoutMs) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), Math.max(1000, timeoutMs));
  try {
    return await fetch(url, { ...opts, signal: ctl.signal });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('TIMEOUT');
    throw err;
  } finally {
    clearTimeout(t);
  }
}

// One page of a NetSuite saved search through Tim's RESTlet (deploy=2).
// pageIndex is 0-based. filters: [{ name, operator, values }] or undefined.
export async function nsSearchPage({ source, pageIndex, pageSize, filters, timeoutMs }) {
  const url = process.env.NS_RESTLET_URL;
  const body = { searchId: NS_SEARCHES[source], pageIndex, pageSize, clientId: 'netlify-dashboard-auto' };
  if (filters && filters.length) body.filters = filters;
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Authorization': nsAuthHeader('POST', url), 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }, timeoutMs);
  const text = await res.text();
  if (!res.ok) throw new Error(`NetSuite ${res.status}: ${text.slice(0, 200)}`);
  let data = JSON.parse(text);
  if (typeof data === 'string') data = JSON.parse(data);
  if (data._status && data._status !== 200) {
    const e = new Error(`NetSuite: ${data.error || 'error'} (${data.errorCode || data._status})`);
    e.netsuite = true;
    throw e;
  }
  const meta = data.meta || {};
  return { rows: data.results || [], total: meta.totalResults || 0, hasMore: !!meta.hasMore };
}

// One page of an Avectous report. pageIndex is 1-based.
export async function avPage({ report, pageIndex, pageLimit, parameters, timeoutMs }) {
  const messageContent = { ...AV_REPORTS[report], PageIndex: pageIndex, PageLimit: pageLimit };
  if (parameters) messageContent.Parameters = parameters;
  const res = await fetchWithTimeout(AV_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'API-Key': process.env.AVECTOUS_API_KEY },
    body: JSON.stringify({ companyCode: 'Bylt', warehouseCode: '810', messageType: 'RequestPageId', messageContent })
  }, timeoutMs);
  const text = await res.text();
  if (!res.ok) throw new Error(`Avectous ${res.status}: ${text.slice(0, 200)}`);
  const outer = JSON.parse(text);
  const inner = JSON.parse(outer.queueMessage);
  if (outer.queueStatus === 'QueueFailed') {
    throw new Error(`Avectous: ${(Array.isArray(inner) && inner[0] && inner[0].Message) || outer.queueMessage}`);
  }
  const page = Array.isArray(inner) ? inner[0] : inner;
  if (!page) throw new Error('Avectous response was empty');
  const rows = Array.isArray(page.MessageContent) ? page.MessageContent : [];
  return {
    rows,
    total: Number(page.TotalLines) || 0,
    hasMore: String(page.hasMorePages ?? page.HasMorePages).toLowerCase() === 'true'
  };
}


// ---------- Shopify (read-only "BYLT Reporting" app, Admin GraphQL API) ----------
// The Client ID/Secret are traded for an access token that lasts ~24 hours
// (client credentials grant). The token is cached server-side in Blobs and
// replaced 1 hour before it expires, or straight away if Shopify answers 401.
// The Client Secret and token never leave Netlify.
export const SHOPIFY_API_VERSION = '2026-10';

async function newShopifyToken() {
  const shop = process.env.SHOPIFY_STORE;
  const id = process.env.SHOPIFY_CLIENT_ID;
  const secret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!shop || !id || !secret) throw new Error('Missing SHOPIFY_STORE, SHOPIFY_CLIENT_ID or SHOPIFY_CLIENT_SECRET in Netlify environment variables.');
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: id.trim(), client_secret: secret.trim() });
  const res = await fetch(`https://${shop.trim()}/admin/oauth/access_token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body
  });
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch {}
  if (!res.ok || !data || !data.access_token) {
    const why = (data && (data.error_description || data.error || data.errors)) || text.slice(0, 200);
    const e = new Error(`Shopify token request failed (${res.status}): ${typeof why === 'string' ? why : JSON.stringify(why)}`);
    e.step = 1; throw e;
  }
  return { token: data.access_token, scope: data.scope || '', expiresAt: Date.now() + (Number(data.expires_in) || 86399) * 1000 };
}

export async function shopifyToken(store, { force = false } = {}) {
  let t = !force && store ? await store.get('shopify:token', { type: 'json' }).catch(() => null) : null;
  if (!t || !t.token || t.expiresAt - Date.now() < 60 * 60 * 1000) {
    t = await newShopifyToken();
    if (store) await store.setJSON('shopify:token', t);
  }
  return t;
}

export async function shopifyGraphQL(store, query, variables) {
  const shop = (process.env.SHOPIFY_STORE || '').trim();
  const call = async tok => fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': tok },
    body: JSON.stringify({ query, variables })
  });
  let t = await shopifyToken(store);
  let res = await call(t.token);
  if (res.status === 401) { t = await shopifyToken(store, { force: true }); res = await call(t.token); }
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch {}
  if (!res.ok || !data) throw new Error(`Shopify API ${res.status}: ${text.slice(0, 200)}`);
  return data;   // { data, errors, extensions }
}

export const shopifyConfigured = () => !!(process.env.SHOPIFY_STORE && process.env.SHOPIFY_CLIENT_ID && process.env.SHOPIFY_CLIENT_SECRET);

export async function shopifyTimezone(store) {
  const r = await shopifyGraphQL(store, '{ shop { ianaTimezone } }');
  return (r.data && r.data.shop && r.data.shop.ianaTimezone) || 'America/Los_Angeles';
}

// Bulk export: Shopify builds the whole list in the background and returns one
// file (JSON lines), so a large pull doesn't hit the per-minute request limits.
// Only the fields the dashboard needs. shippingLine is empty for in-store sales.
const ORDER_FIELDS = 'name createdAt cancelledAt displayFulfillmentStatus sourceName shippingLine { title }';

export async function shopifyBulkStart(store, search) {
  const inner = `{ orders(query: ${JSON.stringify(search)}) { edges { node { ${ORDER_FIELDS} } } } }`;
  const m = `mutation($q: String!) { bulkOperationRunQuery(query: $q) { bulkOperation { id status } userErrors { field message } } }`;
  const r = await shopifyGraphQL(store, m, { q: inner });
  const out = r.data && r.data.bulkOperationRunQuery;
  const errs = (r.errors || []).map(e => e.message).concat((out && out.userErrors || []).map(e => e.message));
  if (errs.length) {
    // Only one bulk export at a time: if an old one is stuck, cancel it so the next try starts clean.
    if (errs.some(m => /already in progress/i.test(m))) {
      const c = await shopifyGraphQL(store, '{ currentBulkOperation(type: QUERY) { id status } }');
      const op = c.data && c.data.currentBulkOperation;
      if (op && (op.status === 'RUNNING' || op.status === 'CREATED')) {
        await shopifyGraphQL(store, 'mutation($id: ID!) { bulkOperationCancel(id: $id) { userErrors { message } } }', { id: op.id });
      }
    }
    throw new Error(`Shopify bulk export: ${errs.join('; ')}`);
  }
  return out.bulkOperation.id;
}

export async function shopifyBulkStatus(store, id) {
  const r = await shopifyGraphQL(store, `query($id: ID!) { node(id: $id) { ... on BulkOperation { status errorCode objectCount url } } }`, { id });
  if (r.errors && r.errors.length) throw new Error(`Shopify bulk status: ${r.errors.map(e => e.message).join('; ')}`);
  return r.data.node;   // { status: CREATED|RUNNING|COMPLETED|FAILED|CANCELED|EXPIRED, url, objectCount, errorCode }
}

// One piece of the export file (byte range), so a big file is read over several
// runs instead of all at once. Returns the text and the file's total size.
export async function shopifyBulkPiece(url, start, size) {
  const res = await fetch(url, { headers: { Range: `bytes=${start}-${start + size - 1}` } });
  if (res.status === 416) return { text: '', total: start };            // past the end
  if (!res.ok) throw new Error(`Shopify export download ${res.status}`);
  const text = await res.text();
  if (res.status === 200) return { text, total: start + Buffer.byteLength(text) };   // server sent it all
  const m = /\/(\d+)\s*$/.exec(res.headers.get('content-range') || '');
  return { text, total: m ? Number(m[1]) : start + Buffer.byteLength(text) };
}

export async function shopifyBulkDownload(url) {
  if (!url) return [];
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Shopify bulk file download ${res.status}`);
  const text = await res.text();
  const out = [];
  for (const line of text.split('\n')) { if (line.trim()) out.push(JSON.parse(line)); }
  return out;
}
