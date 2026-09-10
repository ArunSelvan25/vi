# Sheet schema

The script creates these tabs on first run. Row 1 is always the header row and
the column names are the contract — **rename a header and the app stops seeing
that field**. Adding your own extra columns to the right is safe; the app
ignores them and preserves them on update.

IDs are human-readable and sequential: `PRP-00001`, `UNT-00003`, `INV-00027`.
Dates are stored as `yyyy-MM-dd` text.

## Properties
`id · name · type · address_line1 · address_line2 · city · state · postal_code · country · owner_name · purchase_date · purchase_price · current_value · status · notes · created_at · updated_at`

## Units
`id · property_id → Properties.id · unit_number · floor · bedrooms · bathrooms · area_sqft · furnishing · rent_amount · deposit_amount · status · amenities · notes · created_at · updated_at`

`status` is maintained by the app (Vacant / Occupied) except **Under Maintenance**, which it never overwrites.

## Tenants
`id · full_name · email · phone · alt_phone · id_type · id_number · occupation · emergency_name · emergency_phone · status · notes · created_at · updated_at`

`phone` is required; `email` is **optional**. A tenant without an email simply
receives no email rent reminders — chase them from the arrears list instead.

## Leases
`id · property_id · unit_id · tenant_id · start_date · end_date · rent_amount · deposit_amount · deposit_status · frequency · billing_day · late_fee · grace_days · escalation_pct · status · notes · created_at · updated_at`

- `frequency` — Monthly | Quarterly | Half-Yearly | Yearly. `rent_amount` is per **month**; a quarterly lease bills 3×.
- `grace_days` — days after a period starts before the invoice falls due.
- `escalation_pct` — compounded on each anniversary of `start_date`.
- `billing_day` and `late_fee` are **not used** by the app and are hidden from
  the form. Rent periods follow the lease start date (a lease starting on the
  5th bills on the 5th), and late fees are not charged automatically — add one
  as an invoice line if you need to. The columns remain so existing values are
  not lost.

## Invoices
`id · lease_id · tenant_id · unit_id · property_id · type · period_start · period_end · issue_date · due_date · amount · tax · total · amount_paid · balance · status · notes · created_at · updated_at`

`amount`, `total`, `amount_paid`, `balance` and `status` are all **derived** — the server recomputes them from the Payments tab whenever a payment is recorded. Editing them by hand in the sheet will be overwritten.

Rent invoices are keyed by `lease_id + period_start`; that pair is what makes generation idempotent.

## InvoiceItems
`id · invoice_id → Invoices.id · description · category · quantity · unit_amount · amount · notes · created_at · updated_at`

The charges that make up an invoice — rent, electricity, water, parking and so
on — one row each. `amount` is `quantity × unit_amount`, and the parent
invoice's `amount` is the sum of its lines, so **never type a total by hand**.

Deleting an invoice deletes its lines. Saving an invoice replaces its whole line
set: lines removed in the editor are deleted from this tab.

Because every charge is its own row with a category, you can pivot this tab in
Sheets to see, say, total electricity billed per month across the portfolio.

## Payments
`id · invoice_id · lease_id · tenant_id · property_id · payment_date · amount · method · reference · received_by · notes · created_at · updated_at`

This tab is the source of truth for money received. Delete a row and the linked invoice's balance is restored on the next recalculation.

## Maintenance
`id · property_id · unit_id · tenant_id · title · description · category · priority · status · reported_date · scheduled_date · completed_date · vendor_name · vendor_phone · cost · notes · created_at · updated_at`

`cost` counts as an expense in the P&L, dated by `completed_date` (falling back to `reported_date`).

## Expenses
`id · property_id · unit_id · date · category · vendor · description · amount · payment_method · reference · receipt_url · created_at · updated_at`

## Documents
`id · entity_type · entity_id · title · category · url · issue_date · expiry_date · notes · created_at · updated_at`

## Users
`id · name · phone · email · role · salt · password_hash · active · last_login · created_at · updated_at`

