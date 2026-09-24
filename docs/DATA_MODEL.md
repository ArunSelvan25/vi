# Data model

The tables live in Supabase Postgres. Their exact columns, types, foreign keys and
checks are defined by the files in [`supabase/migrations/`](../supabase/migrations/),
applied in order; that is the source of truth. This page explains what the tables
mean and the rules that keep them consistent.

| Table | Holds |
|---|---|
| `properties` | Buildings and plots |
| `units` | Flats, shops, rooms — each belongs to a property |
| `tenants` | People and businesses renting |
| `leases` | Who rents which unit, from when, at what rent |
| `lease_tenants` | Everyone else living on a lease besides its primary tenant |
| `invoices` | What is owed. Amounts, paid and balance are derived from the lines and payments |
| `invoice_items` | The lines of an invoice: rent, electricity (EB), water, late fee … |
| `payments` | Money received, always against an invoice |
| `maintenance` | Repair tickets |
| `expenses` | Money spent on a property |
| `documents` | Links to agreements, ID proofs, certificates |
| `app_users` | Who can sign in, and their role |
| `settings` | Organisation settings (below) |
| `activity_log` | Append-only audit trail |

The app refers to tables by their own names (`Properties`, `InvoiceItems`, …);
[`supabase/functions/api/schema.js`](../supabase/functions/api/schema.js) maps them
to the tables above and converts every value on the way in and out.

**IDs** are human-readable and sequential: `PRP-00001`, `UNT-00003`, `INV-00027`.
A number is never issued twice: the highest ever used is kept in `id_counters`, so
deleting the newest record does not free its number. **Dates** are `yyyy-MM-dd`,
and "today" is measured in the `APP_TIMEZONE` of the API.

## Leases

- `frequency` — Monthly · Quarterly · Half-Yearly · Yearly. `rent_amount` is
  always the monthly rent.
- `rent_day` — for a monthly lease, the payment day each month: 1–28, or 31 for
  the last day of the month. `billing_day` is an older, unused column and is not read.
- `grace_days` — with a rent day, the days after an invoice's due date before the
  late fee is added.
- `gst_rate` — GST % added to rent invoices and late fees on this lease.
- `renewed_from` — the lease this one renews.
- `deposit_status` — Pending · Held · Partially Refunded · Refunded · Forfeited ·
  Transferred. The last four are written by *Settle deposit* and *Renew*, which
  book the money that goes with them.

## Lease tenants

A lease's `tenant_id` is its **primary tenant**: the person billed, named on its
invoices, statements and deposit. Everyone else living in the unit is a row in
`lease_tenants`, pointing at their own `tenants` record.

- `role` — `Co-tenant` (signed the agreement and shares responsibility) ·
  `Occupant` (lives there, not a party to it).
- `relationship` — free text: Friend, Spouse, Roommate …
- `move_in_date` / `move_out_date` — when they joined or left, if different
  from the lease; a blank move-out means still living there.
- A person is on a lease at most once, and never as both its primary tenant
  and an occupant. Nothing here is billed.
- Deleting a lease removes its occupant rows; a tenant still listed on a lease
  cannot be deleted.

## Users

- **`phone` is the sign-in credential** and must be unique. It is compared on
  digits only, keeping the last 10, so `+91 98800 11111`, `098800 11111` and
  `9880011111` are the same account.
- `email` is **optional** — a contact detail, never used to sign in.
- `role` — `admin` | `manager` | `viewer`.
- `active` — false disables an account without deleting it.
- `password_hash` — PBKDF2-SHA256 (`v3$…`). Accounts from the earlier backend may
  still carry an older `v2$…` hash; it is verified as before and upgraded on that
  account's next sign-in.

## Settings

One row per setting, changed from the app's **Settings** page.

