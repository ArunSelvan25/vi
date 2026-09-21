/**
 * Runs the backend (supabase/functions/api/backend.js) against a real
 * Postgres: `box.handle(action, payload, token)`, `box.readTable(table)`,
 * `box.today()` and friends, each returning a promise.
 *
 * Each sandbox is its own database, cloned from a template that has the
 * migrations applied, so tests cannot see each other's rows. Point it at a
 * server you can create databases on:
 *
 *   TEST_DATABASE_URL=postgres://postgres:pw@localhost:55432/postgres
 *
 * `npm run db:test` starts a disposable one in Docker on that port.
 */
import fs from 'fs';
import postgres from 'postgres';
import {
  createBackend, internals, todayIn, periodsFor, normalisePhone, constantTimeEquals,
  hashPasswordLegacy, hashPasswordV2, signToken, THROTTLE, BOOTSTRAP_WINDOW_MS
} from '../supabase/functions/api/backend.js';
import { PG_TYPES } from '../supabase/functions/api/schema.js';
import { insertRows } from '../supabase/functions/api/db.js';

/** Tables in the order their foreign keys allow them to be filled. */
const SEED_ORDER = ['Properties', 'Units', 'Tenants', 'Leases', 'Invoices', 'InvoiceItems',
                    'Payments', 'Maintenance', 'Expenses', 'Documents'];

const SERVER_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres:pw@localhost:55432/postgres';
const TEMPLATE = 'vipm_template';
const MIGRATIONS = new URL('../supabase/migrations/', import.meta.url);

/** Fast hashing for tests; the production default is 600k rounds. */
export const TEST_HASH_ITERATIONS = 1000;
export const TEST_SECRET = 'test-auth-secret-that-is-long-enough-0123456789';

let server = null;
let template = null;
const opened = [];

function urlFor(db) {
  const u = new URL(SERVER_URL);
  u.pathname = '/' + db;
  return u.toString();
}

function serverSql() {
  if (!server) server = postgres(SERVER_URL, { max: 1, onnotice: () => {} });
  return server;
}

