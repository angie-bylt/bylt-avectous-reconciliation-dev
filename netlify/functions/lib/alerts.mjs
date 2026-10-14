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
export async function checkCards(store, result, note) {
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
