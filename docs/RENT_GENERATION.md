# Generate rent

How rent invoices are raised, and every rule behind the amounts. The rules
here were agreed before the feature was built; the worked examples are the
same ones the tests check (`test/billing-test.mjs`, `test/rent-test.mjs`).

## In one paragraph

Every lease has a **rent day**. Rent is billed **for the time already lived**:
with rent day 10, the invoice for **11 Sep – 10 Oct is due on 10 Oct**. On
Billing → **Generate rent** you pick the leases, add electricity and other
charges, check the totals, and issue the invoices (or save them as drafts).
Nothing is ever billed twice, nothing is billed without being shown first, and
nothing — rent or late fee — is added automatically.

## The rent day

- 1st to 28th, or **Last day of month** (31 stands for the last day, so
  February works). Required on every lease.
- A lease saved before rent days were required keeps working, but shows as
  *Rent day missing* on Generate rent until one is set (there is a *Save rent
  day* button right there).

## Periods and amounts

A **cycle** runs from the day after one rent day to the next rent day.

| Case | Example (rent ₹30,000, rent day 10) | Amount |
|---|---|---|
| Whole cycle | 11 Sep – 10 Oct, due 10 Oct | ₹30,000 — one month's rent, whatever the month's length |
| First part month (move-in) | moved in 20 Aug → 20 Aug – 10 Sep, due 10 Sep | 20–31 Aug: 12/31 × 30,000 = 11,612.90<br>1–10 Sep: 10/30 × 30,000 = 10,000.00<br>**₹21,612.90** |
| Last part month (move-out) | ended 20 Sep → 11–20 Sep, due 20 Sep | 10/30 × 30,000 = **₹10,000** |
| Rent day = last day | 1 – 28 Feb, due 28 Feb | ₹30,000 |

- A part month is charged **day by day, each calendar month at its own
  length** (August ÷ 31, September ÷ 30), one line per month on the invoice.
- **Escalation:** each cycle is charged the rent in force on its first day.
  With 5% a year from 11 Sep 2025, the cycle starting 11 Sep 2026 is ₹31,500.
- **Quarterly / half-yearly / yearly:** one invoice bundles 3, 6 or 12
  cycles, due on the last one's rent day. Quarterly from 20 Jul, rent day 10:
  20 Jul – 10 Oct (part month + two whole months), due 10 Oct; then
  11 Oct – 10 Jan, due 10 Jan.
- The lease's rent is always the **monthly** figure.

### The first part month: you are asked

When a monthly lease starts part-way through a cycle, Generate rent asks every
time:

- **Bill it now on its own** — e.g. 8–10 Sep, ₹3,000, due 10 Sep; or
- **Add it to the next invoice** — 8 Sep – 10 Oct, ₹33,000, due 10 Oct
  (raisable from 1 Oct).

Nothing can be generated for that lease until one is chosen.

## When an invoice can be raised

From the **1st of the month it is due in**. Run on 25 Sep:

| Due | Shown as | Ticked? |
|---|---|---|
| Before September | **Backlog** — never billed | No — tick to include |
| In September | **Ready** | Yes |
| October or later | *Not due yet*, with the date it can be raised | — |

Suggested routine: run Generate rent on the 1st of each month.

## Never billed twice, never skipped

- A period is *billed* once any rent invoice covers it — **draft, issued or
  void**. Voiding an invoice does not put its period back up for billing.
- Only the days between billed periods are offered, so a missed month in the
  middle is offered as backlog rather than skipped.
- If billing stopped on another day (invoices typed by hand), it carries on
  from there with a part cycle up to the next rent day.
- **Billed outside the app:** backlog months settled before the app was used
  can be marked *billed outside the app* with a reason. They are never offered
  again, never counted as income, and the mark can be undone.
- A rent invoice with **no period dates** cannot be matched to a period, so it
  is listed on its lease in step 1 to check by eye.
- Every rent figure is worked out again on the server when you confirm. If a
  lease was edited or billed by someone else in the meantime, that invoice is
  **skipped and named** on the result screen; the rest are created.

## The three steps

1. **Select leases** — every lease with its status: *Ready*, *Backlog*,
   *Already billed*, *Not due yet*, *Rent day missing*, or *Needs end date*
   (terminated, but the end date is not the day the tenant left). Ended leases
   with rent still to bill get a *Final bill*.
2. **Edit invoices**
   - **EB quick grid** — electricity units per invoice; the rate is filled in
     from that lease's last electricity bill. Printed as
     *Electricity · 142 units @ ₹8*.
   - **Add a charge to every invoice** — e.g. Maintenance ₹500; each invoice
     can still remove it.
   - **Other charges** per invoice (water, gas, parking…), each with its own
     GST rate (0% unless you set one).
   - **Rent is locked.** *Adjust rent* asks for the new amount and a reason.
     The worked-out rent stays on the invoice and the difference is its own
     line, *Rent adjustment*. The reason is kept with the invoice and in the
     activity log; it is not printed.
   - **Late fees** (below), unticked.
   - Notes, printed on the invoice.
3. **Review** — totals by property, warnings (already past due, no electricity
   where there was some last time, rent adjusted, late fees charged), and a
   preview of any invoice. Then **Issue** or **Save as drafts**.

The result screen lists every invoice with WhatsApp and Print. What you type is
kept on the device as you go, so a closed tab offers *Continue where you left
off*.

**Drafts** are not sent, not owed, never overdue and never charged a late
fee. Issue them from Billing → **Drafts** (one at a time, or *Issue all*). A
draft is dated the day it is issued.

Invoices are numbered in one sequence, ordered by property, then unit. GST on
rent follows the lease; the CGST/SGST or IGST split is worked out as for any
invoice.

## Late fees — never automatic

- The daily job **no longer adds late fees**.
- An invoice becomes eligible once it is past its **grace days**, counted from
  its due date — or from the day it was issued, if that is later (an invoice
  raised after its due date could not have been paid on time).
- In step 2, the tenant's eligible overdue invoices are listed on their
  invoice, **unticked**: *Late fee ₹500 · INV-00123 was due 10 Sep*. Tick to
  charge it on the new invoice (as its own line, taxed like the rent).
- Left unticked, it is **offered again** next time. **Waive…** (with a reason)
  removes it for good; this is logged.
- An overdue invoice's own page shows the same choice — **Add late fee** (on
  that invoice) or **Waive** — for a tenant with no new invoice to carry it.
- Each overdue invoice is charged at most once. Deposits are never charged.

## Who can

Managers and administrators generate rent, adjust it, charge or waive late
fees and mark periods as billed outside the app. Viewers see the invoices only.

## Where it lives in the code

| | |
|---|---|
| Periods and amounts (no database) | `supabase/functions/api/rent.js` |
| Candidates, generation, late fees, drafts | `supabase/functions/api/backend.js` — *generate rent* section |
| Database changes | `supabase/migrations/20260927000000_rent_generation.sql` |
| The screen | `assets/js/views/rentrun.js` |
