// Flow check: every 15 minutes, straight against NetSuite, separate from the
// hourly refresh, so it keeps working when Avectous is down or the refresh is
// stuck. (Oct 15-16: Avectous stopped pulling orders at ~10 PM and 1,800+ orders
// piled up overnight while the hourly refresh kept failing at the Avectous step.)
//
//  1. Orders not reaching Avectous. Search customsearch_dash_orders_waiting: sales
//     orders Pending Fulfillment, no WMS Export Date, not withheld, created in the
//     last 2 days. Avectous picks up orders every 30 minutes, so orders from the last
//     day still waiting after an hour are stuck. 25 or more = alert.
//  3. Shopify orders not reaching NetSuite: customsearch_dash_latest_orders, none in 2 hours.
//  2. Ship confirmations not reaching NetSuite. Search
//     customsearch_dash_recent_fulfillments: item fulfillments created in the last 2
//     days. None in 3 hours between 6 AM and 8 PM Pacific = alert (nights are quiet).
//
// Each alert is sent once, then once more when it recovers. If a search doesn't
// exist yet, that check is skipped (noted once a day).

const EVERY_MS = 15 * 60 * 1000;
const WAIT_MIN = 60;            // an order still unsent after an hour is stuck
const WAIT_ALERT_COUNT = 25;    // this many stuck orders = alert
const WAIT_WINDOW_H = 24;       // only orders created in the last day (older stragglers are on the cards)
const IF_GAP_MIN = 180;         // no fulfillments for 3 hours...
const IF_HOURS = [6, 20];       // ...between 6 AM and 8 PM Pacific
const ORDER_GAP_MIN = 120;     // no Shopify orders in NetSuite for 2 hours = alert

// NetSuite timestamps come back like "10/15/2026 10:10 pm", in Pacific time.
function pacificOffsetMin(ms) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', timeZoneName: 'shortOffset' }).formatToParts(new Date(ms));
  const m = /GMT([+-]\d+)(?::(\d+))?/.exec((f.find(p => p.type === 'timeZoneName') || {}).value || '');
  return m ? Number(m[1]) * 60 + Math.sign(Number(m[1])) * Number(m[2] || 0) : -480;
}
export function nsTimeToMs(v) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*(am|pm)?/i.exec(String(v || '').trim());
  if (!m) return null;
  let h = Number(m[4]) % 12; if ((m[6] || '').toLowerCase() === 'pm') h += 12;
  const asUtc = Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]), h, Number(m[5]));
  return asUtc - pacificOffsetMin(asUtc) * 60000;
}
const pacificHour = ms => Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: '2-digit', hour12: false }).format(new Date(ms))) % 24;
const when = ms => new Date(ms).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short', hour: 'numeric', minute: '2-digit' });
const ago = min => min >= 120 ? `${Math.floor(min / 60)} hr ${min % 60} min` : `${min} min`;
const col = (row, name) => { for (const k of Object.keys(row)) if (k.toLowerCase().replace(/[^a-z]/g, '') === name) return row[k]; return undefined; };

async function allRows(clients, source) {
  const rows = [];
  for (let i = 0; i < 10; i++) {
    const page = await clients.nsSearchPage({ source, pageIndex: i, pageSize: 1000, timeoutMs: 12000 });
    rows.push(...page.rows);
    if (!page.hasMore) break;
  }
  return rows;
}