/** Build the template database once per test process: every migration, in order. */
function ensureTemplate() {
  if (template) return template;
  template = (async () => {
    const admin = serverSql();
    try { await admin`select 1`; }
    catch (e) {
      throw new Error('Cannot reach the test database at ' + SERVER_URL +
                      ' — start one with `npm run db:test`, or set TEST_DATABASE_URL. (' + e.message + ')');
    }
    // databases left behind by a test run that was killed before it could clean up
    const stale = await admin`select datname from pg_database where datname like 'vipm_t_%'`;
    for (const { datname } of stale) {
      const pid = Number(datname.split('_')[2]);
      let alive = false;
      try { process.kill(pid, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; }
      if (!alive) await admin.unsafe(`drop database if exists ${datname} with (force)`);
    }
    await admin.unsafe(`drop database if exists ${TEMPLATE} with (force)`);
    await admin.unsafe(`create database ${TEMPLATE}`);
    // Supabase's own set-up, which the migrations must hold their own against:
    // the roles behind the public REST API, granted every new table by default.
    await admin.unsafe(`do $$ begin
      if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin; end if;
      if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
    end $$`);
    const sql = postgres(urlFor(TEMPLATE), { max: 1, onnotice: () => {} });
    await sql.unsafe(`grant usage on schema public to anon, authenticated;
                      alter default privileges in schema public grant all on tables to anon, authenticated;
                      alter default privileges in schema public grant all on functions to anon, authenticated;`);
    const files = fs.readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort();
    for (const f of files) await sql.unsafe(fs.readFileSync(new URL(f, MIGRATIONS), 'utf8'));
    await sql.end();
  })();
  return template;
}

let counter = 0;

/**
 * A backend on a fresh, empty database.
 *
 * @param {object} [opts]
 * @param {string} [opts.timeZone]  the app's zone (default Asia/Kolkata)
 * @param {string} [opts.setupKey]  SETUP_KEY for the deployment
 * @param {boolean} [opts.noEmail]  no email provider, as in production today
 * @param {number} [opts.connections] pool size (default 1); more to test concurrent requests
 */
export async function makeSandbox(opts = {}) {
  await ensureTemplate();
  const name = `vipm_t_${process.pid}_${++counter}`;
  await serverSql().unsafe(`create database ${name} template ${TEMPLATE}`);
  // every statement sent, for probes that care how much work a request does
  const queries = [];
  const sql = postgres(urlFor(name), {
    types: PG_TYPES, max: opts.connections || 1, idle_timeout: 1, onnotice: () => {},
    debug: (connection, text, params) => {
      queries.push(text.replace(/\s+/g, ' ').trim() + (params && params.length ? ' -- ' + JSON.stringify(params) : ''));
    }
  });
  opened.push({ name, sql });

  const tz = opts.timeZone || 'Asia/Kolkata';
  const emails = [];
  const backend = createBackend({
    sql,
    authSecret: TEST_SECRET,
    setupKey: opts.setupKey || '',
    timeZone: tz,
    hashIterations: opts.hashIterations || TEST_HASH_ITERATIONS,
    sendEmail: opts.noEmail ? null : async (to, subject, body) => {
      if (opts.failEmailTo && to === opts.failEmailTo) throw new Error('mail rejected');
      emails.push({ to, subject, body });
    }
  });
  const inTx = (fn) => backend.run(fn);
  const SYSTEM = { role: 'admin', phone: 'system', name: 'system' };

  return {
    backend, sql, emails, queries, dbName: name,
    handle: (action, payload, token) => backend.handle(action, payload, token),
    readTable: (table) => inTx(r => internals.readTable(r, table)),
    readSettings: () => inTx(r => internals.readSettings(r)),
    refreshStatuses: (user, quiet) => inTx(r => internals.refreshStatuses(r, user || SYSTEM, quiet)),
    applyInvoiceTotals: (id) => inTx(r => internals.applyInvoiceTotals(r, id)),
    generateInvoices: (payload, user) => inTx(r => internals.generateInvoices(r, payload || {}, user || SYSTEM)),
    sendReminders: (user, o) => inTx(r => internals.sendReminders(r, user || SYSTEM, o || {})),
    dailyReminderJob: () => backend.dailyReminderJob(),
    dailyMaintenanceJob: () => backend.dailyMaintenanceJob(),
    recoverAccess: (phone, password, displayName) => backend.recoverAccess(phone, password, displayName),
    getState: (key) => inTx(r => internals.getState(r, key)),
    setState: (key, value) => inTx(r => internals.setState(r, key, value)),
    /**
     * Write rows straight into the tables, as data that is already there —
     * the dev server's sample portfolio. The id counters are moved past the
     * seeded ids so new records carry on from them, and today's housekeeping
     * is marked done, so opening the app changes nothing by itself.
     */
    seed: (tables) => backend.run(async (r) => {
      for (const name of SEED_ORDER) {
        const rows = tables[name] || [];
        if (!rows.length) continue;
        await insertRows(r, name, rows);
        const last = Math.max(0, ...rows.map(x => Number((String(x.id).match(/(\d+)$/) || [])[1]) || 0));
        await r.tx`insert into id_counters (table_name, last_value) values (${name}, ${last})
                   on conflict (table_name) do update set last_value = greatest(id_counters.last_value, excluded.last_value)`;
      }
      await internals.setState(r, 'LAST_REFRESH', todayIn(tz));
    }),
    /** Run raw SQL against this sandbox's database — the "someone edited the table by hand" case. */
    query: (text, params) => sql.unsafe(text, params || []),
    today: () => todayIn(tz),
    periodsFor,
    normalisePhone,
    constantTimeEquals,
    hashPasswordLegacy,
    hashPasswordV2,
    signToken: (payload) => signToken(TEST_SECRET, payload),
    THROTTLE,
    BOOTSTRAP_WINDOW_MS,
    HASH_ITERATIONS: opts.hashIterations || TEST_HASH_ITERATIONS
  };
}

/** A sandbox with the first administrator created and signed in. */
export async function bootedSandbox(opts) {
  const box = await makeSandbox(opts);
  const setup = await box.handle('setup', { adminPhone: '9000000001', adminPassword: 'correct-horse' }, '');
  if (!setup.ok) throw new Error('setup failed: ' + setup.error);
  const login = await box.handle('login', { phone: '9000000001', password: 'correct-horse' }, '');
  if (!login.ok) throw new Error('admin login failed: ' + login.error);
  return { box, admin: login.data.token };
}

/** Close every connection and drop every database this process created. */
export async function closeAll() {
  for (const { sql } of opened) await sql.end({ timeout: 1 }).catch(() => {});
  if (server) {
    for (const { name } of opened) await server.unsafe(`drop database if exists ${name} with (force)`).catch(() => {});
    await server.end({ timeout: 1 }).catch(() => {});
  }
}
