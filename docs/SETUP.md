# Setup guide

About 15 minutes, start to finish. Everything below is on Google's and GitHub's free tiers.

```
GitHub Pages (this SPA)  ──HTTPS──►  Apps Script Web App  ──►  Your Google Sheet
```

---

## 1 · Create the spreadsheet

1. Go to <https://sheets.new> and name it something like **Property Manager DB**.
2. Leave it empty — the script creates every tab and header row for you.

## 2 · Add the backend script

1. In the sheet: **Extensions → Apps Script**.
2. Delete the placeholder `Code.gs` contents.
3. Paste the entire contents of [`apps-script/Code.gs`](../apps-script/Code.gs).
4. Save (**Ctrl/Cmd + S**).

> Optional: to keep the script separate from the sheet, create a standalone
> Apps Script project instead and add a Script Property `SHEET_ID` set to the
> id from your sheet's URL (`docs.google.com/spreadsheets/d/`**`THIS_PART`**`/edit`).

## 3 · Deploy it as a Web App

1. **Deploy → New deployment**.
2. Click the gear next to "Select type" and choose **Web app**.
3. Set:
   - **Description**: `Property Manager API`
   - **Execute as**: **Me** *(so the script can reach your sheet)*
   - **Who has access**: **Anyone** *(required — the browser calls it anonymously; your own login still guards the data)*
4. **Deploy**, then **Authorize access** and accept the permission screen.
   Google shows an "unverified app" warning because it is your own private
   script: choose **Advanced → Go to … (unsafe)** to continue.
5. Copy the **Web app URL**. It ends in `/exec`.

⚠️ Every time you edit `Code.gs`, use **Deploy → Manage deployments → ✏️ → Version: New version**.
Creating a *new deployment* instead gives you a different URL.

## 4 · Publish the front-end to GitHub Pages

```bash
git init
git add .
git commit -m "Property manager"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

Then in the repo: **Settings → Pages → Source: GitHub Actions**. The included
workflow at [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml)
publishes on every push to `main`.

*(Prefer no Actions? Set **Source: Deploy from a branch → main → / (root)**.
The `.nojekyll` file is already there so `assets/` is served as-is.)*

Your site lands at `https://<you>.github.io/<repo>/`.

## 5 · First run

1. Open the site. The setup wizard asks for the Web App URL — paste it and press **Connect**.
2. The script creates all 12 tabs and their headers.
3. Create the first administrator: **name, phone number, and a password of at
   least 8 characters**. The phone number is what you sign in with — email is
   optional. Country code is optional too; `+91 98800 11111` and `9880011111`
   are treated as the same number.
4. Sign in. You're live.

The URL and your session live in the browser's `localStorage`, which is scoped
**per origin**. Two consequences worth knowing:

- A URL you entered while testing on `localhost` does **not** carry over to your
  `github.io` site — you paste it again there, once.
- Each person pastes it once per browser/device.

### Using the app on several devices

By default each device pastes the URL once. To skip that everywhere, pick one:

**A. Put it in the code** — simplest, best for a **private** repo.
Set `DEFAULT_API_URL` at the top of
[`assets/js/config.js`](../assets/js/config.js) to your `/exec` URL and push.

**B. Put it in a GitHub secret** — best for a **public** repo.
Repo → **Settings → Secrets and variables → Actions → New repository secret**,
named `VIPM_API_URL`, value = your `/exec` URL. The deploy workflow writes it
into `config.js` as the site is published.

> **Be clear about what a secret does here.** GitHub Secrets are readable only
> by Actions, at build time. This site has no build step, so for the browser to
> use the URL it must be written into a published file — where anyone who loads
> the page can read it. Option B keeps the URL out of your **git history**; it
> is not a security boundary.

That is acceptable, because the URL on its own grants nothing: every action
except `ping`, `login` and `setup` needs a valid session token, and roles are
enforced server-side. **If you publish the URL either way, also set a
`SETUP_KEY`** (below) so the one-time bootstrap cannot be hijacked.

