#!/usr/bin/env node
/**
 * Move the data from the Google Sheet into the Supabase database.
 *
 *   1. fetch   node scripts/import-sheet.mjs fetch --url <Apps Script /exec URL> --phone <admin phone>
 *              Signs in to the sheet backend and saves everything, password hashes included,
 *              to sheet-export.json. Needs an EXPORT_KEY script property (see docs/SUPABASE_MIGRATION.md).
 *
 *   2. check   node scripts/import-sheet.mjs check [sheet-export.json]
 *              Checks every row against the rules the database enforces and lists every
 *              problem at once. Fix them in the sheet, fetch again, repeat until clean.
 *
 *   3. import  DATABASE_URL=… node scripts/import-sheet.mjs import [sheet-export.json]
 *              Writes it all in ONE transaction, then recomputes the dashboard figures from
 *              the new tables and compares them with the sheet's own. Any difference, and
 *              nothing is kept.
 *
 * Secrets are read from the environment when set (SHEET_ADMIN_PASSWORD, EXPORT_KEY,
 * DATABASE_URL) and asked for otherwise — never passed as arguments, where they would
 * land in shell history.
 */
import fs from 'fs';
import { ask, askHidden } from './lib/prompt.mjs';
import { pathToFileURL } from 'url';
import { TABLES, toDb } from '../supabase/functions/api/schema.js';

const ORDER = ['Settings', 'Users', 'Properties', 'Units', 'Tenants', 'Leases', 'Invoices', 'InvoiceItems',
               'Payments', 'Maintenance', 'Expenses', 'Documents', 'MeterReadings', 'ActivityLog'];

const ENUMS = {
  Properties: { status: ['Active', 'Inactive', 'Sold'] },
  Units: { status: ['Vacant', 'Occupied', 'Reserved', 'Under Maintenance'] },
  Tenants: { status: ['Active', 'Prospect', 'Past'] },
  Leases: {
    deposit_status: ['Pending', 'Held', 'Partially Refunded', 'Refunded', 'Forfeited', 'Transferred'],
    frequency: ['Monthly', 'Quarterly', 'Half-Yearly', 'Yearly'],
    status: ['Active', 'Upcoming', 'Expired', 'Terminated']
  },
  Invoices: { status: ['Draft', 'Unpaid', 'Partial', 'Paid', 'Overdue', 'Void'] },
  MeterReadings: { category: ['Electricity', 'Water', 'Gas'] },
  Users: { role: ['viewer', 'manager', 'admin'] }
};

/** column → [table it must exist in, whether it may be blank] */
const REFS = {
  Units: { property_id: ['Properties', false] },
  Leases: { property_id: ['Properties', false], unit_id: ['Units', false], tenant_id: ['Tenants', false],
            renewed_from: ['Leases', true] },
  Invoices: { tenant_id: ['Tenants', false], lease_id: ['Leases', true], unit_id: ['Units', true],
              property_id: ['Properties', true] },
  InvoiceItems: { invoice_id: ['Invoices', false] },
  Payments: { invoice_id: ['Invoices', true], lease_id: ['Leases', true], tenant_id: ['Tenants', true],
              property_id: ['Properties', true] },
  Maintenance: { property_id: ['Properties', true], unit_id: ['Units', true], tenant_id: ['Tenants', true] },
  Expenses: { property_id: ['Properties', true], unit_id: ['Units', true] },
  MeterReadings: { property_id: ['Properties', false], unit_id: ['Units', false], lease_id: ['Leases', true],
                   tenant_id: ['Tenants', true], invoice_id: ['Invoices', true] }
};

const NOT_EMPTY = {
  Properties: ['name'], Units: ['unit_number'], Tenants: ['full_name'], Leases: ['start_date'],
  MeterReadings: ['reading_date', 'current_reading']
};

const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const blank = (v) => v === '' || v === null || v === undefined;
const phoneKey = (v) => String(v == null ? '' : v).replace(/[^0-9]/g, '').slice(-10);

/**
 * Check an export against everything the database will enforce, and make the
 * few repairs that are unambiguous. Returns the problems that need a human, the
 * repairs made, and the rows ready to insert.
 */
