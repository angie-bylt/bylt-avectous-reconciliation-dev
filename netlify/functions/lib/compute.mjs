// Runs the dashboard's own comparison code (app.js) on the server, so the
// automatic refresh produces exactly what Update Dashboard produces in the
// browser. app.js is shipped with the function (included_files in netlify.toml)
// and loaded into a sandbox; nothing in it is rewritten.

process.env.TZ = 'America/Los_Angeles';  // NetSuite times are Pacific, same as the office browsers

import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';

let cache = null;

function findAppJs() {
  const roots = [process.cwd(), process.env.LAMBDA_TASK_ROOT, '/var/task'].filter(Boolean);
  const tried = [];
  for (const r of roots) {
    for (const rel of ['app.js', '../app.js', '../../app.js']) {
      const p = path.resolve(r, rel);
      tried.push(p);
      if (fs.existsSync(p)) return p;
    }
  }
  throw new Error(`app.js not found. Tried: ${tried.join(', ')}`);
}

function load() {
  if (cache) return cache;
  const file = findAppJs();
  const code = fs.readFileSync(file, 'utf8');
  const mem = {};
  const ctx = {
    console, Date, Math, JSON, Intl, setTimeout, clearTimeout,
    localStorage: { getItem: k => mem[k] ?? null, setItem: (k, v) => { mem[k] = String(v); }, removeItem: k => { delete mem[k]; } },
    document: {
      addEventListener() {}, getElementById() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; },
      createElement() { return { style: {}, appendChild() {}, click() {}, setAttribute() {} }; }, body: { appendChild() {}, removeChild() {} }
    },
    location: { href: '', pathname: '/' },
    fetch: async () => ({ ok: false, json: async () => ({}) })
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(code + '\n;globalThis.__api = { computeIntegrations, computeOrderStatus, stripLedgers, INTEGRATIONS, ORDER_STATUS, norm, summarizeInterfaceRecords, applySyncReasons, syncMissingOrders };', ctx);

  // Every quoted name in app.js, normalised. A NetSuite column is kept only if
  // the comparison could look it up by one of these names (same matching rules
  // as its column finder), so customer details and unused columns aren't stored.
  const names = new Set();
  for (const m of code.matchAll(/'([^'\\\n]{2,60})'|"([^"\\\n]{2,60})"/g)) {
    const n = ctx.__api.norm(m[1] || m[2]);
    if (n.length >= 2) names.add(n);
  }
  cache = { api: ctx.__api, names };
  return cache;
}

export function keepNetSuiteColumns(headers) {
  const { api, names } = load();
  return headers.filter(h => {
    if (h === 'id') return true;
    const nh = api.norm(h);
    if (!nh) return false;
    if (names.has(nh)) return true;
    for (const n of names) {
      if (n.length >= 4 && (nh.includes(n) || n.includes(nh))) return true;
    }
    return false;
  });
}

// Same conversion the browser does after a NetSuite pull: checkboxes to Yes/No,
// "10/6/2026 11:45 am" timestamps to real dates.
const NS_DATETIME = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?$/i;
function normalizeNetSuiteRow(row) {
  for (const k in row) {
    const v = row[k];
    if (v === true) { row[k] = 'Yes'; continue; }
    if (v === false) { row[k] = 'No'; continue; }
    if (typeof v !== 'string') continue;
    const m = v.trim().match(NS_DATETIME);
    if (!m) continue;
    let h = parseInt(m[4], 10);
    const ap = (m[7] || '').toLowerCase();
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    row[k] = new Date(+m[3], +m[1] - 1, +m[2], h, +m[5], +(m[6] || 0));
  }
  return row;
}

function toObjects(table, normalize) {
  const { headers, rows } = table;
  return {
    headers,
    rows: rows.map(a => {
      const o = {};
      for (let i = 0; i < headers.length; i++) o[headers[i]] = a[i] === undefined ? null : a[i];
      return normalize ? normalizeNetSuiteRow(o) : o;
    })
  };
}

export function computeAll({ nsSo, nsTo, avo, shp }) {
  const { api } = load();
  const so = toObjects(nsSo, true);
  const to = toObjects(nsTo, true);
  const sync = [toObjects(avo, false)];
  const ship = [toObjects(shp, false)];
  const integrations = api.computeIntegrations(so, to, sync, ship);
  const orderStatus = api.computeOrderStatus(so, to, ship);
  return {
    ids: { integrations: api.INTEGRATIONS.id, orderStatus: api.ORDER_STATUS.id },
    integrations: api.stripLedgers(integrations),
    orderStatus: api.stripLedgers(orderStatus),
    orderStatusError: (orderStatus.so && orderStatus.so.error) || (orderStatus.to && orderStatus.to.error) || null
  };
}

// Why-missing helpers, shared with the browser (defined in app.js).
export function missingOrders(result) { return load().api.syncMissingOrders(result); }
export function summarizeReason(records, exported) { return load().api.summarizeInterfaceRecords(records, exported); }
export function applyReasons(result, reasons) { return load().api.applySyncReasons(result, reasons); }
