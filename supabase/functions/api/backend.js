/**
 * VI Property & Tenancy Manager — backend
 * ---------------------------------------
 * Every action the app calls, and the business rules behind them, on Postgres.
 *
 *   data             → Postgres tables (schema.js, supabase/migrations)
 *   concurrency      → one advisory lock per request, inside a transaction
 *   a failed request → rolled back whole, never half-written
 *   sign-in lockout  → login_throttle table
 *   app state        → app_state table + function secrets
 *   email            → an injected `sendEmail` (none configured yet)
 *
 * Plain JavaScript on purpose: the same module runs on Supabase's Deno runtime
 * (index.ts) and under Node for the test suites (test/pg-harness.mjs).
 */
import { TABLES, keyOf } from './schema.js';
import {
  openRequest, assertTable, readTable, readTableTail, findRow, invalidate, reserveIds,
  insertRow, insertRows, patchRow, removeRow, getState, setState, tableVersions, guarded
} from './db.js';
import {
  PAGED, OPEN as OPEN_STATUSES, listPage, scopeSummary, scopeHistory, recordDetail, dashboardData,
  billingFigures, reportData, SEARCHED, searchAll
} from './queries.js';
import {
  validRentDay, rentOn, rentPeriods, joinFirstStub, rentLineText, lateFeeFrom, CYCLES_PER_INVOICE
} from './rent.js';

export { validRentDay, lateFeeFrom };

// ─────────────────────────────────────────────────────────── configuration ──

export const DEFAULT_SETTINGS = {
  org_name: 'VI Properties',
  currency: 'INR',
  currency_symbol: '₹',
  locale: 'en-IN',
  date_format: 'dd MMM yyyy',
  invoice_prefix: 'INV',
  default_late_fee: '0',
  default_grace_days: '5',
  reminder_days_before: '3',
  reminder_enabled: 'false',
  lease_expiry_alert_days: '45',
  session_hours: '12',
  reminder_overdue_days: '1,7,14,30',
  gstin: '',
  sac_code: '997212',
  default_gst_rate: '0',
  upi_id: '',
  whatsapp_country_code: '91'
};

const ROLE_RANK = { viewer: 1, manager: 2, admin: 3 };

/** How long a fresh deployment accepts an anonymous first-run bootstrap. */
export const BOOTSTRAP_WINDOW_MS = 60 * 60 * 1000;

/** Tables that need more than the default 'manager' to write. */
const TABLE_MIN_ROLE = { Users: 'admin', Settings: 'admin', ActivityLog: 'admin' };

/** Tables that need more than the default 'viewer' to read. */
const TABLE_READ_ROLE = { Users: 'admin', ActivityLog: 'manager' };

/** Columns that must never leave the server, whoever is asking. */
const NEVER_RETURN = { Users: ['salt', 'password_hash'] };

function minRoleFor(table) { return TABLE_MIN_ROLE[table] || 'manager'; }
function readRoleFor(table) { return TABLE_READ_ROLE[table] || 'viewer'; }

/**
 * Columns a role below the one named may only see masked. A tenant's ID number
 * (Aadhaar, PAN, passport) is personal data a viewer has no need for in full.
 */
const MASKED_BELOW = { Tenants: { id_number: 'manager' } };

/** The columns `user` gets masked in `table`, or null for none. */
function maskedColumns(user, table) {
  const cols = MASKED_BELOW[table];
  if (!cols) return null;
  const hidden = Object.keys(cols).filter(c => (ROLE_RANK[user.role] || 0) < ROLE_RANK[cols[c]]);
  return hidden.length ? hidden : null;
}

/** All but the last four characters hidden, as a masked Aadhaar shows; a short value is hidden whole. */
export function maskIdNumber(v) {
  const s = String(v == null ? '' : v).replace(/\s+/g, '');
  if (!s) return '';
  const keep = s.length > 6 ? 4 : 0;
  return 'X'.repeat(s.length - keep) + s.slice(s.length - keep);
}

/** One row as `user` may see it: secrets removed, sensitive columns masked for their role. */
function forClient(table, row, user) {
  const safe = stripSecrets(table, row);
  const masked = safe && user ? maskedColumns(user, table) : null;
  if (!masked) return safe;
  const out = { ...safe };
  for (const c of masked) if (out[c] !== undefined) out[c] = maskIdNumber(out[c]);
  return out;
}

/** Rows on their way to a client, with secrets removed. */
async function readTableForClient(r, table, user) {
  requireRole(user, readRoleFor(table));
  return (await readTable(r, table)).map(row => forClient(table, row, user));
}

/**
 * One row with the never-return columns removed. Every path that hands a row
 * back to the browser goes through this — a created or updated user included.
 */
function stripSecrets(table, row) {
  const hidden = NEVER_RETURN[table];
  if (!hidden || !row) return row;
  const safe = {};
  Object.keys(row).forEach(k => { if (hidden.indexOf(k) < 0) safe[k] = row[k]; });
  return safe;
}

const SYSTEM_ACTOR = { role: 'admin', phone: 'system', name: 'system' };

function ok(data)  { return { ok: true, data: data || {} }; }
function fail(msg) { return { ok: false, error: msg }; }

const VERSION = '2.0.0';

// ──────────────────────────────────────────────────────────────── factory ──

/**
 * @param {object} deps
 * @param {Function} deps.sql         a postgres.js client (created with PG_TYPES)
 * @param {string}   deps.authSecret  HMAC key for session tokens
 * @param {string}   [deps.setupKey]  when set, required for the first-run bootstrap
 * @param {string}   [deps.timeZone]  the zone "today" is measured in
 * @param {Function} [deps.sendEmail] async (to, subject, body) — omit and reminders are off
 * @param {number}   [deps.hashIterations] PBKDF2 rounds for new password hashes
 */
export function createBackend(deps) {
  if (!deps || !deps.sql) throw new Error('createBackend needs a postgres client');
  if (!deps.authSecret || String(deps.authSecret).length < 32) {
    throw new Error('AUTH_SECRET must be set to a random value of at least 32 characters');
  }
  const env = {
    sql: deps.sql,
    authSecret: String(deps.authSecret),
    setupKey: deps.setupKey ? String(deps.setupKey) : '',
    tz: deps.timeZone || 'Asia/Kolkata',
    sendEmail: deps.sendEmail || null,
    hashIterations: deps.hashIterations || PBKDF2_ITERATIONS
  };

  /** Run `fn(r)` in one locked transaction. A throw rolls everything back. */
  const run = (fn) => env.sql.begin(async (tx) => {
    const r = await openRequest(tx, env.tz);
    r.env = env;
    return fn(r);
  });

  async function handle(action, payload, token) {
    if (!action) return fail('No action supplied');
    if (action === 'ping') return ok({ service: 'vi-property-manager', version: VERSION, time: nowIso(env.tz) });
    try {
      // Checking a password takes a deliberately slow hash. These two hash
      // outside the request lock, so a flood of sign-in attempts cannot stall
      // everyone else's requests behind it.
      if (action === 'login') return await login(run, env, payload || {});
      if (action === 'changePassword') return await changePassword(run, env, payload || {}, token || '');
      return await run(r => route(r, action, payload || {}, token || ''));
    } catch (err) {
      return fail(describeError(err));
    }
  }

  return {
    handle,
    run,
    env,
    /** The scheduled jobs, for pg_cron (through the function) or a manual run. */
    dailyMaintenanceJob: () => run(r => refreshStatuses(r, SYSTEM_ACTOR, false)),
    dailyReminderJob: () => run(r => dailyReminderJob(r)),
    /** Break-glass: make a phone number an active administrator (scripts/recover-admin.mjs). */
    recoverAccess: (phone, password, name) => run(r => recoverAccess(r, phone, password, name))
  };
}

/** What a caller is told when a request fails. */
function describeError(err) {
  if (!err) return 'Unknown error';
  if (err.name !== 'PostgresError' || !err.code) return err.message || String(err);

  const detail = String(err.detail || '');
  switch (err.code) {
    case '23P01':
      return 'That unit is already let over those dates. Terminate or end that lease first.';
    case '23503': {
      const m = detail.match(/Key \((.+?)\)=\((.+?)\) is not present in table "(.+?)"/);
      if (m) return humanise(m[1]) + ' ' + m[2] + ' does not exist.';
      return 'Cannot delete that record — other records still reference it. Remove or reassign those first.';
    }
    case '23502': return humanise(err.column_name || 'A required value') + ' is required.';
    case '23505':
      if (/phone/.test(err.constraint_name || '')) return 'That phone number already belongs to another user';
      return 'That record already exists.';
    case '23514':
      if (err.constraint_name === 'leases_check') return 'A lease cannot end before it starts.';
      if (err.constraint_name === 'leases_rent_day_check') return 'Rent day must be between the 1st and the 28th, or the last day of the month.';
      return 'A value is not allowed (' + (err.constraint_name || 'check') + ').';
    case '22P02': case '22003': case '22007': case '22008':
      return 'A value is not in the right format or is out of range.';
    case '40001': case '40P01': case '55P03':
      return 'The server was busy. Nothing was saved — please try again.';
    default:
      console.error('database error', err.code, err.message, err.detail || '');
      return 'The database refused that change (' + err.code + '). Nothing was saved.';
  }
}