- **`phone` is the sign-in credential** and must be unique. It is compared on
  digits only, keeping the last 10, so `+91 98800 11111`, `098800 11111` and
  `9880011111` are the same account. For non-10-digit local numbers, change
  `LOCAL_PHONE_DIGITS` in `Code.gs`.
- `email` is **optional** — contact detail only, never used to sign in.
- `role` — `admin` | `manager` | `viewer`.
- `password_hash` — base64 SHA-256 of `salt + '::' + password`.
- Set `active` to `FALSE` to disable an account without deleting it.
- To reset a password you have lost: delete the user row and re-run setup, or set a known salt/hash pair.

## Settings
`key · value` — one row per setting.

| key | default | meaning |
|---|---|---|
| `org_name` | VI Lifestyle Properties | shown in the sidebar and on invoices |
| `currency` / `currency_symbol` | INR / ₹ | money formatting |
| `locale` | en-IN | number grouping (`en-IN` gives 1,00,000) |
| `invoice_prefix` | INV | invoice id prefix |
| `default_grace_days` | 5 | suggested on new leases |
| `default_late_fee` | 0 | suggested on new leases |
| `reminder_days_before` | 3 | how early to email tenants |
| `reminder_enabled` | false | arms the daily reminder trigger |
| `lease_expiry_alert_days` | 45 | dashboard warning window |
| `session_hours` | 12 | how long a login lasts |

## ActivityLog
`id · timestamp · actor · action · entity · entity_id · details`

Append-only audit trail. Safe to prune old rows; the app only reads the last 200.

---

## Rules the app enforces

These run on the server, so they hold however a record is saved:

| Rule | Behaviour |
|---|---|
| New records get a real status | A form saved with the dropdown untouched still lands as Active / Vacant / Open, never blank |
| Lease status follows the dates | Upcoming → Active → Expired, re-derived on every save. Terminated is never overridden |
| Occupancy follows leases | Saving, terminating or deleting a lease updates its unit immediately. `Under Maintenance` is never overwritten |
| One live lease per unit | An overlapping lease is refused, naming the clashing lease |
| Lease dates | An end date before the start date is refused |
| Payments | Cannot exceed the outstanding balance, and a settled or void invoice takes no more |
| Deleting a payment | Restores the invoice's paid amount, balance and status |
| Deleting anything referenced | Refused, listing what still points at it. An invoice's own line items are the exception and are removed with it |
| Voiding | Refused while any payment is recorded against the invoice |
| Sold / Inactive properties | Excluded from the dashboard headline figures — units, occupancy, rent roll, deposits, open tickets. Their history stays in the reports |
| Tenant status | Active while they hold a live lease, Past once every lease has ended. A tenant with no lease at all is left as you set them |
| Maintenance | Marking a ticket Resolved or Closed stamps today's completion date if you left it blank, so the cost lands in the right period |
| Property attribution | An invoice and its payments inherit the property from the unit or lease when the form leaves it blank |
| Deposits | Signing a lease with a deposit raises a Deposit invoice. `deposit_status` is Pending until that invoice is fully paid, then Held — and back to Pending if the payment is reversed |
| Repair costs | Completing a maintenance ticket with a cost writes one Expense row, referenced back to the ticket. Reports read only Expenses, so a repair is never counted twice |

Editing the sheet by hand bypasses all of the above — run
**Property Manager → Refresh statuses** afterwards.

## Editing the sheet directly

You can. It's a normal spreadsheet, and that's the point. Two rules:

1. **Don't rename or reorder header cells** — reordering is actually fine (the
   app reads by name), renaming is not.
2. **Don't hand-edit `amount_paid` / `balance` / `status` on Invoices** — record
   a payment instead, or run **Property Manager → Refresh statuses** from the
   sheet menu afterwards.

## Adding a field

1. Add the column to the relevant tab's `SCHEMA` in `apps-script/Code.gs`, then
   re-run setup (it adds missing columns without touching data).
2. Add a matching entry to that entity's `fields` array in
   `assets/js/schema.js`. Forms, tables, filters, CSV export and validation all
   pick it up from there.
