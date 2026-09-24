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
- **Grace days** — on a lease with a rent day, the days after an invoice's due
  date before the late fee is added.
- **Late fees** — set one on the lease and it is added, once, as a line item
  when an invoice on that lease goes overdue.
- **Annual escalation %** — rent compounds on each lease anniversary. The rent
  roll, property, tenant and lease pages show the rent in force today and the
  next increase, so you know what to bill.
- **Renew a lease** from the lease list, a tenant's page, or by clicking it in
  the dashboard's *Leases expiring* list: it starts the day after, suggests this
  year's escalated rent, and carries the deposit over so it is counted once.
- Status maintained automatically from the dates: Upcoming → Active → Expired,
  plus manual Terminated. It updates the moment a lease is saved, not on the
  next page load.
- **A unit cannot be let twice.** An overlapping lease on a unit that is already
  let is refused, naming the lease in the way.
- A lease that ends before it starts is refused.
- **More than one person per lease.** Each lease has one **primary tenant** —
  the person rent is billed to — and any number of others living in the unit:
  two friends sharing a room, a couple, a family. Each is a tenant record of
  their own (phone, ID proof, emergency contact), added to the lease as a
  *Co-tenant* (signed the agreement) or an *Occupant* (lives there, not a party
  to it), with how they relate to the primary tenant and when they moved in or
  out. They are added straight from the lease form — including someone not yet
  on record, through *New person* — or from *Manage* on the lease page.
- **Change the primary tenant** from the lease page: an occupant becomes the
  person billed and the previous primary stays on as a co-tenant. Invoices
  already raised stay with whoever they were billed to; settling the deposit
  still clears them.
- A co-tenant's own page says whose lease they live on and who pays; lists and
  unit cards show *Anita Rao +1*, and searching for any occupant's name finds
  the lease. Renewing a lease keeps everyone still living there, and a person
  who is on someone's lease cannot be deleted.
- Expiring-lease alerts on the dashboard, with a configurable window.

## Rent & billing

- **Rent is invoiced by hand.** Each month, raise a rent invoice for each lease
  from the Billing page, with its period, due date and a Rent line. Nothing is
  generated automatically.
- **Rent day** — a monthly lease can have a fixed payment day each month
  (1st–28th, or the last day). Grace days count after an invoice's due date,
  before the late fee: due the 10th with 5 days' grace, the fee is added from
  the 16th while the invoice still shows the 10th.
- **Line items** — one invoice carries any mix of charges: rent, electricity
  (EB), water, gas, internet, parking, maintenance, late fees. Add rows as you
  go, each with a description, category, quantity and unit amount, and the total
  adds itself up live. Metered charges work naturally: an EB bill is a line
  with category Electricity, e.g. `EB bill · 142 units` at `142 × ₹8.50`.
- The invoice header total is always the sum of its lines — it is never typed,
  so it cannot disagree with the detail.
- Editing an invoice re-prices it; removed lines are deleted, and payments
  already recorded against it are preserved.
- Every line carries a category (Rent, Electricity, Water …), so electricity
  or water billed per month can be totalled from the lines.
- **Payments** with method (Cash / Bank Transfer / UPI / Card / Cheque),
  reference number, date and who received it.
- **Part payments handled properly** — paid, balance and status (Unpaid →
  Partial → Paid) are recomputed on the server from the payment records, so the
  numbers can't drift out of sync.
- Overdue detection, late fees and lease expiry run once a day — on the daily
  scheduled job, and on the first load of the day as a safety net.
- **A payment covering several months is spread automatically** across that
  tenant's outstanding invoices, oldest due first. More than the tenant owes in
  total is refused, so no balance can ever go negative and understate arrears.
- **Deposits are held money, not income.** Receiving a deposit does not count as
  collected rent, and returning one is not an operating expense; the dashboard's
  *Deposits held* is what is still owed back to tenants, worked out from the
  records.
- **Settle a deposit at move-out** in one step: apply it to the tenant's unpaid
  invoices (and anything still owed on that lease), charge deductions (repainting, damage) on a *Deposit Deduction*
  invoice paid from the deposit, refund the rest, and optionally end the lease.
  What is kept becomes income through the invoices it pays; deductions larger
  than the deposit leave the tenant owing the difference.
- **Changing a deposit re-prices its invoice**, never below what has been paid.
- **Invoices are voided, not deleted.** An issued invoice keeps its number
  forever; *Void* needs a reason and leaves nothing owed. Only drafts can be
  deleted, and **an invoice number is never reused** — not even after the newest
  one is removed.
- **Drafts** — save an invoice as a draft, and issue it when ready. A draft is
  not owed and cannot take a payment.
- **GST** — a rate per invoice line and per lease; CGST + SGST within the state,
  IGST across states, from the property's state and your GSTIN. Registered
  businesses get a printed *Tax invoice*.
- **One Billing screen** holds invoices and the payments received against them,
  as two tabs. The figures across the top — outstanding, overdue, due in the
  next 7 days, collected this month — are also filters. A payment is always
  recorded from the invoice it pays; any excess settles the tenant's other
  unpaid invoices.
