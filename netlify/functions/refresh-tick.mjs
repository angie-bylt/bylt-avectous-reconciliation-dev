// Runs every minute. Does ~20 seconds of the automatic refresh and saves its
// place; see lib/refresh-engine.mjs. Does nothing while the refresh is paused
// or when the next refresh isn't due yet.
import { getStore } from '@netlify/blobs';
import { runTick } from './lib/refresh-engine.mjs';
import * as clients from './lib/clients.mjs';
import * as compute from './lib/compute.mjs';

export default async () => {
  const store = getStore({ name: 'bylt-refresh', consistency: 'strong' });
  const results = getStore({ name: 'bylt-reconciliation', consistency: 'strong' });
  try {
    const out = await runTick({ store, results, clients, compute });
    console.log('refresh tick', JSON.stringify(out));
  } catch (err) {
    console.error('refresh tick failed', err);
  }
};

export const config = { schedule: '* * * * *' };
