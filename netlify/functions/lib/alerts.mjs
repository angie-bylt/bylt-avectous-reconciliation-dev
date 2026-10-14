// Alerts to Slack (an Incoming Webhook for one channel). Env var:
// ALERT_SLACK_WEBHOOK = the https://hooks.slack.com/services/... link.
// (Email still works as a fallback if ALERT_SMTP_USER / ALERT_SMTP_PASS /
// ALERT_TO are set instead.) With nothing set, alerts are off. Put it on live
// only, so Dev and live don't both post the same alert.
//
// Rules:
//  - a Systems card's "made it across" drops under 99%: one alert
//  - still under 24 hours later: a daily reminder (not every hour)
//  - back at 99% or above: one "back to normal" alert
//  - the automatic refresh stops with an error, or runs over 2 hours: one alert,
//    then one when it's running again
// Alerts never hold up the refresh: any problem sending is only noted in the log.

export const ALERT_LINE = 99;
const REMIND_MS = 24 * 3600 * 1000;
const SHOPIFY_GAP_MIN = 120;   // no new Shopify orders in NetSuite for 2 hours = alert

const slackHook = () => (process.env.ALERT_SLACK_WEBHOOK || '').trim();
const emailOn = () => !!(process.env.ALERT_SMTP_USER && process.env.ALERT_SMTP_PASS && process.env.ALERT_TO);
export const alertsConfigured = () => !!slackHook() || emailOn();
export const alertTarget = () => slackHook() ? 'Slack' : (emailOn() ? process.env.ALERT_TO : '');

export async function sendAlert(subject, lines) {
  const site = process.env.URL || '';
  if (slackHook()) {
    const text = `*${subject}*\n${lines.join('\n')}` + (site ? `\n<${site}/systems.html|Open the Systems Dashboard>` : '');
    const res = await fetch(slackHook(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    if (!res.ok) throw new Error(`Slack ${res.status}: ${(await res.text()).slice(0, 120)}`);
    return;
  }
  const nodemailer = (await import('nodemailer')).default;
  const user = process.env.ALERT_SMTP_USER.trim();
  const transport = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user, pass: process.env.ALERT_SMTP_PASS.replace(/\s+/g, '') } });
  await transport.sendMail({
    from: `BYLT Systems Dashboard <${user}>`, to: process.env.ALERT_TO,
    subject: `[BYLT Systems] ${subject}`,
    text: lines.join('\n') + (site ? `\n\nSystems Dashboard: ${site}/systems.html` : '')
  });
}

// The four Systems cards, worked out the same way the page does.
export function cardHealth(result) {
  const out = [];
  if (!result || !result.audits) return out;
  const a = result.audits;
  const sum = (x, y, k) => ((x && x[k]) || 0) + ((y && y[k]) || 0);
  const card = (name, x, y) => {
    const total = sum(x, y, 'total'), missing = sum(x, y, 'missing');
    if (!total) return;
    out.push({ name, pct: ((total - missing) / total) * 100, missing, total });
  };
  card('NetSuite \u2192 Avectous', a.soSync, a.toSync);
  card('Avectous \u2192 NetSuite', a.soFulfil, a.toFulfil);
  const sh = result.shopify && !result.shopify.error ? result.shopify : null;
  if (sh) {
    card('Shopify \u2192 NetSuite', sh.inbound.online, sh.inbound.other);
    card('NetSuite \u2192 Shopify', sh.outbound.online, sh.outbound.other);
  }
  return out;
}

const pctText = c => `${c.name}: ${c.pct.toFixed(2)}% made it across (${c.missing.toLocaleString()} missing of ${c.total.toLocaleString()})`;