| key | default | meaning |
|---|---|---|
| `org_name` | VI Properties | shown in the sidebar and on invoices |
| `currency` / `currency_symbol` | INR / ₹ | money formatting |
| `locale` | en-IN | number grouping (`en-IN` gives 1,00,000) |
| `date_format` | dd MMM yyyy | how dates are shown |
| `invoice_prefix` | INV | invoice id prefix |
| `default_grace_days` | 5 | suggested on new leases |
| `default_late_fee` | 0 | suggested on new leases |
| `lease_expiry_alert_days` | 45 | dashboard warning window |
| `session_hours` | 12 | how long a sign-in lasts |
| `reminder_days_before` / `reminder_overdue_days` / `reminder_enabled` | 3 / 1,7,14,30 / false | the email reminder schedule — inactive until email is set up |
| `gstin` | — | your GSTIN; turns GST invoices into tax invoices |
| `sac_code` | 997212 | printed on tax invoices |
| `default_gst_rate` | 0 | pre-filled on new invoice lines |
| `upi_id` | — | shown on invoices, with a UPI payment link |
| `whatsapp_country_code` | 91 | added to phone numbers stored without one |

---

## Rules the app enforces

These run in the API, inside one transaction per request, so they hold however a
record is saved from the app. The database adds its own checks on top (a unit
cannot be let twice over overlapping dates, a lease's unit must belong to its
property, known values only for statuses, nothing referenced can be deleted).

| Rule | Behaviour |
|---|---|
| New records get a real status | A form saved with the dropdown untouched still lands as Active / Vacant / Open, never blank |
| Lease status follows the dates | Upcoming → Active → Expired, re-derived on every save. Terminated is never overridden |
| Occupancy follows leases | Saving, terminating or deleting a lease updates its unit immediately. `Under Maintenance` is never overwritten |
| One live lease per unit | An overlapping lease is refused, naming the clashing lease |
| Lease dates | An end date before the start date is refused |
| Payments | Recorded against an invoice. Cannot exceed what is owed; any excess settles the tenant's other unpaid invoices. A settled, void or draft invoice takes no more. The invoice's balance and status follow at once |
| Deleting an invoice | Only a draft. An issued invoice is voided instead, with a reason |
| Two saves of one record | The second is refused if the record changed after its form was opened |
| Deposits in the figures | Payments on Deposit invoices are not income, and Deposit Refund expenses are not operating expenses. Deposits held = received − applied at move-out − refunded |
| Editing an invoice | Keeps its status (a void invoice stays void) and, for Rent and Deposit invoices, its type — so adding an electricity line to a month's rent never gets that month billed again |
| Deleting a payment | Restores the invoice's paid amount, balance and status |
| Deleting anything referenced | Refused, listing what still points at it. An invoice's own line items and a lease's occupant rows are the exceptions, and are removed with it |
| Voiding | Refused while any payment is recorded against the invoice |
| Late fees | Added once, when an invoice on a lease with a late fee turns overdue — after the grace days on a rent-day lease |
| Sold / Inactive properties | Excluded from the dashboard headline figures. Their history stays in the reports |
| Tenant status | Active while they hold a live lease or live on one as an occupant (until their move-out date), Past once every lease has ended |
| Occupants | Saved with the lease in one transaction. A form only removes occupants it was opened with, so someone added meanwhile is kept, and a stale edit of one is refused. Making an occupant primary moves the previous primary into their place as a co-tenant. Renewing carries over everyone still living there |
| Maintenance | Marking a ticket Resolved or Closed stamps today's completion date if left blank. A cost writes one Expense, referenced back to the ticket, so a repair is never counted twice |
| Property attribution | An invoice and its payments inherit the property from the unit or lease when the form leaves it blank |
| Deposits | Signing a lease with a deposit raises a Deposit invoice, unless the lease already says Held. `deposit_status` is Pending until that invoice is paid, then Held |

## Editing data by hand

You can, in the Supabase dashboard's **Table editor**, and the app picks it up on
the next load. Edits there bypass the rules above, so:

1. **Don't hand-edit `amount`, `amount_paid`, `balance` or `status` on invoices** —
   record a payment or edit the invoice's lines in the app instead.
2. After changing leases, units or invoices by hand, open **Settings → Re-sync
   statuses** so occupancy, lease and invoice statuses catch up.

## Adding a field

1. **Database:** add a new migration in `supabase/migrations/`
   (`<timestamp>_<what>.sql`), e.g. `alter table tenants add column pan text;`.
2. **API:** add the column to its table in
   [`supabase/functions/api/schema.js`](../supabase/functions/api/schema.js).
3. **App:** add the field to the entity in
   [`assets/js/schema.js`](../assets/js/schema.js). Forms, tables, filters and CSV
   export are generated from it.
4. Push to `main`. The deploy runs the migration, then the API, then the site.