function humanise(column) {
  const s = String(column).replace(/_id$/, '').replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ────────────────────────────────────────────────────────────────── router ──

const READ_ONLY_ACTIONS = { ping: 1, login: 1, bootstrap: 1, list: 1, me: 1, stats: 1,
                            page: 1, detail: 1, history: 1, report: 1, search: 1, rentCandidates: 1 };

/** Tables written only through their own actions, never the generic create/update/remove. */
const OWN_ACTIONS_ONLY = { RentOffline: 'Mark as billed outside the app on Generate rent' };
export { READ_ONLY_ACTIONS };

async function route(r, action, payload, token) {
  if (action === 'setup') return doSetup(r, payload, token);
  if (action === 'logout') return logout(r, token);

  const user = await requireAuth(r, token);

  if ((action === 'create' || action === 'update' || action === 'remove') && OWN_ACTIONS_ONLY[payload.table]) {
    return fail(payload.table + ' is changed only through ' + OWN_ACTIONS_ONLY[payload.table] + '.');
  }

  switch (action) {
    case 'me':               return ok({ user, settings: await readSettings(r) });
    case 'bootstrap':        return ok(await bootstrap(r, user, payload.known, !!payload.lean));
    case 'list':             return ok({ rows: await readTableForClient(r, assertTable(payload.table), user) });
    case 'page':             return ok(await page(r, payload, user));
    case 'search':           return ok(await globalSearch(r, payload, user));
    case 'detail':           return ok(await detail(r, payload, user));
    case 'history':          return ok(await history(r, payload, user));
    case 'report':           return ok(await reportData(r, payload));
    case 'create':
    case 'update': {
      const written = await writeRow(r, action, payload, user);
      const table = payload.table;
      const row = (await findRow(r, table, written[keyOf(table)])) || written;
      return ok(await withSnapshot(r, payload, user, { row: forClient(table, row, user) }));
    }
    case 'remove':           return ok(await withSnapshot(r, payload, user, { id: await deleteRow(r, payload.table, payload.id, user) }));
    case 'saveInvoice':      return ok(await withSnapshot(r, payload, user, await saveInvoice(r, payload, user)));
    case 'voidInvoice':      return ok(await withSnapshot(r, payload, user, await voidInvoice(r, payload, user)));
    case 'recordPayment':    return ok(await withSnapshot(r, payload, user, await recordPayment(r, payload, user)));
    case 'voidPayment':      return ok(await withSnapshot(r, payload, user, await voidPayment(r, payload.id, user)));
    case 'rentCandidates':   return ok(await rentCandidates(r, payload, user));
    case 'generateRent':     return ok(await withSnapshot(r, payload, user, await generateRent(r, payload, user)));
    case 'markRentOffline':  return ok(await markRentOffline(r, payload, user));
    case 'undoRentOffline':  return ok(await undoRentOffline(r, payload, user));
    case 'chargeLateFee':    return ok(await withSnapshot(r, payload, user, await chargeLateFee(r, payload, user)));
    case 'waiveLateFee':     return ok(await withSnapshot(r, payload, user, await waiveLateFee(r, payload, user)));
    case 'issueDrafts':      return ok(await withSnapshot(r, payload, user, await issueDrafts(r, payload, user)));
    case 'settleDeposit':    return ok(await withSnapshot(r, payload, user, await settleDeposit(r, payload, user)));
    case 'renewLease':       return ok(await withSnapshot(r, payload, user, await renewLease(r, payload, user)));
    case 'saveOccupants':    return ok(await withSnapshot(r, payload, user, await saveOccupants(r, payload, user)));
    case 'setPrimaryTenant': return ok(await withSnapshot(r, payload, user, await setPrimaryTenant(r, payload, user)));
    case 'refreshStatuses':  requireRole(user, 'manager'); return ok(await withSnapshot(r, payload, user, await refreshStatuses(r, user)));
    case 'createUser':       return ok({ row: await createUser(r, payload, user) });
    case 'resetPassword':    return ok(await resetPassword(r, payload, user));
    case 'setUserActive':    return ok({ row: await setUserActive(r, payload, user) });
    case 'setUserRole':      return ok({ row: await setUserRole(r, payload, user) });
    case 'endSessions':      return ok(await endSessions(r, payload, user));
    case 'sendReminders':    return ok(await withSnapshot(r, payload, user, await sendReminders(r, user, { scheduled: false })));
    case 'stats':            return ok(await computeStats(r));
    default: return fail('Unknown action: ' + action);
  }
}

// ─────────────────────────────────────────────────────── paged reads ──

/** A property, unit, tenant or lease page summarises what belongs to it. */
const SCOPE_OF = { Properties: 'property', Units: 'unit', Tenants: 'tenant', Leases: 'lease' };

/** One page of a growing table. The paging rules live in queries.js. */
async function page(r, payload, user) {
  const table = assertTable(payload.table);
  if (!PAGED[table]) throw new Error(table + ' is not paged — it arrives with the rest of the data.');
  requireRole(user, readRoleFor(table));
  return listPage(r, table, payload);
}

/** The shortest search worth sending, the longest kept, and the matches listed per table. */
const SEARCH_MIN = 2, SEARCH_MAX = 100, SEARCH_LIMIT = 5;

/**
 * The search box in the top bar, for the tables the browser does not hold
 * whole. Properties, units, tenants and leases are searched in the browser.
 */
async function globalSearch(r, payload, user) {
  const q = String(payload.q || '').trim().slice(0, SEARCH_MAX);
  if (q.length < SEARCH_MIN) return { q, results: {} };
  const limit = Math.max(1, Math.min(parseInt(payload.limit, 10) || SEARCH_LIMIT, 10));
  const tables = SEARCHED.filter(t => (ROLE_RANK[user.role] || 0) >= ROLE_RANK[readRoleFor(t)]);
  return { q, results: await searchAll(r, q, limit, tables) };
}

/** What a record's own page needs beyond the row list the browser already has. */
async function detail(r, payload, user) {
  const table = assertTable(payload.table);
  requireRole(user, readRoleFor(table));
  if (SCOPE_OF[table]) return scopeSummary(r, SCOPE_OF[table], payload.id);
  if (!PAGED[table] || table === 'ActivityLog' || table === 'InvoiceItems') throw new Error('No page for ' + table);
  const out = await recordDetail(r, table, payload.id);
  // whether the invoice's page can offer to charge or waive its late fee
  if (table === 'Invoices' && out && out.row) {
    const lease = out.row.lease_id ? await findRow(r, 'Leases', out.row.lease_id) : null;
    out.late_fee = lateFeeState(lease, out.row, await rentBook(r), today(r));
  }
  return out;
}

/** A property, unit, tenant or lease's invoices, payments and tickets in full: its timeline and statement. */
async function history(r, payload, user) {
  const table = assertTable(payload.table);
  if (!SCOPE_OF[table]) throw new Error('No history for ' + table);
  requireRole(user, readRoleFor(table));
  return scopeHistory(r, SCOPE_OF[table], payload.id);
}

/**
 * Attach the state the browser would otherwise come straight back for. A write
 * that cascades cannot be applied to the client's cache from the response
 * alone, so the snapshot rides along when asked for. Built through bootstrap(),
 * so it obeys exactly the same role limits.
 */
async function withSnapshot(r, payload, user, data) {
  if (payload && payload.withSnapshot) data.snapshot = await bootstrap(r, user, payload.known, !!payload.lean);
  return data;
}

// ───────────────────────────────────────────────────────────── time ──────

function partsIn(date, tz) {
  const out = {};
  new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(date).forEach(p => { if (p.type !== 'literal') out[p.type] = p.value; });
  return out;
}

/** The current wall-clock time in the app's zone, yyyy-MM-ddTHH:mm:ss. */
export function nowIso(tz) {
  const p = partsIn(new Date(), tz);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}

/** Today's date in the app's zone — what "overdue" and "expired" are measured against. */
export function todayIn(tz) { return nowIso(tz).slice(0, 10); }

const today = (r) => todayIn(r.tz);
const now = (r) => nowIso(r.tz);

// ───────────────────────────────────────────────────────────────── CRUD ────

async function createRow(r, table, data, user, skipLog) {
  assertTable(table);
  requireRole(user, minRoleFor(table));
  const row = { ...data };
  if (!TABLES[table].key) row.id = data.id || (await reserveIds(r, table, 1, await prefixFor(r, table)))[0];
  const saved = await insertRow(r, table, row);
  if (!skipLog) await log(r, user, 'create', table, saved.id, data.name || data.full_name || '');
  return saved;
}

/** Create many rows in one table with a single write. */
async function appendRows(r, table, list, user) {
  assertTable(table);
  requireRole(user, minRoleFor(table));
  if (!list.length) return [];
  const ids = await reserveIds(r, table, list.length, await prefixFor(r, table));
  return insertRows(r, table, list.map((data, i) => ({ ...data, id: ids[i] })));
}

/** The id prefix; for invoices it is the one people see on paper, so it is configurable. */
async function prefixFor(r, table) {
  if (table === 'Invoices') {
    const configured = String((await readSettings(r)).invoice_prefix || '').trim();
    if (configured) return configured;
  }
  return TABLES[table].prefix || 'ROW';
}

/**
 * @param expectedVersion the `_v` the caller last saw. When given and the row
 *   has changed since, nothing is written and a CONFLICT error is thrown.
 */
async function updateRow(r, table, id, data, user, skipLog, expectedVersion) {
  assertTable(table);
  requireRole(user, minRoleFor(table));
  if (table === 'Users' && (data.role !== undefined || data.active !== undefined)) {
    await assertAdminRemains(r, id, data);
  }
  const row = await patchRow(r, table, id, data, expectedVersion);
  if (!skipLog) await log(r, user, 'update', table, id, JSON.stringify(data).slice(0, 200));
  return row;
}

/**
 * Refuse any change that would leave the workspace with no way in. Without
 * this an administrator can delete or demote the only admin account and nobody
 * — including them — can ever sign in again.
 */
async function assertAdminRemains(r, userId, changes) {
  const users = await readTable(r, 'Users');
  let stillAdmin = 0;
  for (const u of users) {
    let role = u.role, active = String(u.active).toLowerCase() !== 'false';
    if (String(u.id) === String(userId)) {
      if (changes === null) continue;                       // being deleted
      if (changes.role !== undefined) role = changes.role;
      if (changes.active !== undefined) active = String(changes.active).toLowerCase() !== 'false';
    }
    if (role === 'admin' && active) stillAdmin++;
  }
  if (stillAdmin === 0) {
    throw new Error('This is the only active administrator. Promote another user first.');
  }
}

async function deleteRow(r, table, id, user) {
  assertTable(table);
  requireRole(user, 'admin');
  if (table === 'Users') await assertAdminRemains(r, id, null);

  // An issued invoice is a numbered document: it is voided, never deleted,
  // so the number sequence has no unexplained gaps. A draft was never sent.
  if (table === 'Invoices') {
    const inv = await findRow(r, 'Invoices', id);
    if (inv && String(inv.status) !== 'Draft') {
      throw new Error('Invoice ' + id + ' has been issued, so it cannot be deleted. Void it instead — ' +
                      'the number stays on record and nothing is owed on it.');
    }
  }

  // Refuse to leave other rows pointing at something that no longer exists.
  // An invoice's own line items are the one exception: they go with it
  // (ON DELETE CASCADE).
  await assertNoDependents(r, table, id);
  if (table === 'Maintenance') {
    for (const e of await readTable(r, 'Expenses')) {
      if (String(e.reference) === String(id) && String(e.category) !== 'Deposit Refund') {
        await deleteRow(r, 'Expenses', e.id, SYSTEM_ACTOR);
      }
    }
  }

  // remember what the deletion will invalidate, before the row is gone
  let affectedInvoice = null;
  if (table === 'Payments') {
    const p = await findRow(r, 'Payments', id);
    if (p) affectedInvoice = p.invoice_id;
  }

  await removeRow(r, table, id);
  await log(r, user, 'delete', table, id, '');

  // Deleting money received has to put the invoice back where it was, or the
  // ledger keeps showing it as settled.
  if (affectedInvoice) await applyInvoiceTotals(r, affectedInvoice, user);
  // Removing a lease frees its unit; removing an occupant may end their tenancy.
  if (table === 'Leases' || table === 'Units' || table === 'LeaseTenants') await refreshStatuses(r, user, true);

  return id;
}

// ── business rules ──────────────────────────────────────────────────────────

/** Statuses a new record starts in, so none lands blank. */
const CREATE_DEFAULTS = {
  Properties:  { status: 'Active' },
  Units:       { status: 'Vacant' },
  Tenants:     { status: 'Active' },
  Invoices:    { status: 'Unpaid' },
  Maintenance: { status: 'Open', priority: 'Medium' },
  Leases:      { frequency: 'Monthly', deposit_status: 'Pending' }
};

/** Rows in other tables that point at this one. Deleting is blocked while any exist. */
const DEPENDENTS = {
  Properties: [['Units', 'property_id', 'unit'], ['Leases', 'property_id', 'lease'],
               ['Invoices', 'property_id', 'invoice'], ['Expenses', 'property_id', 'expense'],
               ['Maintenance', 'property_id', 'maintenance ticket'], ['Documents', 'entity_id', 'document']],
  Units:      [['Leases', 'unit_id', 'lease'], ['Invoices', 'unit_id', 'invoice'],
               ['Maintenance', 'unit_id', 'maintenance ticket'], ['Expenses', 'unit_id', 'expense'],
               ['Documents', 'entity_id', 'document']],
  Tenants:    [['Leases', 'tenant_id', 'lease'], ['LeaseTenants', 'tenant_id', 'shared lease'],
               ['Invoices', 'tenant_id', 'invoice'],
               ['Payments', 'tenant_id', 'payment'], ['Maintenance', 'tenant_id', 'maintenance ticket'],
               ['Documents', 'entity_id', 'document']],
  Leases:     [['Invoices', 'lease_id', 'invoice'], ['Payments', 'lease_id', 'payment'],
               ['Documents', 'entity_id', 'document'], ['Leases', 'renewed_from', 'renewal']],
  Invoices:   [['Payments', 'invoice_id', 'payment']]
};

async function assertNoDependents(r, table, id) {
  const refs = DEPENDENTS[table];
  if (!refs) return;
  const blocking = [];
  let total = 0;
  for (const [other, key, noun] of refs) {
    let n = 0;
    (await readTable(r, other)).forEach(row => { if (String(row[key]) === String(id)) n++; });
    if (n) { blocking.push(n + ' ' + noun + (n === 1 ? '' : 's')); total += n; }
  }
  if (blocking.length) {
    throw new Error('Cannot delete ' + id + ' — ' + blocking.join(' and ') +
                    (total === 1 ? ' still references it. Remove or reassign it first.'
                                 : ' still reference it. Remove or reassign those first.'));
  }
}

/** Where a lease sits today. An explicit termination is never overridden. */
function deriveLeaseStatus(r, startDate, endDate, currentStatus) {
  if (String(currentStatus) === 'Terminated') return 'Terminated';
  const t = today(r);
  if (endDate && String(endDate) < t) return 'Expired';
  if (startDate && String(startDate) > t) return 'Upcoming';
  return 'Active';
}

/**
 * A unit cannot be let to two tenants at once. Leases that have ended or been
 * terminated are ignored; anything still live must not overlap the new dates.
 * (The database enforces the same rule; this gives the friendlier message.)
 */
async function assertUnitIsFree(r, data, selfId) {
  if (!data.unit_id) return;
  if (['Terminated', 'Expired'].indexOf(String(data.status)) >= 0) return;

  const start = String(data.start_date || '');
  const end = String(data.end_date || '9999-12-31');
  let clash = null;
  for (const l of await readTable(r, 'Leases')) {
    if (clash || String(l.id) === String(selfId)) continue;
    if (String(l.unit_id) !== String(data.unit_id)) continue;
    if (['Terminated', 'Expired'].indexOf(String(l.status)) >= 0) continue;
    const s = String(l.start_date || '');
    const e = String(l.end_date || '9999-12-31');
    if (start <= e && s <= end) clash = l;
  }
  if (clash) {
    throw new Error('That unit is already let on lease ' + clash.id + ' (' +
                    (clash.start_date || '?') + ' to ' + (clash.end_date || 'open ended') +
                    '). Terminate or end that lease first.');
  }
}

/**
 * Fill in the property a record belongs to when the form left it blank but it
 * can be worked out from what was chosen, so the P&L adds up to its total.
 */
async function inferProperty(r, data) {
  if (data.property_id) return data.property_id;
  if (data.unit_id) {
    const unit = await findRow(r, 'Units', data.unit_id);
    if (unit && unit.property_id) return unit.property_id;
  }
  if (data.lease_id) {
    const lease = await findRow(r, 'Leases', data.lease_id);
    if (lease && lease.property_id) return lease.property_id;
  }
  return '';
}

/**
 * create/update with the per-table rules the app promises: sensible starting
 * statuses, invoice totals derived rather than typed, lease dates validated and
 * occupancy kept in step.
 */
async function writeRow(r, op, payload, user) {
  const table = assertTable(payload.table);
  return writeRowLocked(r, op, table, payload, user);
}

async function writeRowLocked(r, op, table, payload, user) {
  const data = { ...(payload.data || {}) };

  // Ids are issued here, never taken from the browser.
  if (op === 'create') delete data.id;

  if (op === 'create' && CREATE_DEFAULTS[table]) {
    const defaults = CREATE_DEFAULTS[table];
    Object.keys(defaults).forEach(k => {
      if (data[k] === '' || data[k] === null || data[k] === undefined) data[k] = defaults[k];
    });
  }

  // An occupant saved on its own (the lease form saves them with the lease).
  if (table === 'LeaseTenants') {
    const row = await writeOccupant(r, op, payload.id, data, user, payload.expected_version);
    await refreshStatuses(r, user, true);
    return (await findRow(r, table, row.id)) || row;
  }

  if (table === 'Tenants' && data.gstin !== undefined) data.gstin = assertGstin(data.gstin, 'The tenant\'s GSTIN');
  if (table === 'Settings' && String(payload.id || data.key) === 'gstin' && data.value !== undefined) {
    data.value = assertGstin(data.value, 'Your GSTIN');
  }
  if (table === 'Settings' && String(payload.id || data.key) === 'upi_id' && data.value !== undefined) {
    data.value = assertUpiId(data.value);
  }

  if (table === 'Invoices') {
    const amount = parseFloat(data.amount || 0) || 0;
    const tax = parseFloat(data.tax || 0) || 0;
    if (data.total === '' || data.total === null || data.total === undefined) {
      data.total = round2(amount + tax);
    }
    if (op === 'create' || data.property_id !== undefined || data.unit_id !== undefined || data.lease_id !== undefined) {
      data.property_id = await inferProperty(r, data);
    }
  }

  if (table === 'Maintenance') {
    if (op === 'create' && !data.reported_date) data.reported_date = today(r);
    // A ticket closed without a completion date dates its cost by when it was
    // reported, which can drop the spend into the wrong reporting period.
    if (['Resolved', 'Closed'].indexOf(String(data.status)) >= 0 && !data.completed_date) {
      data.completed_date = today(r);
    }
  }

  if (table === 'Invoices' && op === 'update' && String(data.status) === 'Void') {
    await assertVoidable(r, payload.id);
  }
  // nothing is owed on a void invoice — the database refuses one with a balance
  if (table === 'Invoices' && String(data.status) === 'Void') data.balance = 0;

  let before = null;
  if (table === 'Leases') {
    let merged = data;
    if (op === 'update') {
      // validate against the row as it will be, not just the fields that changed
      before = await findRow(r, 'Leases', payload.id);
      if (before) merged = { ...before, ...data };
    }
    if (merged.start_date && merged.end_date && String(merged.end_date) < String(merged.start_date)) {
      throw new Error('A lease cannot end before it starts.');
    }
    // Every lease bills on its rent day (rent.js), so a new lease needs one and
    // a save that sends it cannot clear it. A lease from before rent days were
    // required keeps working — status updates and the like — until it is set.
    if (op === 'create' || data.rent_day !== undefined) {
      const given = merged.rent_day;
      if (given === '' || given === null || given === undefined) {
        throw new Error('Rent day is required — the day of the month the rent is due.');
      }
      if (validRentDay(given) === null) {
        throw new Error('Rent day must be between the 1st and the 28th, or the last day of the month.');
      }
    }
    data.status = deriveLeaseStatus(r, merged.start_date, merged.end_date, merged.status);
    merged.status = data.status;
    await assertUnitIsFree(r, merged, op === 'update' ? payload.id : null);
    await assertDepositStatusChange(r, before, merged);
    if (before) await assertDepositAmountChange(r, before, merged);
  }

  let paymentBefore = null;
  if (table === 'Payments') {
    if (op === 'update') paymentBefore = await findRow(r, 'Payments', payload.id);
    if (paymentBefore) assertPaymentEditAllowed(user, paymentBefore, data);
    await preparePayment(r, data, paymentBefore);
  }

  let row = op === 'create'
    ? await createRow(r, table, data, user)
    : await updateRow(r, table, payload.id, data, user, false, payload.expected_version);

  // Recompute paid/balance/status from the payments so the figures can never
  // be inconsistent with the money actually received.
  if (table === 'Invoices' && String(row.status) !== 'Draft') {
    row = (await applyInvoiceTotals(r, row.id, user)) || row;
  }
  // The same holds for a payment saved from the Payments page rather than from
  // an invoice: the invoice it settles, and the one it was moved off, if any.
  if (table === 'Payments') {
    if (row.invoice_id) await applyInvoiceTotals(r, row.invoice_id, user);
    if (paymentBefore && paymentBefore.invoice_id &&
        String(paymentBefore.invoice_id) !== String(row.invoice_id)) {
      await applyInvoiceTotals(r, paymentBefore.invoice_id, user);
    }
  }
  // Everyone else living on the lease, saved in the same transaction: a lease
  // is never left with half its household. A form that does not send the list
  // leaves the occupants as they are — except that a new primary tenant can no
  // longer be listed as an occupant of their own lease.
  if (table === 'Leases') {
    if (Array.isArray(payload.occupants)) {
      await syncOccupants(r, row.id, payload.occupants, user, payload.occupants_seen);
    } else if (before && String(before.tenant_id) !== String(row.tenant_id)) {
      for (const o of await occupantsOf(r, row.id)) {
        if (String(o.tenant_id) !== String(row.tenant_id)) continue;
        await removeRow(r, 'LeaseTenants', o.id);
        await log(r, user, 'occupant-removed', 'Leases', row.id, o.tenant_id + ' · now the primary tenant');
      }
    }
  }

  // Occupancy is derived from leases, so it has to be re-derived as soon as one
  // changes — not left until the next page load.
  if (table === 'Leases' || table === 'Units') await refreshStatuses(r, user, true);

  if (table === 'Leases') {
    // Signing a lease with a deposit makes that deposit due, like the first
    // rent — unless it is already marked as collected.
    const collected = String(row.deposit_status) !== 'Pending' && String(row.deposit_status) !== '';
    if (!collected && (op === 'create' || (before && !(num(before.deposit_amount) > 0)))) {
      await raiseDepositInvoice(r, row, user);
    }
    // a changed deposit re-prices its invoice while nothing has been paid past it
    if (before && num(before.deposit_amount) > 0 && round2(num(before.deposit_amount)) !== round2(num(row.deposit_amount))) {
      await repriceDepositInvoice(r, row, user);
    }
  }

  // A finished ticket's cost becomes an ordinary expense, so it is counted in
  // exactly one place.
  if (table === 'Maintenance') await recordMaintenanceExpense(r, row, user);

  // Marking a deposit refunded from the lease form returns whatever is still
  // held. Deductions go through settleDeposit instead.
  if (table === 'Leases' && before && String(row.deposit_status) === 'Refunded' &&
      String(before.deposit_status) !== 'Refunded') {
    await recordDepositRefund(r, row, user);
  }

  return (await findRow(r, table, row[keyOf(table)])) || row;
}

function num(v) { return parseFloat(v || 0) || 0; }

/**
 * Raise the invoice for a lease's security deposit, once per lease. Billing it
 * like rent means it shows up in outstanding until paid, and only then counts
 * as held.
 */
async function raiseDepositInvoice(r, lease, user) {
  const amount = round2(parseFloat(lease.deposit_amount || 0) || 0);
  if (amount <= 0) return null;

  const already = (await readTable(r, 'Invoices')).some(inv =>
    String(inv.lease_id) === String(lease.id) && String(inv.type) === 'Deposit');
  if (already) return null;

  const invoice = await createRow(r, 'Invoices', {
    lease_id: lease.id, tenant_id: lease.tenant_id, unit_id: lease.unit_id,
    property_id: lease.property_id, type: 'Deposit',
    issue_date: lease.start_date || today(r), due_date: lease.start_date || today(r),
    amount, tax: 0, total: amount, amount_paid: 0, balance: amount,
    status: 'Unpaid', notes: 'Security deposit for lease ' + lease.id
  }, user, true);

  await createRow(r, 'InvoiceItems', {
    invoice_id: invoice.id, description: 'Security deposit',
    category: 'Deposit', quantity: 1, unit_amount: amount, amount, notes: ''
  }, user, true);

  await log(r, user, 'deposit-invoiced', 'Invoices', invoice.id, 'lease ' + lease.id + ' · ' + amount);
  // a lease entered after it began has a deposit that is already overdue
  return (await applyInvoiceTotals(r, invoice.id, user)) || invoice;
}

/**
 * Keep a lease's deposit_status in step with whether its deposit invoice has
 * been paid, so "deposits held" only ever counts money actually received.
 */
async function syncDepositStatus(r, invoice) {
  if (String(invoice.type) !== 'Deposit' || !invoice.lease_id) return;
  const lease = await findRow(r, 'Leases', invoice.lease_id);
  if (!lease) return;
  if (DEPOSIT_SETTLED.indexOf(String(lease.deposit_status)) >= 0) return;

  const want = String(invoice.status) === 'Paid' ? 'Held' : 'Pending';
  if (String(lease.deposit_status) !== want) {
    await updateRow(r, 'Leases', lease.id, { deposit_status: want }, SYSTEM_ACTOR, true);
  }
}

/**
 * Book a completed maintenance ticket's cost as an expense, linked back by
 * `reference`, so re-saving the ticket updates the same row.
 */
const MAINTENANCE_EXPENSE_CATEGORY = { Cleaning: 'Cleaning', Security: 'Security', Other: 'Other' };

async function recordMaintenanceExpense(r, ticket) {
  const cost = round2(parseFloat(ticket.cost || 0) || 0);
  const done = ['Resolved', 'Closed'].indexOf(String(ticket.status)) >= 0;

  let existing = null;
  (await readTable(r, 'Expenses')).forEach(e => {
    if (String(e.reference) === String(ticket.id) && String(e.category) !== 'Deposit Refund') existing = e;
  });

  // not finished, or nothing spent: make sure no stale expense is left behind
  if (!done || cost <= 0) {
    if (existing) await deleteRow(r, 'Expenses', existing.id, SYSTEM_ACTOR);
    return null;
  }

  const row = {
    property_id: ticket.property_id, unit_id: ticket.unit_id,
    date: ticket.completed_date || today(r),
    category: MAINTENANCE_EXPENSE_CATEGORY[String(ticket.category)] || 'Repairs',
    description: ticket.title + (ticket.vendor_name ? ' · ' + ticket.vendor_name : ''),
    vendor: ticket.vendor_name || '', amount: cost, reference: ticket.id
  };
  return existing
    ? updateRow(r, 'Expenses', existing.id, row, SYSTEM_ACTOR, true)
    : createRow(r, 'Expenses', row, SYSTEM_ACTOR, true);
}

/**
 * Validate a payment saved from the Payments page, and tie it to its invoice.
 * A payment with no invoice is money on account and is left as entered.
 */
/**
 * Taking money back is an administrator's call — voidPayment and deleting a
 * payment both need admin — so lowering a recorded amount to nothing, or moving
 * it off its invoice, must not be open to a manager through a plain edit.
 */
function assertPaymentEditAllowed(user, before, data) {
  if (ROLE_RANK[user.role] >= ROLE_RANK.admin) return;
  const amountChanged = data.amount !== undefined && round2(num(data.amount)) !== round2(num(before.amount));
  const invoiceChanged = data.invoice_id !== undefined && String(data.invoice_id || '') !== String(before.invoice_id || '');
  if (amountChanged || invoiceChanged) {
    throw new Error('Only an administrator can change the amount or invoice of a recorded payment. ' +
                    'Ask an administrator to void it, then record the correct payment.');
  }
}

async function preparePayment(r, data, before) {
  const invoiceId = data.invoice_id !== undefined ? data.invoice_id : (before ? before.invoice_id : '');
  if (!invoiceId) return;

  const invoice = await findRow(r, 'Invoices', invoiceId);
  if (!invoice) throw new Error('Invoice ' + invoiceId + ' not found');

  const amount = round2(parseFloat(data.amount !== undefined ? data.amount : (before ? before.amount : 0)) || 0);
  if (!(amount > 0)) throw new Error('Payment amount must be greater than zero');

  const alreadyOnIt = before && String(before.invoice_id) === String(invoiceId)
    ? round2(parseFloat(before.amount || 0) || 0) : 0;
  const changesMoney = !before || alreadyOnIt !== amount || String(before.invoice_id) !== String(invoiceId);
  if (changesMoney) {
    if (String(invoice.status) === 'Void') throw new Error('That invoice is void.');
    if (String(invoice.status) === 'Draft') throw new Error(invoice.id + ' is still a draft. Issue it before taking payment.');
    const room = round2((parseFloat(invoice.balance || 0) || 0) + alreadyOnIt);
    if (amount > room + 0.009) {
      throw new Error('That is more than the ' + room + ' still owed on ' + invoice.id +
                      '. To spread a larger payment over several invoices, record it from the invoice.');
    }
  }

  // the invoice decides whose money this is, as it does for recordPayment
  data.tenant_id = invoice.tenant_id;
  data.lease_id = invoice.lease_id;
  data.property_id = invoice.property_id || await inferProperty(r, invoice);
}

// ── deposits ────────────────────────────────────────────────────────────────

/** Deposit statuses the app sets itself, once money has moved. */
const DEPOSIT_SETTLED = ['Refunded', 'Partially Refunded', 'Forfeited', 'Transferred'];

/**
 * Where a lease's security deposit stands, from the records rather than from
 * its status field: received, applied at move-out, refunded, and still held.
 * A deposit is money held for the tenant, not income.
 */
async function depositLedger(r, lease) {
  let paid = 0, hasInvoice = false;
  (await readTable(r, 'Invoices')).forEach(inv => {
    if (String(inv.lease_id) === String(lease.id) && String(inv.type) === 'Deposit' && String(inv.status) !== 'Void') {
      hasInvoice = true;
      paid += num(inv.amount_paid);
    }
  });
  const status = String(lease.deposit_status || '');
  const received = paid > 0 ? paid : (status && status !== 'Pending' ? num(lease.deposit_amount) : 0);

  let applied = 0, refunded = 0;
  (await readTable(r, 'Payments')).forEach(p => {
    if (String(p.method) === 'Deposit Adjustment' && String(p.reference) === String(lease.id)) applied += num(p.amount);
  });
  (await readTable(r, 'Expenses')).forEach(e => {
    if (String(e.category) === 'Deposit Refund' && String(e.reference) === String(lease.id)) refunded += num(e.amount);
  });

  const held = status === 'Transferred' ? 0 : round2(received - applied - refunded);
  return { received: round2(received), applied: round2(applied), refunded: round2(refunded),
           held: Math.max(0, held), hasInvoice };
}

/** depositLedger for many leases in one pass over the tables — for the dashboard figures. */
async function depositLedgers(r, leases) {
  const paid = {}, applied = {}, refunded = {};
  (await readTable(r, 'Invoices')).forEach(inv => {
    if (String(inv.type) === 'Deposit' && String(inv.status) !== 'Void') paid[inv.lease_id] = (paid[inv.lease_id] || 0) + num(inv.amount_paid);
  });
  (await readTable(r, 'Payments')).forEach(p => {
    if (String(p.method) === 'Deposit Adjustment') applied[p.reference] = (applied[p.reference] || 0) + num(p.amount);
  });
  (await readTable(r, 'Expenses')).forEach(e => {
    if (String(e.category) === 'Deposit Refund') refunded[e.reference] = (refunded[e.reference] || 0) + num(e.amount);
  });
  const out = {};
  leases.forEach(l => {
    const status = String(l.deposit_status || '');
    const received = paid[l.id] > 0 ? paid[l.id] : (status && status !== 'Pending' ? num(l.deposit_amount) : 0);
    const held = status === 'Transferred' ? 0 : round2(received - (applied[l.id] || 0) - (refunded[l.id] || 0));
    out[l.id] = { received: round2(received), applied: round2(applied[l.id] || 0),
                  refunded: round2(refunded[l.id] || 0), held: Math.max(0, held) };
  });
  return out;
}

/**
 * The statuses that record money leaving the deposit are written by
 * settleDeposit and renewLease, which book the money that goes with them.
 * Refunded stays allowed from the form — it returns the whole balance.
 */
async function assertDepositStatusChange(r, before, merged) {
  const was = before ? String(before.deposit_status || '') : '';
  const now_ = String(merged.deposit_status || '');
  if (now_ === was) return;
  if (['Partially Refunded', 'Forfeited', 'Transferred'].indexOf(now_) >= 0) {
    throw new Error('Use "Settle deposit" on the lease to record deductions and refunds — ' +
                    'it books the money as well as the status.');
  }
  if (now_ === 'Refunded' && before && (await depositLedger(r, before)).held <= 0) {
    throw new Error('No deposit is held on ' + before.id + ', so there is nothing to refund. ' +
                    'Record the deposit payment first, or mark it Held if it was collected outside the app.');
  }
}

/** A deposit cannot be cut below what has already been paid against it. */
async function assertDepositAmountChange(r, before, merged) {
  if (round2(num(before.deposit_amount)) === round2(num(merged.deposit_amount))) return;
  let paid = 0;
  (await readTable(r, 'Invoices')).forEach(inv => {
    if (String(inv.lease_id) === String(before.id) && String(inv.type) === 'Deposit' && String(inv.status) !== 'Void') {
      paid += num(inv.amount_paid);
    }
  });
  if (num(merged.deposit_amount) < paid - 0.009) {
    throw new Error(round2(paid) + ' of the deposit has already been received on ' + before.id +
                    ', so it cannot be reduced below that.');
  }
}

/**
 * Keep the Deposit invoice in step with the lease's deposit. It is re-priced
 * rather than replaced, so its number and any part payment stay; a deposit
 * taken away before anything was paid voids it.
 */
async function repriceDepositInvoice(r, lease, user) {
  const amount = round2(num(lease.deposit_amount));
  for (const inv of await readTable(r, 'Invoices')) {
    if (String(inv.lease_id) !== String(lease.id) || String(inv.type) !== 'Deposit' || String(inv.status) === 'Void') continue;
    if (amount <= 0 && num(inv.amount_paid) <= 0) {
      await updateRow(r, 'Invoices', inv.id, { status: 'Void', balance: 0, notes: 'Deposit removed from lease ' + lease.id }, SYSTEM_ACTOR, true);
      await applyInvoiceTotals(r, inv.id, user);
      continue;
    }
    let line = null;
    (await itemsOfInvoice(r, inv.id)).forEach(it => { if (String(it.category) === 'Deposit') line = it; });
    if (line) {
      await updateRow(r, 'InvoiceItems', line.id, { unit_amount: amount, amount, quantity: 1 }, SYSTEM_ACTOR, true);
    }
    await updateRow(r, 'Invoices', inv.id, { amount }, SYSTEM_ACTOR, true);
    await applyInvoiceTotals(r, inv.id, user);
    await log(r, user, 'deposit-repriced', 'Invoices', inv.id, 'lease ' + lease.id + ' · ' + amount);
  }
}

/** Marking a deposit Refunded from the lease form pays back whatever is still held. */
async function recordDepositRefund(r, lease, user) {
  const amount = (await depositLedger(r, lease)).held;
  if (amount <= 0) return null;
  const tenant = await findRow(r, 'Tenants', lease.tenant_id);
  return createRow(r, 'Expenses', {
    property_id: lease.property_id, unit_id: lease.unit_id, date: today(r),
    category: 'Deposit Refund',
    description: 'Security deposit returned' + (tenant ? ' to ' + tenant.full_name : '') +
                 ' · lease ' + lease.id,
    amount, reference: lease.id
  }, user, true);
}

/**
 * Move-out: settle a lease's deposit in one step — apply it to arrears, charge
 * deductions on a "Deposit Deduction" invoice paid from it, refund the rest,
 * and optionally end the lease.
 */
async function settleDeposit(r, payload, user) {
  requireRole(user, 'manager');
  const lease = await findRow(r, 'Leases', payload.lease_id);
  if (!lease) throw new Error('Lease ' + payload.lease_id + ' not found');
  const ledger = await depositLedger(r, lease);
  if (ledger.held <= 0.009) throw new Error('No deposit is held on ' + lease.id + ', so there is nothing to settle.');

  const date = String(payload.settlement_date || today(r)).slice(0, 10);
  let remaining = ledger.held;
  const applied = [];

  const adjust = async (invoice, amount, note) => {
    await createRow(r, 'Payments', {
      invoice_id: invoice.id, lease_id: invoice.lease_id || lease.id, tenant_id: invoice.tenant_id,
      property_id: invoice.property_id || lease.property_id, payment_date: date,
      amount: round2(amount), method: 'Deposit Adjustment', reference: lease.id,
      received_by: user.name || user.phone || '', notes: note
    }, user, true);
    await applyInvoiceTotals(r, invoice.id, user);
    applied.push({ invoice_id: invoice.id, amount: round2(amount) });
    remaining = round2(remaining - amount);
  };

  if (payload.apply_to_arrears) {
    // the primary tenant's arrears, and anything still owed on this lease by
    // whoever was primary when it was billed
    const owing = (await readTable(r, 'Invoices'))
      .filter(i => (String(i.tenant_id) === String(lease.tenant_id) || String(i.lease_id) === String(lease.id)) &&
                   String(i.type) !== 'Deposit' &&
                   ['Unpaid', 'Partial', 'Overdue'].indexOf(String(i.status)) >= 0 && num(i.balance) > 0)
      .sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)));
    for (const inv of owing) {
      if (remaining <= 0.009) break;
      await adjust(inv, Math.min(remaining, round2(num(inv.balance))), 'Settled from the security deposit of ' + lease.id);
    }
  }

  let deductionInvoice = null;
  const deductions = (payload.deductions || []).filter(d => String(d.description || '').trim() && num(d.amount) > 0);
  if (deductions.length) {
    deductionInvoice = (await saveInvoice(r, {
      data: { tenant_id: lease.tenant_id, lease_id: lease.id, unit_id: lease.unit_id,
              property_id: lease.property_id, type: 'Deposit Deduction',
              issue_date: date, due_date: date,
              notes: 'Deductions from the security deposit of ' + lease.id },
      items: deductions.map(d => ({ description: String(d.description).trim(), category: d.category || 'Other',
                                    quantity: 1, unit_amount: round2(num(d.amount)), tax_rate: 0 }))
    }, user)).invoice;
    if (remaining > 0.009) {
      await adjust(deductionInvoice, Math.min(remaining, round2(num(deductionInvoice.balance))),
                   'Deducted from the security deposit of ' + lease.id);
    }
    deductionInvoice = await findRow(r, 'Invoices', deductionInvoice.id);
  }

  const refund = remaining > 0.009 ? round2(remaining) : 0;
  let refundRow = null;
  if (refund > 0) {
    const tenant = await findRow(r, 'Tenants', lease.tenant_id);
    refundRow = await createRow(r, 'Expenses', {
      property_id: lease.property_id, unit_id: lease.unit_id, date, category: 'Deposit Refund',
      vendor: tenant ? tenant.full_name : '', payment_method: payload.refund_method || '',
      description: 'Security deposit returned' + (tenant ? ' to ' + tenant.full_name : '') + ' · lease ' + lease.id +
                   (payload.refund_reference ? ' · ref ' + payload.refund_reference : ''),
      amount: refund, reference: lease.id
    }, user, true);
  }

  const changes = {
    deposit_status: refund >= ledger.held - 0.009 ? 'Refunded' : (refund > 0 ? 'Partially Refunded' : 'Forfeited')
  };
  if (payload.end_lease && ['Active', 'Upcoming'].indexOf(String(lease.status)) >= 0) {
    changes.status = 'Terminated';
    const moveOut = String(payload.move_out_date || date).slice(0, 10);
    if (!lease.end_date || moveOut < String(lease.end_date)) changes.end_date = moveOut;
  }
  await updateRow(r, 'Leases', lease.id, changes, SYSTEM_ACTOR, true);
  if (changes.status) await refreshStatuses(r, user, true);

  await log(r, user, 'deposit-settled', 'Leases', lease.id,
            'held ' + ledger.held + ' · applied ' + round2(ledger.held - remaining) + ' · refunded ' + refund);
  return {
    lease: await findRow(r, 'Leases', lease.id),
    held: ledger.held, applied, refunded: refund,
    deduction_invoice: deductionInvoice, refund: refundRow
  };
}

