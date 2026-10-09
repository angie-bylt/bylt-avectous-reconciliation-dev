// Fetches one page of an Avectous report through the MessageGateway API.
// The browser calls this once per page (with a pause between calls), so no
// single request runs long and Avectous is never hit in parallel.
//
// Env var: AVECTOUS_API_KEY — the key Avectous issued. Never sent to the browser.

import { isAuthorized, getSecret } from './lib/auth.mjs';

const ENDPOINT = 'https://bylt.avectous.com/API/MessageGateway/v1/MessageGateway/json';

// Only these reports can be pulled. PanelName is required by Avectous even
// though their doc doesn't mention it.
const REPORTS = {
  orders: { PageId: 6, PageName: 'Orders', PanelName: 'Orders' },
  // Slow unless filtered, so it is always asked for one order date at a time.
  // The date must be written exactly as Avectous's screen shows it.
  shipments: { PageId: 11900, PageName: 'Shipments by Order/Tracking', PanelName: 'Shipments by Order/Tracking',
               requiresOrderDate: true },
  // Avectous's log of every order NetSuite sent it, with why it was rejected.
  // Looked up one order at a time; only the fields the dashboard needs come back.
  interface: { PageId: 122, PageName: 'Interface - Order', PanelName: 'Interface - Order',
               requiresOrderNumber: true, keep: ['OrderNumber', 'RecordDate', 'Action', 'Success', 'LoadingResult'] }
};

const PAGE_LIMIT = 1000;

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

export default async (req) => {
  if (!isAuthorized(req, getSecret())) {
    return json(401, { ok: false, error: 'Not signed in. Log out and back in.' });
  }
  if (req.method !== 'POST') return json(405, { ok: false, error: 'POST only' });
  if (!process.env.AVECTOUS_API_KEY) {
    return json(500, { ok: false, error: 'AVECTOUS_API_KEY is not set in Netlify environment variables.' });
  }

  let body;
  try { body = await req.json(); } catch { return json(400, { ok: false, error: 'Bad request body' }); }

  const report = REPORTS[body.report];
  if (!report) return json(400, { ok: false, error: `Unknown report: ${body.report}` });
  const pageIndex = Math.max(1, parseInt(body.pageIndex, 10) || 1);

  const { requiresOrderDate, requiresOrderNumber, keep, ...pageDef } = report;
  // Smaller pages answer faster when Avectous is busy; the browser drops the
  // size if a page fails. Only sizes that divide 1,000 so pages stay aligned.
  const pageLimit = [1000, 500, 250].includes(parseInt(body.pageLimit, 10)) ? parseInt(body.pageLimit, 10) : PAGE_LIMIT;
  const messageContent = { ...pageDef, PageIndex: pageIndex, PageLimit: pageLimit };
  if (requiresOrderDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.orderDate || '')) {
      return json(400, { ok: false, error: 'This report needs an orderDate (YYYY-MM-DD).' });
    }
    messageContent.Parameters = { OrderDate: `${body.orderDate} 00:00:00` };
  }
  if (requiresOrderNumber) {
    const num = String(body.orderNumber || '').trim();
    if (!num || num.length > 60) return json(400, { ok: false, error: 'This report needs an orderNumber.' });
    messageContent.Parameters = { OrderNumber: num };
  }

  let res, text;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'API-Key': process.env.AVECTOUS_API_KEY },
      body: JSON.stringify({
        companyCode: 'Bylt',
        warehouseCode: '810',
        messageType: 'RequestPageId',
        messageContent
      })
    });
    text = await res.text();
  } catch (err) {
    return json(502, { ok: false, error: `Could not reach Avectous: ${err.message}` });
  }

  if (!res.ok) {
    return json(502, { ok: false, error: `Avectous returned ${res.status}: ${text.slice(0, 300)}` });
  }

  // Avectous wraps the result as a JSON string inside queueMessage.
  let outer, inner;
  try {
    outer = JSON.parse(text);
    inner = JSON.parse(outer.queueMessage);
  } catch (err) {
    return json(502, { ok: false, error: `Unexpected response from Avectous: ${text.slice(0, 300)}` });
  }

  if (outer.queueStatus === 'QueueFailed') {
    const msg = Array.isArray(inner) && inner[0] && inner[0].Message ? inner[0].Message : outer.queueMessage;
    return json(502, { ok: false, error: `Avectous: ${msg}` });
  }

  const page = Array.isArray(inner) ? inner[0] : inner;
  if (!page) {
    return json(502, { ok: false, error: 'Avectous response was empty.' });
  }
  // A filter that matches nothing (e.g. a day with no shipments) comes back
  // with TotalLines 0 and no MessageContent at all. That's an empty page, not an error.
  if (!Array.isArray(page.MessageContent)) {
    if (Number(page.TotalLines) === 0 || Number(page.ReturnedLines) === 0) page.MessageContent = [];
    else return json(502, { ok: false, error: 'Avectous response had no rows section.' });
  }

  return json(200, {
    ok: true,
    currentPage: page.CurrentPage,
    totalPages: page.TotalPages,
    totalLines: page.TotalLines,
    // Avectous sends "True"/"False" as text, not true/false.
    hasMore: String(page.hasMorePages ?? page.HasMorePages).toLowerCase() === 'true',
    rows: keep ? page.MessageContent.map(r => Object.fromEntries(keep.map(k => [k, r[k] ?? null]))) : page.MessageContent
  });
};

export const config = { path: '/api/avectous' };
