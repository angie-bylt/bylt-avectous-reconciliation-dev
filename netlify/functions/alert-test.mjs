// POST /api/alert-test: sends one test alert (Slack, or email) so the setup can be checked.
import { isAuthorized, getSecret } from './lib/auth.mjs';
import { getStore } from '@netlify/blobs';
import { alertsConfigured, sendAlert, alertTarget, ALERT_LINE, dailySummary } from './lib/alerts.mjs';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export default async (req) => {
  if (!isAuthorized(req, getSecret())) return json(401, { ok: false, error: 'Not signed in. Log out and back in.' });
  if (req.method !== 'POST') return json(405, { ok: false, error: 'POST only' });
  if (!alertsConfigured()) return json(200, { ok: false, error: 'Alerts are off on this site: add ALERT_SLACK_WEBHOOK in Netlify, then redeploy.' });
  // ?summary=1: post the daily summary now, from the latest saved numbers.
  // Doesn't touch the 7:30 AM schedule or its "since yesterday" comparison.
  if (new URL(req.url).searchParams.get('summary')) {
    try {
      const results = getStore({ name: 'bylt-reconciliation', consistency: 'strong' });
      const store = getStore({ name: 'bylt-refresh', consistency: 'strong' });
      const saved = await results.get('integrations', { type: 'json' });
      if (!saved || !saved.result) return json(200, { ok: false, error: 'No saved numbers yet.' });
      const st = (await store.get('alerts:state', { type: 'json' })) || {};
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());
      const { lines } = dailySummary(saved, st.dailyPrev, today);
      const label = new Date(today + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' });
      await sendAlert(`Integrations summary, ${label} (sent from the dashboard)`, lines);
      return json(200, { ok: true, to: alertTarget(), summary: true });
    } catch (err) { return json(200, { ok: false, error: err.message }); }
  }
  try {
    await sendAlert('Test alert', [`This is a test from the BYLT Systems Dashboard.`, '', `Alerts are on. You'll get a message when a Systems card drops under ${ALERT_LINE}%, a daily reminder while it stays there, one when it's back, and one if the automatic refresh stops.`]);
    return json(200, { ok: true, to: alertTarget() });
  } catch (err) {
    return json(200, { ok: false, error: err.message });
  }
};

export const config = { path: '/api/alert-test' };
