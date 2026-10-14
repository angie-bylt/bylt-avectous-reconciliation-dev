// POST /api/alert-test: sends one test alert (Slack, or email) so the setup can be checked.
import { isAuthorized, getSecret } from './lib/auth.mjs';
import { alertsConfigured, sendAlert, alertTarget, ALERT_LINE } from './lib/alerts.mjs';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export default async (req) => {
  if (!isAuthorized(req, getSecret())) return json(401, { ok: false, error: 'Not signed in. Log out and back in.' });
  if (req.method !== 'POST') return json(405, { ok: false, error: 'POST only' });
  if (!alertsConfigured()) return json(200, { ok: false, error: 'Alerts are off on this site: add ALERT_SLACK_WEBHOOK in Netlify, then redeploy.' });
  try {
    await sendAlert('Test alert', [`This is a test from the BYLT Systems Dashboard.`, '', `Alerts are on. You'll get a message when a Systems card drops under ${ALERT_LINE}%, a daily reminder while it stays there, one when it's back, and one if the automatic refresh stops.`]);
    return json(200, { ok: true, to: alertTarget() });
  } catch (err) {
    return json(200, { ok: false, error: err.message });
  }
};

export const config = { path: '/api/alert-test' };