/**
 * Renew a lease: the next agreement for the same unit and tenant, starting the
 * day after this one ends, at the escalated rent. The deposit can be carried
 * over — the old lease is marked Transferred and the new one Held.
 */
async function renewLease(r, payload, user) {
  requireRole(user, 'manager');
  const old = await findRow(r, 'Leases', payload.id);
  if (!old) throw new Error('Lease ' + payload.id + ' not found');
  if (String(old.status) === 'Terminated') throw new Error(old.id + ' was terminated, so it cannot be renewed.');
  if (!old.end_date) throw new Error(old.id + ' has no end date — it is still running, so there is nothing to renew.');

  const start = String(payload.start_date || fmtDate(addDays(parseDate(old.end_date), 1))).slice(0, 10);
  const end = String(payload.end_date || '').slice(0, 10);
  if (!end) throw new Error('Choose when the renewed lease ends.');
  if (start <= String(old.end_date)) {
    throw new Error('The renewal must start after ' + old.id + ' ends on ' + old.end_date + '.');
  }

  const carry = payload.carry_deposit !== false;
  const held = carry ? (await depositLedger(r, old)).held : 0;
  const rent = payload.rent_amount !== undefined && payload.rent_amount !== ''
    ? round2(num(payload.rent_amount)) : round2(currentMonthlyRent(r, old, old.end_date));

  const renewed = await writeRowLocked(r, 'create', 'Leases', { table: 'Leases', data: {
    property_id: old.property_id, unit_id: old.unit_id, tenant_id: old.tenant_id,
    start_date: start, end_date: end, rent_amount: rent,
    deposit_amount: carry ? held : num(payload.deposit_amount),
    deposit_status: carry && held > 0 ? 'Held' : 'Pending',
    frequency: payload.frequency || old.frequency,
    rent_day: payload.rent_day !== undefined && payload.rent_day !== '' ? payload.rent_day : old.rent_day,
    late_fee: old.late_fee, grace_days: old.grace_days,
    escalation_pct: payload.escalation_pct !== undefined && payload.escalation_pct !== ''
      ? payload.escalation_pct : old.escalation_pct,
    gst_rate: old.gst_rate, renewed_from: old.id,
    notes: 'Renewal of ' + old.id + (carry && held > 0 ? ' · deposit of ' + held + ' carried over' : '')
  } }, user);

  if (carry && held > 0) {
    await updateRow(r, 'Leases', old.id, { deposit_status: 'Transferred' }, SYSTEM_ACTOR, true);
  }

  // The household renews with the lease: everyone still living there when it
  // ended moves onto the new one. Someone who moved out stays on the old lease.
  let carried = 0;
  if (payload.carry_occupants !== false) {
    for (const o of await occupantsOf(r, old.id)) {
      if (o.move_out_date && String(o.move_out_date) <= String(old.end_date)) continue;
      await writeOccupant(r, 'create', null, {
        lease_id: renewed.id, tenant_id: o.tenant_id, role: o.role, relationship: o.relationship, notes: o.notes
      }, user, null, true);
      carried++;
    }
    if (carried) await refreshStatuses(r, user, true);
  }

  await log(r, user, 'lease-renewed', 'Leases', renewed.id, 'from ' + old.id + ' · rent ' + rent +
            (carried ? ' · ' + carried + ' occupant' + (carried === 1 ? '' : 's') + ' carried over' : ''));
  return { lease: await findRow(r, 'Leases', renewed.id), previous: await findRow(r, 'Leases', old.id) };
}

// ── lease occupants ─────────────────────────────────────────────────────────
//
// A lease has one primary tenant (leases.tenant_id) — the person billed — and
// any number of others living there, each a LeaseTenants row pointing at their
// own tenant record. Nothing about billing reads these rows.

const OCCUPANT_ROLES = ['Co-tenant', 'Occupant'];
const OCCUPANT_FIELDS = ['tenant_id', 'role', 'relationship', 'move_in_date', 'move_out_date', 'notes'];

/** More than any real household; a guard against a runaway client, not a business rule. */
export const MAX_OCCUPANTS = 20;

/** The occupants of one lease, in the order they were added. */
async function occupantsOf(r, leaseId) {
  return (await readTable(r, 'LeaseTenants')).filter(o => String(o.lease_id) === String(leaseId));
}