export function validateExport(data) {
  const problems = [];
  const repairs = [];
  const at = (table, row, msg) => `${table} ${row && row[TABLES[table].key || 'id'] || '(no id)'}: ${msg}`;
  const tables = {};
  for (const name of ORDER) tables[name] = ((data.tables || {})[name] || []).map(r => ({ ...r }));

  // columns someone added to a tab by hand have nowhere to go
  for (const [name, headers] of Object.entries(data.headers || {})) {
    if (!TABLES[name]) { repairs.push(`tab ${name} is not part of the app and is not migrated`); continue; }
    const extra = headers.filter(h => h && !(h in TABLES[name].cols));
    if (extra.length) repairs.push(`${name}: column(s) ${extra.join(', ')} are not part of the app and are not migrated`);
  }

  // ids: present and unique
  const ids = {};
  for (const name of ORDER) {
    const key = TABLES[name].key || 'id';
    ids[name] = new Map();
    let dup = 0;
    for (const row of tables[name]) {
      const id = String(row[key] == null ? '' : row[key]).trim();
      if (!id) { problems.push(at(name, row, 'has no ' + key)); continue; }
      if (ids[name].has(id)) {
        // audit entries are never referred to, so a repeated one is renumbered rather than refused
        if (name === 'ActivityLog') { row.id = id + '-' + (++dup); repairs.push(`ActivityLog: repeated id ${id} renumbered ${row.id}`); ids[name].set(row.id, row); continue; }
        problems.push(at(name, row, 'the id is used twice'));
        continue;
      }
      row[key] = id;
      ids[name].set(id, row);
    }
  }

  // a lease with no property but a unit takes the unit's
  for (const lease of tables.Leases) {
    if (blank(lease.property_id) && !blank(lease.unit_id) && ids.Units.has(String(lease.unit_id))) {
      lease.property_id = ids.Units.get(String(lease.unit_id)).property_id;
      repairs.push(`Leases ${lease.id}: property filled in from unit ${lease.unit_id}`);
    }
  }
  // nothing is owed on a void invoice (the sheet already computed it so)
  for (const inv of tables.Invoices) {
    if (String(inv.status) === 'Void' && Number(inv.balance || 0) !== 0) {
      inv.balance = 0;
      repairs.push(`Invoices ${inv.id}: void with a balance — balance set to 0`);
    }
  }

  for (const name of ORDER) {
    const spec = TABLES[name].cols;
    for (const row of tables[name]) {
      // every value must convert to its column's type
      for (const col of Object.keys(spec)) {
        try { toDb(name, col, row[col]); }
        catch (e) { problems.push(at(name, row, e.message)); }
      }
      for (const col of NOT_EMPTY[name] || []) {
        if (blank(row[col])) problems.push(at(name, row, col.replace(/_/g, ' ') + ' is empty'));
      }
      for (const [col, allowed] of Object.entries(ENUMS[name] || {})) {
        const v = row[col];
        if (!blank(v) && allowed.indexOf(String(v)) < 0) {
          problems.push(at(name, row, `${col} "${v}" is not one of ${allowed.join(', ')}`));
        }
      }
      for (const [col, [target, optional]] of Object.entries(REFS[name] || {})) {
        const v = row[col];
        if (blank(v)) { if (!optional) problems.push(at(name, row, col.replace(/_/g, ' ') + ' is empty')); continue; }
        if (!ids[target].has(String(v))) problems.push(at(name, row, `${col} ${v} does not exist in ${target}`));
      }
    }
  }

  // relationships the database checks across tables
  for (const lease of tables.Leases) {
    const unit = ids.Units.get(String(lease.unit_id));
    if (unit && !blank(lease.property_id) && String(unit.property_id) !== String(lease.property_id)) {
      problems.push(at('Leases', lease, `unit ${lease.unit_id} belongs to ${unit.property_id}, not ${lease.property_id}`));
    }
    if (!blank(lease.end_date) && !blank(lease.start_date) && String(lease.end_date) < String(lease.start_date)) {
      problems.push(at('Leases', lease, 'ends before it starts'));
    }
  }
  const live = tables.Leases.filter(l => ['Terminated', 'Expired'].indexOf(String(l.status)) < 0);
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i], b = live[j];
      if (String(a.unit_id) !== String(b.unit_id)) continue;
      const aEnd = String(a.end_date || '9999-12-31'), bEnd = String(b.end_date || '9999-12-31');
      if (String(a.start_date) <= bEnd && String(b.start_date) <= aEnd) {
        problems.push(`Leases ${a.id} and ${b.id}: both let unit ${a.unit_id} over overlapping dates — terminate or end one`);
      }
    }
  }
  for (const t of tables.Tenants) {
    if (!blank(t.gstin) && !GSTIN.test(String(t.gstin).replace(/\s+/g, '').toUpperCase())) {
      problems.push(at('Tenants', t, `GSTIN "${t.gstin}" is not valid`));
    }
  }
  for (const p of tables.Payments) {
    if (!(Number(String(p.amount).replace(/,/g, '')) > 0)) problems.push(at('Payments', p, `amount ${JSON.stringify(p.amount)} is not above zero`));
  }
  for (const m of tables.MeterReadings) {
    if (Number(m.current_reading) < Number(m.previous_reading || 0)) problems.push(at('MeterReadings', m, 'current reading is below the previous one'));
  }
  const phones = new Map();
  for (const u of tables.Users) {
    const k = phoneKey(u.phone);
    if (!k) continue;
    if (phones.has(k)) problems.push(`Users ${phones.get(k)} and ${u.id}: the same phone number`);
    else phones.set(k, u.id);
    if (!u.salt || !u.password_hash) problems.push(at('Users', u, 'has no password — set one in the sheet app first'));
  }

  return { problems, repairs, tables };
}

