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

Two counting rules, both of which the original spec got wrong:

**Count distinct orders, not rows.** These searches return one row per
fulfillment status per order. A partially shipped order therefore produces
two rows — one "Fulfilled", one "Unfulfilled" — and counting rows puts that
single order in both the fulfilled and the unfulfilled bucket. On the
21 Aug 2026 files this inflated the total by 215 orders.

**Key on Internal ID, not PO/Check Number.** Replacement orders inherit the
original order's Shopify number, so PO/Check Number is not unique. It
undercounted sales orders by 14.

Hence three states rather than two. An order is Fully shipped only if every
row says Fulfilled, Not started only if every row says Unfulfilled, and
Partial if it has both. The three always sum to the order count — the tab
shows a red warning if they ever don't, rather than displaying wrong numbers
silently.

Baseline from the 21 Aug 2026 exports:

| | Total | Fully shipped | Partial | Not started |
|---|---|---|---|---|
| 810 Texas DC | 21,693 | 11,589 | 215 | 9,889 |
| Sales orders | 19,962 | 11,589 | 7 | 8,366 |
| Transfer orders | 1,731 | 0 | 208 | 1,523 |

Note that zero transfer orders are completely fulfilled — all 208 with any
fulfillment are partial. Worth investigating separately from this dashboard.

Column detection is by header name, never column letter, since the saved
search column order can change. The tab shows which column it keyed on so a
wrong guess is visible.

### Sections on the tab

**Where the warehouse is** — orders grouped by the day they were *placed*,
green for fully shipped, red for still open. The headline date is the most
recent order date that is at least 90% shipped; past that point the backlog
starts. Orders dated in the future (pre-orders, backorders) are excluded from
the chart and reported underneath as a count.

**By channel** — sales orders read channel from `Order Type`, transfer orders
from `Channel`. Each order counted once, so the "All channels" row always
matches the card above it.

**Fulfilled per day** — orders counted on the day they *finished* shipping,
from `Date Fulfilled`. Where an order shipped across several days, the latest
date wins. Last 21 days shown.

The upload panel is collapsed by default so the tab reads as a dashboard.
Click "Update these numbers" to open it.

**Overlap worth resolving:** the Integration Health scorecard still carries a
fulfillment widget built on search 4854, which defines "fulfillable" more
loosely (any status except Closed and Pending Approval). It will report a
different shipped count than this tab. Decide which one is authoritative.

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