/** Everything that must hold for one occupant row, checked against the row as it will be saved. */
async function assertOccupantAllowed(r, row, selfId) {
  if (!row.lease_id) throw new Error('Choose the lease this person lives on.');
  if (!row.tenant_id) throw new Error('Choose the person living on the lease.');
  const lease = await findRow(r, 'Leases', row.lease_id);
  if (!lease) throw new Error('Lease ' + row.lease_id + ' does not exist.');
  const tenant = await findRow(r, 'Tenants', row.tenant_id);
  if (!tenant) throw new Error('Tenant ' + row.tenant_id + ' does not exist.');
  const who = tenant.full_name || tenant.id;

  if (String(lease.tenant_id) === String(row.tenant_id)) {
    throw new Error(who + ' is the primary tenant on ' + lease.id + ', so they cannot also be listed as an occupant.');
  }
  if (row.role && OCCUPANT_ROLES.indexOf(String(row.role)) < 0) {
    throw new Error('An occupant is either a Co-tenant or an Occupant, not "' + row.role + '".');
  }
  const moveIn = String(row.move_in_date || ''), moveOut = String(row.move_out_date || '');
  if (moveIn && moveOut && moveOut < moveIn) throw new Error(who + ' cannot move out before they move in.');
  if (moveOut && lease.start_date && moveOut < String(lease.start_date)) {
    throw new Error(who + '\'s move-out date is before ' + lease.id + ' starts on ' + lease.start_date + '.');
  }
  if (moveIn && lease.end_date && moveIn > String(lease.end_date)) {
    throw new Error(who + '\'s move-in date is after ' + lease.id + ' ends on ' + lease.end_date + '.');
  }

  const others = (await occupantsOf(r, lease.id)).filter(o => String(o.id) !== String(selfId || ''));
  if (others.some(o => String(o.tenant_id) === String(row.tenant_id))) {
    throw new Error(who + ' is already on ' + lease.id + '.');
  }
  if (!selfId && others.length >= MAX_OCCUPANTS) {
    throw new Error(lease.id + ' already has ' + MAX_OCCUPANTS + ' occupants besides the primary tenant.');
  }
}

/**
 * Create or update one occupant, validated. Statuses are left to the caller,
 * which re-derives them once for however many rows it wrote.
 */
async function writeOccupant(r, op, id, data, user, expectedVersion, skipLog) {
  requireRole(user, minRoleFor('LeaseTenants'));
  const clean = {};
  for (const k of OCCUPANT_FIELDS.concat('lease_id')) if (data[k] !== undefined) clean[k] = data[k];
  if (clean.relationship !== undefined) clean.relationship = String(clean.relationship || '').trim().slice(0, 60);
  if (op === 'create') {
    if (!clean.role) clean.role = 'Co-tenant';
    await assertOccupantAllowed(r, clean, null);
    const row = await createRow(r, 'LeaseTenants', clean, user, true);
    if (!skipLog) await log(r, user, 'occupant-added', 'Leases', row.lease_id, row.tenant_id + ' · ' + row.role);
    return row;
  }
  const before = await findRow(r, 'LeaseTenants', id);
  if (!before) throw new Error('Occupant ' + id + ' not found — someone may have removed them. Reopen the lease to see who is on it.');
  // an occupant cannot be moved to another lease; remove and add them instead
  delete clean.lease_id;
  await assertOccupantAllowed(r, { ...before, ...clean }, id);
  const row = await updateRow(r, 'LeaseTenants', id, clean, user, true, expectedVersion);
  if (!skipLog) await log(r, user, 'occupant-updated', 'Leases', row.lease_id, row.tenant_id + ' · ' + row.role);
  return row;
}

/**
 * Make a lease's occupants match `list`. A row with an `id` is updated (and
 * refused if it changed since `_v`), one without is added, and one that was on
 * the lease but is no longer listed is removed.
 *
 * @param seen the occupant ids the form was opened with. When given, only those
 *   can be removed, so someone added by another user meanwhile is kept rather
 *   than silently dropped.
 */
async function syncOccupants(r, leaseId, list, user, seen) {
  requireRole(user, minRoleFor('LeaseTenants'));
  if (!Array.isArray(list)) throw new Error('Occupants must be a list.');
  if (list.length > MAX_OCCUPANTS) throw new Error('A lease can list at most ' + MAX_OCCUPANTS + ' occupants besides the primary tenant.');

  const people = new Set();
  for (const o of list) {
    const t = String((o && o.tenant_id) || '');
    if (!t) throw new Error('Choose a person for every occupant, or remove the empty row.');
    if (people.has(t)) {
      const tenant = await findRow(r, 'Tenants', t);
      throw new Error((tenant ? tenant.full_name : t) + ' is listed twice.');
    }
    people.add(t);
  }

  const current = await occupantsOf(r, leaseId);
  const listed = new Set(list.filter(o => o.id).map(o => String(o.id)));
  const removable = Array.isArray(seen) ? new Set(seen.map(String)) : null;
  // removals first, so someone taken off and added back never meets their old row
  for (const o of current) {
    if (listed.has(String(o.id))) continue;
    if (removable && !removable.has(String(o.id))) continue;
    await removeRow(r, 'LeaseTenants', o.id);
    await log(r, user, 'occupant-removed', 'Leases', leaseId, o.tenant_id);
  }
  const mine = new Set(current.map(o => String(o.id)));
  for (const o of list) {
    const data = { ...o, lease_id: leaseId };
    if (o.id) {
      if (!mine.has(String(o.id))) {
        throw new Error('Occupant ' + o.id + ' is not on ' + leaseId + ' — someone may have removed them. ' +
                        'Reopen the lease to see who is on it.');
      }
      await writeOccupant(r, 'update', o.id, data, user, o._v);
    } else {
      await writeOccupant(r, 'create', null, data, user);
    }
  }
  return occupantsOf(r, leaseId);
}

/** The lease page's "Manage occupants": the whole list, saved at once. */
async function saveOccupants(r, payload, user) {
  requireRole(user, 'manager');
  const lease = await findRow(r, 'Leases', payload.lease_id);
  if (!lease) throw new Error('Lease ' + payload.lease_id + ' not found');
  const occupants = await syncOccupants(r, lease.id, payload.occupants || [], user, payload.occupants_seen);
  await refreshStatuses(r, user, true);
  return { lease: await findRow(r, 'Leases', lease.id), occupants };
}

/**
 * Hand the lease to one of its occupants: they become the primary tenant, and
 * the previous primary takes their place among the occupants as a Co-tenant.
 * Invoices already raised stay with whoever they were billed to; rent from now
 * on is billed to the new primary.
 */
async function setPrimaryTenant(r, payload, user) {
  requireRole(user, 'manager');
  const lease = await findRow(r, 'Leases', payload.lease_id);
  if (!lease) throw new Error('Lease ' + payload.lease_id + ' not found');
  if (['Terminated', 'Expired'].indexOf(String(lease.status)) >= 0) {
    throw new Error(lease.id + ' has ended, so its primary tenant can no longer change.');
  }
  const occupant = (await occupantsOf(r, lease.id)).find(o => String(o.tenant_id) === String(payload.tenant_id));
  if (!occupant) throw new Error('That person is not on ' + lease.id + '. Add them as an occupant first.');
  if (occupant.move_out_date && String(occupant.move_out_date) < today(r)) {
    throw new Error('They moved out on ' + occupant.move_out_date + ', so they cannot become the primary tenant.');
  }
  const previous = lease.tenant_id;
  // the lease first, with the version the page was opened on: a change made
  // meanwhile is refused before anything is written
  await updateRow(r, 'Leases', lease.id, { tenant_id: occupant.tenant_id }, user, true, payload.expected_version);
  await updateRow(r, 'LeaseTenants', occupant.id, {
    tenant_id: previous, role: 'Co-tenant', move_in_date: '', move_out_date: ''
  }, user, true);
  await refreshStatuses(r, user, true);
  await log(r, user, 'primary-tenant-changed', 'Leases', lease.id, previous + ' → ' + occupant.tenant_id);
  return { lease: await findRow(r, 'Leases', lease.id), occupants: await occupantsOf(r, lease.id) };
}

/** The monthly rent in force on a date, with annual escalation compounded from the lease start. */
export function currentMonthlyRent(r, lease, onDate) {
  return rentOn(lease, onDate || today(r));
}

export function addDays(d, n) { const out = new Date(d.getTime()); out.setDate(out.getDate() + n); return out; }

// ── invoices: voiding ───────────────────────────────────────────────────────

async function assertVoidable(r, invoiceId) {
  let received = 0;
  (await readTable(r, 'Payments')).forEach(pay => {
    if (String(pay.invoice_id) === String(invoiceId)) received += num(pay.amount);
  });
  if (received > 0) {
    throw new Error('Cannot void ' + invoiceId + ' — ' + round2(received) +
                    ' has already been received against it. Delete those payments first.');
  }
}

/**
 * Void an issued invoice. It keeps its number and stays on record, and
 * nothing is owed on it.
 */
async function voidInvoice(r, payload, user) {
  requireRole(user, 'manager');
  const inv = await findRow(r, 'Invoices', payload.id);
  if (!inv) throw new Error('Invoice ' + payload.id + ' not found');
  if (String(inv.status) === 'Void') throw new Error(inv.id + ' is already void.');
  await assertVoidable(r, inv.id);
  const reason = String(payload.reason || '').trim();
  if (!reason) throw new Error('Give a reason for voiding ' + inv.id + ' — it is kept on the invoice.');
  await updateRow(r, 'Invoices', inv.id, {
    status: 'Void', balance: 0,
    notes: (inv.notes ? inv.notes + ' · ' : '') + 'Voided ' + today(r) + ': ' + reason
  }, user, true, payload.expected_version);
  await applyInvoiceTotals(r, inv.id, user);
  await log(r, user, 'void', 'Invoices', inv.id, reason.slice(0, 180));
  return { invoice: await findRow(r, 'Invoices', inv.id) };
}

/** Append to the audit trail. Logging must never break a write. */
async function log(r, user, action, entity, entityId, details) {
  await guarded(r, async (sp) => {
    const [id] = await reserveIds(sp, 'ActivityLog', 1, TABLES.ActivityLog.prefix);
    await sp.tx`insert into activity_log (id, timestamp, actor, action, entity, entity_id, details) values (
      ${id}, ${now(r)}, ${(user && (user.phone || user.email || user.name)) || 'system'},
      ${action}, ${entity || null}, ${entityId || null}, ${details || null})`;
  });
  invalidate(r, 'ActivityLog');
}

// ────────────────────────────────────────────────────────────────── auth ────

/**
 * Reduce a phone number to a comparable form so that "+91 98800 11111",
 * "098800 11111" and "9880011111" all resolve to the same account: digits only,
 * the last ten. The database's app_users.phone_key uses the same rule.
 */
const LOCAL_PHONE_DIGITS = 10;

export function normalisePhone(v) {
  let digits = String(v == null ? '' : v).replace(/[^0-9]/g, '');
  if (digits.length > LOCAL_PHONE_DIGITS) digits = digits.slice(-LOCAL_PHONE_DIGITS);
  return digits;
}

/** Compares two strings in time independent of where they first differ. */
export function constantTimeEquals(a, b) {
  a = String(a); b = String(b);
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

/**
 * Sign-in throttling, per account: a few free attempts, then each failure
 * locks the number out for twice as long as the last (30 s … 30 min), for six
 * hours. While failures across all accounts run unusually high (spraying), the
 * free attempts drop to none. Kept in login_throttle instead of CacheService.
 */
export const THROTTLE = { freeAttempts: 4, baseDelaySec: 30, maxDelaySec: 1800, windowSec: 21600,
                          sprayThreshold: 100, sprayWindowSec: 900 };

async function throttleRow(r, identifier, windowSec) {
  const [row] = await r.tx`
    select failures,
           coalesce((extract(epoch from locked_until) * 1000)::bigint, 0) as until,
           (extract(epoch from updated_at) * 1000)::bigint as at
    from login_throttle where identifier = ${identifier}`;
  if (!row || Date.now() - Number(row.at) > windowSec * 1000) return { n: 0, until: 0 };
  return { n: Number(row.failures), until: Number(row.until) };
}

async function throttleCheck(r, identifier) {
  const state = await throttleRow(r, identifier, THROTTLE.windowSec);
  const wait = state.until - Date.now();
  if (wait > 0) {
    const minutes = Math.ceil(wait / 60000);
    throw new Error('Too many failed sign-in attempts. Try again in ' +
                    (minutes <= 1 ? 'a minute.' : minutes + ' minutes.'));
  }
}

async function throttleWrite(r, identifier, n, until) {
  await r.tx`insert into login_throttle (identifier, failures, locked_until, updated_at)
             values (${identifier}, ${n}, ${until ? new Date(until).toISOString() : null}, now())
             on conflict (identifier) do update
               set failures = excluded.failures, locked_until = excluded.locked_until, updated_at = now()`;
}

/**
 * Count an attempt against `identifier` before its password is checked. The
 * check runs outside the request lock, so charging only afterwards would let a
 * burst of parallel guesses all pass throttleCheck first. A success clears the
 * count again (throttleReset).
 */
async function throttleCharge(r, identifier) {
  const spray = (await throttleRow(r, '__global', THROTTLE.sprayWindowSec)).n;
  const state = await throttleRow(r, identifier, THROTTLE.windowSec);
  state.n++;
  const free = spray >= THROTTLE.sprayThreshold ? 0 : THROTTLE.freeAttempts;
  if (state.n > free) {
    const delay = Math.min(THROTTLE.baseDelaySec * Math.pow(2, state.n - free - 1), THROTTLE.maxDelaySec);
    state.until = Date.now() + delay * 1000;
  }
  await throttleWrite(r, identifier, state.n, state.until);
  // keep the table from growing without bound
  await r.tx`delete from login_throttle where updated_at < now() - make_interval(secs => ${THROTTLE.windowSec})`;
}

/** A failed attempt counts towards the spray total across all accounts. */
async function throttleSpray(r) {
  const spray = (await throttleRow(r, '__global', THROTTLE.sprayWindowSec)).n + 1;
  await throttleWrite(r, '__global', spray, 0);
}

async function throttleReset(r, identifier) {
  await r.tx`delete from login_throttle where identifier = ${identifier}`;
}

// ── crypto ──────────────────────────────────────────────────────────────────

const enc = new TextEncoder();

function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
const toBase64Url = (bytes) => bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function fromBase64Url(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function sha256(str) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(str)));
}

async function hmac(key, str) {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(str)));
}

export const uuid = () => crypto.randomUUID();

/**
 * Password hashing.
 *
 *   v3$<iterations>$<b64>  PBKDF2-SHA256 — what every password is stored as now
 *   v2$<b64>               an older scheme: SHA-256 stretched 1,000 times
 *   <b64>                  the original single round
 *
 * Accounts brought over from the earlier backend can still carry the older
 * forms. They are still verified, so nobody is locked out, and each account
 * is re-hashed as v3 the next time its password is used.
 */
export const PBKDF2_ITERATIONS = 600000;
const V2_ITERATIONS = 1000;

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password, salt, iterations) {
  return 'v3$' + iterations + '$' + bytesToBase64(await pbkdf2(String(password), String(salt), iterations));
}

export async function hashPasswordV2(password, salt) {
  let digest = await sha256(salt + '::' + password);
  for (let i = 1; i < V2_ITERATIONS; i++) digest = await sha256(bytesToBase64(digest) + salt);
  return 'v2$' + bytesToBase64(digest);
}

export async function hashPasswordLegacy(password, salt) {
  return bytesToBase64(await sha256(salt + '::' + password));
}

/** True when `password` matches `stored`, under whichever scheme wrote it. */
async function passwordMatches(password, salt, stored) {
  stored = String(stored || '');
  password = String(password);
  if (stored.indexOf('v3$') === 0) {
    const iterations = parseInt(stored.split('$')[1], 10);
    if (!(iterations > 0)) return false;
    return constantTimeEquals(await hashPassword(password, salt, iterations), stored);
  }
  if (stored.indexOf('v2$') === 0) return constantTimeEquals(await hashPasswordV2(password, salt), stored);
  return constantTimeEquals(await hashPasswordLegacy(password, salt), stored);
}

/** True when a stored hash is weaker than what a new one would be. */
function needsRehash(stored, iterations) {
  stored = String(stored || '');
  if (stored.indexOf('v3$') !== 0) return true;
  return (parseInt(stored.split('$')[1], 10) || 0) < iterations;
}

/**
 * Rules for a new password. Deliberately short: length is what actually
 * matters, and long lists of character classes push people towards
 * "Password1!" and a sticky note.
 */
const MIN_PASSWORD = 10;

function assertPasswordAcceptable(password, phone) {
  const pw = String(password || '');
  if (pw.length < MIN_PASSWORD) {
    throw new Error('Password must be at least ' + MIN_PASSWORD + ' characters.');
  }
  if (/^[0-9]+$/.test(pw)) throw new Error('Password cannot be only numbers.');
  if (/^(.)\1+$/.test(pw)) throw new Error('Password cannot be the same character repeated.');
  const digits = normalisePhone(phone);
  if (digits && pw.replace(/[^0-9]/g, '').indexOf(digits) >= 0) {
    throw new Error('Password cannot contain the phone number.');
  }
  return pw;
}

export async function signToken(secret, payload) {
  const body = toBase64Url(enc.encode(JSON.stringify(payload)));
  return body + '.' + toBase64Url(await hmac(secret, body));
}

async function verifyToken(secret, token) {
  if (!token || typeof token !== 'string' || token.indexOf('.') < 0) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const expect = toBase64Url(await hmac(secret, parts[0]));
  if (!constantTimeEquals(expect, parts[1])) return null;
  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(fromBase64Url(parts[0]))); }
  catch (e) { return null; }
  if (!payload || !payload.exp || payload.exp < Date.now()) return null;
  return payload;
}

/**
 * Verify the token, then re-check the account in the database: roles and the
 * active flag can change mid-session, and a password change revokes every
 * session minted before it.
 */
async function requireAuth(r, token) {
  const payload = await verifyToken(r.env.authSecret, token);
  if (!payload) throw new Error('AUTH_REQUIRED');

  const current = await findRow(r, 'Users', payload.id);
  if (!current) throw new Error('AUTH_REQUIRED');
  if (String(current.active).toLowerCase() === 'false') throw new Error('AUTH_REQUIRED');

  const changedAt = parseFloat(current.password_changed_at || 0) || 0;
  if (changedAt && (!payload.iat || payload.iat < changedAt)) {
    throw new Error('AUTH_REQUIRED');
  }
  // "sign out other devices", or an admin signing this account out
  const revokedAt = parseFloat(current.sessions_revoked_at || 0) || 0;
  if (revokedAt && (!payload.iat || payload.iat <= revokedAt)) {
    throw new Error('AUTH_REQUIRED');
  }
  // this one token, signed out of on its device
  const [revoked] = await r.tx`select 1 from revoked_sessions where token_hash = ${await tokenHash(token)}`;
  if (revoked) throw new Error('AUTH_REQUIRED');

  return {
    id: current.id, phone: current.phone, email: current.email,
    name: current.name, role: current.role
  };
}

/** What revoked_sessions stores: a digest, so the table never holds a usable token. */
async function tokenHash(token) {
  return bytesToBase64(await sha256(String(token)));
}

