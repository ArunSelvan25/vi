# Feature list

## Portfolio

- **Properties** — address, type (apartment / villa / commercial / land / PG …),
  owner, purchase date and price, current value, status.
- **Units** — per-property units with floor, bed/bath count, area, furnishing,
  market rent, deposit and amenities.
- **Occupancy is derived, not typed.** A unit flips between Vacant and Occupied
  from its active lease automatically; only "Under Maintenance" is manual.
- **Property dashboard** — units grid showing who occupies what, lifetime
  collected vs. spent, outstanding balance and net position.

## Tenants

- Full contact record: **phone (required)**, alternate phone, **email
  (optional)**, occupation, government ID type and number, emergency contact.
- A tenant with no email is perfectly valid — they just receive no email
  reminders, and show up in the arrears list to chase directly.
- Lifecycle status: Prospect → Active → Past.
- **Tenant ledger** — every lease, every invoice, every payment, plus the
  outstanding balance, on one page.
- Click-to-call and click-to-email links.

## Leases

- Unit ↔ tenant agreement with start and end dates, rent, deposit and deposit
  status (Held / Partially Refunded / Refunded).
- Billing frequency: **Monthly, Quarterly, Half-Yearly or Yearly**.
- **Grace days** — how long after a period starts before the invoice is due.
- **Part periods are pro-rated by day.** A lease ending on the 10th of a month
  is charged 10/31 of the rent, not a full month — and the invoice line says so.
- **Late fees** — set one on the lease and it is added, once, as a line item
  when an invoice on that lease goes overdue.
- **Annual escalation %** — rent compounds automatically on each lease
  anniversary, so a 3-year lease at 5% bills correctly without you touching it.
- Status maintained automatically from the dates: Upcoming → Active → Expired,
  plus manual Terminated. It updates the moment a lease is saved, not on the
  next page load.
- **A unit cannot be let twice.** An overlapping lease on a unit that is already
  let is refused, naming the lease in the way.
- A lease that ends before it starts is refused.
- Expiring-lease alerts on the dashboard, with a configurable window.

## Rent & billing

- **One-click invoice generation.** Raises every missing rent invoice for every
  active lease up to today. **Idempotent** — a period that already has an
  invoice is never billed twice, so it is safe to run daily on a trigger.
- Correct period maths: month-end leases don't drift (a lease starting on the
  31st bills on the 31st, not the 28th, after February), lease end dates clip
  the final period, quarterly periods charge 3× the monthly rent.
- **Line items** — one invoice carries any mix of charges: rent, electricity
  (EB), water, gas, internet, parking, maintenance, late fees. Add rows as you
  go, each with a description, category, quantity and unit amount, and the total
  adds itself up live. Metered charges work naturally: `142 units × ₹8.50`.
- The invoice header total is always the sum of its lines — it is never typed,
  so it cannot disagree with the detail.
- Editing an invoice re-prices it; removed lines are deleted, and payments
  already recorded against it are preserved.
- Every line carries a category, so you can pivot the `InvoiceItems` tab in
  Sheets to see total electricity or water billed per month.
- **Payments** with method (Cash / Bank Transfer / UPI / Card / Cheque),
  reference number, date and who received it.
- **Part payments handled properly** — paid, balance and status (Unpaid →
  Partial → Paid) are recomputed on the server from the payment records, so the
  numbers can't drift out of sync.
- Overdue detection runs on every load.
- **A payment covering several months is spread automatically** across that
  tenant's outstanding invoices, oldest due first. More than the tenant owes in
  total is refused, so no balance can ever go negative and understate arrears.
- **Refunding a deposit records the expense**, so the money leaving the business
  appears in the P&L rather than the liability simply vanishing.
- **"Deposits held" means money actually received** — an unpaid deposit shows as
  outstanding, not as a liability you are holding.
- **Deleting a payment puts the invoice back**, restoring its balance and status.
- **Records other rows depend on cannot be deleted.** Deleting a tenant with a
  lease, a unit with a lease, or an invoice with a payment against it is refused
  with a message naming what is in the way. Deleting an invoice does remove its
  own line items, since they are part of it.
- **Printable invoice / receipt** — opens in the app, prints to paper or PDF via
  the browser, showing the payment history.
- **Automated rent reminders by email** — a friendly note before the due date, a
  firmer one after, sent from your own Gmail via a daily trigger.

## Maintenance

