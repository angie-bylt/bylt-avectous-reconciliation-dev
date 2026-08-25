# BYLT NetSuite–Avectous Reconciliation Site

Pages, one password gate:
- login.html              -> Sign in (password gate for the whole site)
- index.html              -> Order Status, 810 Texas DC — landing page / first tab
- integrations.html       -> Integrations Status (NetSuite <-> Avectous queue audit)
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

## Integrations Status tab

Audits the two order queues between NetSuite and Avectous. Four files: the two
NetSuite searches already used on Order Status, plus both Avectous exports.
Avectous names both of its files `Orders(number).xlsx` — they are different
reports, distinguished by their columns (`Status` on the order download,
`LastShipDate` on shipments).

### Direction is different for the two halves

**Order sync runs NetSuite -> Avectous.** NetSuite creates the order and the
queue pushes it out, so the test is: of the orders NetSuite holds, how many
reached Avectous?

**Fulfillment sync runs Avectous -> NetSuite.** The warehouse physically ships,
then confirms back, so the test is the reverse: of the orders Avectous shipped,
how many did NetSuite record?

Getting this backwards is the trap. Scoping the fulfillment check to orders
NetSuite already fulfilled and asking whether Avectous agrees reads 99.78% —
and is meaningless, because an order NetSuite never fulfilled cannot appear in
that sample. Every real failure is excluded by construction. Read the correct
way round the same data gives 78.73%.

Baseline from the 21 Aug 2026 exports:

| Queue | Direction | Expected | Arrived | Missing | Health |
|---|---|---|---|---|---|
| Sales order sync | NS -> AV | 20,092 | 19,829 | 263 | 98.69% |
| Transfer order sync | NS -> AV | 1,731 | 1,727 | 4 | 99.77% |
| Sales order fulfillments | AV -> NS | 14,696 | 11,570 | 3,126 | 78.73% |
| Transfer order fulfillments | AV -> NS | 409 | 204 | 205 | 49.88% |

Outbound order sync is healthy. Ship confirmations coming back are not. Of the
3,126 missing sales-order fulfillments, only 59 shipped on the latest Avectous
day — 3,067 shipped earlier and have had far longer than the 15-minute queue
interval. All sit at Pending Fulfillment in NetSuite with WMS Status also
Pending Fulfillment, so NetSuite has no idea the warehouse touched them.
Verified against `#55635919`, which has no Item Fulfillment in NetSuite.

### Fulfilled in NetSuite, no Avectous shipment

The mirror of the main failure: NetSuite has an Item Fulfillment but the
Avectous shipments report has no record of the order at all. Either it was
fulfilled by hand in NetSuite without the warehouse shipping, or Avectous
shipped it and lost the record.

Reported as its own line on each fulfillment card and its own export sheet,
never inside queue health — the denominator there is what Avectous shipped, so
an order Avectous has no record of cannot belong in it.

On the 21 Aug data: 18 sales orders and 4 transfer orders. Most are `Billed`,
so they have already been invoiced, and several still carry
`WMS Status = Pending Fulfillment`, meaning NetSuite created a fulfillment the
warehouse never confirmed. These need chasing from the NetSuite end.

### Cancelled orders are excluded everywhere

An order counts as cancelled when its `WMS Status` is Pending Cancellation,
Cancellation Confirmed or Cancellation Failed, or when its NetSuite `Status` is
Closed. CX is actively trying to stop these, so counting them as warehouse
backlog blames the warehouse for orders nobody wants shipped, and counting them
as missing from Avectous flags a queue fault where none exists.

Excluded from every percentage on both tabs, and from the source-file tiles at
the top of Integrations Status too — otherwise the tile disagrees with the
"Orders in NetSuite" line on the card directly beneath it. Always reported as a
visible count, and listed in full on the Cancelled Excluded sheet of the export.

### Matching and exclusions

Sales orders match on `PO/Check Number`, transfer orders on `Document Number`,
both against Avectous `OrderNumber`. Avectous mixes both order types into one
export, so each NetSuite search is matched against the whole file rather than
trusting `OrderType`.

Orders present only in Avectous are listed separately and never included in a
health percentage. Two different things end up here and the tab separates them:

- **Avectous test orders** — the order number contains TEST (`SHPYTEST31`,
  `GOLIVETEST36`). These should not exist in a production warehouse. 14 on the
  21 Aug data, including a leftover from go-live testing.
- **Created after the NetSuite pull** — real orders Avectous is working
  correctly; the NetSuite snapshot is simply older. 182 on the same data,
  mostly Shopify orders numbered above anything in the NetSuite export.

Lumping them together hides test pollution behind a timing artefact, which is
why the export carries a Kind column.

### The export

**Export comparison** builds a workbook for two audiences: a Summary sheet for
Chris, a Method sheet explaining the direction logic, and five detail sheets
with one row per problem order, filterable, for sending to Avectous.

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