/**
 * Sign this device out: the token stops working now rather than when it
 * expires. Always answers ok — a token that is already invalid has nothing
 * left to end, and a stranger learns nothing from the reply.
 */
async function logout(r, token) {
  const payload = await verifyToken(r.env.authSecret, token);
  if (!payload) return ok({ signedOut: true });
  await r.tx`insert into revoked_sessions (token_hash, expires_at)
             values (${await tokenHash(token)}, ${new Date(payload.exp).toISOString()})
             on conflict (token_hash) do nothing`;
  // a revoked token past its expiry is refused anyway; no need to keep it
  await r.tx`delete from revoked_sessions where expires_at < now()`;
  await log(r, payload, 'sign-out', 'Users', payload.id, '');
  return ok({ signedOut: true });
}

/**
 * End every session of an account at once. Your own: every other device is
 * signed out and this one is handed a fresh token, so it stays signed in.
 * Someone else's (admin only): they are signed out everywhere.
 */
async function endSessions(r, payload, user) {
  const own = !payload.id || String(payload.id) === String(user.id);
  if (!own) requireRole(user, 'admin');
  const target = await findRow(r, 'Users', own ? user.id : payload.id);
  if (!target) throw new Error('User not found');

  const at = Date.now();
  await updateRow(r, 'Users', target.id, { sessions_revoked_at: at }, SYSTEM_ACTOR, true);
  await log(r, user, 'sessions-ended', 'Users', target.id, own ? 'other devices' : 'by ' + (user.phone || user.name));
  if (!own) return { ended: true, id: target.id };
  // issued after the cut-off, so it survives it
  const session = await issueSession(r, target, at + 1);
  return { ended: true, id: target.id, token: session.token, user: session.user };
}

function requireRole(user, min) {
  if ((ROLE_RANK[user.role] || 0) < (ROLE_RANK[min] || 3)) {
    throw new Error('Your role (' + user.role + ') cannot perform this action');
  }
}

/**
 * Sign in, in three steps so the slow hash never runs inside the request lock:
 * a short locked read (throttle, charge the attempt, find the account), the
 * hash with no lock or connection held, then a short locked write that
 * re-reads the account in case it changed in between.
 */
async function login(run, env, payload) {
  // Phone is the login credential; email is optional contact detail only.
  const phone = normalisePhone(payload.phone || payload.identifier || '');
  const password = String(payload.password || '');
  if (!phone || !password) return fail('Phone number and password are required');

  const before = await run(async (r) => {
    try { await throttleCheck(r, phone); } catch (e) { return { refused: e.message }; }
    await throttleCharge(r, phone);
    const u = (await readTable(r, 'Users')).find(x => normalisePhone(x.phone) === phone) || null;
    return { found: u && { id: u.id, salt: u.salt, password_hash: u.password_hash } };
  });
  if (before.refused) return fail(before.refused);

  const found = before.found;
  // Hash even when the number is unknown, so a missing account is not
  // measurably faster to probe than a wrong password.
  const matches = found
    ? await passwordMatches(password, found.salt, found.password_hash)
    : ((await hashPassword(password, 'no-such-user', env.hashIterations)) && false);

  // Move an account onto the current hashing scheme the first time we can,
  // now that we have the plaintext in hand.
  let upgrade = null;
  if (matches && needsRehash(found.password_hash, env.hashIterations)) {
    const salt = uuid();
    upgrade = { salt, password_hash: await hashPassword(password, salt, env.hashIterations) };
  }

  return run(r => finishLogin(r, phone, found, matches, upgrade, payload));
}

async function finishLogin(r, phone, checked, matches, upgrade, payload) {
  // One generic message for every failure mode, so a stranger cannot tell
  // which numbers are registered.
  const GENERIC = 'Invalid phone number or password';

  const found = checked ? await findRow(r, 'Users', checked.id) : null;
  const disabled = found && String(found.active).toLowerCase() === 'false';
  // the password was checked against this hash; a change since then voids the check
  const stale = found && String(found.password_hash) !== String(checked.password_hash);

  if (!found || disabled || stale || !matches) {
    await throttleSpray(r);
    await log(r, { phone }, 'login-failed', 'Users', found ? found.id : '', disabled ? 'disabled' : '');
    return fail(GENERIC);
  }

  await throttleReset(r, phone);

  if (upgrade) {
    await updateRow(r, 'Users', found.id, upgrade, SYSTEM_ACTOR, true);
    await log(r, SYSTEM_ACTOR, 'password-rehash', 'Users', found.id, 'upgraded to v3');
  }

  const session = await issueSession(r, found, Date.now());
  await updateRow(r, 'Users', found.id, { last_login: now(r) }, { phone: found.phone, role: 'admin' }, true);
  const data = { token: session.token, user: session.user, settings: await readSettings(r) };
  // Signing in is always followed by a request for all the data; answer
  // both at once. Built through bootstrap(), so it obeys the same role limits.
  if (payload.withSnapshot) data.snapshot = await bootstrap(r, session.user, null, !!payload.lean);
  return ok(data);
}

/**
 * A signed session for an account. `iat` must not be earlier than the
 * account's password_changed_at, or requireAuth rejects the token.
 */
async function issueSession(r, account, at) {
  const hours = parseFloat((await readSettings(r)).session_hours || '12') || 12;
  const user = { id: account.id, phone: account.phone, email: account.email,
                 name: account.name, role: account.role };
  const token = await signToken(r.env.authSecret, {
    id: user.id, phone: user.phone, email: user.email, name: user.name, role: user.role,
    iat: at, exp: at + hours * 3600 * 1000
  });
  return { token, user };
}

/**
 * Split like login(): both hashes run outside the request lock, and wrong
 * current passwords are throttled like failed sign-ins, so a stolen session
 * cannot be used to guess the password behind it.
 */
async function changePassword(run, env, payload, token) {
  const before = await run(async (r) => {
    const user = await requireAuth(r, token);
    const me = await findRow(r, 'Users', user.id);
    if (!me) throw new Error('User not found');
    assertPasswordAcceptable(payload.next, me.phone);
    const key = normalisePhone(me.phone);
    await throttleCheck(r, key);
    await throttleCharge(r, key);
    return { id: me.id, salt: me.salt, password_hash: me.password_hash };
  });

  const matches = await passwordMatches(payload.current || '', before.salt, before.password_hash);
  const salt = uuid();
  const hash = matches ? await hashPassword(payload.next, salt, env.hashIterations) : null;

  return run(async (r) => {
    const user = await requireAuth(r, token);
    const me = await findRow(r, 'Users', user.id);
    if (!me || String(me.password_hash) !== String(before.password_hash)) {
      throw new Error('Your password was changed in the meantime. Sign in again.');
    }
    if (!matches) {
      await log(r, user, 'password-change-failed', 'Users', me.id, 'wrong current password');
      return fail('Current password is incorrect');
    }
    await throttleReset(r, normalisePhone(me.phone));
    const at = Date.now();
    await updateRow(r, 'Users', me.id, { salt, password_hash: hash, password_changed_at: at }, SYSTEM_ACTOR, true);
    await log(r, user, 'password-change', 'Users', me.id, '');
    // The change ends every session minted before it — including the one it was
    // made from. Hand that one a replacement.
    const session = await issueSession(r, me, at);
    return ok({ changed: true, token: session.token, user: session.user });
  });
}

async function createUser(r, payload, user) {
  requireRole(user, 'admin');
  const phone = normalisePhone(payload.phone);
  if (!phone) throw new Error('A phone number is required — it is the sign-in credential');
  assertPasswordAcceptable(payload.password, payload.phone);

  if ((await readTable(r, 'Users')).some(u => normalisePhone(u.phone) === phone)) {
    throw new Error('That phone number already belongs to another user');
  }
  if (payload.role && !ROLE_RANK[payload.role]) throw new Error('Unknown role: ' + payload.role);

  const salt = uuid();
  return stripSecrets('Users', await createRow(r, 'Users', {
    name: payload.name || '',
    phone: String(payload.phone).trim(),
    email: payload.email ? String(payload.email).trim().toLowerCase() : '',
    role: payload.role || 'viewer',
    salt, password_hash: await hashPassword(payload.password, salt, r.env.hashIterations),
    password_changed_at: Date.now(), active: true
  }, user));
}

// ───────────────────────────────────────────────────────────────── setup ────

/** Add any default setting that is missing. Never overwrites one that exists. */
async function ensureDefaultSettings(r) {
  const settings = await readSettings(r);
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    if (settings[k] === undefined) await setSetting(r, k, DEFAULT_SETTINGS[k]);
  }
}

/**
 * Break-glass recovery, for when nobody can sign in. Run from a machine that
 * holds the database URL (scripts/recover-admin.mjs) — never reachable from
 * the public endpoint. Makes the phone number an active administrator with the
 * given password, and clears any sign-in lockout.
 */
async function recoverAccess(r, phone, password, name) {
  const normalised = normalisePhone(phone);
  if (!normalised) throw new Error('A phone number is required');
  assertPasswordAcceptable(password, phone);
  await ensureDefaultSettings(r);

  const actor = { role: 'admin', phone: 'owner', name: 'database owner' };
  const users = await readTable(r, 'Users');
  // the account with this number — or, for data carried over from the era of
  // email sign-in, an account that has no phone yet
  const target = users.find(u => normalisePhone(u.phone) === normalised) ||
                 users.find(u => !normalisePhone(u.phone)) || null;

  const salt = uuid();
  const creds = {
    phone: String(phone).trim(),
    salt,
    password_hash: await hashPassword(password, salt, r.env.hashIterations),
    password_changed_at: Date.now(),
    role: 'admin',
    active: true
  };

  const result = target
    ? await updateRow(r, 'Users', target.id, creds, actor, true)
    : await createRow(r, 'Users', { ...creds, name: name || 'Administrator', email: '' }, actor, true);

  await throttleReset(r, normalised);
  await throttleReset(r, '__global');

  await log(r, actor, 'recover-access', 'Users', result.id, 'via recover-admin script');
  return { id: result.id, name: result.name, phone: result.phone, role: result.role };
}

/**
 * Seed the first administrator.
 *
 * Authorisation, in order of precedence:
 *   1. An admin session token — always allowed (fills in missing settings).
 *   2. No users exist yet AND, if SETUP_KEY is configured, the caller supplies
 *      it. Without a key, anonymous bootstrap is open only for an hour after
 *      the deployment first answers, so a forgotten install cannot be claimed.
 */
async function doSetup(r, payload, token) {
  let isAdmin = false;
  try { isAdmin = (await requireAuth(r, token)).role === 'admin'; } catch (e) { isAdmin = false; }

  const tables = Object.keys(TABLES);
  if (!isAdmin) {
    const existing = await readTable(r, 'Users');
    if (existing.length > 0) {
      // A new browser connecting to a configured workspace: acknowledge, but
      // do not let an unauthenticated caller write anything.
      return ok({ tables, adminCreated: false, alreadySeeded: true });
    }
    if (r.env.setupKey) {
      if (!constantTimeEquals(String(payload.setupKey || ''), r.env.setupKey)) {
        return fail('A setup key is required for this deployment.');
      }
    } else {
      let firstSeen = parseFloat(await getState(r, 'FIRST_SEEN') || 0) || 0;
      if (!firstSeen) { firstSeen = Date.now(); await setState(r, 'FIRST_SEEN', String(firstSeen)); }
      if (Date.now() - firstSeen > BOOTSTRAP_WINDOW_MS) {
        return fail('The first-run window for this deployment has closed. Create the ' +
                    'administrator with scripts/recover-admin.mjs, or set a SETUP_KEY secret.');
      }
    }
  }

  await ensureDefaultSettings(r);

  // seed the first admin (only when there are no users at all)
  const users = await readTable(r, 'Users');
  let created = null;
  if (users.length === 0) {
    const phone = normalisePhone(payload.adminPhone);
    if (!phone) return fail('Provide adminPhone — it is the sign-in credential');
    let password;
    try { password = assertPasswordAcceptable(payload.adminPassword, payload.adminPhone); }
    catch (e) { return fail(e.message); }
    const salt = uuid();
    created = await createRow(r, 'Users', {
      name: payload.adminName || 'Administrator',
      phone: String(payload.adminPhone).trim(),
      email: payload.adminEmail ? String(payload.adminEmail).trim().toLowerCase() : '',
      role: 'admin',
      salt, password_hash: await hashPassword(password, salt, r.env.hashIterations),
      password_changed_at: Date.now(), active: true
    }, { phone: 'system', role: 'admin' });
  }
  return ok({ tables, adminCreated: !!created, alreadySeeded: users.length > 0 });
}

// ────────────────────────────────────────────────────────────── settings ────

async function readSettings(r) {
  const out = {};
  (await readTable(r, 'Settings')).forEach(row => { if (row.key) out[String(row.key)] = row.value; });
  return out;
}

async function setSetting(r, key, value) {
  if (await findRow(r, 'Settings', key)) await patchRow(r, 'Settings', key, { value });
  else await insertRow(r, 'Settings', { key, value });
}

// ───────────────────────────────────────────────────────────── bootstrap ────

const COLLECTIONS = {
  properties: 'Properties', units: 'Units', tenants: 'Tenants', leases: 'Leases',
  invoices: 'Invoices', invoiceItems: 'InvoiceItems', payments: 'Payments',
  maintenance: 'Maintenance', expenses: 'Expenses', documents: 'Documents'
};

/**
 * The small tables a lean browser keeps whole. Everything else in COLLECTIONS
 * it pages through (queries.js).
 */
const KEPT = { properties: 'Properties', units: 'Units', tenants: 'Tenants', leases: 'Leases' };

/**
 * Tables a kept collection's figures are worked out from (DERIVED below). Its
 * fingerprint covers them too, so a new payment refreshes the leases' deposit
 * figures even though no lease row changed.
 */
const DERIVED_FROM = {
  properties: ['properties', 'invoices'],
  units:      ['units', 'invoices'],
  tenants:    ['tenants', 'invoices'],
  leases:     ['leases', 'lease_tenants', 'invoices', 'invoice_items', 'payments', 'expenses']
};

/**
 * Figures the cards show that depend on invoices and payments the browser no
 * longer holds: what each tenant, unit and property owes, where each lease's
 * deposit stands, and who else lives on it.
 */
async function derivedFigures(r) {
  const owed = { tenant_id: {}, unit_id: {}, property_id: {} };
  const invoices = await readTable(r, 'Invoices');
  for (const inv of invoices) {
    if (OPEN_STATUSES.indexOf(String(inv.status)) < 0) continue;
    for (const k of Object.keys(owed)) {
      if (inv[k]) owed[k][inv[k]] = round2((owed[k][inv[k]] || 0) + num(inv.balance));
    }
  }
  const ledgers = await depositLedgers(r, await readTable(r, 'Leases'));
  // everyone besides the primary tenant living on each lease
  const occupants = {};
  for (const o of await readTable(r, 'LeaseTenants')) {
    (occupants[o.lease_id] = occupants[o.lease_id] || []).push({
      id: o.id, tenant_id: o.tenant_id, role: o.role, relationship: o.relationship,
      move_in_date: o.move_in_date, move_out_date: o.move_out_date, notes: o.notes, _v: o._v
    });
  }
  return { owed, ledgers, occupants };
}

const DERIVED = {
  properties: (row, f) => ({ ...row, _owed: f.owed.property_id[row.id] || 0 }),
  units:      (row, f) => ({ ...row, _owed: f.owed.unit_id[row.id] || 0 }),
  tenants:    (row, f) => ({ ...row, _owed: f.owed.tenant_id[row.id] || 0 }),
  leases:     (row, f) => ({ ...row, _deposit: f.ledgers[row.id] || { received: 0, applied: 0, refunded: 0, held: 0 },
                             _occupants: f.occupants[row.id] || [] })
};

/**
 * One round-trip that hands the SPA what it keeps.
 *
 * @param known the fingerprints of what the browser already holds. A
 *   collection whose fingerprint still matches is left out and named in
 *   `unchanged`, so a save that touched one table does not send back all of
 *   them — and an unchanged table is not even read.
 * @param lean  a current browser: only the small tables, with their derived
 *   figures, plus the dashboard's lists and Billing's figures. Without it,
 *   every table whole, for a browser still running the previous release.
 */
async function bootstrap(r, user, known, lean) {
  await refreshIfStale(r, user);
  known = known || {};
  const versions = await tableVersions(r);
  let instance = await getState(r, 'INSTANCE');
  if (!instance) { instance = uuid().slice(0, 8); await setState(r, 'INSTANCE', instance); }

  const out = {
    user,
    settings: await readSettings(r),
    hashes: {},
    unchanged: [],
    // the zone "today" is measured in — dates change over at its midnight
    timezone: r.tz,
    users: (user.role === 'admin' ? (await readTable(r, 'Users')).map(scrubUser) : []),
    stats: await computeStats(r)
  };

  if (!lean) {
    out.activity = ROLE_RANK[user.role] >= ROLE_RANK[readRoleFor('ActivityLog')]
      ? (await readTableTail(r, 'ActivityLog', 200)).reverse() : [];
    for (const key of Object.keys(COLLECTIONS)) {
      const table = COLLECTIONS[key];
      // A masked copy is a different copy: a viewer promoted to manager must not
      // be told the masked rows they already hold are still current.
      const hash = instance + '.' + (versions[TABLES[table].sql] || 0) + (maskedColumns(user, table) ? '.m' : '');
      out.hashes[key] = hash;
      if (known[key] && known[key] === hash) out.unchanged.push(key);
      else out[key] = (await readTable(r, table)).map(row => forClient(table, row, user));
    }
    return out;
  }

  out.lean = true;
  out.dashboard = await dashboardData(r);
  out.billing = await billingFigures(r);
  let figures = null;
  for (const key of Object.keys(KEPT)) {
    const table = KEPT[key];
    const hash = instance + '.' + DERIVED_FROM[key].map(t => versions[t] || 0).join('-') +
                 (maskedColumns(user, table) ? '.m' : '');
    out.hashes[key] = hash;
    if (known[key] && known[key] === hash) { out.unchanged.push(key); continue; }
    figures = figures || await derivedFigures(r);
    out[key] = (await readTable(r, table)).map(row => DERIVED[key](forClient(table, row, user), figures));
  }
  return out;
}

