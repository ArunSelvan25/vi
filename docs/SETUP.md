# Setup guide

The app has three parts:

```
GitHub Pages (the app)            Supabase Edge Function "api"        Supabase Postgres
┌──────────────────────┐          ┌───────────────────────────┐      ┌──────────────────┐
│ api(action, payload) │──HTTPS──►│ sign-in, roles, billing   │─SQL─►│ tables, foreign  │
│                      │◄─────────│ rules, every action       │◄─────│ keys, checks     │
└──────────────────────┘          └───────────────────────────┘      └──────────────────┘
                                         ▲ pg_cron, daily 05:00 IST (housekeeping)
```

- **The app** is static files served free by GitHub Pages. It installs on a
  phone like an app.
- **The API** is one Supabase Edge Function, [`supabase/functions/api/`](../supabase/functions/api/).
  It holds every rule: sign-in, roles, rent, payments, deposits.
- **The database** is Supabase Postgres, created by the files in
  [`supabase/migrations/`](../supabase/migrations/). Each request runs in one
  transaction, so nothing is ever left half-saved.

You need Node 20+. The [Supabase CLI](https://supabase.com/docs/guides/cli) runs
through `npx`, so there is nothing to install.

---

## First-time setup

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

### 3 · Set the secrets and deploy the API

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

| Secret | What it does |
|---|---|
| `AUTH_SECRET` | Signs sign-in sessions. Changing it signs everyone out. |
| `CRON_SECRET` | Lets the daily job (step 5) call the API. |
| `SETUP_KEY` | Needed once, to create the first administrator. See *Close the bootstrap window* below. |
| `APP_TIMEZONE` | The zone "today" is measured in: when rent turns overdue, when leases expire. |

Check it answers:

```sh
curl https://<project-ref>.supabase.co/functions/v1/api
# {"ok":true,"data":{"service":"vi-property-manager",...}}
```

### 4 · Publish the app to GitHub Pages

Push this repository to GitHub, then in the repo: **Settings → Pages → Source:
GitHub Actions**. The workflow in
[`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) deploys on every
push to `main` (see *Deploying* below). Your site lands at
`https://<you>.github.io/<repo>/`.

### 5 · Schedule the daily housekeeping

Housekeeping flags overdue invoices, expires leases, keeps unit occupancy in step
and applies late fees. The app also runs it on the first load of each day, so this
is a safety net.

1. In the Supabase dashboard, open **Integrations** and enable **Cron** and **pg_net**.
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

### 6 · First run

1. Open the site. The setup wizard asks for the API URL:
   `https://<project-ref>.supabase.co/functions/v1/api`. Paste it and press **Connect**.
2. Create the first administrator: **name, phone number, and a password of at
   least 10 characters**, plus the `SETUP_KEY` from step 3. The phone number is
   what you sign in with; email is optional. Country code is optional too:
   `+91 98800 11111` and `9880011111` are the same number.
3. Sign in. You're live.

---

## Using the app on several devices

The API URL and your session live in the browser's `localStorage`, which is
scoped **per origin**, so by default each device pastes the URL once. To skip the
wizard everywhere, pick one:

**A. Put it in the code** — simplest, best for a **private** repo. Set
`DEFAULT_API_URL` at the top of [`assets/js/config.js`](../assets/js/config.js)
and push.

**B. Put it in a GitHub secret** — best for a **public** repo. Add a repository
secret named `VIPM_API_URL` with the API URL. The deploy workflow writes it into
`config.js` as the site is published.

> **What a secret does here.** This site has no build step, so for the browser to
> use the URL it must be written into a published file, where anyone who loads the
> page can read it. Option B keeps the URL out of your **git history**; it is not a
> security boundary. That is fine: the URL on its own grants nothing (see below).

With either, a device that still remembers an older API address follows the
published one automatically. **Disconnect** in Settings returns a device to the
wizard.

---

## Install it on a phone

The site is a Progressive Web App, so it can be added to a home screen and run
like an installed app: full screen, its own icon, no browser chrome.

- **Android (Chrome):** accept the install prompt, or **⋮ → Install app** /
  **Add to Home screen**.
- **iPhone / iPad (Safari):** tap **Share**, then **Add to Home Screen**. iOS only
  offers this in Safari.
- **Desktop (Chrome / Edge):** the install icon at the right of the address bar.

Once installed it opens instantly, and even without a network, though it cannot
load data until you are back online.

**What is stored on the device:** only the app itself (HTML, CSS, JavaScript,
icons). No property, tenant, invoice or payment data is ever written to the app
cache, and neither is your session token: every API call is a POST to another
origin, and the service worker ignores both. A shared or lost phone leaks nothing
beyond what is on the public site.

**Updates:** each deployment stamps a new build id into `sw.js`, so an installed
copy offers **Update now** the next time it opens. It is never applied underneath
you mid-session. If you ever deploy by copying files by hand rather than through
the workflow, run `node scripts/stamp-build.mjs` first, or installed devices keep
the previous version.

---

## Deploying

A push to `main` runs the tests, then the **backend** job — database migrations
(`supabase db push`), then the `api` function — and only then publishes the site,
so the site never goes out ahead of the database it talks to. If the tests or a
migration fail, nothing after them runs. A newer push waits for a deploy in
progress rather than cancelling it part-way through a migration.

It needs three repository secrets, under **Settings → Secrets and variables →
Actions** on GitHub. Without them the deploy stops with a message naming what is
missing:

| Secret | Where to find it |
|---|---|
| `SUPABASE_ACCESS_TOKEN` | supabase.com → your account → **Access Tokens** → generate one for GitHub |
| `SUPABASE_DB_PASSWORD` | The database password chosen when the project was created (Project Settings → Database can reset it) |
| `SUPABASE_PROJECT_ID` | The project ref — `abcdefghijklmnop` in `https://abcdefghijklmnop.supabase.co` |

Each run's **Migrations waiting to run** step lists what it is about to apply.
`db push` only applies migrations the database has not had yet, so a deploy with
no new migration changes nothing there.

**Changing the database:** add a **new** file to `supabase/migrations/` (named
`<timestamp>_<what>.sql`) and push. Never edit a migration that has already been
pushed — the database will not notice. Back up first when a migration drops or
rewrites data.

---

## Optional · GST, UPI and WhatsApp

In **Settings**:

- **Your GSTIN** — invoices that carry GST print as *Tax invoice*, with your
  GSTIN, the tenant's (set it on the tenant), the SAC code, the place of supply
  and CGST + SGST or IGST. For renting property the place of supply is where the
  property is, so fill in each property's **state** (name, `KA`, or `29`).
- **GST on rent %** is set per lease (18 for commercial, 0 for a home) and is
  added to rent invoices and late fees. Any invoice line can carry its own rate.
- **UPI ID** — shown on invoices, with a *Pay via UPI* link that opens the
  payer's UPI app on a phone.
- **Country code for WhatsApp** — invoices, receipts and statements have a
  *WhatsApp* button that opens a chat with the tenant, message filled in.

**Email reminders are not set up.** The reminder logic exists, but no email
provider is connected: **Send reminders** says so, and the daily reminder job does
nothing. Share invoices over WhatsApp instead. Turning email on later means
supplying a `sendEmail` function in `supabase/functions/api/index.ts` (for example
with Resend or SMTP).

---

## Day to day

| Task | How |
|---|---|
| Someone forgot their password | Settings → Team members → *Reset password* |
| Someone has left | *Disable* them. They are signed out at once and their records are kept. |
| Look at or fix data by hand | Supabase dashboard → Table editor. The app picks up edits on the next load. |
| Back up | `npx supabase db dump --data-only -f backup.sql` now and then, and before any migration that drops or rewrites data. The Pro plan adds daily backups. |
| Free-plan pausing | A free project pauses after 7 days with no traffic. The daily job counts as traffic, so an app in use won't pause. |
| Run the app locally | `npm run db:test`, then `npm run dev`. Sign in with 9000012345 / password123. |

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| *"Could not reach the API"* | Wrong URL. It is `https://<project-ref>.supabase.co/functions/v1/api`. |
| Every call fails right after a deploy | The function and the database are out of step. Check the latest **Deploy** run on GitHub: the migration or function step will show the error. |
| *"Your session expired"* | Sessions last `session_hours` (default 12). Sign in again. |
| *"… was changed by someone else after you opened it"* | Another person saved the same record first. Close the form, open it again to see their change, and redo yours. |
| *"Invoice … has been issued, so it cannot be deleted"* | Issued invoices keep their number. Use **Void** (with a reason) instead. Only drafts can be deleted. |

---

## Security

The API URL is **not secret**. Treat it as a public endpoint.

**What the URL alone gets an attacker: nothing.** Every action except `ping`,
`login` and `setup` requires a valid HMAC-signed session token, and roles are
re-checked on the server for every write. Password hashes and salts are never sent
to the browser. Supabase's auto-generated REST API is switched off for every table,
so nobody can go around the API.

| Guard | Behaviour |
|---|---|
| Setup takeover | `setup` refuses to create an admin once one exists, and performs **no writes at all** for an unauthenticated caller |
| Brute force | After 4 wrong passwords a number is locked out, for 30 s, then 1 min, 2 min … up to 30 min per further failure. Someone else's failures never lock out a person typing the right password |
| Password spraying | While failures across all accounts run unusually high (over 100 in 15 min), each targeted number locks after its first wrong guess |
| Account enumeration | Unknown / disabled / wrong-password all return one identical message |
| Passwords | PBKDF2-SHA256 with 600,000 rounds. At least 10 characters, not all digits, not one repeated character, not containing the phone number. |

All of the above are covered by `npm run test:security`.

- Changing or resetting a password **ends that account's other sessions**.
- Every request re-checks the account, so disabling or demoting someone takes
  effect at once rather than when their session expires.
- Two people saving the same record: the second save is refused with a message,
  never silently overwriting the first. Two payments at the same moment cannot
  both squeeze into one balance.
- Anyone with access to the Supabase dashboard can read and change everything
  directly. Invite only people who should have full access.
- Do not use this to store payment card data.

### Close the bootstrap window

Between deploying the API and creating the first administrator, whoever reaches the
URL first could make themselves admin. The `SETUP_KEY` secret (step 3) closes that:
setup refuses to create an administrator without it. With no `SETUP_KEY`, the
window closes on its own **one hour** after the API first answers a request.

### Locked out?

The API deliberately cannot let you back in — that is what stops a stranger
seizing the workspace. Recovery talks to the database directly, so only someone
holding the database connection string can run it:

```sh
DATABASE_URL='<connection string: dashboard → Connect → Session pooler>' \
  node scripts/recover-admin.mjs <phone> [name]
```

It asks for a new password, makes that phone number an active administrator
(adopting the existing account rather than creating a duplicate), and clears any
sign-in lockout.

---

## Tests

```sh
npm run db:test   # a disposable Postgres in Docker on port 55432
npm test          # everything below
```

| Suite | What it proves |
|---|---|
| `test:backend` | Rent days and late-fee grace |
| `test:paging` | Server-side paging, search and scopes, and every server-computed figure checked against the old in-browser arithmetic |
| `test:security` | The attacks above, and that accounts with older password hashes still sign in |
| `test:production` | ~140 behaviour probes: billing, deposits, roles, concurrency, a failed request leaving nothing behind |
| `test:http` | The HTTP surface, the cron secret, and that the public REST roles can reach no table |
| `test:pwa`, `test:pwa:ui` | The installable app: manifest, service worker, offline start, updates |
| `test:ui` | The real app in Chrome against the real API on Postgres |
| `test:responsive` | Every screen at phone widths: no sideways scrolling, thumb-sized targets |

CI runs all of it against a Postgres service container on every push, before
anything is deployed.