Whichever you choose, someone can still paste a different URL on their own
device, and **Disconnect** in Settings returns them to the wizard.

---

## Install it on a phone

The published site is a Progressive Web App, so it can be added to a home
screen and run like an installed app — full screen, its own icon, no browser
chrome.

**Android (Chrome)** — open the site, then either accept the install prompt or
use **⋮ → Install app** / **Add to Home screen**.

**iPhone / iPad (Safari)** — open the site, tap **Share**, then **Add to Home
Screen**. iOS only offers this in Safari, not in Chrome or Firefox.

**Desktop (Chrome / Edge)** — the install icon appears at the right-hand end of
the address bar.

Once installed:

- It **opens instantly**, because the interface is stored on the device.
- It **opens without a network**, though it will say it cannot load data until
  you are back online — the records themselves are never cached (see below).
- Long-press the icon for shortcuts straight to Dashboard, Invoices or
  Maintenance.

### What is and is not stored on the device

Only the application itself — HTML, CSS, JavaScript and icons. **No property,
tenant, lease, invoice or payment data is ever written to the app cache**, and
neither is your session token. Every call to the Apps Script Web App is a POST
to another origin, and the service worker ignores both. A shared or lost phone
therefore leaks nothing beyond what is already on the public site.

Signing out still clears the session as usual. To remove the app entirely,
uninstall it the way you would any app; that clears its cache with it.

### Updating an installed copy

Each deployment stamps a new build id into `sw.js`, so an installed copy notices
the release the next time it is opened and offers **Update now**. It is never
applied underneath you mid-session — accepting it reloads onto the new version,
and the previous cache is discarded so a release can never leave half the old
files in place.

> If you deploy by copying files somewhere by hand rather than through the
> included GitHub Actions workflow, run `node scripts/stamp-build.mjs` first.
> Without it `sw.js` is unchanged, no browser notices the release, and installed
> devices keep serving the previous version.

---

## Optional · Automatic rent reminders

1. In the Apps Script editor open **Triggers** (the clock icon) → **Add trigger**.
2. Function: `dailyReminderJob` · Event source: **Time-driven** · **Day timer** ·
   pick an hour (e.g. 8–9am).
3. In the app: **Settings → Scheduled reminders → `true`**, and set how many days
   before the due date to send.

Tenants with an email address get a reminder as their rent approaches, and a
differently-worded note once it is overdue. Gmail's free quota is 100
recipients/day, which is plenty for a private portfolio.

## Optional · Nightly invoice generation

Add a second time-driven trigger on `menuGenerate` to raise rent invoices
automatically. It is safe to run daily — periods that already have an invoice
are skipped.

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| *"The API returned HTML instead of JSON"* | The deployment's access is not **Anyone**. Redeploy with the correct setting. |
| *"Could not reach the API"* | Wrong URL, or you copied the `/dev` URL. It must end in `/exec`. |
| Changes to `Code.gs` have no effect | You created a new deployment instead of a **new version** of the existing one. |
| *"Your session expired"* | Sessions last `session_hours` (default 12). Just sign in again. |
| Setup says tables exist but you have no login | Someone already seeded a user. Recover it from the **Users** tab, or clear that tab and re-run setup. |
| Everything is slow | Google Sheets is the bottleneck. The app fetches everything in one call and caches it; press the refresh icon only when you need fresh data. |

## Security, honestly

The Web App URL is unguessable but **not secret** — treat it as a public
endpoint and assume someone may eventually find it.

**What the URL alone gets an attacker: nothing.** Every action except `ping`,
`login` and `setup` requires a valid HMAC-signed session token, and roles are
re-checked on the server for every write. Tampering with a token invalidates its
signature. Password hashes and salts are never sent to the browser.

**Hardening that is in place:**