- **Printable receipts** for every payment, and **tenant statements** for any
  date range — opening balance, each charge and payment, running and closing
  balance, and the deposit position.
- **WhatsApp and UPI** — share an invoice, receipt, statement or balance on
  WhatsApp with the message written; *Pay via UPI* opens the tenant's UPI app
  with the amount filled in.
- **"Deposits held" means money actually received** — an unpaid deposit shows as
  outstanding, not as a liability you are holding.
- **Deleting a payment puts the invoice back**, restoring its balance and status.
- **Records other rows depend on cannot be deleted.** Deleting a tenant with a
  lease, a unit with a lease, or an invoice with a payment against it is refused
  with a message naming what is in the way. So is deleting a tenant with
  maintenance tickets or documents. Deleting a
  draft invoice removes its own line items, since they are part of it.
- **Printable invoice / receipt** — opens in the app, prints to paper or PDF via
  the browser, showing the payment history.
- **Rent reminders by email** are built — N days before, on the due date, and
  on chosen days overdue, one email per tenant — but not connected to an email
  provider yet, so none are sent. Share invoices over WhatsApp instead.

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

- Six live KPIs: monthly rent roll (with escalation), collected this month
  (compared with the same point last month), outstanding (with overdue split
  out), occupancy rate, open tickets, deposits held.
- 6-month cash-flow chart, income against expenses.
- Occupancy donut.
- Rent arrears ranked by size, with the oldest debt flagged.
- Leases expiring, maintenance queue, documents expiring, vacant units.
- Every card is clickable through to the underlying records.

## Search

- **One search box for every module**, in the top bar — or press `/` or
  Ctrl/⌘ K from anywhere. It finds tenants, properties, units, leases,
  invoices, payments, maintenance tickets, expenses and documents.
- Properties, units, tenants and leases match as you type: by name, phone
  (with or without spaces and country code), email, unit, city, ID, and anyone
  living on a lease. Every word must match, so *anita 101* finds Anita's lease
  on A-101.
- Invoices, payments, tickets, expenses and documents are searched on the
  server from two characters, the same way each list's own search box works —
  including by tenant, property or unit name.
- **Start with a module's name** to list that module: *lea* shows the leases,
  *invoice* the invoices, *tickets* the maintenance queue. Words after it search
  only that module — *lease anita*, *invoice overdue*, *ticket leak*.
- **Screens are found by name** too: *repo* offers Reports, *upi* Settings.
- Status, rent, dates, property and frequency are searchable as well, so
  *active*, *vacant* or *overdue* work.
- Up to five matches per module, with the total. *See all* opens that module's
  list already searched. Arrow keys move, Enter opens, Esc closes.

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
- The cash-flow chart and top debtors follow the date range and property filter;
  yield is annualised, so a nine-month range is not read as a full year.
- **Owner statements** — for each owner, per-property income, expenses, net,
  arrears and deposits held for the range, printable or as CSV.

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
  Invoices, payments, expenses, maintenance, documents and the audit log are
  paged by the server — searched, sorted and filtered there, a page at a time —
  so signing in stays quick however much history builds up. Dashboard, report
  and record-page figures are worked out on the server too.
- Light and dark themes; works on phones and tablets.
- **Installs as an app** — add it to a phone's home screen and it runs full
  screen with its own icon, opens instantly from an on-device cache, and starts
  even with no network. Only the interface is cached: no records and no session
  token are ever written to the device, because every API call is a
  cross-origin POST that the service worker ignores. Releases are picked up
  automatically and applied only when you accept the prompt.
- Configurable currency, symbol, locale, organisation name and invoice prefix.
- Keyboard-friendly: `Esc` closes any dialog.
- **Your data stays yours** — it is a standard Postgres database you can query,
  export (`supabase db dump`) or move at any time, and every list exports to CSV.

## Known gaps

Honest about what the current features do *not* do:

- **Rent invoices are not generated.** Each one is raised by hand, so the app
  does not warn about a month nobody billed. (The old `billing_day` column is not read.)
- **A sold property's history stays in the reports** while dropping out of the
  dashboard headline figures. That is deliberate: past income and costs remain
  true.
- **A late fee on an invoice raised already overdue** is added at the next
  day's housekeeping, not the moment it is saved.
- **No QR code** for UPI on printed invoices — the UPI ID and a *Pay via UPI*
  link are shown instead.

## Deliberately not included

Being straight about the boundaries of this stack:

- **No tenant-facing portal or online rent collection.** There's no payment
  gateway; you record payments that happened elsewhere.
- **No file uploads.** Documents are links to wherever the file lives.
- **No real-time multi-user sync.** Screens show data as of the last load or
  save. Two people editing the same record cannot overwrite each other — the
  second save is refused — but neither sees the other's change until they
  refresh.
- **Not built for thousands of units.** The whole portfolio loads into the
  browser. It's comfortable into the low thousands of records and slows after that.
- **Not a substitute for accounting software** at tax time — export the CSVs.
