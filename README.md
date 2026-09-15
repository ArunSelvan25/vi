# Property & Tenancy Manager

A complete property management application that runs on **GitHub Pages for free**
and uses a **Google Sheet as its database**.

No build step, no server bill, no vendor lock-in — your data stays in a
spreadsheet you can open, filter and export at any time.

![dashboard](docs/screenshot-dashboard.png)

---

## How it works

```
GitHub Pages                Google Apps Script            Google Sheet
┌───────────────────┐       ┌────────────────────┐        ┌──────────────┐
│  static SPA       │──────►│  Web App API       │───────►│  13 tabs     │
│  vanilla ES       │ HTTPS │  auth, billing,    │        │  = your DB   │
│  modules, no deps │◄──────│  reminders, cron   │◄───────│              │
└───────────────────┘       └────────────────────┘        └──────────────┘
        free                        free                       free
```

GitHub Pages can only serve static files, so a browser there can't safely hold a
Google service-account key. Apps Script solves that: it runs **as you**, already
has permission to your sheet, and gives you a free HTTPS endpoint plus cron
triggers and email — which is also how rent reminders get sent.

## What it does

Properties · units · tenants · leases · rent invoicing · payments · maintenance
tickets · expenses · documents · dashboard · reports.

Some things worth calling out:

- **Idempotent rent generation** — one click raises every missing invoice for
  every active lease; periods already billed are skipped, so it's safe on a
  daily trigger.
- **Accounting that holds up** — deposits are held money, not income; issued
  invoices are voided, never deleted, and their numbers never reused; GST with
  CGST/SGST/IGST and printed tax invoices.
- **Move-out and renewal** — settle a deposit against arrears and deductions in
  one step; renew a lease with the escalated rent and the deposit carried over.
- **Tenant-friendly** — statements, receipts, WhatsApp sharing and UPI payment
  links; reminders on a schedule, one email per tenant.
- **Billing maths that holds up** — quarterly/half-yearly/annual cycles, grace
  days, compounding annual escalation, month-end leases that don't drift to the
  28th after February, and lease end dates that clip the final period.
- **Derived state, server-side** — occupancy, invoice balances and overdue flags
  are computed from the records, so they can't fall out of sync.
- **Automated rent reminders** by email, before and after the due date.
- **Reports** — per-property P&L with gross yield, arrears ageing, collection
  rate, CSV export.
- **Roles enforced on the server** — viewer / manager / admin, with login
  throttling, no account enumeration, and a setup path that cannot be hijacked.
  See [docs/SETUP.md](docs/SETUP.md#security-honestly) and `npm run test:security`.
- **Designed, not just assembled** — a real token system, grouped navigation,
  semantic colour used only for meaning, keyboard focus rings, skeleton loading,
  and a responsive layout that works down to a phone.

Full list: **[docs/FEATURES.md](docs/FEATURES.md)** (including an honest section
on what this stack deliberately does *not* do).

## Setup

**→ [docs/SETUP.md](docs/SETUP.md)** — about 15 minutes.

The short version:

1. Create a blank Google Sheet.
2. **Extensions → Apps Script**, paste [`apps-script/Code.gs`](apps-script/Code.gs).
3. **Deploy → New deployment → Web app**, execute as **Me**, access **Anyone**. Copy the `/exec` URL.
4. Push this repo and turn on GitHub Pages.
5. Open the site, paste the URL, create your admin account. Done.

## Repository layout

```
index.html               entry point — loads assets/js/app.js as a module
manifest.webmanifest     installable-app metadata (name, icons, colours)
sw.js                    service worker — offline shell, cache per build
assets/
  css/styles.css         design system — 4px spacing scale, type scale,
                         brand accent (#21420d), light + dark themes
  icons/                 app icons, including a maskable one for Android
  js/
    app.js               shell, routing, boot sequence
    pwa.js               worker registration and the update prompt
    schema.js            ⭐ every entity definition — drives forms, tables, filters
    store.js             client-side cache of the workbook, joins and derived views
    api.js               Apps Script transport (text/plain POST, no CORS preflight)
    ui.js                DOM helpers, formatters, modals, toasts
    router.js            hash router
    components/          form builder · data table · SVG charts
    views/               one module per screen
apps-script/Code.gs      the entire backend
test/                    backend logic tests + browser smoke tests
docs/                    setup, feature list, sheet schema
```

**To use it on several devices without pasting the URL each time**, either set
`DEFAULT_API_URL` in [`assets/js/config.js`](assets/js/config.js), or add a
`VIPM_API_URL` repository secret and let the deploy workflow inject it. Either
way the URL ends up readable in the published page — see
[docs/SETUP.md](docs/SETUP.md#using-the-app-on-several-devices).

**To install it on a phone**, open the published site and use **Add to Home
Screen** (iOS Safari: Share → Add to Home Screen; Android Chrome: menu → Install
app, or the install prompt). It then launches full-screen with its own icon, and
opens instantly because the interface is cached on the device — see
[docs/SETUP.md](docs/SETUP.md#install-it-on-a-phone).

**To restyle**, change the `--brand` tokens at the top of
[`assets/css/styles.css`](assets/css/styles.css). Light and dark each need
`--brand`, `--brand-hover`, `--brand-weak` and `--brand-ring`; a test asserts the
result still clears WCAG AA contrast in both themes.

**To add a field anywhere**, edit two places: the tab's `SCHEMA` in `Code.gs`,
and the entity's `fields` array in `assets/js/schema.js`. Forms, table columns,
filters, validation and CSV export all follow automatically.

## Development

```bash
npm install          # puppeteer-core, for the tests only
npm run dev          # serves the app + a mock API on a free port
npm test             # billing maths, then security, then a browser run
```

`npm run dev` runs the **real** `apps-script/Code.gs` on an in-memory spreadsheet
with sample data dated around today, so every business rule applies exactly as
it will on Google — without touching a real sheet. Sign in with phone
`9000012345` / password `password123`.

The suite has these parts:

- **`test:backend`** — billing maths against the real `Code.gs`: period
  generation, month-end handling, escalation, quarterly cycles.
- **`test:security`** — runs `Code.gs` against an in-memory spreadsheet and
  attacks it: setup takeover, brute force, account enumeration, forged and
  expired tokens, role escalation, hash leakage.
- **`test:ui`** — drives the real interface in headless Chrome through login,
  every view, search/sort/filter, record creation, validation, payment
  recording, the printable invoice, reports, contrast and the responsive layout.
- **`test:responsive`** — every screen at 320–768px, plus the dialogs, detail
  screens, empty states, the drawer and dark theme. It enforces one rule: a
  table may scroll sideways inside its own box, the page never may.
- **`test:pwa`** / **`test:pwa:ui`** — the installable-app wiring, and then a
  real browser proving it installs, opens with the network cut, takes an
  update, and never puts an API response in the cache.

## Locked out?

Spreadsheet menu → **Property Manager → Recover admin access**. It runs as the
sheet owner, so it can do what the public endpoint must not: set a phone number
and password for an administrator and clear any lockout. See
[docs/SETUP.md](docs/SETUP.md#locked-out-recover-from-the-spreadsheet).

## Limitations

Google Sheets is a genuinely good database for a portfolio of this size and a
genuinely bad one at scale. The whole workbook loads into the browser: fine into
the low thousands of rows, slow beyond. There is no tenant portal, no payment
gateway and no file upload (documents are links). Two people editing the same
record cannot overwrite each other — the second save is refused — but screens
do not update live.

If you outgrow it, `store.js` and `api.js` are the only files that know where
data comes from — swapping in a real API is a contained change.

## Licence

MIT — use it however you like.
