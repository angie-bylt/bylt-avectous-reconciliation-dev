// Automatic refresh.
//
// Runs once a minute (refresh-tick.mjs). Each run does about 20 seconds of
// work, saves where it got to, and stops — the next run carries on. That keeps
// every run inside Netlify's 30-second limit on any plan, and means Avectous and
// NetSuite are only ever asked one thing at a time.
//
// A refresh ("cycle") goes through these steps in order:
//   1. NetSuite sales orders     (search 4875)
//   2. NetSuite transfer orders  (search 4872)
//   3. Avectous orders           (report 6)
//   4. Avectous shipments        (report 11900, one order date at a time)
//   5. Check orders that left an open status
//   6. Recalculate Order Status and Integrations Status
//   7. Ask Avectous why any never-arrived orders are missing, then save Integrations
//
// The first cycle pulls everything (a few hours, spread over many runs) and
// keeps a saved copy. After that each cycle only fetches what changed:
//   - NetSuite: orders modified since the day before the last refresh
//   - Avectous orders: every order still open (by status) plus the last 2 days
//   - Avectous shipments: the last 2 days, plus the order dates of any order
//     that was open last time and isn't now
// Once a week it does a full pull again as a safety net.

const FINAL_STATUSES = ['shipped', 'cancelled'];
const DEFAULT_OPEN_STATUSES = ['New', 'Batched', 'Waved', 'Picked', 'Packed'];
const SHIP_FROM = '2026-07-01';
const CYCLE_EVERY_MIN = 60;
const FULL_EVERY_DAYS = 7;
const RUN_BUDGET_MS = 23000;        // stop starting new requests after this
const HARD_LIMIT_MS = 28000;        // nothing may still be running after this
const EST = { ns: 18000, av: 9000, merge: 12000, compute: 20000 };
const MAX_ERRORS = 6;               // in a row, before a cycle is abandoned
const RESOLVE_CAP = 120;            // single-order lookups per cycle

const AVO_KEEP = ['OrderNumber', 'Status', 'OrderType', 'Channel', 'ChannelOrderNumber', 'OrderDate', 'Profile'];
const SHP_KEEP = ['OrderNumber', 'ChannelOrderNumber', 'ShipDate', 'OrderDate', 'Channel', 'TrackingNo', 'TotalQtyShipped', 'LinesShipped'];

