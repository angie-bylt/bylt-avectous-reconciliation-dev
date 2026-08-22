# BYLT NetSuite–Avectous Reconciliation Site

Pages, one password gate:
- login.html              -> Sign in (password gate for the whole site)
- index.html              -> Order Status, 810 Texas DC — landing page / first tab
- integration-health.html -> Integration Health (was index.html: missing records + discrepancies)
- load-data.html          -> Load Data (upload NetSuite + Avectous CSVs or XLSX, compare)
- totals.html             -> Totals (just the summary numbers, one row per area)
- dashboard.html          -> redirects to integration-health.html for old bookmarks

## Order Status tab

Two NetSuite exports, uploaded on the tab itself (not on Load Data):
- Search 4866, `customsearch_fulfillable_orders_final` -> fulfillable sales orders
- Search 4867, `customsearchfulfillable_to_final`      -> fulfillable transfer orders

Three counting rules:

**Count distinct orders, not rows.** These searches return one row per
fulfillment status per order, so a partially shipped order produces two rows.
Counting rows double-counts it.

**Key on Internal ID, not PO/Check Number.** Replacement orders inherit the
original order's Shopify number, so PO/Check Number is not unique.

**A partially shipped order counts as SHIPPED.** Something physically left the
building; the outstanding items are a customer-service follow-up, not warehouse
work in progress. The partial count is reported separately so it stays visible.

That gives two states, not three: shipped (any Fulfilled line) and not shipped
(every line Unfulfilled). They always sum to the order count; the tab shows a
red warning if they ever don't.

Baseline from the 21 Aug 2026 exports:

| | Total | Shipped | of which partial | Not shipped |
|---|---|---|---|---|
| 810 Texas DC | 21,837 | 11,804 | 215 | 10,033 |
| Sales orders | 20,106 | 11,596 | 7 | 8,510 |
| Transfer orders | 1,731 | 208 | 208 | 1,523 |

### There is no SLA target in this data

Ship By Date is blank on every transfer order and 569 sales orders. Where it is
populated it is identical to Ship Date on 100% of rows, and Ship Date is itself
identical to the order date on 99.5% of rows. None of these columns carries a
promised ship date.

So the tab measures what actually happened rather than performance against a
target:

- **Days to ship** — order date to Date Fulfilled, for orders that shipped.
  Sales orders run a median of 3 days, 90% within 8.
- **Days waiting** — order date to today, for orders with nothing shipped.
- **The "beyond normal" line** is the 90th percentile of actual ship time, not
  an invented threshold. Anything past it is an outlier by the warehouse's own
  pace.

Do not reintroduce an order-date-based "how late are we" metric. Order date is
the wrong clock: an EDI order placed in March with a ship date of 1 Aug is
20 days late, not 164.

### Sections on the tab, in order

1. Hero tiles — total, shipped, not shipped
2. Sales orders card / Transfer orders card
3. Sales orders by channel
4. Transfer orders by channel
5. Sales orders shipped per day
6. Transfer orders shipped per day
7. Update these numbers (collapsed)

Ship time and queue age are reported as one line each on the cards —
"typical time to ship" (median) and "waiting over N days", where N is the 90th
percentile of actual ship time. Full percentile grids were tried and removed:
four panels to answer two questions was too much for the audience.

Partial orders are not shown on the page at all. They count as shipped, they
change no total, and calling them out on every table added a column nobody
needed. The `Partial` field survives in the export ledger, so the detail is
still auditable.

### Show your work

The dashboard itself stays clean — no methodology disclosures on the page, so
it reads as a finished report rather than a worked example. The full set of
counting rules lives inside the collapsed "Update these numbers" panel, which
only whoever refreshes the data opens, along with a live readout of which
columns were detected on the last run. The **Export proof** button in the header builds a workbook
with a Summary & Method sheet and one row per order in a filterable ledger, so
anyone can rebuild the figures without trusting the dashboard. The ledger is
kept in the shared copy; if the browser's local storage runs out it is the first
thing dropped, and the export says so rather than exporting a partial file.

The upload panel is collapsed by default. Click "Update these numbers" to open it.

## How data works

Data you load and compare on the Load Data page is saved two places:
1. **Your browser** (localStorage) — always works, no setup required.
2. **Netlify Blobs** (shared storage) — this is what makes it "live" for
   everyone who logs in, on any device, without them loading anything.

Dashboard and Totals check the shared store first, falling back to your
own browser's copy if the shared one has nothing for that area yet.

No external service, no tokens, no extra signup — Netlify Blobs comes
built into every Netlify site. An earlier attempt at this hit a persistent
502 error; that turned out to be a project configuration issue (dependency
version + bundler settings), not a fundamental Blobs problem — fixed by:
- Pinning `@netlify/blobs` to `^8.1.0` in `package.json` at the site root
  (not inside `netlify/functions/`)
- Explicitly setting `node_bundler = "esbuild"` in `netlify.toml`
- Using `getStore({ name, consistency: "strong" })` instead of the
  shorthand `getStore("name")`

If you ever bump the `@netlify/blobs` version, retest the shared sync
before relying on it — that version jump is what broke this originally.

## How the password gate works

- `netlify/functions/login.mjs` checks the password you type against an
  environment variable called `SITE_PASSWORD`. If it matches, it sets a
  signed, HttpOnly cookie.
- Every page runs `auth-check.js` on load, which asks the server "is this
  visitor's cookie valid?" — if not, it redirects to `login.html`.
- The cookie lasts 7 days, then you'll need to sign in again. "Log out" in
  the nav clears it immediately.

This is one shared password for anyone you give the link to — not
individual logins per person.

## Deploy to Netlify

**Recommended — Netlify CLI:**
1. Install once: `npm install -g netlify-cli`
2. From this folder: `netlify deploy --prod`
3. Set the environment variables (above), then redeploy

**Also works — drag and drop:**
1. Go to https://app.netlify.com/drop
2. Drag this whole folder onto the page
3. Add environment variables in Site settings, then trigger a redeploy

**Also works — GitHub-connected:**
1. Push this folder's contents to a GitHub repo
2. Netlify → Add new project → Import an existing project → pick the repo
3. Build command: blank. Publish directory: repo root.
4. Add environment variables, deploy.

## Notes

- No database, no third-party storage service, no tokens required — just
  the two password-related environment variables above.
- If `auth-check.js` can't reach `/api/check-auth` (e.g. you open a page by
  double-clicking it on your computer instead of via the live Netlify URL),
  it logs a warning to the console instead of blocking you — the password
  gate only actually works once this is deployed.