| Guard | Behaviour |
|---|---|
| Setup takeover | `setup` refuses to create an admin once one exists, and performs **no writes at all** for an unauthenticated caller |
| Brute force | 5 failed sign-ins per account, or 30 across all accounts, trigger a 15-minute lockout |
| Account enumeration | Unknown / disabled / wrong-password all return one identical message |
| Timing | Password comparison is constant-time, and an unknown address still costs a hash |

All of the above are covered by `npm run test:security`.

### Close the bootstrap window

There is one genuinely sensitive moment: **between deploying the Web App and
creating your first administrator**, anyone who reaches the URL can seed
themselves as admin. Two ways to handle it:

1. **Just finish setup immediately** after deploying. The window is minutes, and
   nobody knows the URL yet. This is fine for most people.
2. **Require a setup key** — do this if you are publishing the URL (see
   `DEFAULT_API_URL`) or working in a public repo. In the Apps Script editor go
   to **Project Settings → Script Properties → Add script property**, name it
   `SETUP_KEY`, and give it any random string. Setup then refuses to bootstrap
   without it, and the wizard will ask for it.

With no `SETUP_KEY` set, the window closes **on its own one hour** after the
deployment first answers a request. After that, create the administrator from
**Property Manager → Recover admin access** in the spreadsheet instead.

### Locked out? Recover from the spreadsheet

The Web App deliberately cannot let you back in — that is what stops a stranger
seizing the workspace. Recovery runs from the sheet instead, where Google has
already authenticated you as the owner:

1. Open the spreadsheet → menu **Property Manager → Recover admin access**.
   *(If the menu is missing, reload the sheet. If it still isn't there, open
   Extensions → Apps Script and run the `onOpen` function once.)*
2. Enter the phone number you want to sign in with, then a new password.
3. Sign in with that number and password.

It adds any missing columns, makes that number an active administrator —
adopting your existing account rather than creating a duplicate — and clears any
sign-in lockout.

**If you set the workspace up before sign-in moved to phone numbers**, this is
exactly what you need: your account has an email but no phone, so nothing you
type can match. One run of *Recover admin access* fixes it.

### Running it day to day

- **Someone forgot their password** — Settings → Team members → *Reset password*.
- **Someone has left** — *Disable* them. They are signed out at once and their
  records are kept. Deleting is possible but loses the audit trail.
- **Quotas** (consumer Google account): a script run must finish inside 6
  minutes, with 90 minutes of total runtime a day, and `MailApp` sends at most
  100 emails a day. Comfortable for a private portfolio; watch the email cap if
  you have many tenants and enable reminders.
- **Backups** — the sheet is your database. Google keeps version history
  (File → Version history), and *File → Download → CSV* per tab is a quick
  belt-and-braces export. Take one before any bulk edit.

### Remaining trade-offs

- Passwords are salted and **stretched over 1,000 SHA-256 rounds**. Apps Script
  has no bcrypt/scrypt/PBKDF2, and `computeDigest` is slow enough that a modern
  iteration count would take minutes per sign-in. 1,000 is a compromise, not a
  recommendation — raise `HASH_ITERATIONS` in `Code.gs` if sign-in feels
  instant. Existing accounts upgrade to the current scheme automatically the
  next time they sign in.
- New passwords must be at least 10 characters, and cannot be all digits, one
  repeated character, or contain the phone number.
- Changing or resetting a password **ends that account's other sessions**.
- Anyone with edit access to the spreadsheet can read and change everything
  directly, bypassing the app entirely. Share the sheet only with people who
  should have full access.
- Sessions live in `localStorage` and last `session_hours` (default 12), but
  every request re-checks the account against the sheet, so disabling or
  demoting someone takes effect at once rather than when their token expires.
- **Concurrent edits are last-write-wins.** Two people saving the same record in
  the same minute will overwrite each other; the audit log shows what happened.

Do not use this to store payment card data.