// After each saved refresh: compare cards with the line and send what changed.
export async function checkCards(store, result, note, savedAt) {
  if (!alertsConfigured()) return;
  const st = (await store.get('alerts:state', { type: 'json' })) || { cards: {} };
  const nowMs = Date.now();
  const dropped = [], remind = [], recovered = [];
  for (const c of cardHealth(result)) {
    const s = st.cards[c.name] || {};
    if (c.pct < ALERT_LINE) {
      if (!s.below) { dropped.push(c); st.cards[c.name] = { below: true, since: nowMs, lastSent: nowMs }; }
      else if (nowMs - (s.lastSent || 0) >= REMIND_MS) { remind.push(c); s.lastSent = nowMs; }
    } else if (s.below) { recovered.push(c); st.cards[c.name] = { below: false }; }
  }
  const sends = [];
  if (dropped.length) sends.push([`Under ${ALERT_LINE}%: ${dropped.map(c => c.name).join(', ')}`,
    [`These dropped under ${ALERT_LINE}% at the latest refresh:`, '', ...dropped.map(pctText), '', 'Use Export missing on the card for the order list and reasons.']]);
  if (remind.length) sends.push([`Still under ${ALERT_LINE}%: ${remind.map(c => c.name).join(', ')}`,
    [`Still under ${ALERT_LINE}% (daily reminder):`, '', ...remind.map(pctText)]]);
  if (recovered.length) sends.push([`Back to normal: ${recovered.map(c => c.name).join(', ')}`,
    [`Back at ${ALERT_LINE}% or above:`, '', ...recovered.map(pctText)]]);
  // Same-day check: are Shopify orders still reaching NetSuite? The cards only
  // count orders from before today, so a breakdown today would otherwise wait
  // until tomorrow. Orders come in around the clock, so a 2-hour gap means stuck.
  const sh = result && result.shopify && !result.shopify.error ? result.shopify : null;
  if (sh && sh.lastInNetSuite && savedAt) {
    const gapMin = Math.round((Date.parse(savedAt) - Date.parse(sh.lastInNetSuite)) / 60000);
    const last = `${sh.lastInNetSuiteName || 'the last one'} at ${new Date(sh.lastInNetSuite).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short', hour: 'numeric', minute: '2-digit' })}`;
    const gapText = gapMin >= 120 ? `${Math.floor(gapMin / 60)} hr ${gapMin % 60} min` : `${gapMin} min`;
    if (gapMin > SHOPIFY_GAP_MIN && !st.shopifyFlowDown) {
      st.shopifyFlowDown = nowMs;
      sends.push([`\uD83D\uDEA8 No Shopify orders have reached NetSuite in ${gapText}.`,
        [`Last one: ${last}.`, "Check Celigo\u2019s Shopify \u2192 NetSuite order flow."]]);
    } else if (gapMin <= SHOPIFY_GAP_MIN && st.shopifyFlowDown) {
      st.shopifyFlowDown = null;
      sends.push(['\u2705 Shopify orders are reaching NetSuite again.', [`Latest: ${last}.`]]);
    }
  }
  for (const [subject, lines] of sends) {
    try { await sendAlert(subject, lines); note(`Alert sent: ${subject}`); }
    catch (err) { note(`Alert failed to send: ${err.message}`); }
  }
  await store.setJSON('alerts:state', st);
}

// Refresh health: stopped with an error, or running unusually long; then recovered.
export async function checkRefresh(store, rs, note) {
  if (!alertsConfigured()) return;
  const st = (await store.get('alerts:state', { type: 'json' })) || { cards: {} };
  const nowMs = Date.now();
  let subject = null, lines = null;
  const failed = rs.lastCycle && rs.lastCycle.ok === false;
  const long = rs.status === 'running' && rs.cycleStartedAt && nowMs - Date.parse(rs.cycleStartedAt) > 2 * 3600 * 1000;
  if ((failed || long) && !st.refreshDown) {
    st.refreshDown = nowMs;
    subject = failed ? 'Automatic refresh stopped' : 'Automatic refresh is taking unusually long';
    lines = failed
      ? ['The automatic refresh stopped with an error:', '', String(rs.lastCycle.error || rs.lastError || 'unknown error'), '', 'The dashboard is showing the last saved numbers. Check Recent activity on Integrations Status \u2013 Orders.']
      : ['The automatic refresh has been running for over 2 hours. The dashboard is showing the last saved numbers.', '', `Current step: ${rs.progress || 'unknown'}`];
  } else if (!failed && !long && st.refreshDown && rs.lastCycle && rs.lastCycle.ok) {
    st.refreshDown = null;
    subject = 'Automatic refresh is running again';
    lines = ['The automatic refresh finished normally again. Numbers are current.'];
  }
  if (subject) {
    try { await sendAlert(subject, lines); note(`Alert sent: ${subject}`); }
    catch (err) { note(`Alert failed to send: ${err.message}`); }
    await store.setJSON('alerts:state', st);
  }
}

