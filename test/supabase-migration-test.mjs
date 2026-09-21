/**
 * The move itself, end to end: a portfolio built on the real Apps Script
 * backend (Code.gs), exported with exportForMigration, imported into Postgres
 * by scripts/import-sheet.mjs — then every row compared field by field, the
 * dashboard figures compared, and the old passwords tried against the new
 * backend.
 */
import { bootedSandbox as gasBooted } from './gas-harness.mjs';
import { makeSandbox, closeAll } from './pg-harness.mjs';
import { validateExport, importExport } from '../scripts/import-sheet.mjs';
import { TABLES } from '../supabase/functions/api/schema.js';

let pass = 0, fail = 0;
const check = async (name, fn) => {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

/** A year of a small landlord's life, on the sheet backend. */
function buildSheetPortfolio() {
  const { box, admin } = gasBooted();
  const c = (a, p) => {
    const r = box.handle(a, p, admin);
    if (!r.ok) throw new Error(a + ' failed on the sheet: ' + r.error);
    return r.data;
  };
  const Y = Number(box.today().slice(0, 4));
  c('update', { table: 'Settings', id: 'gstin', data: { value: '29ABCDE1234F1Z5' } });
  c('update', { table: 'Settings', id: 'org_name', data: { value: 'Rao Estates' } });

  const home = c('create', { table: 'Properties', data: { name: 'Sunrise', state: 'Karnataka', city: 'Bengaluru', purchase_price: 9500000 } }).row;
  const shop = c('create', { table: 'Properties', data: { name: 'Market Row', state: 'Tamil Nadu', type: 'Retail' } }).row;
  const u1 = c('create', { table: 'Units', data: { property_id: home.id, unit_number: 'A-101', rent_amount: 28000, bedrooms: 2, bathrooms: 1.5 } }).row;
  const u2 = c('create', { table: 'Units', data: { property_id: home.id, unit_number: 'A-102' } }).row;
  const u3 = c('create', { table: 'Units', data: { property_id: shop.id, unit_number: 'S-1' } }).row;
  const anita = c('create', { table: 'Tenants', data: { full_name: 'Anita Rao', phone: '+91 98800 11111', email: 'anita@example.com', notes: '=HYPERLINK("x")' } }).row;
  const kumar = c('create', { table: 'Tenants', data: { full_name: 'Kumar Traders', phone: '9940033333', gstin: '33ABCDE1234F1Z5' } }).row;
  const ravi = c('create', { table: 'Tenants', data: { full_name: 'Ravi', phone: '9000012345' } }).row;

  const l1 = c('create', { table: 'Leases', data: { property_id: home.id, unit_id: u1.id, tenant_id: anita.id,
    start_date: (Y - 1) + '-01-15', end_date: (Y + 1) + '-01-14', rent_amount: 28000, deposit_amount: 150000,
    grace_days: 5, late_fee: 500, escalation_pct: 5 } }).row;
  const l2 = c('create', { table: 'Leases', data: { property_id: shop.id, unit_id: u3.id, tenant_id: kumar.id,
    start_date: (Y - 1) + '-04-01', end_date: (Y + 2) + '-03-31', rent_amount: 60000, frequency: 'Quarterly',
    gst_rate: 18, deposit_amount: 0 } }).row;
  const l3 = c('create', { table: 'Leases', data: { property_id: home.id, unit_id: u2.id, tenant_id: ravi.id,
    start_date: (Y - 2) + '-01-01', end_date: (Y - 1) + '-06-30', rent_amount: 15000, deposit_amount: 30000 } }).row;

  c('generateInvoices', { upto: box.today() });
  const invoices = box.readTable('Invoices');
  const dep1 = invoices.find(i => i.type === 'Deposit' && i.lease_id === l1.id);
  const dep3 = invoices.find(i => i.type === 'Deposit' && i.lease_id === l3.id);
  c('recordPayment', { invoice_id: dep1.id, amount: 150000, method: 'Bank Transfer', reference: 'NEFT-1' });
  c('recordPayment', { invoice_id: dep3.id, amount: 30000, method: 'Cash' });
  const rent1 = invoices.filter(i => i.lease_id === l1.id && i.type === 'Rent');
  c('recordPayment', { invoice_id: rent1[0].id, amount: 70000, method: 'UPI' });   // spills over
  const shopRent = invoices.find(i => i.lease_id === l2.id && i.type === 'Rent');
  c('recordPayment', { invoice_id: shopRent.id, amount: 1000, method: 'Cheque' });

  // move-out on the old lease: arrears and a deduction from the deposit, the rest back
  c('settleDeposit', { lease_id: l3.id, apply_to_arrears: true, refund_method: 'UPI',
    deductions: [{ description: 'Repainting', amount: 4000 }] });

  const parking = c('saveInvoice', { data: { tenant_id: anita.id, due_date: (Y - 1) + '-03-01' },
    items: [{ description: 'Parking', category: 'Parking', quantity: 2, unit_amount: 750, tax_rate: 18 }] }).invoice;
  c('voidInvoice', { id: parking.id, reason: 'raised twice' });
  c('saveInvoice', { data: { tenant_id: ravi.id, due_date: (Y + 1) + '-01-01', status: 'Draft' },
    items: [{ description: 'Draft', category: 'Other', quantity: 1, unit_amount: 10 }] });

  const ticket = c('create', { table: 'Maintenance', data: { property_id: home.id, unit_id: u1.id, title: 'Leak',
    vendor_name: 'Plumber', cost: 2500 } }).row;
  c('update', { table: 'Maintenance', id: ticket.id, data: { status: 'Resolved' } });
  c('create', { table: 'Expenses', data: { property_id: shop.id, date: box.today(), category: 'Tax', amount: 12000, description: 'Property tax' } });
  c('create', { table: 'Documents', data: { entity_type: 'Tenant', entity_id: anita.id, title: 'Aadhaar', url: 'https://example.com/a' } });
  c('billMeterReadings', { property_id: home.id, category: 'Electricity', rate: 8.5, reading_date: box.today(),
    readings: [{ unit_id: u1.id, previous_reading: 1000, current_reading: 1142.5 }, { unit_id: u2.id, previous_reading: 10, current_reading: 12 }] });
  c('createUser', { name: 'Meera', phone: '9000000004', role: 'manager', password: 'manager-pass-1234' });
  box.handle('bootstrap', {}, admin);             // housekeeping: overdue flags and late fees

  return { box, admin, c };
}

const norm = (v) => (v === null || v === undefined ? '' : v);
const same = (a, b) => {
  a = norm(a); b = norm(b);
  if (typeof a === 'number' || typeof b === 'number') return Math.abs(Number(a) - Number(b)) < 0.0005 && a !== '' === (b !== '');
  if (typeof a === 'boolean' || typeof b === 'boolean') return String(a).toLowerCase() === String(b).toLowerCase();
  return String(a) === String(b);
};

console.log('\n— moving a real portfolio —');
const sheet = buildSheetPortfolio();
sheet.box.__props.set('EXPORT_KEY', 'export-key-for-tests');
const exported = sheet.box.handle('exportForMigration', { exportKey: 'export-key-for-tests' }, sheet.admin);
if (!exported.ok) throw new Error('export failed: ' + exported.error);
// what reaches the import is JSON that has crossed the network
const data = JSON.parse(JSON.stringify(exported.data));

const pg = await makeSandbox();
let result = null;

await check('the export passes every check the database will make', async () => {
  const { problems } = validateExport(data);
  assert(!problems.length, problems.join('; '));
});

await check('the import runs in one go and the figures match the sheet', async () => {
  result = await importExport(pg.sql, data, { timeZone: 'Asia/Kolkata' });
  assert(result.counts.Invoices === data.tables.Invoices.length, 'invoices ' + result.counts.Invoices);
});

await check('every row of every table arrives with every field intact', async () => {
  const diffs = [];
  for (const name of Object.keys(TABLES)) {
    const before = data.tables[name];
    const after = await pg.readTable(name);
    const key = TABLES[name].key || 'id';
    if (name !== 'ActivityLog' && after.length !== before.length) { diffs.push(`${name}: ${before.length} rows became ${after.length}`); continue; }
    const byKey = new Map(after.map(r => [String(r[key]), r]));
    for (const row of before) {
      const got = byKey.get(String(row[key]));
      if (!got) { diffs.push(`${name} ${row[key]} is missing`); continue; }
      for (const col of Object.keys(TABLES[name].cols)) {
        if (col === 'updated_at' || col === 'created_at') continue;       // compared below
        // a blank in a column the database keeps NOT NULL DEFAULT 0 arrives as 0 —
        // which is how every line of the backend already read it (num(v))
        const kind = TABLES[name].cols[col].kind;
        const want = (kind === 'num0' || kind === 'int0') && norm(row[col]) === '' ? 0 : row[col];
        if (!same(want, got[col])) diffs.push(`${name} ${row[key]}.${col}: ${JSON.stringify(row[col])} → ${JSON.stringify(got[col])}`);
      }
      if (row.created_at && got.created_at.slice(0, 19) !== String(row.created_at).slice(0, 19)) {
        diffs.push(`${name} ${row[key]}.created_at: ${row.created_at} → ${got.created_at}`);
      }
    }
  }
  assert(!diffs.length, diffs.length + ' difference(s): ' + diffs.join('; '));
});

await check('the administrator signs in with the password they had on the sheet', async () => {
  const r = await pg.handle('login', { phone: '9000000001', password: 'correct-horse' }, '');
  assert(r.ok, 'refused: ' + r.error);
  const m = await pg.handle('login', { phone: '9000000004', password: 'manager-pass-1234' }, '');
  assert(m.ok && m.data.user.role === 'manager', 'the manager could not sign in: ' + JSON.stringify(m).slice(0, 160));
  const users = await pg.readTable('Users');
  assert(users.every(u => /^v3\$/.test(u.password_hash)), 'hashes were not upgraded on first sign-in');
});

await check('the app shows the same portfolio after the move', async () => {
  const token = (await pg.handle('login', { phone: '9000000001', password: 'correct-horse' }, '')).data.token;
  const now = (await pg.handle('bootstrap', {}, token)).data;
  const was = sheet.box.handle('bootstrap', {}, sheet.admin).data;
  const diffs = [];
  for (const k of Object.keys(was.stats)) {
    if (k === 'occupancy_rate' ? Math.abs(was.stats[k] - now.stats[k]) > 0.05 : !same(was.stats[k], now.stats[k])) {
      diffs.push(`${k}: ${was.stats[k]} → ${now.stats[k]}`);
    }
  }
  for (const k of ['properties', 'units', 'tenants', 'leases', 'invoices', 'invoiceItems', 'payments', 'expenses', 'meterReadings']) {
    if (now[k].length !== was[k].length) diffs.push(`${k}: ${was[k].length} → ${now[k].length}`);
  }
  assert(now.settings.org_name === 'Rao Estates', 'settings were not carried over');
  assert(!diffs.length, diffs.join('; '));
});

await check('numbering carries on from the sheet — no invoice number is issued twice', async () => {
  const token = (await pg.handle('login', { phone: '9000000001', password: 'correct-horse' }, '')).data.token;
  const tenant = (await pg.readTable('Tenants'))[0];
  const inv = await pg.handle('saveInvoice', { data: { tenant_id: tenant.id, due_date: '2031-01-01' },
    items: [{ description: 'After the move', category: 'Other', quantity: 1, unit_amount: 1 }] }, token);
  assert(inv.ok, inv.error);
  const highest = Math.max(...data.tables.Invoices.map(i => parseInt(i.id.split('-')[1], 10)),
                           Number(data.sequences.Invoices) || 0);
  assert(parseInt(inv.data.invoice.id.split('-')[1], 10) === highest + 1, `new invoice ${inv.data.invoice.id} after ${highest}`);
});

await check('a second import into the same database is refused, and changes nothing', async () => {
  const before = (await pg.readTable('Invoices')).length;
  let refused = false;
  try { await importExport(pg.sql, data, { timeZone: 'Asia/Kolkata' }); } catch (e) { refused = /already holds data/.test(e.message); }
  assert(refused, 'not refused');
  assert((await pg.readTable('Invoices')).length === before, 'rows changed');
});

console.log('\n— problems in the sheet are found before anything is written —');
await check('broken references, double lets, bad statuses and shared phones are all reported at once', async () => {
  const bad = JSON.parse(JSON.stringify(data));
  const lease = bad.tables.Leases[0];
  bad.tables.Leases.push({ ...lease, id: 'LSE-09999', notes: 'typed twice' });                  // double let
  bad.tables.Invoices[0].tenant_id = 'TNT-99999';                                             // orphan
  bad.tables.Units[0].status = 'Occupied?';                                                   // typo
  bad.tables.Users.push({ ...bad.tables.Users[0], id: 'USR-09999', phone: '+91 90000 00001' }); // same phone
  bad.tables.Expenses.push({ id: 'EXP-09999', date: '31/02/2026', amount: 'twelve', category: 'Other' });
  const { problems } = validateExport(bad);
  const want = [/overlapping/, /TNT-99999 does not exist/, /Occupied\?/, /same phone/, /not a date/, /must be a number/];
  const missing = want.filter(re => !problems.some(p => re.test(p)));
  assert(!missing.length, 'not reported: ' + missing.join(', ') + ' — got: ' + problems.join(' | '));
});

await check('an import with problems writes nothing at all', async () => {
  const bad = JSON.parse(JSON.stringify(data));
  bad.tables.Invoices[0].tenant_id = 'TNT-99999';
  const fresh = await makeSandbox();
  let threw = false;
  try { await importExport(fresh.sql, bad, {}); } catch (e) { threw = true; }
  assert(threw, 'the import went ahead');
  assert((await fresh.readTable('Properties')).length === 0, 'rows were written');
});

await check('figures that do not reconcile roll the whole import back', async () => {
  const off = JSON.parse(JSON.stringify(data));
  off.stats.outstanding = Number(off.stats.outstanding) + 1;          // the sheet said something else
  const fresh = await makeSandbox();
  let message = '';
  try { await importExport(fresh.sql, off, {}); } catch (e) { message = e.message + ' ' + (e.problems || []).join(' '); }
  assert(/do not match/.test(message) && /outstanding/.test(message), 'not caught: ' + message);
  assert((await fresh.readTable('Invoices')).length === 0, 'a mismatched import was kept');
});

console.log('\n— devices set up before the move —');
await check('a browser that remembers the Apps Script URL follows the new default after cut-over', async () => {
  const fs = await import('fs');
  const source = fs.readFileSync(new URL('../assets/js/config.js', import.meta.url), 'utf8');
  const load = async (defaultUrl) => {
    const store = new Map();
    globalThis.localStorage = { getItem: k => (store.has(k) ? store.get(k) : null),
                                setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
    const code = source.replace(/^const DEFAULT_API_URL = '.*';$/m, `const DEFAULT_API_URL = '${defaultUrl}';`);
    const { config } = await import('data:text/javascript,' + encodeURIComponent(code) + '%0A//' + Math.random());
    return { config, store };
  };
  const NEW = 'https://abcdefghijklmnop.supabase.co/functions/v1/api';
  const OLD = 'https://script.google.com/macros/s/AKfy-old/exec';

  let { config, store } = await load(NEW);
  store.set('vipm.apiUrl', OLD);
  assert(config.apiUrl === NEW, 'still pointing at the sheet: ' + config.apiUrl);
  store.set('vipm.apiUrl', '');
  assert(config.apiUrl === '', 'a deliberate disconnect was overridden');
  store.set('vipm.apiUrl', 'https://zyxwvutsrqponmlk.supabase.co/functions/v1/api');
  assert(/zyxw/.test(config.apiUrl), 'a chosen Supabase project was overridden');

  // before cut-over (no Supabase default published) nothing changes
  ({ config, store } = await load(''));
  store.set('vipm.apiUrl', OLD);
  assert(config.apiUrl === OLD, 'redirected before the move');
  delete globalThis.localStorage;
});

await closeAll();
console.log('\n' + '─'.repeat(56));
console.log(fail ? `${fail} FAILED, ${pass} passed` : `ALL ${pass} MIGRATION CHECKS PASSED`);
process.exit(fail ? 1 : 0);