/** An administrator sets a new password for someone who has lost theirs. */
async function resetPassword(r, payload, user) {
  requireRole(user, 'admin');
  const target = await findRow(r, 'Users', payload.id);
  if (!target) throw new Error('User not found');
  assertPasswordAcceptable(payload.password, target.phone);

  const salt = uuid();
  await updateRow(r, 'Users', target.id, {
    salt, password_hash: await hashPassword(payload.password, salt, r.env.hashIterations),
    password_changed_at: Date.now()
  }, user, true);
  await log(r, user, 'password-reset', 'Users', target.id, 'by ' + (user.phone || user.name));
  return { reset: true, id: target.id };
}

/** Disable an account without deleting its history. Takes effect immediately. */
async function setUserActive(r, payload, user) {
  requireRole(user, 'admin');
  const active = payload.active === true || String(payload.active).toLowerCase() === 'true';
  const row = await updateRow(r, 'Users', payload.id, { active }, user);
  await log(r, user, active ? 'user-enabled' : 'user-disabled', 'Users', payload.id, '');
  return scrubUser(row);
}

async function setUserRole(r, payload, user) {
  requireRole(user, 'admin');
  if (!ROLE_RANK[payload.role]) throw new Error('Unknown role: ' + payload.role);
  const row = await updateRow(r, 'Users', payload.id, { role: payload.role }, user);
  await log(r, user, 'user-role-changed', 'Users', payload.id, payload.role);
  return scrubUser(row);
}

function scrubUser(u) {
  return {
    id: u.id, name: u.name, phone: u.phone, email: u.email,
    role: u.role, active: u.active, last_login: u.last_login
  };
}

// ───────────────────────────────────────────────────── billing operations ──

/**
 * Price invoice lines: quantity × unit amount, and GST per line at its own
 * rate. Every invoice — typed in the editor or raised by Generate rent — is
 * priced here, so the same lines always come to the same total.
 */
function priceLines(items) {
  let subtotal = 0, lineTax = 0, hasRates = false;
  const priced = items.map(raw => {
    const figure = (v) => Number(String(v).replace(/,/g, '').trim());
    const qty = raw.quantity === '' || raw.quantity === undefined || raw.quantity === null ? 1 : figure(raw.quantity);
    const unit = raw.unit_amount === '' || raw.unit_amount === undefined || raw.unit_amount === null ? 0 : figure(raw.unit_amount);
    if (!Number.isFinite(qty)) throw new Error('Quantity "' + raw.quantity + '" is not a number.');
    if (!Number.isFinite(unit)) throw new Error('Amount "' + raw.unit_amount + '" is not a number.');
    const amount = round2(qty * unit);
    const rate = raw.tax_rate === '' || raw.tax_rate === undefined || raw.tax_rate === null ? 0 : figure(raw.tax_rate);
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) throw new Error('GST rate must be between 0 and 100%.');
    const taxAmount = round2(amount * rate / 100);
    if (rate > 0) hasRates = true;
    subtotal += amount;
    lineTax += taxAmount;
    return {
      id: raw.id || '',
      description: String(raw.description || '').trim(),
      category: raw.category || 'Other',
      quantity: qty,
      unit_amount: unit,
      amount,
      tax_rate: rate || 0,
      tax_amount: taxAmount,
      notes: raw.notes
    };
  });
  for (const it of priced) {
    if (!it.description) throw new Error('Every line item needs a description');
  }
  return { priced, subtotal: round2(subtotal), lineTax: round2(lineTax), hasRates };
}

/**
 * Create or update an invoice together with its line items. The header's
 * `amount` is always the sum of its lines; sending the full item list replaces
 * what was there.
 */
async function saveInvoice(r, payload, user) {
  requireRole(user, 'manager');
  const data = { ...(payload.data || {}) };
  const items = payload.items || [];
  if (!items.length) throw new Error('An invoice needs at least one line item');

  const { priced, subtotal, lineTax, hasRates } = priceLines(items);

  // GST charged per line is the tax; an invoice with no rates keeps a flat tax
  // typed on the header, as invoices made before line rates existed do
  const tax = hasRates ? round2(lineTax) : num(data.tax);
  data.tax = tax;
  data.amount = round2(subtotal);
  data.total = round2(subtotal + tax);

  const prior = payload.id ? await findRow(r, 'Invoices', payload.id) : null;
  if (payload.id && !prior) throw new Error('Invoices ' + payload.id + ' not found');
  if (prior && String(prior.status) === 'Void') {
    throw new Error(prior.id + ' is void, so it cannot be changed. Raise a new invoice instead.');
  }
  // An edit keeps the status it has; the one change an edit can make is
  // issuing a draft. Paid, Overdue and the rest are worked out, never typed.
  if (!prior) data.status = String(data.status) === 'Draft' ? 'Draft' : 'Unpaid';
  else if (String(prior.status) === 'Draft' && data.status && String(data.status) !== 'Draft') data.status = 'Unpaid';
  else delete data.status;
  // a draft is dated the day it is issued, unless a date was chosen
  if (prior && String(prior.status) === 'Draft' && data.status === 'Unpaid' && !data.issue_date && !prior.issue_date) {
    data.issue_date = today(r);
  }

  // a single-category invoice keeps that label; a mixed one says so — except
  // that Rent and Deposit are what billing keys on, so they keep their type
  const distinct = Object.keys(priced.reduce((m, it) => { m[it.category] = true; return m; }, {}));
  const keepType = prior && ['Rent', 'Deposit', 'Deposit Deduction'].indexOf(String(prior.type)) >= 0;
  if (!data.type) data.type = keepType ? prior.type : (distinct.length === 1 ? distinct[0] : 'Mixed');

  data.property_id = await inferProperty(r, prior ? { ...prior, ...data } : data);

  const invoice = payload.id
    ? await updateRow(r, 'Invoices', payload.id, data, user, false, payload.expected_version)
    : await createRow(r, 'Invoices', data, user);

  // replace the line set: update what stayed, add what is new, drop the rest
  const existing = await itemsOfInvoice(r, invoice.id);
  const kept = {};
  const added = [];
  for (const it of priced) {
    const row = { invoice_id: invoice.id, description: it.description, category: it.category,
                  quantity: it.quantity, unit_amount: it.unit_amount, amount: it.amount,
                  tax_rate: it.tax_rate, tax_amount: it.tax_amount };
    // the editor does not send a line's notes (a rent adjustment's reason is
    // kept there), so a line that stays keeps them
    if (it.notes !== undefined) row.notes = it.notes;
    if (it.id && existing.some(e => e.id === it.id)) {
      await updateRow(r, 'InvoiceItems', it.id, row, user, true);
      kept[it.id] = true;
    } else {
      added.push(row);
    }
  }
  for (const e of existing) {
    if (!kept[e.id]) await deleteRow(r, 'InvoiceItems', e.id, SYSTEM_ACTOR);
  }
  await appendRows(r, 'InvoiceItems', added, user);

  const settled = (await applyInvoiceTotals(r, invoice.id, user)) || invoice;
  await log(r, user, payload.id ? 'update' : 'create', 'Invoices', invoice.id,
            priced.length + ' line item(s), total ' + data.total);
  return { invoice: (await findRow(r, 'Invoices', settled.id)) || settled, items: await itemsOfInvoice(r, invoice.id) };
}

async function itemsOfInvoice(r, invoiceId) {
  return (await readTable(r, 'InvoiceItems')).filter(it => it.invoice_id === invoiceId);
}

/**
 * Record money received against an invoice. Anything beyond its balance is
 * applied to the same tenant's other outstanding invoices, oldest due first,
 * so no balance ever goes negative and nothing is silently absorbed.
 */
async function recordPayment(r, payload, user) {
  requireRole(user, 'manager');
  const invoiceId = payload.invoice_id;
  const amount = parseFloat(payload.amount || 0);
  if (!(amount > 0)) throw new Error('Payment amount must be greater than zero');

  const invoices = await readTable(r, 'Invoices');
  const invoice = invoices.find(i => i.id === invoiceId) || null;
  if (!invoice) throw new Error('Invoice ' + invoiceId + ' not found');
  if (String(invoice.status) === 'Void') throw new Error('That invoice is void.');
  if (String(invoice.status) === 'Draft') throw new Error(invoice.id + ' is still a draft. Issue it before taking payment.');

  const owed = round2(parseFloat(invoice.balance || 0) || 0);
  if (owed <= 0) throw new Error('Invoice ' + invoice.id + ' is already settled.');

  const overflow = round2(amount - owed);
  const applyHere = Math.min(round2(amount), owed);
  const spillTargets = [];
  if (overflow > 0.009) {
    let remaining = overflow;
    const others = invoices
      .filter(i => i.id !== invoice.id && i.tenant_id === invoice.tenant_id &&
                   ['Unpaid', 'Partial', 'Overdue'].indexOf(String(i.status)) >= 0 &&
                   (parseFloat(i.balance || 0) || 0) > 0)
      .sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)));
    for (const other of others) {
      if (remaining <= 0.009) break;
      const take = Math.min(remaining, round2(parseFloat(other.balance || 0) || 0));
      spillTargets.push({ invoice: other, amount: round2(take) });
      remaining = round2(remaining - take);
    }
    if (remaining > 0.009) {
      throw new Error('That is ' + remaining + ' more than ' +
        (spillTargets.length ? 'every outstanding invoice for this tenant comes to.'
                             : 'the ' + owed + ' owed on ' + invoice.id + '.') +
        ' Reduce the amount or raise the invoice first.');
    }
  }

  const payment = await createRow(r, 'Payments', {
    invoice_id: invoice.id, lease_id: invoice.lease_id, tenant_id: invoice.tenant_id,
    property_id: invoice.property_id || await inferProperty(r, invoice),
    payment_date: payload.payment_date || today(r),
    amount: round2(applyHere), method: payload.method || 'Cash', reference: payload.reference || '',
    received_by: user.name || user.phone || user.email, notes: payload.notes || ''
  }, user, true);

  const updated = await applyInvoiceTotals(r, invoice.id, user);

  const alsoSettled = [];
  for (const target of spillTargets) {
    await createRow(r, 'Payments', {
      invoice_id: target.invoice.id, lease_id: target.invoice.lease_id,
      tenant_id: target.invoice.tenant_id,
      property_id: target.invoice.property_id || await inferProperty(r, target.invoice),
      payment_date: payload.payment_date || today(r), amount: target.amount,
      method: payload.method || 'Cash', reference: payload.reference || '',
      received_by: user.name || user.phone || user.email,
      notes: 'Applied from a payment made against ' + invoice.id
    }, user, true);
    alsoSettled.push(await applyInvoiceTotals(r, target.invoice.id, user));
  }

  await log(r, user, 'payment', 'Invoices', invoice.id,
            round2(amount) + ' via ' + (payload.method || 'Cash') +
            (alsoSettled.length ? ' (spread over ' + (alsoSettled.length + 1) + ' invoices)' : ''));
  return { payment: (await findRow(r, 'Payments', payment.id)) || payment, invoice: updated, alsoSettled };
}

async function voidPayment(r, paymentId, user) {
  requireRole(user, 'admin');
  const target = await findRow(r, 'Payments', paymentId);
  if (!target) throw new Error('Payment not found');
  // deleteRow puts the invoice back
  await deleteRow(r, 'Payments', paymentId, user);
  return { voided: paymentId, invoice: target.invoice_id ? await findRow(r, 'Invoices', target.invoice_id) : null };
}

/** Recompute amount_paid / balance / status — and the GST split — for one invoice. */
async function applyInvoiceTotals(r, invoiceId) {
  const invoice = await findRow(r, 'Invoices', invoiceId);
  if (!invoice) return null;

  let paid = 0;
  (await readTable(r, 'Payments')).forEach(p => {
    if (p.invoice_id === invoiceId) paid += parseFloat(p.amount || 0) || 0;
  });

  // line items, when present, are the source of truth for what is owed
  const lines = await itemsOfInvoice(r, invoiceId);
  let amount = parseFloat(invoice.amount || 0) || 0;
  let lineTax = 0, hasRates = false;
  if (lines.length) {
    amount = 0;
    lines.forEach(it => {
      amount += num(it.amount);
      if (num(it.tax_rate) > 0) hasRates = true;
      lineTax += num(it.tax_amount);
    });
    amount = round2(amount);
  }
  const tax = hasRates ? round2(lineTax) : num(invoice.tax);
  const total = lines.length ? round2(amount + tax)
                             : (parseFloat(invoice.total || invoice.amount || 0) || 0);
  const isVoid = String(invoice.status) === 'Void';
  // nothing is owed on a void invoice, so it must not read as a balance
  const balance = isVoid ? 0 : round2(total - paid);
  const t = today(r);
  let status;
  if (isVoid) status = 'Void';
  // a draft stays a draft until it is issued, whatever its dates say
  else if (String(invoice.status) === 'Draft') status = 'Draft';
  else if (paid <= 0) status = (invoice.due_date && invoice.due_date < t) ? 'Overdue' : 'Unpaid';
  else if (balance > 0.009) status = (invoice.due_date && invoice.due_date < t) ? 'Overdue' : 'Partial';
  else status = 'Paid';

  const changes = { amount, tax, total, amount_paid: round2(paid), balance, status };
  const split = hasRates ? await gstSplit(r, invoice, tax) : { cgst: '', sgst: '', igst: '', place_of_supply: '' };
  Object.assign(changes, split);

  const saved = await updateRow(r, 'Invoices', invoiceId, changes, SYSTEM_ACTOR, true);
  await syncDepositStatus(r, saved);
  return saved;
}

// ── GST ─────────────────────────────────────────────────────────────────────

/** GST state codes, by name and by the usual two-letter abbreviation. */
const GST_STATES = {
  '01': ['Jammu and Kashmir', 'JK'], '02': ['Himachal Pradesh', 'HP'], '03': ['Punjab', 'PB'],
  '04': ['Chandigarh', 'CH'], '05': ['Uttarakhand', 'UK', 'UT'], '06': ['Haryana', 'HR'],
  '07': ['Delhi', 'DL'], '08': ['Rajasthan', 'RJ'], '09': ['Uttar Pradesh', 'UP'], '10': ['Bihar', 'BR'],
  '11': ['Sikkim', 'SK'], '12': ['Arunachal Pradesh', 'AR'], '13': ['Nagaland', 'NL'], '14': ['Manipur', 'MN'],
  '15': ['Mizoram', 'MZ'], '16': ['Tripura', 'TR'], '17': ['Meghalaya', 'ML'], '18': ['Assam', 'AS'],
  '19': ['West Bengal', 'WB'], '20': ['Jharkhand', 'JH'], '21': ['Odisha', 'OD', 'OR', 'Orissa'],
  '22': ['Chhattisgarh', 'CG', 'CT'], '23': ['Madhya Pradesh', 'MP'], '24': ['Gujarat', 'GJ'],
  '26': ['Dadra and Nagar Haveli and Daman and Diu', 'DN', 'DD'], '27': ['Maharashtra', 'MH'],
  '29': ['Karnataka', 'KA'], '30': ['Goa', 'GA'], '31': ['Lakshadweep', 'LD'], '32': ['Kerala', 'KL'],
  '33': ['Tamil Nadu', 'TN'], '34': ['Puducherry', 'PY', 'Pondicherry'], '35': ['Andaman and Nicobar Islands', 'AN'],
  '36': ['Telangana', 'TS', 'TG'], '37': ['Andhra Pradesh', 'AP'], '38': ['Ladakh', 'LA']
};

/** A state's two-digit GST code from its name, abbreviation or code; '' when unknown. */
function gstStateCode(value) {
  let v = String(value || '').trim();
  if (!v) return '';
  if (/^\d{1,2}$/.test(v)) { v = String(parseInt(v, 10)).padStart(2, '0'); return GST_STATES[v] ? v : ''; }
  const key = v.toLowerCase().replace(/&/g, 'and').replace(/[^a-z]/g, '');
  for (const code of Object.keys(GST_STATES)) {
    for (const name of GST_STATES[code]) {
      if (name.toLowerCase().replace(/[^a-z]/g, '') === key) return code;
    }
  }
  return '';
}

const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/** A GSTIN in canonical form, or '' — refusing anything that is not one. */
function assertGstin(value, label) {
  const v = String(value || '').replace(/\s+/g, '').toUpperCase();
  if (!v) return '';
  if (!GSTIN_PATTERN.test(v) || !GST_STATES[v.slice(0, 2)]) {
    throw new Error(label + ' "' + value + '" is not a valid GSTIN — 15 characters, starting with the state code.');
  }
  return v;
}

function assertUpiId(value) {
  const v = String(value || '').trim();
  if (!v) return '';
  if (!/^[A-Za-z0-9.\-_]{2,256}@[A-Za-z][A-Za-z0-9]{1,63}$/.test(v)) {
    throw new Error('"' + value + '" is not a UPI ID. It looks like name@bank.');
  }
  return v;
}

/**
 * Split an invoice's GST into CGST + SGST (supplier and place of supply in the
 * same state) or IGST (different states). For renting immovable property the
 * place of supply is where the property is (IGST Act s.12(3)), then the
 * tenant's GSTIN; unknown is treated as intra-state and left visibly blank.
 */
async function gstSplit(r, invoice, gst) {
  gst = round2(gst);
  const settings = await readSettings(r);
  const supplier = /^[0-9]{2}/.test(String(settings.gstin || '')) ? String(settings.gstin).slice(0, 2) : '';
  let place = '';
  const property = invoice.property_id ? await findRow(r, 'Properties', invoice.property_id) : null;
  if (property) place = gstStateCode(property.state);
  if (!place && invoice.tenant_id) {
    const tenant = await findRow(r, 'Tenants', invoice.tenant_id);
    if (tenant && GSTIN_PATTERN.test(String(tenant.gstin || ''))) place = String(tenant.gstin).slice(0, 2);
  }
  const placeLabel = place ? place + '-' + GST_STATES[place][0] : '';
  if (supplier && place && supplier !== place) {
    return { cgst: 0, sgst: 0, igst: gst, place_of_supply: placeLabel };
  }
  const half = round2(gst / 2);
  return { cgst: half, sgst: round2(gst - half), igst: 0, place_of_supply: placeLabel };
}

// ─────────────────────────────────────────────────────────── generate rent ──
//
// The periods themselves are worked out in rent.js. This part reads what is
// already billed, offers what is not (rentCandidates), and raises the invoices
// the screen sends back (generateRent) — recomputing every rent figure here,
// never taking an amount from the browser.

/** Invoice types never charged a late fee: money held for the tenant, not owed. */
const NO_LATE_FEE = ['Deposit', 'Deposit Deduction'];

/** Charges typed in on Generate rent may be anything but these, which have their own paths. */
const NOT_AN_EXTRA = ['Rent', 'Late Fee', 'Deposit'];