export async function runFlowCheck({ store, clients, alerts, nowMs, note }) {
  const canSend = !!(alerts && alerts.alertsConfigured && alerts.alertsConfigured());
  const st = (await store.get('flow:state', { type: 'json' })) || {};
  if (st.lastRun && nowMs - st.lastRun < EVERY_MS) return;
  st.lastRun = nowMs;
  const sends = [];
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const skip = (key, msg) => { if (st[key] !== today) { st[key] = today; note(msg); } };

  // 1. Orders not reaching Avectous
  try {
    const rows = await allRows(clients, 'waiting');
    const stuck = [];
    for (const r of rows) {
      const t = nsTimeToMs(col(r, 'datecreated'));
      if (!t) continue;
      const ageMin = Math.round((nowMs - t) / 60000);
      if (ageMin >= WAIT_MIN && ageMin <= WAIT_WINDOW_H * 60) stuck.push({ t, ageMin, po: col(r, 'pochecknumber') || '', doc: col(r, 'documentnumber') || '' });
    }
    stuck.sort((a, b) => a.t - b.t);
    if (stuck.length >= WAIT_ALERT_COUNT && !st.waitingDown) {
      st.waitingDown = nowMs;
      const o = stuck[0];
      sends.push([`\uD83D\uDEA8 ${stuck.length.toLocaleString()} orders haven\u2019t reached Avectous.`,
        [`Oldest: ${o.po || o.doc}${o.po && o.doc ? ` (${o.doc})` : ''}, created ${when(o.t)}, ${ago(o.ageMin)} ago.`,
         'Avectous normally picks up new orders every 30 minutes. Check with Avectous (Alan) that order intake is running.']]);
    } else if (stuck.length < WAIT_ALERT_COUNT && st.waitingDown) {
      st.waitingDown = null;
      sends.push(['\u2705 Orders are reaching Avectous again.', [`${stuck.length.toLocaleString()} still waiting over an hour.`]]);
    }
    st.waitingCount = stuck.length;
    st.waiting = { ok: true, count: stuck.length, oldestAt: stuck.length ? stuck[0].t : null, oldest: stuck.length ? (stuck[0].po || stuck[0].doc) : null };
  } catch (err) {
    st.waiting = { ok: false };
    if (/not found|invalid|does not exist|SSS_MISSING|INVALID_SEARCH/i.test(err.message)) skip('waitingMissingNoted', 'Flow check: search customsearch_dash_orders_waiting not found yet, skipped');
    else note(`Flow check (orders to Avectous) failed: ${err.message}`);
  }

  // 2. Ship confirmations not reaching NetSuite. The search is sorted newest
  // first (Date Created, descending), so the first page holds the newest one.
  // If the first row isn't the newest on the page, the sort is off: then read the
  // last page instead (newest at the end) rather than wrongly alerting.
  try {
    const first = await clients.nsSearchPage({ source: 'recentIf', pageIndex: 0, pageSize: 1000, timeoutMs: 12000 });
    const times = first.rows.map(r => nsTimeToMs(col(r, 'datecreated'))).filter(Boolean);
    let latest = times.length ? Math.max(...times) : null;
    const sortedNewestFirst = !times.length || times[0] === latest;
    if (!sortedNewestFirst && first.total > 1000) {
      const lastIdx = Math.ceil(first.total / 1000) - 1;
      const last = await clients.nsSearchPage({ source: 'recentIf', pageIndex: lastIdx, pageSize: 1000, timeoutMs: 12000 });
      for (const r of last.rows) { const t = nsTimeToMs(col(r, 'datecreated')); if (t && t > latest) latest = t; }
      skip('ifSortNoted', 'Flow check: Recent Fulfillments search isn\u2019t sorted newest first; set Sort By Date Created, Descending');
    }
    const h = pacificHour(nowMs);
    const daytime = h >= IF_HOURS[0] && h < IF_HOURS[1];
    const newest = first.rows.find(r => nsTimeToMs(col(r, 'datecreated')) === latest);
    st.recentIf = { ok: true, latestAt: latest, doc: newest ? col(newest, 'documentnumber') || '' : '', daytime };
    const gapMin = latest ? Math.round((nowMs - latest) / 60000) : null;
    if (daytime && gapMin !== null && gapMin > IF_GAP_MIN && !st.ifDown) {
      st.ifDown = nowMs;
      sends.push([`\uD83D\uDEA8 No ship confirmations have reached NetSuite in ${ago(gapMin)}.`,
        [`Last fulfillment created ${when(latest)}.`, 'Check that Avectous is sending ship confirmations, and the RESTlet log in NetSuite.']]);
    } else if (gapMin !== null && gapMin <= IF_GAP_MIN && st.ifDown) {
      st.ifDown = null;
      sends.push(['\u2705 Ship confirmations are reaching NetSuite again.', [`Latest fulfillment created ${when(latest)}.`]]);
    }
  } catch (err) {
    st.recentIf = { ok: false };
    if (/not found|invalid|does not exist|SSS_MISSING|INVALID_SEARCH/i.test(err.message)) skip('ifMissingNoted', 'Flow check: search customsearch_dash_recent_fulfillments not found yet, skipped');
    else note(`Flow check (ship confirmations) failed: ${err.message}`);
  }

  // 3. Shopify orders reaching NetSuite. Search customsearch_dash_latest_orders:
  // sales orders with a Shopify order number (PO starts with #), created since
  // yesterday, newest first. Orders come in around the clock, so none for 2 hours
  // means stuck.
  try {
    const first = await clients.nsSearchPage({ source: 'latestOrders', pageIndex: 0, pageSize: 100, timeoutMs: 12000 });
    let latest = null, po = '';
    for (const r of first.rows) { const t = nsTimeToMs(col(r, 'datecreated')); if (t && (!latest || t > latest)) { latest = t; po = col(r, 'pochecknumber') || col(r, 'documentnumber') || ''; } }
    st.latestOrder = { ok: true, latestAt: latest, po };
    const gapMin = latest ? Math.round((nowMs - latest) / 60000) : null;
    if (gapMin !== null && gapMin > ORDER_GAP_MIN && !st.ordersDown) {
      st.ordersDown = nowMs;
      sends.push([`\uD83D\uDEA8 No Shopify orders have reached NetSuite in ${ago(gapMin)}.`,
        [`Last one: ${po} at ${when(latest)}.`, 'Check Celigo\u2019s Shopify \u2192 NetSuite order flow.']]);
    } else if (gapMin !== null && gapMin <= ORDER_GAP_MIN && st.ordersDown) {
      st.ordersDown = null;
      sends.push(['\u2705 Shopify orders are reaching NetSuite again.', [`Latest: ${po} at ${when(latest)}.`]]);
    }
  } catch (err) {
    st.latestOrder = { ok: false };
    if (/not found|invalid|does not exist|SSS_MISSING|INVALID_SEARCH/i.test(err.message)) skip('ordersMissingNoted', 'Flow check: search customsearch_dash_latest_orders not found yet, skipped');
    else note(`Flow check (Shopify orders) failed: ${err.message}`);
  }

  st.checkedAt = nowMs;
  await store.setJSON('flow:state', st);
  if (!canSend) return;
  for (const [subject, lines] of sends) {
    try { await alerts.sendAlert(subject, lines); note(`Alert sent: ${subject}`); }
    catch (err) { note(`Alert failed to send: ${err.message}`); }
  }
}
