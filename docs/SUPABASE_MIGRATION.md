# Moving from Google Sheets to Supabase (Postgres)

**Status:** the backend is built and tested; the switch-over has not happened yet.
The app keeps running on the Google Sheet until you follow the steps below.

| Done | What |
|---|---|
| ✅ | Database schema: [`supabase/migrations/`](../supabase/migrations/) |
| ✅ | Backend (every action of `Code.gs`, ported): [`supabase/functions/api/`](../supabase/functions/api/) |
| ✅ | Import from the sheet, with checks and reconciliation: [`scripts/import-sheet.mjs`](../scripts/import-sheet.mjs) |
| ✅ | Break-glass admin recovery: [`scripts/recover-admin.mjs`](../scripts/recover-admin.mjs) |
| ✅ | Tests: `npm run test:supabase` (the existing behaviour suites, ported, plus HTTP, access and migration tests) |
| ⏳ | Email reminders — deliberately left out for now (see below) |
| ⏳ | Your steps: 1–7 below |

## How it fits together

```
GitHub Pages (same SPA)          Supabase Edge Function "api"         Supabase Postgres
┌──────────────────────┐         ┌────────────────────────────┐      ┌──────────────────┐
│ api(action, payload) │─HTTPS──►│ the same actions as Code.gs│─SQL─►│ 14 tables, FKs,  │
│                      │◄────────│ auth, roles, billing rules │◄─────│ checks, RLS on   │
└──────────────────────┘         └────────────────────────────┘      └──────────────────┘
                                        ▲ pg_cron, daily 05:00 IST (housekeeping)
```

The SPA is unchanged apart from the URL it talks to. Every action keeps its name,
payload and response, so the Apps Script backend stays usable as a fallback until
you retire it.

## What gets better

- **Nothing is left half-saved.** Each request runs in one transaction: if any
  step fails, none of it is kept. The sheet could be left with, say, a payment
  recorded but the invoice not updated.
- **The database refuses bad data itself.** This is on top of the checks the app
  already made:
  - a unit can't be let twice over overlapping dates;
  - a lease's unit must belong to its property;
  - nothing that other records point to can be deleted;
  - statuses must be one of the known values;
  - a void invoice owes nothing;
  - one sign-in per phone number, however it is typed.
- **Passwords are stored more strongly.** PBKDF2 with 600,000 rounds, where Apps
  Script could only manage 1,000 rounds of SHA-256.
  - Existing passwords keep working. Each account is upgraded silently on its
    next sign-in.
  - Tested byte for byte against `Code.gs`.
- **Nobody can go around the app.** Supabase publishes every table on a public
  REST API. The migration switches that off for every table, and a test proves it.
- **It's faster.** A save no longer re-reads whole tabs, and an unchanged table
  isn't even read.

## Email reminders: off for now

The reminder logic is ported (schedule, one email per tenant, "last reminded"
dates), but no email provider is connected.

- The **Send reminders** button says so rather than pretending to send.
- The daily reminder job does nothing.
- WhatsApp sharing and UPI links are unaffected.
- Turning email on later means supplying a `sendEmail` function in
  `supabase/functions/api/index.ts` (for example with Resend or SMTP).

> If reminders are switched on in your current Settings, tenants who get
> automatic emails today will stop getting them after the switch.

---

## The switch-over