/** Highest number in each table's ids, or the sheet's own high-water mark if higher. */
function counters(data, tables) {
  const out = {};
  for (const name of ORDER) {
    if (TABLES[name].key) continue;
    let max = 0;
    tables[name].forEach(r => { const m = String(r.id).match(/(\d{1,9})$/); if (m) max = Math.max(max, parseInt(m[1], 10)); });
    out[name] = Math.max(max, Number((data.sequences || {})[name]) || 0);
  }
  return out;
}

const FIGURES = ['properties', 'units', 'occupied_units', 'vacant_units', 'active_leases', 'tenants',
                 'monthly_rent_roll', 'outstanding', 'overdue', 'overdue_count', 'collected_this_month',
                 'expenses_this_month', 'open_tickets', 'deposits_held'];

/**
 * Write a validated export into an empty database, in one transaction, and
 * prove it adds up. Throws — and so rolls everything back — on any problem.
 */
export async function importExport(sql, data, { timeZone } = {}) {
  const { createBackend, internals } = await import('../supabase/functions/api/backend.js');
  const { openRequest, insertRows } = await import('../supabase/functions/api/db.js');

  const { problems, repairs, tables } = validateExport(data);
  if (problems.length) throw Object.assign(new Error(problems.length + ' problem(s) must be fixed in the sheet first'), { problems });

  const tz = timeZone || data.timezone || 'Asia/Kolkata';
  const backend = createBackend({ sql, authSecret: 'import-only-'.padEnd(40, 'x'), timeZone: tz });

  return sql.begin(async (tx) => {
    const r = await openRequest(tx, tz);
    r.env = backend.env;

    const [{ n }] = await tx`select (select count(*) from app_users) + (select count(*) from properties) +
                                    (select count(*) from tenants) + (select count(*) from invoices) as n`;
    if (Number(n) > 0) throw new Error('The database already holds data. Import into a fresh project (or reset it) — nothing was changed.');

    const counts = {};
    for (const name of ORDER) {
      const rows = tables[name];
      if (name === 'Settings') {
        for (const s of rows) {
          await tx`insert into settings (key, value) values (${String(s.key)}, ${s.value == null ? '' : String(s.value)})
                   on conflict (key) do update set value = excluded.value`;
        }
      } else {
        await insertRows(r, name, rows);
      }
      counts[name] = rows.length;
    }
    for (const [name, value] of Object.entries(counters(data, tables))) {
      await tx`insert into id_counters (table_name, last_value) values (${name}, ${value})
               on conflict (table_name) do update set last_value = greatest(id_counters.last_value, excluded.last_value)`;
    }
    // the sheet was refreshed as it was exported; today's housekeeping is done
    await tx`insert into app_state (key, value) values ('LAST_REFRESH', ${data.today || ''})
             on conflict (key) do update set value = excluded.value`;

    // prove it: the dashboard computed from the new tables must match the sheet's own
    r.memo = new Map();
    const now = await internals.computeStats(r);
    const was = data.stats || {};
    const differ = FIGURES.filter(k => k in was && Math.abs(Number(now[k]) - Number(was[k])) > 0.005)
                          .map(k => `${k}: sheet ${was[k]}, database ${now[k]}`);
    if (differ.length) {
      throw Object.assign(new Error('The imported figures do not match the sheet — nothing was kept'), { problems: differ });
    }
    return { counts, repairs, stats: now };
  });
}