- Tickets against a property and optionally a specific unit and tenant.
- Category, priority (Low → Urgent), status (Open → In Progress → On Hold →
  Resolved → Closed).
- Reported / scheduled / completed dates, vendor name and phone, and cost.
- **A completed ticket's cost is booked as an expense**, linked back to the
  ticket. Costs therefore live in exactly one place and cannot be counted twice
  in the P&L. Correcting the cost updates that expense; reopening or deleting
  the ticket withdraws it.
- Priority-sorted queue on the dashboard.

## Money out

- **Expenses** by property and unit: repairs, utilities, property tax,
  insurance, management fees, mortgage, cleaning, security, legal.
- Vendor, payment method, reference and a link to the receipt file.

## Documents

- Register lease agreements, ID proofs, insurance, tax receipts, inspections and
  NOCs, each linked to a property, unit, tenant or lease.
- Stores a **link** (Google Drive works well) rather than the file, so you stay
  inside the free tier.
- **Expiry tracking** — anything lapsing within 60 days surfaces on the dashboard.

## Dashboard

- Six live KPIs: monthly rent roll, collected this month, outstanding (with
  overdue split out), occupancy rate, open tickets, deposits held.
- 6-month cash-flow chart, income against expenses.
- Occupancy donut.
- Rent arrears ranked by size, with the oldest debt flagged.
- Leases expiring, maintenance queue, documents expiring, vacant units.
- Every card is clickable through to the underlying records.

## Reports

- Date range and per-property filters.
- Income, operating expenses, **net operating income**, amount billed and
  **collection rate**.
- 12-month cash-flow chart and expenses broken down by category.
- **Profit & loss by property** — units, occupancy, income, expenses, net,
  outstanding and **gross yield** against current value, with totals.
- **Arrears ageing** — not yet due / 1–30 / 31–60 / 61–90 / 90+ days.
- Top debtors.
- CSV export of the P&L, and of any table in the app.

## Platform

- **Sign in with a phone number**, not an email. Numbers are matched on digits
  so the country code and any spacing or punctuation are optional. Email on a
  user account is optional contact detail.
- **Roles enforced server-side**: `viewer` (read only), `manager` (day-to-day
  edits, billing, payments), `admin` (everything, including deletes, users and
  settings).
- Salted-hash passwords, HMAC-signed sessions with a configurable lifetime.
- **Account administration** — add users, reset a forgotten password, change a
  role, disable someone who has left. Role changes and disabling take effect
  **immediately**, on sessions that are already open.
- **The workspace cannot lock itself out** — the last active administrator
  cannot be deleted, demoted or disabled.
- **Audit log** — every create, update, delete, payment, password reset and
  failed sign-in, with who and when.
- Every table: full-text search, column sort, faceted filters, paging, CSV export.
- Light and dark themes; works on phones and tablets.
- **Installs as an app** — add it to a phone's home screen and it runs full
  screen with its own icon, opens instantly from an on-device cache, and starts
  even with no network. Only the interface is cached: no records and no session
  token are ever written to the device, because every API call is a
  cross-origin POST that the service worker ignores. Releases are picked up
  automatically and applied only when you accept the prompt.
- Configurable currency, symbol, locale, organisation name and invoice prefix.
- Keyboard-friendly: `Esc` closes any dialog.
- **Your data stays yours** — it is a normal Google Sheet you can open, filter,
  chart or export at any time. Nothing is locked in.

## Known gaps

Honest about what the current features do *not* do:

- **`billing_day` is not honoured.** Rent bills from the lease start date, so a
  lease starting on the 5th bills on the 5th (part periods are pro-rated). The
  field is hidden from the form rather than left as an input that does nothing.
- **A sold property's history stays in the reports** while dropping out of the
  dashboard headline figures. That is deliberate: past income and costs remain
  true.

## Deliberately not included

Being straight about the boundaries of a free, static + Sheets stack:

- **No tenant-facing portal or online rent collection.** There's no payment
  gateway; you record payments that happened elsewhere.
- **No file uploads.** Documents are links, because Sheets is not a file store.
- **No real-time multi-user sync.** Two people editing the same record in the
  same minute can overwrite each other; the audit log will show it.
- **Not built for thousands of units.** The whole workbook loads into the
  browser. It's comfortable into the low thousands of rows and slows after that.
- **Not a substitute for accounting software** at tax time — export the CSVs.
