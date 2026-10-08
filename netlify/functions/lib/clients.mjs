// Request helpers used by the automatic refresh. Same calls the browser pull
// buttons make through /api/netsuite and /api/avectous, without the browser.

import crypto from 'node:crypto';

export const NS_SEARCHES = { so: '4875', to: '4872' };

export const AV_REPORTS = {
  orders: { PageId: 6, PageName: 'Orders', PanelName: 'Orders' },
  shipments: { PageId: 11900, PageName: 'Shipments by Order/Tracking', PanelName: 'Shipments by Order/Tracking' }
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