// ─────────────────────────────────────────────────────────────── CLI ──


const arg = (name) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : ''; };

/**
 * Refuse a URL that cannot be the Web App before calling it: Google answers
 * those with a sign-in or error PAGE, which says nothing about what was wrong.
 */
function assertExecUrl(url) {
  const where = 'Apps Script editor → Deploy → Manage deployments → the Web app URL';
  if (/\/dev\/?$/.test(url)) {
    throw new Error('That is the /dev test URL, which only works in a browser signed in to your Google account. ' +
                    'Use the deployment URL that ends in /exec (' + where + ').');
  }
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url)) {
    throw new Error('That is not an Apps Script Web App URL. It looks like ' +
                    'https://script.google.com/macros/s/AKfy…/exec (' + where + ').');
  }
  if (!/\/s\/AKfy/.test(url)) {
    throw new Error('The id in that URL is not a deployment id (those start with AKfy) — it looks like the id of ' +
                    'the script or the spreadsheet. Copy the Web app URL from ' + where + '.');
  }
}

async function callSheet(url, action, payload, token) {
  const res = await fetch(url, { method: 'POST', redirect: 'follow',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action, payload, token }) });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch (e) {
    throw new Error('Google answered with a web page instead of the app (HTTP ' + res.status + '). ' +
                    'Check that the Web App is deployed with "Who has access: Anyone", and that you ' +
                    'deployed a new version after pasting the updated Code.gs.');
  }
  if (!body.ok) throw new Error(body.error);
  return body.data;
}

function report({ problems, repairs }) {
  repairs.forEach(x => console.log('  · ' + x));
  if (!problems.length) return true;
  console.log(`\n${problems.length} problem(s) to fix in the sheet:\n`);
  problems.forEach(x => console.log('  ✗ ' + x));
  return false;
}

async function main() {
  const [command, file = 'sheet-export.json'] = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !(all[i - 1] || '').startsWith('--'));

  if (command === 'fetch') {
    const url = (arg('url') || await ask('Apps Script /exec URL: ')).trim();
    assertExecUrl(url);
    const phone = arg('phone') || await ask('Administrator phone: ');
    const password = process.env.SHEET_ADMIN_PASSWORD || await askHidden('Password: ');
    const exportKey = process.env.EXPORT_KEY || await askHidden('EXPORT_KEY (from Script properties): ');
    const login = await callSheet(url, 'login', { phone, password }, '');
    const data = await callSheet(url, 'exportForMigration', { exportKey }, login.token);
    fs.writeFileSync(arg('out') || 'sheet-export.json', JSON.stringify(data, null, 1), { mode: 0o600 });
    const n = Object.entries(data.tables).map(([k, v]) => `${k} ${v.length}`).join(', ');
    console.log(`Saved ${arg('out') || 'sheet-export.json'} (${n}).`);
    console.log('It contains password hashes: keep it private, and delete it once the import is done.');
    console.log('Next: node scripts/import-sheet.mjs check');
    return;
  }

  if (command === 'check' || command === 'import') {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    console.log(`Export of ${data.exported_at} (${data.timezone}).`);
    const checked = validateExport(data);
    if (!report(checked)) { process.exitCode = 1; return; }
    if (command === 'check') { console.log('\nNo problems. Next: DATABASE_URL=… node scripts/import-sheet.mjs import'); return; }

    const postgres = (await import('postgres')).default;
    const { PG_TYPES } = await import('../supabase/functions/api/schema.js');
    const url = process.env.DATABASE_URL || await askHidden('Supabase connection string (Session pooler): ');
    const sql = postgres(url, { types: PG_TYPES, max: 1, prepare: false, onnotice: () => {} });
    try {
      const result = await importExport(sql, data, { timeZone: process.env.APP_TIMEZONE || data.timezone });
      console.log('\nImported: ' + Object.entries(result.counts).map(([k, v]) => `${k} ${v}`).join(', '));
      console.log('Every dashboard figure matches the sheet.');
    } catch (e) {
      console.log('\n✗ ' + e.message);
      (e.problems || []).forEach(p => console.log('  ' + p));
      process.exitCode = 1;
    } finally {
      await sql.end();
    }
    return;
  }

  console.log('Usage: node scripts/import-sheet.mjs fetch|check|import [file] — see the top of this file.');
  process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((e) => { console.error('✗ ' + e.message); process.exit(1); });
}
