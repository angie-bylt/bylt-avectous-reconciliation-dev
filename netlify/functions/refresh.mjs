// Status and controls for the automatic refresh, for the dashboard page.
//   GET  /api/refresh                -> current state
//   POST /api/refresh {action}       -> start | pause | now | full | cancel
import { getStore } from '@netlify/blobs';
import { isAuthorized, getSecret } from './lib/auth.mjs';
import { getState, request, inspect } from './lib/refresh-engine.mjs';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function summary(st) {
  const step = st.status === 'running' && st.steps[st.step];
  return {
    ok: true,
    paused: st.paused, status: st.status, mode: st.mode,
    step: step ? st.step + 1 : null, steps: st.steps ? st.steps.length : 0,
    progress: st.progress, requested: st.requested,
    cycleStartedAt: st.cycleStartedAt, lastSuccessAt: st.lastSuccessAt, lastFullAt: st.lastFullAt,
    lastCycle: st.lastCycle, lastError: st.lastError, history: (st.history || []).slice(0, 12)
  };
}

export default async (req) => {
  if (!isAuthorized(req, getSecret())) return json(401, { ok: false, error: 'Not signed in. Log out and back in.' });
  const store = getStore({ name: 'bylt-refresh', consistency: 'strong' });
  if (req.method === 'GET') {
    if (new URL(req.url).searchParams.get('inspect')) return json(200, { ok: true, saved: await inspect(store) });
    return json(200, summary(await getState(store)));
  }
  if (req.method === 'POST') {
    let body = {};
    try { body = await req.json(); } catch {}
    if (!['start', 'pause', 'now', 'full', 'cancel'].includes(body.action)) return json(400, { ok: false, error: 'Unknown action' });
    return json(200, summary(await request(store, body.action)));
  }
  return json(405, { ok: false, error: 'GET or POST only' });
};

export const config = { path: '/api/refresh' };