/**
 * Everything Generate rent reads, once per request: the days rent already
 * covers on each lease, rent invoices that name no period, the late fees
 * charged or waived, and the last electricity rate used on each lease.
 */
async function rentBook(r) {
  const invoices = await readTable(r, 'Invoices');
  const items = await readTable(r, 'InvoiceItems');
  const offline = await readTable(r, 'RentOffline');
  const byId = {};
  invoices.forEach(i => { byId[i.id] = i; });

  const rentLine = {}, feeFor = {}, feeOnItself = {}, eb = {};
  for (const it of items) {
    const cat = String(it.category);
    if (cat === 'Rent') rentLine[it.invoice_id] = true;
    if (it.late_fee_for) feeFor[it.late_fee_for] = it.invoice_id;
    // a late fee added the old way, by the daily job, on the overdue invoice itself
    else if (cat === 'Late Fee') feeOnItself[it.invoice_id] = true;
    // a meter bill typed as units × rate gives the rate to suggest next time
    if (cat === 'Electricity' && num(it.quantity) !== 1 && num(it.unit_amount) > 0) {
      const inv = byId[it.invoice_id];
      if (inv && inv.lease_id && String(inv.status) !== 'Void') {
        const when = String(inv.issue_date || inv.due_date || '') + '|' + inv.id;
        if (!eb[inv.lease_id] || when > eb[inv.lease_id].when) eb[inv.lease_id] = { when, rate: num(it.unit_amount) };
      }
    }
  }

  const billed = {}, unperioded = {}, lastBilled = {};
  const push = (map, key, v) => { (map[key] || (map[key] = [])).push(v); };
  for (const inv of invoices) {
    if (!inv.lease_id || !(String(inv.type) === 'Rent' || rentLine[inv.id])) continue;
    if (inv.period_start && inv.period_end) {
      // void or draft, a period with a rent invoice is billed: voiding one does
      // not put it back up for billing
      push(billed, inv.lease_id, { start: inv.period_start, end: inv.period_end, invoice_id: inv.id });
      const last = lastBilled[inv.lease_id];
      if (!last || inv.period_end > last.end) lastBilled[inv.lease_id] = { end: inv.period_end, invoice_id: inv.id };
    } else if (String(inv.status) !== 'Void') {
      push(unperioded, inv.lease_id, {
        id: inv.id, issue_date: inv.issue_date, due_date: inv.due_date, total: inv.total, status: inv.status
      });
    }
  }
  for (const o of offline) {
    push(billed, o.lease_id, { start: o.period_start, end: o.period_end, offline_id: o.id });
  }
  return { invoices, byId, billed, unperioded, lastBilled, offline, feeFor, feeOnItself, eb };
}

/**
 * The overdue invoices on a lease a late fee may now be charged for: open,
 * past the grace days (counted from the later of the due and issue dates),
 * not a deposit, and neither charged nor waived already.
 */
function lateFeeCandidates(lease, book, t) {
  const fee = round2(num(lease.late_fee));
  if (!(fee > 0)) return [];
  return book.invoices
    .filter(inv => inv.lease_id === lease.id && lateFeeState(lease, inv, book, t).eligible)
    .sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)))
    .map(inv => ({
      invoice_id: inv.id, type: inv.type, due_date: inv.due_date, issue_date: inv.issue_date,
      period_start: inv.period_start, period_end: inv.period_end, balance: num(inv.balance),
      fee, from: lateFeeFrom(lease, inv)
    }));
}

/** Where one invoice stands for a late fee. */
function lateFeeState(lease, inv, book, t) {
  const fee = lease ? round2(num(lease.late_fee)) : 0;
  const chargedOn = book.feeFor[inv.id] || (book.feeOnItself[inv.id] ? inv.id : '');
  const from = lease && inv.due_date ? lateFeeFrom(lease, inv) : '';
  const eligible = !!lease && fee > 0 && !chargedOn && !inv.late_fee_waived &&
    OPEN_STATUSES.indexOf(String(inv.status)) >= 0 && num(inv.balance) > 0 &&
    NO_LATE_FEE.indexOf(String(inv.type)) < 0 && !!from && from <= t;
  return { eligible, fee, from, charged_on: chargedOn, waived: inv.late_fee_waived || '' };
}

/** A period as the screen gets it: the key it sends back is its start date. */
function offered(p) {
  return {
    start: p.start, end: p.end, due: p.due, raise_from: p.raise_from, kind: p.kind,
    amount: p.amount, first_stub: !!p.first_stub, final: !!p.final, joined: !!p.joined,
    cycles: p.cycles.length,
    lines: p.lines.map(l => ({ start: l.start, end: l.end, days: l.days, month_days: l.monthDays,
                               rent: l.rent, amount: l.amount, text: rentLineText(l) }))
  };
}

/**
 * One lease as Generate rent sees it on day `t`.
 *
 *   state  ready            a period is due this month
 *          backlog          only periods due before this month are unbilled
 *          billed           nothing to bill until the next period's month
 *          not_due          nothing billed yet and the first period is due later
 *          missing_rent_day cannot be billed until a rent day is set
 *          open_termination terminated with no end date on or before today,
 *                           so where billing stops is not known
 *          done             ended and billed to its last day — not listed
 */
function rentCandidate(lease, book, t) {
  const base = {
    lease_id: lease.id, tenant_id: lease.tenant_id, unit_id: lease.unit_id, property_id: lease.property_id,
    lease_status: lease.status, frequency: lease.frequency || 'Monthly', rent_day: lease.rent_day,
    rent_amount: num(lease.rent_amount), gst_rate: num(lease.gst_rate), late_fee: num(lease.late_fee),
    grace_days: parseInt(lease.grace_days || 0, 10) || 0,
    ended: String(lease.status) === 'Expired' || String(lease.status) === 'Terminated' ||
           (!!lease.end_date && String(lease.end_date) < t),
    periods: [], joined: null, next: null,
    last_billed: book.lastBilled[lease.id] || null,
    unperioded: book.unperioded[lease.id] || [],
    offline: book.offline.filter(o => o.lease_id === lease.id)
      .map(o => ({ id: o.id, start: o.period_start, end: o.period_end, reason: o.reason, by: o.created_by,
                   at: o.created_at })),
    late_fees: lateFeeCandidates(lease, book, t),
    last_eb_rate: book.eb[lease.id] ? book.eb[lease.id].rate : null
  };
  if (validRentDay(lease.rent_day) === null) return { ...base, state: 'missing_rent_day' };
  // An early termination is marked by the status alone; billing to the old end
  // date would charge months nobody lived there, so wait for the real one.
  if (String(lease.status) === 'Terminated' && (!lease.end_date || String(lease.end_date) > t)) {
    return { ...base, state: 'open_termination' };
  }

  const all = rentPeriods(lease, { billed: book.billed[lease.id] || [], asOf: t });
  const raisable = all.filter(p => p.kind !== 'future');
  const future = all.find(p => p.kind === 'future') || null;
  const joined = joinFirstStub(all);
  const state = raisable.some(p => p.kind === 'current') ? 'ready'
    : raisable.length ? 'backlog'
    : future ? (base.last_billed ? 'billed' : 'not_due')
    : 'done';
  return {
    ...base, state,
    periods: raisable.map(offered),
    joined: joined ? offered(joined) : null,
    next: future ? offered(future) : null
  };
}

/** Leases in the order they are listed and numbered: property, then unit. */
async function leaseOrder(r) {
  const props = {}, units = {};
  (await readTable(r, 'Properties')).forEach(p => { props[p.id] = String(p.name || p.id); });
  (await readTable(r, 'Units')).forEach(u => { units[u.id] = String(u.unit_number || u.id); });
  const opts = { numeric: true, sensitivity: 'base' };
  return (a, b) => (props[a.property_id] || '').localeCompare(props[b.property_id] || '', 'en', opts) ||
                   (units[a.unit_id] || '').localeCompare(units[b.unit_id] || '', 'en', opts) ||
                   String(a.id || a.lease_id).localeCompare(String(b.id || b.lease_id));
}

/** Step 1 of Generate rent: every lease with what it can be billed today. */
async function rentCandidates(r, payload, user) {
  requireRole(user, 'manager');
  const t = today(r);
  const book = await rentBook(r);
  const order = await leaseOrder(r);
  const leases = (await readTable(r, 'Leases')).sort(order);
  const list = leases.map(l => rentCandidate(l, book, t)).filter(c => c.state !== 'done');
  return { as_of: t, leases: list };
}

/** Which invoice or record already covers `start` on a lease, for a skip message. */
function coveredBy(book, leaseId, start) {
  const hit = (book.billed[leaseId] || []).find(b => b.start <= start && b.end >= start);
  if (!hit) return '';
  return hit.invoice_id ? 'already billed on ' + hit.invoice_id : 'marked as billed outside the app';
}

/**
 * Raise the rent invoices chosen on the Generate rent screen, as drafts or
 * issued, in one transaction. Each entry names a lease and the start of a
 * period the screen was offered; the rent is recomputed here and checked
 * against what the screen showed, so a lease edited in the meantime is
 * skipped and named rather than billed at a figure nobody saw.
 *
 * @param payload.mode      'issue' or 'draft'
 * @param payload.invoices  [{ lease_id, period_start, period_end, rent, join_first,
 *                            extras: [{description, category, quantity, unit_amount, tax_rate}],
 *                            adjust: { amount, reason }, late_fees: [invoice_id], notes }]
 */
async function generateRent(r, payload, user) {
  requireRole(user, 'manager');
  const mode = payload.mode === 'draft' ? 'draft' : payload.mode === 'issue' ? 'issue' : '';
  if (!mode) throw new Error('Choose whether to issue the invoices or save them as drafts.');
  const entries = Array.isArray(payload.invoices) ? payload.invoices : [];
  if (!entries.length) throw new Error('Choose at least one lease to bill.');

  const t = today(r);
  const book = await rentBook(r);
  const leases = {};
  (await readTable(r, 'Leases')).forEach(l => { leases[l.id] = l; });
  const tenants = {};
  (await readTable(r, 'Tenants')).forEach(tn => { tenants[tn.id] = tn; });
  const candidates = {};
  const candidateOf = (lease) => candidates[lease.id] || (candidates[lease.id] = rentCandidate(lease, book, t));
  const who = (lease) => (tenants[lease.tenant_id] ? tenants[lease.tenant_id].full_name + ' (' + lease.id + ')' : lease.id);

  const plan = [], skipped = [], feesDropped = [];
  const claimed = {}, feesClaimed = {};
  for (const entry of entries) {
    const lease = leases[entry.lease_id];
    if (!lease) { skipped.push({ lease_id: entry.lease_id, reason: 'The lease no longer exists.' }); continue; }
    const c = candidateOf(lease);
    if (c.state === 'missing_rent_day') { skipped.push({ lease_id: lease.id, reason: 'The lease has no rent day.' }); continue; }
    if (c.state === 'open_termination') {
      skipped.push({ lease_id: lease.id, reason: 'The lease was terminated without an end date.' }); continue;
    }

    const start = String(entry.period_start || '');
    const period = entry.join_first
      ? (c.joined && c.joined.start === start && c.joined.kind !== 'future' ? c.joined : null)
      : c.periods.find(p => p.start === start) || null;
    if (!period) {
      const why = coveredBy(book, lease.id, start);
      skipped.push({ lease_id: lease.id, period_start: start,
                     reason: why ? 'This period is ' + why + '.' : 'This period is no longer due to be billed.' });
      continue;
    }
    // the screen and the server must be looking at the same invoice
    if (String(entry.period_end || '') !== period.end || round2(num(entry.rent)) !== period.amount) {
      skipped.push({ lease_id: lease.id, period_start: start,
                     reason: 'The lease changed after you opened Generate rent (now ' + period.start + ' to ' +
                             period.end + ', rent ' + period.amount + '). Open it again to review.' });
      continue;
    }
    // a first part month is billed on its own or with the next invoice only when asked
    if (period.first_stub && entry.join_first !== false) {
      throw new Error(who(lease) + ': choose whether to bill the first part month on its own or with the next invoice.');
    }
    const mine = claimed[lease.id] || (claimed[lease.id] = []);
    if (mine.some(x => !(period.end < x.start || period.start > x.end))) {
      skipped.push({ lease_id: lease.id, period_start: start, reason: 'These days are already in another invoice on this screen.' });
      continue;
    }
    mine.push({ start: period.start, end: period.end });

    const rate = num(lease.gst_rate);
    const lines = period.lines.map(l => ({
      description: l.text, category: 'Rent', quantity: 1, unit_amount: l.amount, tax_rate: rate
    }));

    // a changed rent is its own line, so the calculated rent stays on record
    if (entry.adjust && entry.adjust.amount !== undefined && entry.adjust.amount !== '') {
      const to = round2(num(String(entry.adjust.amount).replace(/,/g, '')));
      const reason = String(entry.adjust.reason || '').trim();
      if (!(to >= 0)) throw new Error(who(lease) + ': the adjusted rent cannot be negative.');
      if (!reason) throw new Error(who(lease) + ': give a reason for changing the rent.');
      const diff = round2(to - period.amount);
      if (diff !== 0) {
        lines.push({ description: 'Rent adjustment', category: 'Rent', quantity: 1, unit_amount: diff, tax_rate: rate,
                     notes: 'Rent adjusted from ' + period.amount + ' to ' + to + ': ' + reason.slice(0, 300),
                     _adjust: { from: period.amount, to, reason } });
      }
    }

    for (const id of [].concat(entry.late_fees || [])) {
      const fee = c.late_fees.find(f => f.invoice_id === id);
      if (!fee || feesClaimed[id]) { feesDropped.push({ lease_id: lease.id, invoice_id: id }); continue; }
      feesClaimed[id] = true;
      lines.push({ description: 'Late fee · ' + id + ' overdue since ' + fee.due_date, category: 'Late Fee',
                   quantity: 1, unit_amount: fee.fee, tax_rate: rate, late_fee_for: id });
    }

    for (const x of [].concat(entry.extras || [])) {
      const category = String(x.category || 'Other');
      if (NOT_AN_EXTRA.indexOf(category) >= 0) {
        throw new Error(who(lease) + ': a ' + category + ' charge cannot be added as an extra line.');
      }
      lines.push({ description: x.description, category, quantity: x.quantity, unit_amount: x.unit_amount,
                   tax_rate: x.tax_rate });
    }

    let priced;
    try { priced = priceLines(lines); }
    catch (err) { throw new Error(who(lease) + ': ' + err.message); }
    if (priced.subtotal < 0) throw new Error(who(lease) + ': the invoice cannot come to less than zero.');
    priced.priced.forEach((p, i) => { p.late_fee_for = lines[i].late_fee_for || ''; p._adjust = lines[i]._adjust; });
    plan.push({ lease, period, priced, notes: String(entry.notes || '').trim() });
  }

  const order = await leaseOrder(r);
  plan.sort((a, b) => order(a.lease, b.lease) || a.period.start.localeCompare(b.period.start));

  const headers = plan.map(({ lease, period, priced, notes }) => {
    const tax = priced.hasRates ? priced.lineTax : 0;
    const total = round2(priced.subtotal + tax);
    return {
      lease_id: lease.id, tenant_id: lease.tenant_id, unit_id: lease.unit_id, property_id: lease.property_id,
      type: 'Rent', period_start: period.start, period_end: period.end,
      issue_date: mode === 'issue' ? t : '', due_date: period.due,
      amount: priced.subtotal, tax, total, amount_paid: 0, balance: total,
      status: mode === 'issue' ? 'Unpaid' : 'Draft', notes
    };
  });
  const created = await appendRows(r, 'Invoices', headers, user);
  await appendRows(r, 'InvoiceItems', created.flatMap((inv, n) => plan[n].priced.priced.map(p => ({
    invoice_id: inv.id, description: p.description, category: p.category, quantity: p.quantity,
    unit_amount: p.unit_amount, amount: p.amount, tax_rate: p.tax_rate, tax_amount: p.tax_amount,
    notes: p.notes || '', late_fee_for: p.late_fee_for
  }))), user);

  const saved = [];
  for (let n = 0; n < created.length; n++) {
    const inv = (await applyInvoiceTotals(r, created[n].id, user)) || created[n];
    saved.push(inv);
    for (const p of plan[n].priced.priced) {
      if (p._adjust) {
        await log(r, user, 'rent-adjusted', 'Invoices', inv.id,
                  p._adjust.from + ' → ' + p._adjust.to + ' · ' + p._adjust.reason.slice(0, 150));
      }
      if (p.late_fee_for) await log(r, user, 'late-fee', 'Invoices', p.late_fee_for, p.amount + ' charged on ' + inv.id);
    }
  }
  const total = round2(saved.reduce((s, i) => s + num(i.total), 0));
  await log(r, user, 'generate-rent', 'Invoices', '',
            saved.length + ' ' + (mode === 'issue' ? 'issued' : 'saved as drafts') + ', total ' + total +
            (skipped.length ? ', ' + skipped.length + ' skipped' : ''));
  return { mode, created: saved, total, skipped, fees_dropped: feesDropped };
}

/**
 * Mark periods of a lease as billed outside the app — rent settled before the
 * lease was entered here, say — so Generate rent stops offering them. Only
 * periods it offers now can be marked, and a reason is kept with each.
 */
async function markRentOffline(r, payload, user) {
  requireRole(user, 'manager');
  const lease = await findRow(r, 'Leases', payload.lease_id);
  if (!lease) throw new Error('Lease ' + payload.lease_id + ' not found');
  const reason = String(payload.reason || '').trim();
  if (!reason) throw new Error('Give a reason — for example "collected before we used the app".');
  const starts = [].concat(payload.period_starts || []).map(String);
  if (!starts.length) throw new Error('Choose at least one period.');

  const c = rentCandidate(lease, await rentBook(r), today(r));
  const rows = starts.map(start => {
    const p = c.periods.find(x => x.start === start);
    if (!p) throw new Error('The period from ' + start + ' is not waiting to be billed on ' + lease.id + '.');
    return { lease_id: lease.id, period_start: p.start, period_end: p.end, reason: reason.slice(0, 500),
             created_by: user.name || user.phone || '' };
  });
  const saved = await appendRows(r, 'RentOffline', rows, user);
  await log(r, user, 'rent-billed-outside', 'Leases', lease.id,
            saved.map(s => s.period_start + '..' + s.period_end).join(', ') + ' · ' + reason.slice(0, 120));
  return { marked: saved };
}