// ---------- Daily summary, 7:30 AM Pacific ----------
// One short message each morning from the latest saved numbers, with the change
// in missing counts since the previous morning's summary. Sent once per day, the
// first time a run happens at or after 7:30 AM Pacific.
const DAILY_AT_MIN = 7 * 60 + 30;   // 7:30 AM Pacific, right after the 6:45 update finishes
function pacific(ms) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(ms));
  const g = t => (f.find(p => p.type === t) || {}).value;
  return { day: `${g('year')}-${g('month')}-${g('day')}`, min: (Number(g('hour')) % 24) * 60 + Number(g('minute')) };
}
const fmtDay = d => d ? new Date(d + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' }) : '';
const fmtTime = iso => new Date(iso).toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit' });
const n = x => Number(x || 0).toLocaleString();
const daysSince = (day, today) => day ? Math.max(0, Math.round((Date.parse(today + 'T12:00:00') - Date.parse(day + 'T12:00:00')) / 864e5)) : null;
function oldestDay(rows, col) { let m = null; for (const r of rows || []) { const d = String(r[col] || '').slice(0, 10); if (/^\d{4}-\d{2}-\d{2}$/.test(d) && (!m || d < m)) m = d; } return m; }
function topReason(x, y) {
  const c = {};
  for (const a of [x, y]) for (const rc of (a && a.reasonCounts) || []) c[rc.label] = (c[rc.label] || 0) + rc.count;
  const best = Object.entries(c).sort((p, q) => q[1] - p[1])[0];
  return best ? `${best[0]} (${n(best[1])})` : '';
}

export function dailySummary(saved, prev, today) {
  const r = saved.result || {};
  const a = r.audits || {};
  const sh = r.shopify && !r.shopify.error ? r.shopify : null;
  const cards = [
    { name: 'Shopify \u2192 NetSuite', x: sh && sh.inbound.online, y: sh && sh.inbound.other, col: 1 },
    { name: 'NetSuite \u2192 Avectous', x: a.soSync, y: a.toSync, col: 2, reasons: true },
    { name: 'Avectous \u2192 NetSuite', x: a.soFulfil, y: a.toFulfil, col: 2, reasons: true, onTheWay: true },
    { name: 'NetSuite \u2192 Shopify', x: sh && sh.outbound.online, y: sh && sh.outbound.other, col: 2 }
  ];
  const lines = [`Numbers as of ${fmtTime(saved.savedAt)}`, ''];
  const counts = {};
  for (const c of cards) {
    if (!c.x && !c.y) continue;
    const total = ((c.x && c.x.total) || 0) + ((c.y && c.y.total) || 0);
    const missing = ((c.x && c.x.missing) || 0) + ((c.y && c.y.missing) || 0);
    if (!total) continue;
    const pct = ((total - missing) / total) * 100;
    counts[c.name] = missing;
    const icon = pct < ALERT_LINE ? '\uD83D\uDEA8' : missing ? '\uD83D\uDD0D' : '\u2705';   // problem / orders to check / all caught up
    let change = '';
    if (prev && prev[c.name] !== undefined) {
      const d = missing - prev[c.name];
      change = d > 0 ? `, up ${n(d)} since yesterday` : d < 0 ? `, down ${n(-d)} since yesterday` : ', same as yesterday';
    }
    lines.push(`${icon} *${c.name}:* ${n(missing)} missing (${pct.toFixed(2)}%)${change}`);
    const extra = [];
    if (missing) {
      const old = daysSince(oldestDay([].concat((c.x && c.x.rows) || [], (c.y && c.y.rows) || []), c.col), today);
      if (old !== null) extra.push(`oldest ${old} day${old === 1 ? '' : 's'}`);
      if (c.reasons) { const t = topReason(c.x, c.y); if (t) extra.push(`top reason: ${t}`); }
    }
    if (c.name === 'Shopify \u2192 NetSuite' && sh && sh.lastInNetSuite) extra.push(`latest one in NetSuite ${new Date(sh.lastInNetSuite).toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit' })}`);
    if (c.onTheWay) { const w = ((c.x && c.x.sameDay) || 0) + ((c.y && c.y.sameDay) || 0); if (w) extra.push(`${n(w)} shipped today, on the way`); }
    if (extra.length) lines.push(`      ${extra.join(' \u00B7 ')}`);
  }
  const wh = r.warehouseDay, aged = r.agedOpen;
  if (wh && wh.orderDay) {
    lines.push('');
    if (wh && wh.orderDay) lines.push(`\uD83D\uDCE6 Warehouse is shipping orders placed ${fmtDay(wh.orderDay)}`);
  }
  return { lines, counts };
}

export async function checkDaily(store, results, nowMs, note) {
  if (!alertsConfigured()) return;
  const t = pacific(nowMs);
  if (t.min < DAILY_AT_MIN) return;
  const st = (await store.get('alerts:state', { type: 'json' })) || { cards: {} };
  if (st.dailySent === t.day) return;
  const saved = await results.get('integrations', { type: 'json' });
  if (!saved || !saved.result) return;
  const { lines, counts } = dailySummary(saved, st.dailyPrev, t.day);
  st.dailySent = t.day;           // mark first, so a send problem can't cause a repeat every minute
  st.dailyPrev = counts;
  await store.setJSON('alerts:state', st);
  try { await sendAlert(`Daily integrations summary, ${fmtDay(t.day)}`, lines); note('Daily summary sent'); }
  catch (err) { note(`Daily summary failed to send: ${err.message}`); }
}
