# BYLT NetSuite–Avectous Reconciliation Site

Pages, one password gate:
- login.html              -> Sign in (password gate for the whole site)
- index.html              -> Order Status, 810 Texas DC — landing page / first tab
- integrations.html       -> Integrations Status - Orders (NetSuite <-> Avectous queue audit)
- integration-health.html -> Integrations Status - Receiving, Inventory & VESYL Audits
- load-data.html          -> Load Data (upload NetSuite + Avectous CSVs or XLSX, compare)
- totals.html             -> removed; redirects to index.html for old bookmarks
- dashboard.html          -> redirects to index.html for old bookmarks

## Order Status tab

Three uploads: NetSuite sales orders (4866), NetSuite transfer orders (4867),
and Avectous Shipment Details.

**Two questions per order, and only two.** Did it ship, and when was it created.

An order counts as **shipped** if it appears in the Avectous shipment file OR has
a fulfillment in NetSuite. Either one is enough. Avectous is the source of truth
for goods leaving the building; NetSuite's fulfillment is the accounting record
and can lag by days, so counting only NetSuite understates reality.

Ship date is Avectous `RecordDate` where available, falling back to NetSuite
`Date Fulfilled`. RecordDate is when the warehouse shipped; Date Fulfilled is
when NetSuite found out.

**What this tab deliberately does not do** is judge whether an order *should*
have shipped. Holds, cancellation states, backorder flags and payment blocks
answer "why hasn't this shipped" — a different question, and one that belongs on
Integrations Status. An earlier version bucketed orders into ready/held/cancelled
and it made the five numbers people actually asked for harder to find.

### The five metrics

1. **Total, shipped, not shipped** with percentages, combined and per order type.
2. **How far behind** — orders grouped by creation date. The most recent day at
   90%+ shipped is the last day cleared; the gap from there to today is the lag.
   Days under 50 orders are skipped so a quiet day can't set the line.
3. **By channel** — sales orders read `Order Source`, transfer orders read
   `Channel`. The All channels row always matches the card above.
4. **Shipped per day** — counted on the day Avectous shipped.

Baseline from the 27 Aug files: 32,167 orders, 24,232 shipped (75.3%). Sales
orders 78.8% shipped and 4 days behind; transfer orders 20.5% shipped and 17 days
behind.

### Counting rules

Orders are grouped by `Internal ID`, so an order with several rows counts once.
Matching to Avectous uses `PO/Check Number` for sales orders and
`Document Number` for transfer orders, because those are what Avectous stores.

All three files must be pulled at the same time. Pull NetSuite at 9am and
Avectous at 11am and anything shipped in between looks unshipped.

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

Orders present only in Avectous are excluded from every health percentage and no
longer shown on the tab — they were noise once the Avectous export started
covering a wider window than the NetSuite searches. They remain on the
"In Avectous Only" sheet of the export, split by Kind:

- **Avectous test orders** — the order number contains TEST (`SHPYTEST31`,
  `GOLIVETEST36`). These should not exist in a production warehouse. 14 on the
  21 Aug data, including a leftover from go-live testing.
- **Created after the NetSuite pull** — real orders Avectous is working
  correctly; the NetSuite snapshot is simply older. 182 on the same data,
  mostly Shopify orders numbered above anything in the NetSuite export.

Lumping them together hides test pollution behind a timing artefact, which is
why the export carries a Kind column.

### Where Avectous has the orders

A section below the four audit cards showing Avectous's own status for every
order that reached it: Shipped, Waved, New, Cancelled. The cards ask whether the
handoff worked; this asks where the orders actually are.

Totals match "Reached Avectous" on the cards — orders NetSuite has cancelled are
excluded from both, so the two never disagree.

**"Waved" is unconfirmed.** It's Avectous's term and may mean actively being
picked, or simply assigned to a wave that hasn't started. The data says only that
it's a pre-shipment state further along than New: 6 of 7,406 Waved orders appear
in the shipments file, and New orders are all under 7 days old while Waved
stretches to 25. Worth confirming with Avectous, since the two readings point in
opposite directions. Labelled "Queued, not yet shipped" until then.

Any status value Avectous starts using that isn't one of the four appears as its
own red row rather than being dropped.

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


## Receiving, Inventory & VESYL Audits tab

Formerly the Integration Health tab, and formerly `index.html`. Now covers four
areas only: Inbound TOs, Inbound Shipments, Inventory Discrepancies, and the
VESYL Shipments Audit.

Removed from this tab because they moved to Order Status and Integrations
Status: Sales Orders, Outbound Transfer Orders, SO Fulfillments, Outbound TO
Fulfillments, and the Fulfillment & Audit Overview bar at the top. Shopify
Fulfillments was dropped outright; Shopify eCommerce Orders from Celigo is
parked until it gets its own tab.

These are filtered out at render time via `HEALTH_SECTION_IDS`, not deleted from
`SECTIONS` — Load Data and Totals still drive off the full list, so nothing
became unloadable. The overview bar is still built and simply not inserted, so
restoring it is one commented line in `renderScorecard`.


## A bug worth remembering

The Integrations tab once read ship dates from `LastShipDate` only. When Order
Status moved to the Shipment Details report (`RecordDate`), Integrations was not
updated — so no column matched, every ship date came back blank, and the blank
date then broke the export builder partway through. The workbook silently
produced 3 sheets instead of 9.

Two lessons baked in since: the date column list accepts both names, and if no
date column is found at all the tab shows a red warning rather than a column of
blanks. A missing date now reports as Age "Unknown" instead of being labelled
"Overdue", which was a guess dressed up as a fact.


## If an export comes back with missing sheets

`integrations-export.js` is a separate file from the HTML, so a browser can serve
a stale copy of it while the page itself is current. That produced a 3-sheet
workbook with no Summary sheet, which looked like the export had truncated.

Two guards now:

- The script is loaded as `integrations-export.js?v=2`, so bumping that number
  forces browsers to refetch it after any change to the file.
- The Summary sheet ends with an "Export built ... workbook version 2" line. If
  that line is missing from a workbook, the browser was running an old copy of
  the script — hard-refresh the page.

Each sheet is also built inside its own try/catch. A sheet that fails now leaves
a placeholder and a "Build Problems" sheet listing what went wrong, rather than
silently costing you every sheet after it.