About 45 minutes. You need Node 20+. The [Supabase CLI](https://supabase.com/docs/guides/cli)
runs through `npx`, so there is nothing to install (`npm install -g supabase` is not supported).

### 1 · Create the Supabase project

1. At [supabase.com](https://supabase.com), create a project. Choose region
   **South Asia (Mumbai)**, and keep the database password somewhere safe.
2. Note the **project ref**: the `abcdefghijklmnop` in `https://abcdefghijklmnop.supabase.co`.
3. In this repository, run:

```sh
npx supabase login
npx supabase link --project-ref <project-ref>
```

### 2 · Create the tables

```sh
npx supabase db push
```

### 3 · Set the secrets and deploy the backend

```sh
CRON_SECRET="$(openssl rand -hex 32)"
echo "CRON_SECRET=$CRON_SECRET   <- save this, step 5 needs it"

npx supabase secrets set \
  AUTH_SECRET="$(openssl rand -hex 32)" \
  CRON_SECRET="$CRON_SECRET" \
  SETUP_KEY="$(openssl rand -hex 16)" \
  APP_TIMEZONE=Asia/Kolkata

npx supabase functions deploy api --no-verify-jwt
```

Check it answers:

```sh
curl https://<project-ref>.supabase.co/functions/v1/api
# {"ok":true,"data":{"service":"vi-property-manager",...}}
```

`npx supabase secrets list` shows only a digest of each secret, never the value.
If you lose `CRON_SECRET` before step 5, generate and set a new one the same way.

### 4 · Move the data

**a. Allow the export, once.** In the Apps Script editor:

1. Replace the code with the current [`apps-script/Code.gs`](../apps-script/Code.gs).
2. Choose **Deploy → Manage deployments → ✏️ → Version: New version → Deploy**.
3. Under **Project Settings → Script properties**, add `EXPORT_KEY` with a random
   value.

The export needs both an administrator's sign-in and that key.

**b. Fetch and check.** Tell everyone to stop making changes in the app, then run:

```sh
node scripts/import-sheet.mjs fetch --url https://script.google.com/macros/s/<id>/exec --phone <your admin phone>
node scripts/import-sheet.mjs check
```

`check` lists every row the new database would refuse, all at once. Typical
findings:
- a lease whose unit was deleted;
- two live leases on one unit;
- a typo in a status;
- two users with the same phone number.

These rows are already inconsistent today; the database just won't accept them.
Fix them in the sheet, then run `fetch` and `check` again until the check is clean.

**c. Import.** Get the connection string from the Supabase dashboard (**Connect →
Session pooler**, with your database password), then run:

```sh
DATABASE_URL='postgresql://postgres.<ref>:<password>@aws-0-ap-south-1.pooler.supabase.com:5432/postgres' \
  node scripts/import-sheet.mjs import
```

The import runs in one transaction. It then recomputes every dashboard figure
from the new tables and compares them with the sheet's own figures:
outstanding, overdue, collected this month, deposits held, rent roll, occupancy
and so on. If a single figure differs, nothing is kept.

**d. Clean up.**
- Delete `sheet-export.json`, which contains password hashes.
- Delete the `EXPORT_KEY` script property.

### 5 · Schedule the daily housekeeping

Housekeeping flags overdue invoices, expires leases, syncs occupancy and applies
late fees. The app also runs it on the first load of each day, so this is a
safety net.

1. In the dashboard, open **Integrations** and enable **Cron** and **pg_net**.
2. In the SQL editor, run:

```sql
select vault.create_secret('<CRON_SECRET from step 3>', 'vipm_cron_secret');

select cron.schedule('vipm-daily-maintenance', '30 23 * * *',   -- 05:00 IST
$$
  select net.http_post(
    url     := 'https://<project-ref>.supabase.co/functions/v1/api/cron',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets
                                   where name = 'vipm_cron_secret')),
    body    := '{"job":"dailyMaintenanceJob"}'::jsonb);
$$);
```

This replaces **Property Manager → Install daily automation** in the sheet menu.

### 6 · Point the app at Supabase

1. In GitHub, go to **Settings → Secrets and variables → Actions**.
2. Set `VIPM_API_URL` to `https://<project-ref>.supabase.co/functions/v1/api`.
3. Re-run the **Deploy to GitHub Pages** workflow.

What happens after that:
- **Existing devices:** a device that was set up with the Apps Script URL follows
  the new one automatically.
- **Sign-in:** everyone signs in once more, with the same phone number and password.
- **If you don't use `VIPM_API_URL`:** each device must enter the new URL in the
  setup wizard instead.

### 7 · Retire the sheet backend (after about two weeks)

Keep the Apps Script deployment as a read-only fallback for a while, then do these:
1. Archive the Apps Script deployment.
2. Remove the old triggers.
3. Set the sheet to read-only, and keep it as a record.

**Rolling back before step 6** only means not changing the URL. The sheet is
never modified by any of this.

---

## Day-to-day

| Task | How |
|---|---|
| Locked out of every admin account | `DATABASE_URL=… node scripts/recover-admin.mjs <phone>` |
| Look at or fix data by hand | Supabase dashboard → Table editor. The app picks up edits on the next load. |
| Back up | Free plan: `npx supabase db dump --data-only > backup.sql` now and then. Pro plan ($25/mo): daily backups. |
| Free-plan pausing | A free project pauses after 7 days with no traffic. The daily cron job counts as traffic, so an app in use won't pause. |
| Change the schema | Add a file to `supabase/migrations/`, then `npx supabase db push`. |
| Run the app locally on Postgres | `npm run db:test`, then `npm run dev:supabase`. Sign in with 9000012345 / password123. |

## Tests

```sh
npm run db:test          # a disposable Postgres in Docker on port 55432
npm run test:supabase    # everything below
```

| Suite | What it proves |
|---|---|
| `supabase-billing-test` | The rent-period maths gives the same results as `Code.gs` |
| `supabase-security-test` | The 39 existing attacks, plus a check that migrated passwords sign in |
| `supabase-production-test` | The ~140 behaviour probes, plus Postgres-specific ones (below) |
| `supabase-http-test` | The HTTP surface, the cron secret, and that the `anon` and `authenticated` roles can reach no table |
| `supabase-migration-test` | A portfolio built on `Code.gs`, exported and imported, arrives with every field intact |
| `test:ui:supabase` | The browser smoke suite, with the real SPA in Chrome against Postgres |

The Postgres-specific probes in the production suite cover:
- three simultaneous payments for the same balance, of which only one is accepted;
- a failed request leaving nothing behind;
- queries per rent run.

The migration test also checks that the dashboard figures match, that passwords
still work, and that invoice numbering carries on without reuse.

CI runs all of it against a Postgres service container on every push.