/** Undo "billed outside the app": the period is offered again. */
async function undoRentOffline(r, payload, user) {
  requireRole(user, 'manager');
  const row = await findRow(r, 'RentOffline', payload.id);
  if (!row) throw new Error('That record no longer exists.');
  await removeRow(r, 'RentOffline', row.id);
  await log(r, user, 'rent-billed-outside-undone', 'Leases', row.lease_id, row.period_start + '..' + row.period_end);
  return { removed: row.id };
}

/** Charge the late fee on an overdue invoice itself — for a tenant with no new invoice to carry it. */
async function chargeLateFee(r, payload, user) {
  requireRole(user, 'manager');
  const inv = await findRow(r, 'Invoices', payload.invoice_id);
  if (!inv) throw new Error('Invoice ' + payload.invoice_id + ' not found');
  const lease = inv.lease_id ? await findRow(r, 'Leases', inv.lease_id) : null;
  const state = lateFeeState(lease, inv, await rentBook(r), today(r));
  if (!state.eligible) throw new Error(lateFeeRefusal(inv, lease, state, today(r)));
  const rate = num(lease.gst_rate);
  await createRow(r, 'InvoiceItems', {
    invoice_id: inv.id, description: 'Late fee · overdue since ' + inv.due_date, category: 'Late Fee',
    quantity: 1, unit_amount: state.fee, amount: state.fee, tax_rate: rate,
    tax_amount: round2(state.fee * rate / 100), notes: '', late_fee_for: inv.id
  }, user, true);
  const saved = await applyInvoiceTotals(r, inv.id, user);
  await log(r, user, 'late-fee', 'Invoices', inv.id, state.fee + ' charged on the invoice itself');
  return { invoice: saved };
}

/** Waive an invoice's late fee for good, with the reason. It is not offered again. */
async function waiveLateFee(r, payload, user) {
  requireRole(user, 'manager');
  const inv = await findRow(r, 'Invoices', payload.invoice_id);
  if (!inv) throw new Error('Invoice ' + payload.invoice_id + ' not found');
  const reason = String(payload.reason || '').trim();
  if (!reason) throw new Error('Give a reason for waiving the late fee.');
  const state = lateFeeState(inv.lease_id ? await findRow(r, 'Leases', inv.lease_id) : null, inv, await rentBook(r), today(r));
  if (state.charged_on) throw new Error('The late fee for ' + inv.id + ' is already charged on ' + state.charged_on + '.');
  if (state.waived) throw new Error('The late fee for ' + inv.id + ' is already waived.');
  const saved = await updateRow(r, 'Invoices', inv.id, { late_fee_waived: reason.slice(0, 500) }, user, true);
  await log(r, user, 'late-fee-waived', 'Invoices', inv.id, reason.slice(0, 180));
  return { invoice: saved };
}

function lateFeeRefusal(inv, lease, state, t) {
  if (!lease) return inv.id + ' is not on a lease, so there is no late fee to charge.';
  if (!(state.fee > 0)) return 'Lease ' + lease.id + ' has no late fee set.';
  if (state.charged_on) return 'The late fee for ' + inv.id + ' is already charged on ' + state.charged_on + '.';
  if (state.waived) return 'The late fee for ' + inv.id + ' was waived: ' + state.waived;
  if (NO_LATE_FEE.indexOf(String(inv.type)) >= 0) return 'A deposit is never charged a late fee.';
  if (OPEN_STATUSES.indexOf(String(inv.status)) < 0 || !(num(inv.balance) > 0)) return inv.id + ' has nothing owing.';
  if (state.from && state.from > t) return 'The grace days for ' + inv.id + ' run until the day before ' + state.from + '.';
  return 'No late fee can be charged on ' + inv.id + '.';
}

/** Issue drafts: every draft, or the ones named. Each is dated today unless it has a date. */
async function issueDrafts(r, payload, user) {
  requireRole(user, 'manager');
  const only = Array.isArray(payload.ids) && payload.ids.length ? new Set(payload.ids.map(String)) : null;
  const drafts = (await readTable(r, 'Invoices'))
    .filter(i => String(i.status) === 'Draft' && (!only || only.has(i.id)));
  if (!drafts.length) throw new Error('There are no drafts to issue.');
  const t = today(r);
  const issued = [];
  for (const d of drafts) {
    await updateRow(r, 'Invoices', d.id, { status: 'Unpaid', issue_date: d.issue_date || t }, user, true);
    issued.push((await applyInvoiceTotals(r, d.id, user)) || d);
  }
  const total = round2(issued.reduce((s, i) => s + num(i.total), 0));
  await log(r, user, 'issue-drafts', 'Invoices', '', issued.length + ' issued, total ' + total);
  return { issued, total };
}

// ───────────────────────────────────────────────────────────── housekeeping ──

/**
 * Housekeeping: flips overdue invoices, expires leases, syncs unit occupancy
 * and tenant status, charges late fees. The writes are made as SYSTEM, not as
 * the caller — the app maintaining its own derived state.
 */
async function refreshStatuses(r, user, quiet) {
  const result = await refreshStatusesLocked(r, user, quiet);
  await setState(r, 'LAST_REFRESH', today(r));
  return result;
}

/** Housekeeping, at most once a day on a read; the daily job normally beats it. */
async function refreshIfStale(r, user) {
  if (await getState(r, 'LAST_REFRESH') === today(r)) return;
  await refreshStatuses(r, user, true);
}

async function refreshStatusesLocked(r, user, quiet) {
  const t = today(r);
  let changes = 0;
  const sys = SYSTEM_ACTOR;

  for (const inv of await readTable(r, 'Invoices')) {
    if (['Paid', 'Void', 'Draft'].indexOf(String(inv.status)) >= 0) continue;
    if (inv.due_date && String(inv.due_date) < t && String(inv.status) !== 'Overdue') {
      await updateRow(r, 'Invoices', inv.id, { status: 'Overdue' }, sys, true); changes++;
    }
  }

  const occupied = {};
  for (const lease of await readTable(r, 'Leases')) {
    const status = String(lease.status);
    if (status === 'Terminated') continue;
    if (lease.end_date && String(lease.end_date) < t && status !== 'Expired') {
      await updateRow(r, 'Leases', lease.id, { status: 'Expired' }, sys, true); changes++;
      continue;
    }
    if (lease.start_date && String(lease.start_date) > t && status !== 'Upcoming') {
      await updateRow(r, 'Leases', lease.id, { status: 'Upcoming' }, sys, true); changes++;
    }
    if (String(lease.start_date) <= t && (!lease.end_date || String(lease.end_date) >= t)) {
      if (status !== 'Active') { await updateRow(r, 'Leases', lease.id, { status: 'Active' }, sys, true); changes++; }
      occupied[lease.unit_id] = true;
    }
  }

  for (const unit of await readTable(r, 'Units')) {
    if (String(unit.status) === 'Under Maintenance') continue;
    const want = occupied[unit.id] ? 'Occupied' : 'Vacant';
    if (String(unit.status) !== want) { await updateRow(r, 'Units', unit.id, { status: want }, sys, true); changes++; }
  }

  // A tenant is Active while they hold a live lease and Past once every lease
  // has ended. Someone with no lease at all is left alone — a Prospect. Living
  // on someone else's lease counts, until the day they move out.
  const live = {}, everLeased = {}, leaseById = {};
  (await readTable(r, 'Leases')).forEach(l => {
    leaseById[l.id] = l;
    if (!l.tenant_id) return;
    everLeased[l.tenant_id] = true;
    if (['Active', 'Upcoming'].indexOf(String(l.status)) >= 0) live[l.tenant_id] = true;
  });
  (await readTable(r, 'LeaseTenants')).forEach(o => {
    const l = leaseById[o.lease_id];
    if (!l || !o.tenant_id) return;
    everLeased[o.tenant_id] = true;
    const stillThere = !o.move_out_date || String(o.move_out_date) >= t;
    if (stillThere && ['Active', 'Upcoming'].indexOf(String(l.status)) >= 0) live[o.tenant_id] = true;
  });
  for (const tenant of await readTable(r, 'Tenants')) {
    if (!everLeased[tenant.id]) continue;
    const want = live[tenant.id] ? 'Active' : 'Past';
    if (String(tenant.status) !== want) {
      await updateRow(r, 'Tenants', tenant.id, { status: want }, sys, true); changes++;
    }
  }

  // Late fees are no longer added here: they are chosen, invoice by invoice,
  // when rent is generated or from the overdue invoice's page (see
  // lateFeeCandidates).
  await pruneActivityLog(r);

  if (!quiet) await log(r, user || sys, 'refresh-statuses', 'System', '', changes + ' rows updated');
  return { changes };
}

/** Keep the audit trail to a workable size, trimming in batches. */
export const ACTIVITY_LOG_KEEP = 5000;

/**
 * Failed sign-ins are trimmed on their own allowance. Anyone on the internet
 * can add them, so counting them against the real history would let a stranger
 * push every payment, deletion and role change out of the log.
 */
export const FAILED_LOGIN_KEEP = 1000;

async function pruneActivityLog(r) {
  const trimmed = await trimActivityLog(r, true, FAILED_LOGIN_KEEP) +
                  await trimActivityLog(r, false, ACTIVITY_LOG_KEEP);
  if (trimmed) invalidate(r, 'ActivityLog');
  return trimmed;
}

async function trimActivityLog(r, failedLogins, keep) {
  const [{ n }] = await r.tx`
    select count(*)::int as n from activity_log where (action = 'login-failed') = ${failedLogins}`;
  const excess = Number(n) - keep;
  if (excess < 500) return 0;
  await r.tx`delete from activity_log where seq in (
    select seq from activity_log where (action = 'login-failed') = ${failedLogins} order by seq limit ${excess})`;
  return excess;
}

// ───────────────────────────────────────────────────────────────── stats ────

async function computeStats(r) {
  // A sold or inactive property is no longer part of the portfolio.
  const live = {};
  let liveProperties = 0;
  (await readTable(r, 'Properties')).forEach(p => {
    const status = String(p.status || 'Active');
    if (status !== 'Sold' && status !== 'Inactive') { live[p.id] = true; liveProperties++; }
  });
  const inPortfolio = (row) => !row.property_id || live[row.property_id];

  const units = (await readTable(r, 'Units')).filter(inPortfolio);
  const leases = (await readTable(r, 'Leases')).filter(inPortfolio);
  const invoices = await readTable(r, 'Invoices');
  const payments = await readTable(r, 'Payments');
  const expenses = await readTable(r, 'Expenses');
  const maintenance = (await readTable(r, 'Maintenance')).filter(inPortfolio);
  const tenants = await readTable(r, 'Tenants');

  const t = today(r);
  const month = t.slice(0, 7);
  // A deposit is money held for the tenant, not income, and returning it is not
  // an operating expense — so neither moves "collected" or "spent".
  const depositInvoice = {};
  invoices.forEach(i => { if (String(i.type) === 'Deposit') depositInvoice[i.id] = true; });
  const ledgers = await depositLedgers(r, leases);
  const sum = (arr, field, test) => {
    let total = 0;
    arr.forEach(row => { if (!test || test(row)) total += parseFloat(row[field] || 0) || 0; });
    return round2(total);
  };

  let occupied = 0;
  units.forEach(u => { if (String(u.status) === 'Occupied') occupied++; });

  return {
    properties: liveProperties,
    units: units.length,
    occupied_units: occupied,
    vacant_units: units.length - occupied,
    occupancy_rate: units.length ? Math.round((occupied / units.length) * 1000) / 10 : 0,
    active_leases: leases.filter(l => String(l.status) === 'Active').length,
    tenants: tenants.filter(tn => String(tn.status) === 'Active').length,
    // the rent actually in force, escalation included
    monthly_rent_roll: round2(leases.reduce((acc, l) =>
      String(l.status) === 'Active' ? acc + currentMonthlyRent(r, l, t) : acc, 0)),
    outstanding: sum(invoices, 'balance', i => ['Unpaid', 'Partial', 'Overdue'].indexOf(String(i.status)) >= 0),
    overdue: sum(invoices, 'balance', i => String(i.status) === 'Overdue'),
    overdue_count: invoices.filter(i => String(i.status) === 'Overdue').length,
    collected_this_month: sum(payments, 'amount', p =>
      String(p.payment_date || '').slice(0, 7) === month && !depositInvoice[p.invoice_id] &&
      String(p.method) !== 'Deposit Adjustment'),
    expenses_this_month: sum(expenses, 'amount', e =>
      String(e.date || '').slice(0, 7) === month && String(e.category) !== 'Deposit Refund'),
    open_tickets: maintenance.filter(m => ['Open', 'In Progress', 'On Hold'].indexOf(String(m.status)) >= 0).length,
    // what is still owed back to tenants, from the deposit ledger
    deposits_held: round2(leases.reduce((acc, l) => acc + (ledgers[l.id] ? ledgers[l.id].held : 0), 0))
  };
}

// ───────────────────────────────────────────────────────────── reminders ────

/** The daily reminder run. Does nothing unless switched on and email is configured. */
async function dailyReminderJob(r) {
  const settings = await readSettings(r);
  if (String(settings.reminder_enabled).toLowerCase() !== 'true') return { sent: 0, skipped: 0, invoices: 0 };
  if (!r.env.sendEmail) return { sent: 0, skipped: 0, invoices: 0, disabled: 'no email provider configured' };
  return sendReminders(r, { email: 'scheduler', role: 'admin', name: 'Scheduler' }, { scheduled: true });
}

/**
 * The days an unpaid invoice is due a reminder on, from the settings: N days
 * before it falls due, on the day itself, and on each listed day overdue.
 */
function reminderSchedule(settings) {
  const before = parseInt(settings.reminder_days_before || '3', 10);
  const overdue = String(settings.reminder_overdue_days || '1,7,14,30').split(/[,\s]+/)
    .map(d => parseInt(d, 10))
    .filter(d => d > 0);
  return { before: isNaN(before) ? 3 : Math.max(0, before), overdue };
}

/** Whole days from `a` to `b` (yyyy-MM-dd), negative when b is earlier. */
function daysFrom(a, b) {
  const da = parseDate(a), db = parseDate(b);
  if (!da || !db) return NaN;
  return Math.round((db.getTime() - da.getTime()) / 86400000);
}

/**
 * Email tenants about what they owe: one email per tenant listing all their
 * invoices, on a schedule, never twice in a day for the same invoice.
 *
 * No email provider is configured yet, so the button reports that plainly
 * instead of pretending to send.
 */
async function sendReminders(r, user, opts) {
  requireRole(user, 'manager');
  if (!r.env.sendEmail) {
    throw new Error('Email reminders are not set up yet. Share invoices over WhatsApp from the invoice page instead.');
  }
  const scheduled = !!(opts && opts.scheduled);
  const settings = await readSettings(r);
  const schedule = reminderSchedule(settings);
  const t = today(r);
  const tenants = {};
  (await readTable(r, 'Tenants')).forEach(tn => { tenants[tn.id] = tn; });

  const byTenant = {}, order = [];
  (await readTable(r, 'Invoices')).forEach(inv => {
    if (['Unpaid', 'Partial', 'Overdue'].indexOf(String(inv.status)) < 0) return;
    if (num(inv.balance) <= 0) return;
    if (String(inv.last_reminded) === t) return;
    const until = daysFrom(t, inv.due_date);
    if (isNaN(until)) return;
    const due = scheduled
      ? (until === schedule.before || until === 0 || schedule.overdue.indexOf(-until) >= 0)
      : until <= schedule.before;
    if (!due) return;
    if (!byTenant[inv.tenant_id]) { byTenant[inv.tenant_id] = []; order.push(inv.tenant_id); }
    byTenant[inv.tenant_id].push(inv);
  });

  let sent = 0, skipped = 0, reminded = [];
  const money = (v) => (settings.currency_symbol || '') + round2(v).toLocaleString('en-IN');
  for (const tenantId of order) {
    const tenant = tenants[tenantId];
    const list = byTenant[tenantId].sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)));
    // Email is optional on a tenant record; those tenants simply get no email.
    if (!tenant || !String(tenant.email || '').trim()) { skipped++; continue; }

    const overdue = list.some(inv => String(inv.due_date) < t);
    const total = list.reduce((s, inv) => s + num(inv.balance), 0);
    const lines = list.map(inv =>
      '  ' + inv.id + ' · ' + (inv.type || 'Invoice') +
      (inv.period_start ? ' · ' + inv.period_start + ' to ' + inv.period_end : '') +
      ' · due ' + inv.due_date + ' · ' + money(inv.balance) +
      (String(inv.due_date) < t ? ' (overdue)' : ''));
    const subject = (overdue ? 'Payment overdue — ' : 'Payment due — ') + money(total) +
                    ' · ' + (settings.org_name || 'Property Management');
    const body =
      'Hello ' + tenant.full_name + ',\n\n' +
      (overdue ? 'Our records show an overdue balance on your account.\n\n'
               : 'This is a friendly reminder that a payment is due shortly.\n\n') +
      lines.join('\n') + '\n\n' +
      'Total due: ' + money(total) + '\n' +
      (settings.upi_id ? 'Pay by UPI to: ' + settings.upi_id + '\n' : '') +
      '\nPlease disregard this note if payment is already on its way.\n\n' +
      '— ' + (settings.org_name || 'Property Management');
    try {
      await r.env.sendEmail(tenant.email, subject, body);
      sent++;
      reminded = reminded.concat(list);
    } catch (e) { skipped++; }
  }

  for (const inv of reminded) {
    await updateRow(r, 'Invoices', inv.id, { last_reminded: t }, SYSTEM_ACTOR, true);
  }
  await log(r, user, 'send-reminders', 'Invoices', '', sent + ' sent, ' + skipped + ' skipped' + (scheduled ? ' (scheduled)' : ''));
  return { sent, skipped, invoices: reminded.length };
}

// ───────────────────────────────────────────────────────────── date utils ──
// Calendar arithmetic on local-midnight Dates built from y/m/d components and
// formatted back the same way, so the server's own zone never shifts a day.

export function parseDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  const s = String(v).slice(0, 10);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) { const d = new Date(s); return isNaN(d.getTime()) ? null : d; }
  return new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
}

export function fmtDate(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

export function monthsBetween(a, b) {
  return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
}

export function round2(n) { return Math.round((parseFloat(n) || 0) * 100) / 100; }

/**
 * Internals the test suites drive directly (test/pg-harness.mjs). Each takes
 * the request context `r` that `backend.run(fn)` hands to `fn`.
 */
export const internals = {
  readTable, findRow, readSettings, refreshStatuses, applyInvoiceTotals, computeStats,
  sendReminders, dailyReminderJob, today, deriveLeaseStatus, getState, setState
};
