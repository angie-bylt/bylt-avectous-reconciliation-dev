// Runs one page of a NetSuite saved search through Tim's BYLT Saved Search API
// RESTlet (script 2500), using the dashboard's own deployment (deploy=2) and
// its own read-only role. Avectous's deployment (deploy=1) is never touched.
//
// Env vars: NS_ACCOUNT_ID, NS_RESTLET_URL, NS_CONSUMER_KEY, NS_CONSUMER_SECRET,
//           NS_TOKEN_ID, NS_TOKEN_SECRET. None are sent to the browser.

import crypto from 'node:crypto';
import { isAuthorized, getSecret } from './lib/auth.mjs';

// Only these searches can be run from the dashboard.
// Same searches the "Open" links on Integrations Status point to.
const SEARCHES = {
  so: '4875',  // NetSuite All Orders Report
  to: '4872'   // NetSuite All Transfer Orders Report
};

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

// RFC 3986 encoding, which OAuth 1.0a requires.
const enc = s => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

function authHeader(method, fullUrl) {
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
  // Signature covers the OAuth values plus the URL's query (script, deploy).
  const all = { ...oauth };
  url.searchParams.forEach((v, k) => { all[k] = v; });
  const paramString = Object.keys(all).sort().map(k => `${enc(k)}=${enc(all[k])}`).join('&');
  const baseString = [method.toUpperCase(), enc(baseUrl), enc(paramString)].join('&');
  const key = `${enc(process.env.NS_CONSUMER_SECRET)}&${enc(process.env.NS_TOKEN_SECRET)}`;
  oauth.oauth_signature = crypto.createHmac('sha256', key).update(baseString).digest('base64');

  const realm = String(process.env.NS_ACCOUNT_ID).toUpperCase().replace('-', '_');
  return 'OAuth realm="' + realm + '", ' +
    Object.keys(oauth).map(k => `${k}="${enc(oauth[k])}"`).join(', ');
}

export default async (req) => {
  if (!isAuthorized(req, getSecret())) {
    return json(401, { ok: false, error: 'Not signed in. Log out and back in.' });
  }
  if (req.method !== 'POST') return json(405, { ok: false, error: 'POST only' });

  const missing = ['NS_ACCOUNT_ID', 'NS_RESTLET_URL', 'NS_CONSUMER_KEY', 'NS_CONSUMER_SECRET', 'NS_TOKEN_ID', 'NS_TOKEN_SECRET']
    .filter(k => !process.env[k]);
  if (missing.length) {
    return json(500, { ok: false, error: `Missing Netlify environment variables: ${missing.join(', ')}` });
  }

  let body;
  try { body = await req.json(); } catch { return json(400, { ok: false, error: 'Bad request body' }); }

  const searchId = SEARCHES[body.source];
  if (!searchId) return json(400, { ok: false, error: `Unknown source: ${body.source}` });
  const pageIndex = Math.max(0, parseInt(body.pageIndex, 10) || 0);
  const pageSize = Math.min(1000, Math.max(100, parseInt(body.pageSize, 10) || 1000));

  const restletUrl = process.env.NS_RESTLET_URL;
  let res, text;
  try {
    res = await fetch(restletUrl, {
      method: 'POST',
      headers: {
        'Authorization': authHeader('POST', restletUrl),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ searchId, pageIndex, pageSize, clientId: 'netlify-dashboard' })
    });
    text = await res.text();
  } catch (err) {
    return json(502, { ok: false, error: `Could not reach NetSuite: ${err.message}` });
  }

  if (!res.ok) {
    let msg = text.slice(0, 300);
    try { const e = JSON.parse(text); msg = (e.error && (e.error.message || e.error.code)) || msg; } catch {}
    return json(502, { ok: false, error: `NetSuite returned ${res.status}: ${msg}` });
  }

  // The RESTlet returns a JSON string; NetSuite sometimes wraps it once more.
  let data;
  try {
    data = JSON.parse(text);
    if (typeof data === 'string') data = JSON.parse(data);
  } catch {
    return json(502, { ok: false, error: `Unexpected response from NetSuite: ${text.slice(0, 300)}` });
  }

  if (data._status && data._status !== 200) {
    return json(502, { ok: false, error: `NetSuite: ${data.error || 'error'} (${data.errorCode || data._status})` });
  }

  const meta = data.meta || {};
  return json(200, {
    ok: true,
    totalResults: meta.totalResults,
    totalPages: meta.totalPages,
    pageIndex: meta.pageIndex,
    pageSize: meta.pageSize,
    hasMore: !!meta.hasMore,
    rows: data.results || []
  });
};

export const config = { path: '/api/netsuite' };