// ---------- dates (Pacific) ----------
const pacific = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' });
const dayOf = ms => pacific.format(new Date(ms));                       // YYYY-MM-DD
const addDays = (day, n) => { const d = new Date(day + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const nsDate = day => { const [y, m, d] = day.split('-'); return `${+m}/${+d}/${y}`; };   // M/D/YYYY
const isoDay = v => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) ? v.slice(0, 10) : null;
const isOpen = s => !FINAL_STATUSES.includes(String(s || '').trim().toLowerCase());

// ---------- saved tables (stored in chunks, rows as arrays) ----------
const CHUNK = 5000;

async function readTable(store, name) {
  const man = await store.get(`snap:${name}`, { type: 'json' });
  if (!man) return null;
  // Read in small batches, retrying a piece that comes back empty once.
  const parts = [];
  for (let i = 0; i < man.chunks.length; i += 4) {
    const batch = man.chunks.slice(i, i + 4);
    parts.push(...await Promise.all(batch.map(async k => {
      let p = await store.get(k, { type: 'json' });
      if (!p) { await new Promise(r => setTimeout(r, 700)); p = await store.get(k, { type: 'json' }); }
      return p;
    })));
  }
  const rows = [];
  for (let i = 0; i < parts.length; i++) {
    // A missing piece means the saved copy can't be trusted; never use part of it.
    if (!parts[i]) throw new Error(`saved copy "${name}" is missing piece ${i + 1} of ${parts.length}`);
    rows.push(...parts[i]);
  }
  if (man.count != null && rows.length !== man.count) throw new Error(`saved copy "${name}" has ${rows.length} rows, expected ${man.count}`);
  return { headers: man.headers, rows, savedAt: man.savedAt };
}

async function writeTable(store, name, headers, rows) {
  const old = await store.get(`snap:${name}`, { type: 'json' });
  const gen = Date.now().toString(36);
  const chunks = [];
  const writes = [];
  for (let i = 0; i < rows.length; i += CHUNK) {
    const key = `snap:${name}:${gen}:${chunks.length}`;
    chunks.push(key);
    writes.push(store.setJSON(key, rows.slice(i, i + CHUNK)));
  }
  await Promise.all(writes);
  await store.setJSON(`snap:${name}`, { headers, chunks, count: rows.length, savedAt: new Date().toISOString() });
  if (old && old.chunks) await Promise.all(old.chunks.map(k => store.delete(k).catch(() => {})));
}

// Objects -> arrays in a fixed column order.
function toArrays(objs, headers) {
  return objs.map(o => headers.map(h => (o[h] === undefined ? null : o[h])));
}

// Line up an old table and new rows on one set of columns.
function unify(oldTable, newHeaders) {
  const headers = oldTable ? [...oldTable.headers] : [];
  for (const h of newHeaders) if (!headers.includes(h)) headers.push(h);
  const oldRows = oldTable
    ? oldTable.rows.map(a => headers.map(h => { const i = oldTable.headers.indexOf(h); return i < 0 ? null : a[i]; }))
    : [];
  return { headers, oldRows };
}

// ---------- page buffers for the step in progress ----------
async function addWork(store, key, n, headers, rows) {
  await store.setJSON(`work:${key}:${n}`, { headers, rows });
}
async function readWork(store, key, count) {
  const pages = await Promise.all(Array.from({ length: count }, (_, i) => store.get(`work:${key}:${i}`, { type: 'json' })));
  const headers = [];
  const objs = [];
  for (const p of pages) {
    if (!p) continue;
    for (const h of p.headers) if (!headers.includes(h)) headers.push(h);
    for (const a of p.rows) { const o = {}; p.headers.forEach((h, i) => { o[h] = a[i]; }); objs.push(o); }
  }
  return { headers, objs };
}
async function clearWork(store, key, count) {
  await Promise.all(Array.from({ length: count }, (_, i) => store.delete(`work:${key}:${i}`).catch(() => {})));
}

function pick(obj, keep) { const o = {}; for (const k of keep) if (k in obj) o[k] = obj[k]; return o; }

// ---------- state ----------
const BLANK = {
  paused: true,            // off until someone presses Start
  status: 'idle',
  steps: [], step: 0, cursor: null,
  mode: null, cycleStartedAt: null, lastSuccessAt: null, lastFullAt: null, lastCycle: null,
  requested: null, errors: 0, lastError: null, lockUntil: 0, progress: '', history: []
};

export async function getState(store) {
  return { ...BLANK, ...(await store.get('state', { type: 'json' }) || {}) };
}
async function putState(store, st) { await store.setJSON('state', st); }

function buildCycle(st, now, haveSnapshots, forceFull) {
  const full = forceFull || !haveSnapshots || !st.lastFullAt ||
    (now - Date.parse(st.lastFullAt)) > FULL_EVERY_DAYS * 864e5;
  const since = st.lastSuccessAt ? nsDate(addDays(dayOf(Date.parse(st.cycleOfLastSuccess || st.lastSuccessAt)), -1)) : null;
  return {
    mode: full ? 'full' : 'incremental',
    steps: [
      { kind: 'ns', source: 'so', incremental: !full && !!since, since },
      { kind: 'ns', source: 'to', incremental: !full && !!since, since },
      { kind: 'avo', incremental: !full },
      { kind: 'shp', incremental: !full },
      { kind: 'resolve', incremental: !full },
      { kind: 'compute' },
      { kind: 'reasons' }
    ]
  };
}

// ---------- steps ----------
// Each returns true when the step is finished. Each does ONE request or one merge.

async function stepNs(ctx, step, cur) {
  const { store, clients, compute, timeLeft } = ctx;
  cur.offset ??= 0; cur.size ??= 1000; cur.pages ??= 0;
  const key = `ns-${step.source}`;
  if (cur.finished) {
    // Merge the pulled pages into the saved copy.
    const { headers, objs } = await readWork(store, key, cur.pages);
    let outHeaders, outRows;
    if (step.incremental) {
      let old = null, why = '';
      try {
        old = await readTable(store, key);
        if (!old) why = `no saved copy found (snap:${key} missing)`;
        else if (!old.headers.includes('id')) why = `saved copy has no id column (${old.headers.length} columns: ${old.headers.slice(0, 6).join(', ')}...)`;
      } catch (err) { why = err.message; }
      if (why) {
        // No trustworthy saved copy to add changes to: pull this search in full instead.
        await clearWork(store, key, cur.pages);
        step.incremental = false;
        for (const k of Object.keys(cur)) delete cur[k];
        ctx.note(`NetSuite ${step.source}: saved copy unusable (${why}); pulling the whole search instead`);
        return false;
      }
      const changed = new Set(objs.map(o => String(o.id)));
      const { headers: h, oldRows } = unify(old, headers);
      const idIdx = h.indexOf('id');
      const kept = oldRows.filter(a => !changed.has(String(a[idIdx])));
      outHeaders = h; outRows = kept.concat(toArrays(objs, h));
      // A quick refresh only adds and updates orders, so the copy can't shrink much.
      if (outRows.length < old.rows.length * 0.95) {
        await clearWork(store, key, cur.pages);
        step.incremental = false;
        for (const k of Object.keys(cur)) delete cur[k];
        ctx.note(`NetSuite ${step.source}: merge would shrink the copy from ${old.rows.length} to ${outRows.length} rows; pulling the whole search instead`);
        return false;
      }
      ctx.note(`NetSuite ${step.source === 'so' ? 'sales' : 'transfer'} orders: ${changed.size} changed orders merged (${old.rows.length} -> ${outRows.length} rows)`);
    } else {
      outHeaders = headers; outRows = toArrays(objs, headers);
      ctx.note(`NetSuite ${step.source === 'so' ? 'sales' : 'transfer'} orders: ${outRows.length} rows`);
    }
    await writeTable(store, key, outHeaders, outRows);
    await clearWork(store, key, cur.pages);
    return true;
  }
  const filters = step.incremental ? [{ name: 'lastmodifieddate', operator: 'onorafter', values: [step.since] }] : undefined;
  let page;
  try {
    page = await clients.nsSearchPage({ source: step.source, pageIndex: cur.offset / cur.size, pageSize: cur.size, filters, timeoutMs: timeLeft() - 1500 });
  } catch (err) {
    if (err.message === 'TIMEOUT' && cur.size > 250 && cur.offset % (cur.size / 2) === 0) { cur.size /= 2; return false; }
    if (step.incremental && cur.offset === 0 && err.netsuite) {
      // The "changed since" filter wasn't accepted — fall back to a full pull of this search.
      step.incremental = false;
      ctx.note(`NetSuite would not take the changed-since filter (${err.message}); pulling search ${step.source} in full`);
      return false;
    }
    throw err;
  }
  if (page.rows.length) {
    cur.keep ??= compute.keepNetSuiteColumns(Object.keys(page.rows[0]));
    await addWork(store, key, cur.pages, cur.keep, toArrays(page.rows, cur.keep));
    cur.pages++;
  }
  cur.offset += page.rows.length;
  cur.total = page.total;
  ctx.progress = `NetSuite ${step.source === 'so' ? 'sales' : 'transfer'} orders: ${cur.offset.toLocaleString()} of ${page.total.toLocaleString()} rows`;
  if (!page.hasMore || !page.rows.length) cur.finished = true;
  return false;
}

async function stepAvo(ctx, step, cur) {
  const { store, clients, st } = ctx;
  cur.pages ??= 0; cur.size ??= 1000;
  if (!cur.queries) {
    if (step.incremental) {
      const old = await readTable(store, 'avo');
      const sIdx = old ? old.headers.indexOf('Status') : -1;
      const seen = new Set(DEFAULT_OPEN_STATUSES);
      if (old) for (const a of old.rows) if (isOpen(a[sIdx]) && a[sIdx]) seen.add(String(a[sIdx]));
      const today = dayOf(Date.now());
      cur.queries = [...seen].map(s => ({ Status: s }))
        .concat([addDays(today, -1), today].map(d => ({ OrderDate: d })));
    } else {
      cur.queries = [null];
    }
    cur.q = 0; cur.page = 1;
  }
  if (cur.finished) {
    const { objs } = await readWork(store, 'avo', cur.pages);
    const fetched = new Map(objs.map(o => [String(o.OrderNumber), pick(o, AVO_KEEP)]));
    let rows;
    st.leftOpen = [];
    if (step.incremental) {
      let old = null, why = '';
      try { old = await readTable(store, 'avo'); if (!old) why = 'no saved copy found'; } catch (err) { why = err.message; }
      if (!old) {
        await clearWork(store, 'avo', cur.pages);
        step.incremental = false;
        for (const k of Object.keys(cur)) delete cur[k];
        ctx.note(`Avectous orders: saved copy unusable (${why}), pulling the whole report instead`);
        return false;
      }
      const map = new Map();
      if (old) for (const a of old.rows) { const o = {}; old.headers.forEach((h, i) => { o[h] = a[i]; }); map.set(String(o.OrderNumber), o); }
      for (const [k, o] of map) {
        if (isOpen(o.Status) && !fetched.has(k)) st.leftOpen.push({ OrderNumber: k, day: isoDay(o.OrderDate) });
      }
      for (const [k, o] of fetched) map.set(k, o);
      rows = [...map.values()];
      ctx.note(`Avectous orders: ${fetched.size} open/new orders refreshed, ${st.leftOpen.length} left an open status`);
    } else {
      rows = [...fetched.values()];
      ctx.note(`Avectous orders: ${rows.length} orders`);
    }
    await writeTable(store, 'avo', AVO_KEEP, toArrays(rows, AVO_KEEP));
    await clearWork(store, 'avo', cur.pages);
    return true;
  }
  const q = cur.queries[cur.q];
  let page;
  try {
    page = await clients.avPage({ report: 'orders', pageIndex: cur.page, pageLimit: cur.size, parameters: q || undefined, timeoutMs: ctx.timeLeft() - 1500 });
  } catch (err) {
    if (err.message === 'TIMEOUT' && cur.size > 250 && ((cur.page - 1) * cur.size) % (cur.size / 2) === 0) {
      cur.page = ((cur.page - 1) * 2) + 1; cur.size /= 2; return false;
    }
    throw err;
  }
  if (q && q.Status && page.rows.some(r => String(r.Status) !== q.Status)) {
    // Avectous ignored the Status filter — do a full pull of the report instead.
    step.incremental = false;
    await clearWork(store, 'avo', cur.pages);
    for (const k of Object.keys(cur)) delete cur[k];
    ctx.note('Avectous ignored the Status filter; pulling the Orders report in full');
    return false;
  }
  if (page.rows.length) {
    const objs = page.rows.map(r => pick(r, AVO_KEEP));
    await addWork(store, 'avo', cur.pages, AVO_KEEP, toArrays(objs, AVO_KEEP));
    cur.pages++;
  }
  ctx.progress = `Avectous orders: ${q ? (q.Status ? `status ${q.Status}` : `order date ${q.OrderDate}`) : 'full report'}, page ${cur.page}${page.total ? ` of ${Math.ceil(page.total / cur.size)}` : ''}`;
  if (page.hasMore && page.rows.length) { cur.page++; return false; }
  cur.q++; cur.page = 1; cur.size = 1000;
  if (cur.q >= cur.queries.length) cur.finished = true;
  return false;
}

async function stepShp(ctx, step, cur) {
  const { store, clients, st } = ctx;
  cur.pages ??= 0;
  if (!cur.days) {
    const today = dayOf(Date.now());
    if (step.incremental) {
      const set = new Set([addDays(today, -1), today]);
      for (const o of st.leftOpen || []) if (o.day) set.add(o.day);
      cur.days = [...set].sort();
    } else {
      cur.days = [];
      for (let d = SHIP_FROM; d <= today; d = addDays(d, 1)) cur.days.push(d);
    }
    cur.d = 0; cur.page = 1;
  }
  if (cur.finished) {
    const { objs } = await readWork(store, 'shp', cur.pages);
    const fresh = objs.map(o => pick(o, SHP_KEEP));
    let rows;
    if (step.incremental) {
      let old = null, why = '';
      try { old = await readTable(store, 'shp'); if (!old) why = 'no saved copy found'; } catch (err) { why = err.message; }
      if (!old) {
        await clearWork(store, 'shp', cur.pages);
        step.incremental = false;
        for (const k of Object.keys(cur)) delete cur[k];
        ctx.note(`Avectous shipments: saved copy unusable (${why}), pulling every order date instead`);
        return false;
      }
      const days = new Set(cur.days);
      const oIdx = old.headers.indexOf('OrderDate');
      const kept = old.rows.filter(a => !days.has(isoDay(a[oIdx])));
      rows = kept.concat(toArrays(fresh, SHP_KEEP));
    } else {
      rows = toArrays(fresh, SHP_KEEP);
    }
    await writeTable(store, 'shp', SHP_KEEP, rows);
    ctx.note(`Avectous shipments: ${cur.days.length} order date(s) refreshed, ${fresh.length} shipment rows`);
    await clearWork(store, 'shp', cur.pages);
    return true;
  }
  const day = cur.days[cur.d];
  const page = await clients.avPage({ report: 'shipments', pageIndex: cur.page, pageLimit: 1000, parameters: { OrderDate: `${day} 00:00:00` }, timeoutMs: ctx.timeLeft() - 1500 });
  if (page.rows.length) {
    await addWork(store, 'shp', cur.pages, SHP_KEEP, toArrays(page.rows.map(r => pick(r, SHP_KEEP)), SHP_KEEP));
    cur.pages++;
  }
  ctx.progress = `Avectous shipments: order date ${day} (${cur.d + 1} of ${cur.days.length})`;
  if (page.hasMore && page.rows.length) { cur.page++; return false; }
  cur.d++; cur.page = 1;
  if (cur.d >= cur.days.length) cur.finished = true;
  return false;
}

// Orders that were open last time and didn't come back in this cycle's open
// list: mark the ones that now have a shipment as Shipped, and look the rest
// up one at a time (usually cancellations).
async function stepResolve(ctx, step, cur) {
  const { store, clients, st } = ctx;
  if (!step.incremental || !(st.leftOpen && st.leftOpen.length)) return true;
  if (!cur.todo) {
    const shp = await readTable(store, 'shp');
    const kIdx = shp ? shp.headers.indexOf('OrderNumber') : -1;
    const shipped = new Set(shp ? shp.rows.map(a => String(a[kIdx])) : []);
    cur.shipped = st.leftOpen.filter(o => shipped.has(o.OrderNumber)).map(o => o.OrderNumber);
    cur.todo = st.leftOpen.filter(o => !shipped.has(o.OrderNumber)).slice(0, RESOLVE_CAP).map(o => o.OrderNumber);
    cur.i = 0; cur.updates = {};
  }
  if (cur.i < cur.todo.length) {
    const num = cur.todo[cur.i];
    const page = await clients.avPage({ report: 'orders', pageIndex: 1, pageLimit: 10, parameters: { OrderNumber: num }, timeoutMs: ctx.timeLeft() - 1500 });
    const hit = page.rows.find(r => String(r.OrderNumber) === num);
    if (hit) cur.updates[num] = hit.Status;
    cur.i++;
    ctx.progress = `Checking orders that left an open status: ${cur.i} of ${cur.todo.length}`;
    return false;
  }
  const avo = await readTable(store, 'avo');
  const kIdx = avo.headers.indexOf('OrderNumber');
  const sIdx = avo.headers.indexOf('Status');
  const shippedSet = new Set(cur.shipped);
  for (const a of avo.rows) {
    const k = String(a[kIdx]);
    if (shippedSet.has(k)) a[sIdx] = 'Shipped';
    else if (cur.updates[k]) a[sIdx] = cur.updates[k];
  }
  await writeTable(store, 'avo', avo.headers, avo.rows);
  ctx.note(`Orders that left an open status: ${cur.shipped.length} shipped, ${Object.keys(cur.updates).length} looked up`);
  return true;
}

async function stepCompute(ctx) {
  const { store, results, compute } = ctx;
  const [nsSo, nsTo, avo, shp] = await Promise.all(['ns-so', 'ns-to', 'avo', 'shp'].map(n => readTable(store, n)));
  if (!nsSo || !nsTo || !avo || !shp) throw new Error('A saved copy is missing; the next full refresh will rebuild it');
  // Sanity check against the last good run: totals only grow, so a big drop means
  // the saved copy is damaged. Don't publish numbers from it; rebuild instead.
  const prev = ctx.st.lastCounts || null;
  const counts = { nsSo: nsSo.rows.length, nsTo: nsTo.rows.length, avo: avo.rows.length, shp: shp.rows.length };
  if (prev) {
    for (const k of Object.keys(counts)) {
      if (prev[k] && counts[k] < prev[k] * 0.9) {
        ctx.st.requested = 'full';
        throw new Error(`Saved ${k} copy dropped from ${prev[k]} to ${counts[k]} rows; numbers not published, full rebuild queued`);
      }
    }
  }
  const out = compute.computeAll({ nsSo, nsTo, avo, shp });
  ctx.st.lastCounts = counts;
  const savedAt = new Date().toISOString();
  if (!out.orderStatusError) {
    await results.setJSON(out.ids.orderStatus, { result: out.orderStatus, savedAt, ranBy: 'Auto-refresh' });
    ctx.note('Order Status updated');
  } else {
    ctx.note(`Order Status not updated: ${out.orderStatusError}`);
  }
  // Integrations Status is saved after the next step adds Avectous's reasons.
  await store.setJSON('work:integrations', { id: out.ids.integrations, result: out.integrations });
  return true;
}

// For each order on the never-reached-Avectous lists, look up Avectous's
// Interface - Order log and keep the latest attempt's result. Cached for 3
// hours so hourly refreshes only re-check what's new. Then save Integrations.
const REASON_TTL_MS = 3 * 3600 * 1000;
const REASON_CAP = 200;
async function stepReasons(ctx, step, cur) {
  const { store, results, clients, compute } = ctx;
  const parked = await store.get('work:integrations', { type: 'json' });
  if (!parked) return true;
  const cache = (await store.get('reasons-cache', { type: 'json' })) || {};
  if (!cur.todo) {
    const list = compute.missingOrders(parked.result).slice(0, REASON_CAP);
    const nowMs = Date.now();
    cur.list = list;
    cur.todo = list.filter(m => !cache[m.order] || nowMs - Date.parse(cache[m.order].checkedAt) > REASON_TTL_MS);
    cur.i = 0;
  }
  if (cur.i < cur.todo.length) {
    const m = cur.todo[cur.i];
    let why;
    try {
      const page = await clients.avPage({ report: 'interface', pageIndex: 1, pageLimit: 50, parameters: { OrderNumber: m.order }, timeoutMs: ctx.timeLeft() - 1500 });
      why = compute.summarizeReason(page.rows.filter(r => String(r.OrderNumber) === m.order), m.exported);
    } catch (err) {
      why = { label: 'Not checked yet', detail: `Avectous lookup failed: ${err.message}`, at: '' };
    }
    cache[m.order] = { ...why, checkedAt: new Date().toISOString() };
    await store.setJSON('reasons-cache', cache);
    cur.i++;
    ctx.progress = `Asking Avectous why orders are missing: ${cur.i} of ${cur.todo.length}`;
    return false;
  }
  const reasons = {};
  for (const m of cur.list) if (cache[m.order]) reasons[m.order] = cache[m.order];
  // Keep the cache to orders still missing.
  const keep = {};
  for (const m of cur.list) if (cache[m.order]) keep[m.order] = cache[m.order];
  await store.setJSON('reasons-cache', keep);
  compute.applyReasons(parked.result, reasons);
  await results.setJSON(parked.id, { result: parked.result, savedAt: new Date().toISOString(), ranBy: 'Auto-refresh' });
  await store.delete('work:integrations').catch(() => {});
  ctx.note(`Integrations Status updated (${cur.todo.length} missing orders checked with Avectous)`);
  return true;
}

const STEP_FN = { ns: stepNs, avo: stepAvo, shp: stepShp, resolve: stepResolve, compute: stepCompute, reasons: stepReasons };
const STEP_EST = { ns: EST.ns, avo: EST.av, shp: EST.av, resolve: EST.av, compute: EST.compute, reasons: EST.av };

// ---------- one run ----------
export async function runTick({ store, results, clients, compute, now = () => Date.now() }) {
  const t0 = now();
  const st = await getState(store);
  if (st.lockUntil && st.lockUntil > t0) return { skipped: 'locked' };
  st.lockUntil = t0 + 40000;
  await putState(store, st);

  const notes = [];
  const ctx = {
    store, results, clients, compute, st,
    progress: st.progress,
    note: m => notes.push(`${new Date(now()).toISOString()} ${m}`),
    timeLeft: () => HARD_LIMIT_MS - (now() - t0)
  };

  try {
    if (st.status === 'idle') {
      const due = !st.lastSuccessAt || (t0 - Date.parse(st.lastSuccessAt)) >= CYCLE_EVERY_MIN * 60000;
      if (st.paused && !st.requested) return { skipped: 'paused' };
      if (!due && !st.requested) return { skipped: 'not due' };
      const haveSnapshots = !!(await store.get('snap:ns-so', { type: 'json' }));
      const c = buildCycle(st, t0, haveSnapshots, st.requested === 'full');
      Object.assign(st, { status: 'running', steps: c.steps, mode: c.mode, step: 0, cursor: {}, cycleStartedAt: new Date(t0).toISOString(), requested: null, errors: 0, lastError: null, leftOpen: [] });
      ctx.note(`Started a${c.mode === "incremental" ? "n" : ""} ${c.mode} refresh`);
    }

    while (st.status === 'running') {
      const step = st.steps[st.step];
      const est = (st.cursor && st.cursor.finished) ? EST.merge : STEP_EST[step.kind];
      if ((now() - t0) + est > HARD_LIMIT_MS || (now() - t0) > RUN_BUDGET_MS) break;
      let done;
      try {
        done = await STEP_FN[step.kind](ctx, step, st.cursor);
        st.errors = 0;
      } catch (err) {
        st.errors++;
        if (/full rebuild queued/.test(err.message)) st.errors = MAX_ERRORS;
        st.lastError = `${new Date(now()).toISOString()} ${step.kind}: ${err.message}`;
        if (st.errors >= MAX_ERRORS) {
          ctx.note(`Refresh stopped after ${MAX_ERRORS} errors in a row: ${err.message}`);
          st.status = 'idle'; st.lastCycle = { ok: false, endedAt: new Date(now()).toISOString(), error: err.message };
          st.lastSuccessAt = st.lastSuccessAt; // unchanged; next cycle starts on schedule
          st.failedAt = new Date(now()).toISOString();
        }
        break;  // try again next minute
      }
      if (done) {
        st.step++; st.cursor = {};
        if (st.step >= st.steps.length) {
          const end = new Date(now()).toISOString();
          st.status = 'idle';
          st.cycleOfLastSuccess = st.cycleStartedAt;
          st.lastSuccessAt = end;
          if (st.mode === 'full') st.lastFullAt = end;
          st.lastCycle = { ok: true, mode: st.mode, startedAt: st.cycleStartedAt, endedAt: end };
          st.progress = '';
          st.leftOpen = [];
        }
      }
    }
    st.progress = st.status === 'running' ? ctx.progress : '';
  } finally {
    st.history = [...notes, ...(st.history || [])].slice(0, 40);
    st.lockUntil = 0;
    await putState(store, st);
  }
  return { status: st.status, progress: st.progress };
}

export async function request(store, action) {
  const st = await getState(store);
  if (action === 'start') { st.paused = false; if (st.status === 'idle') st.requested = st.requested || 'now'; }
  else if (action === 'pause') { st.paused = true; }
  else if (action === 'now') { if (st.status === 'idle') st.requested = 'now'; }
  else if (action === 'full') { if (st.status === 'idle') st.requested = 'full'; }
  else if (action === 'cancel') { st.status = 'idle'; st.steps = []; st.cursor = null; st.requested = null; st.progress = ''; }
  await putState(store, st);
  return st;
}


// What's saved, for troubleshooting (/api/refresh?inspect=1).
export async function inspect(store) {
  const out = {};
  for (const name of ['ns-so', 'ns-to', 'avo', 'shp']) {
    const man = await store.get(`snap:${name}`, { type: 'json' });
    if (!man) { out[name] = 'no saved copy'; continue; }
    const present = await Promise.all(man.chunks.map(k => store.getMetadata(k).then(m => !!m).catch(() => false)));
    out[name] = {
      rows: man.count, savedAt: man.savedAt, columns: man.headers.length, hasId: man.headers.includes('id'),
      pieces: man.chunks.length, missingPieces: present.filter(x => !x).length
    };
  }
  return out;
}
