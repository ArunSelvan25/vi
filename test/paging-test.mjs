/**
 * Server-side paging (supabase/functions/api/queries.js) on a real Postgres.
 *
 * The browser used to hold every row and work its figures out itself. Those
 * figures now come from the server, so each one is checked against the
 * browser's old arithmetic — ported here as the "oracle" and run over the
 * whole tables. A workspace with months of rent, part payments, deposits,
 * refunds, tickets and documents is built through the real API first.
 */
import { bootedSandbox, closeAll } from './pg-harness.mjs';

let pass = 0, fail = 0;
const check = async (name, fn) => {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + (e && e.stack || e).toString().split('\n').slice(0, 3).join('\n      ')); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const same = (a, b, what) => assert(JSON.stringify(a) === JSON.stringify(b),
  `${what}\n        server: ${JSON.stringify(a).slice(0, 300)}\n        oracle: ${JSON.stringify(b).slice(0, 300)}`);
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// ── a workspace with history ────────────────────────────────────────────────
const { box, admin } = await bootedSandbox();
const call = async (action, payload, token = admin) => {
  const r = await box.handle(action, payload, token);
  if (!r.ok) throw new Error(action + ' failed: ' + r.error);
  return r.data;
};
const create = async (table, data) => (await call('create', { table, data })).row;

const today = box.today();
const shift = (months, day = 1) => {
  const [y, m] = today.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + months, day));
  return d.toISOString().slice(0, 10);
};

const P1 = await create('Properties', { name: 'Sunrise Residency', owner_name: 'V Iyer', current_value: 18500000 });
const P2 = await create('Properties', { name: 'Palm Court', owner_name: 'R Rao' });
const P3 = await create('Properties', { name: 'Empty Lot', owner_name: 'V Iyer' });
const units = [];
for (const [prop, n] of [[P1, 'A-101'], [P1, 'A-102'], [P1, 'A-103'], [P2, 'V-1'], [P2, 'V-2']]) {
  units.push(await create('Units', { property_id: prop.id, unit_number: n, rent_amount: 20000 }));
}
const names = ['Anita Rao', 'Karthik Menon', 'Zebediah Quill', 'Priya Nair', 'Omar 50%_Off'];
const tenants = [];
for (const full_name of names) tenants.push(await create('Tenants', { full_name, id_number: '123456789012' }));

const leases = [];
const leaseSpec = [
  [units[0], tenants[0], -14, 12, 18000, 50000, null],
  [units[1], tenants[1], -9, 24, 22000, 60000, 5],
  [units[3], tenants[2], -6, 12, 30000, 0, null],
  [units[4], tenants[3], -3, 12, 25000, 40000, 31],
  [units[0], tenants[4], -1, 12, 19000, 45000, null]
];
for (const [u, t, start, months, rent, deposit, rentDay] of leaseSpec) {
  // the first lease on A-101 ended before the last one began
  const end = start + months <= -1 ? shift(start + months, 1) : shift(start + months, 1);
  const lease = await create('Leases', {
    property_id: u.property_id, unit_id: u.id, tenant_id: t.id,
    start_date: shift(start, 1), end_date: leases.length === 0 ? shift(-2, 28) : end,
    rent_amount: rent, deposit_amount: deposit, grace_days: 3, late_fee: 500,
    rent_day: rentDay === null ? '' : rentDay
  });
  leases.push(lease);
}
await call('generateInvoices', { upto: today });
await create('Invoices', { tenant_id: tenants[1].id, type: 'Utility', due_date: shift(-1, 10), amount: 1234.5 });
await create('Invoices', { tenant_id: tenants[2].id, type: 'Utility', due_date: shift(1, 10), amount: 400, property_id: P2.id });

// pay most invoices, some in part, leave a few owing
let k = 0;
for (const inv of await box.readTable('Invoices')) {
  if (['Void', 'Draft', 'Paid'].includes(inv.status) || !(Number(inv.balance) > 0)) continue;
  k++;
  if (k % 4 === 0) continue;
  const amount = k % 3 === 0 ? round2(Number(inv.balance) / 2) : Number(inv.balance);
  await call('recordPayment', { invoice_id: inv.id, amount, method: k % 2 ? 'UPI' : 'Cash',
                                payment_date: (inv.due_date && inv.due_date < today) ? inv.due_date : today,
                                reference: 'REF-' + k });
}
// one issued invoice voided, with nothing paid on it
const unpaidManual = (await box.readTable('Invoices')).find(i => i.type === 'Utility' && Number(i.amount_paid) === 0);
await call('voidInvoice', { id: unpaidManual.id, reason: 'raised in error' });

const expenseSpec = [
  [P1, units[0], 'Repairs', 1500, -5], [P1, null, 'Utilities', 800, -1], [P2, units[3], 'Cleaning', 600, -2],
  [P1, units[1], 'Repairs', 2500, 0], [P2, null, 'Insurance', 12000, -8], [null, null, 'Legal', 3000, -1]
];
for (const [p, u, category, amount, m] of expenseSpec) {
  await create('Expenses', { property_id: p ? p.id : '', unit_id: u ? u.id : '', category, amount, date: shift(m, 12),
                             description: category + ' work' });
}
const ticketSpec = [
  [P1, units[0], tenants[0], 'Leaking tap', 'Open', 'High'], [P1, units[1], null, 'Lift noise', 'In Progress', 'Urgent'],
  [P2, units[3], tenants[2], 'Pool pump', 'On Hold', 'Low'], [P2, null, null, 'Gate paint', 'Open', 'Medium'],
  [P1, units[2], null, 'Broken window', 'Resolved', 'High']
];
for (const [p, u, t, title, status, priority] of ticketSpec) {
  await create('Maintenance', { property_id: p.id, unit_id: u ? u.id : '', tenant_id: t ? t.id : '', title, status,
                                priority, reported_date: shift(-1, 3), cost: status === 'Resolved' ? 4200 : '' });
}
const docSpec = [
  ['Property', P1.id, 'Title deed', null], ['Unit', units[0].id, 'Inventory', shift(1, 1)],
  ['Lease', leases[0].id, 'Agreement', shift(-1, 1)], ['Lease', leases[3].id, 'Agreement', shift(0, 20)],
  ['Tenant', tenants[2].id, 'ID proof', shift(5, 1)], ['Unit', units[3].id, 'Fire NOC', shift(0, 25)]
];
for (const [entity_type, entity_id, title, expiry] of docSpec) {
  await create('Documents', { entity_type, entity_id, title, category: 'Legal', url: 'https://example.com/' + title,
                              issue_date: shift(-3, 1), expiry_date: expiry || '' });
}
// a refund of part of one deposit, booked as an expense against the lease
await create('Expenses', { property_id: P1.id, category: 'Deposit Refund', amount: 5000, date: shift(-1, 20),
                           reference: leases[0].id, description: 'Part refund' });

const T = {};
for (const t of ['Properties', 'Units', 'Tenants', 'Leases', 'Invoices', 'InvoiceItems', 'Payments',
                 'Maintenance', 'Expenses', 'Documents']) T[t] = await box.readTable(t);
console.log(`\n(workspace: ${T.Invoices.length} invoices, ${T.Payments.length} payments, ` +
            `${T.Expenses.length} expenses, ${T.Maintenance.length} tickets, ${T.Documents.length} documents)`);

// ── the browser's old arithmetic ────────────────────────────────────────────
const OPEN = ['Unpaid', 'Partial', 'Overdue'];
const invoiceById = new Map(T.Invoices.map(i => [i.id, i]));
const isDepositPayment = (p) => { const i = invoiceById.get(p.invoice_id); return !!i && i.type === 'Deposit'; };
const income = (rows) => rows.filter(p => !isDepositPayment(p));
const opex = (rows) => rows.filter(e => e.category !== 'Deposit Refund');
const sum = (rows, key = 'amount') => round2(rows.reduce((s, r) => s + Number(r[key] || 0), 0));
const owed = (invoices) => sum(invoices.filter(i => OPEN.includes(i.status)), 'balance');
const docsFor = (type, ids) => { const set = new Set([].concat(ids)); return T.Documents.filter(d => d.entity_type === type && set.has(d.entity_id)); };
const byOrder = (key, dir) => (a, b) => {
  const av = a[key] ?? '', bv = b[key] ?? '';
  if (av === bv || (av === '' && bv === '')) return dir === 'asc' ? a._seq - b._seq : b._seq - a._seq;
  if (av === '') return dir === 'asc' ? -1 : 1;
  if (bv === '') return dir === 'asc' ? 1 : -1;
  const c = typeof av === 'number' ? av - bv : String(av) < String(bv) ? -1 : 1;
  return dir === 'asc' ? c : -c;
};
// insertion order, which the server breaks ties by
for (const rows of Object.values(T)) rows.forEach((r, i) => { r._seq = i; });

function arrears(filter) {
  const map = new Map();
  for (const inv of T.Invoices) {
    if (filter && !filter(inv)) continue;
    const bal = Number(inv.balance || 0);
    if (bal <= 0 || ['Void', 'Draft'].includes(inv.status)) continue;
    const cur = map.get(inv.tenant_id) || { tenant_id: inv.tenant_id, balance: 0, invoices: 0, oldest: null };
    cur.balance = round2(cur.balance + bal); cur.invoices += 1;
    if (!cur.oldest || inv.due_date < cur.oldest) cur.oldest = inv.due_date;
    map.set(inv.tenant_id, cur);
  }
  return [...map.values()].sort((a, b) => b.balance - a.balance);
}
function monthlySeries(months, endIso, match) {
  const [y, m] = endIso.split('-').map(Number);
  const out = [];
  for (let i = months - 1; i >= 0; i--) {
    const key = new Date(Date.UTC(y, m - 1 - i, 1)).toISOString().slice(0, 7);
    const inc = sum(income(T.Payments).filter(p => (!match || match(p)) && String(p.payment_date || '').slice(0, 7) === key));
    const exp = sum(opex(T.Expenses).filter(e => (!match || match(e)) && String(e.date || '').slice(0, 7) === key));
    out.push({ key, income: inc, expense: exp, net: round2(inc - exp) });
  }
  return out;
}
function depositLedger(lease) {
  const deposits = T.Invoices.filter(i => i.lease_id === lease.id && i.type === 'Deposit' && i.status !== 'Void');
  const paid = deposits.reduce((s, i) => s + Number(i.amount_paid || 0), 0);
  const status = String(lease.deposit_status || '');
  const received = paid > 0 ? paid : (status && status !== 'Pending' ? Number(lease.deposit_amount || 0) : 0);
  const applied = sum(T.Payments.filter(p => p.method === 'Deposit Adjustment' && p.reference === lease.id));
  const refunded = sum(T.Expenses.filter(e => e.category === 'Deposit Refund' && e.reference === lease.id));
  const held = status === 'Transferred' ? 0 : Math.max(0, round2(received - applied - refunded));
  return { received: round2(received), applied, refunded, held };
}

/** Every row of a scope, by the rules the detail pages used. */
const SCOPE = {
  property: (id) => {
    const unitIds = T.Units.filter(u => u.property_id === id).map(u => u.id);
    const leaseIds = T.Leases.filter(l => l.property_id === id).map(l => l.id);
    return {
      Invoices: T.Invoices.filter(i => i.property_id === id), Payments: T.Payments.filter(p => p.property_id === id),
      Expenses: T.Expenses.filter(e => e.property_id === id), Maintenance: T.Maintenance.filter(m => m.property_id === id),
      Documents: [...docsFor('Property', id), ...docsFor('Unit', unitIds), ...docsFor('Lease', leaseIds)]
    };
  },
  unit: (id) => {
    const leaseIds = new Set(T.Leases.filter(l => l.unit_id === id).map(l => l.id));
    const invoices = T.Invoices.filter(i => i.unit_id === id);
    const invIds = new Set(invoices.map(i => i.id));
    return {
      Invoices: invoices, Payments: T.Payments.filter(p => invIds.has(p.invoice_id) || (p.lease_id && leaseIds.has(p.lease_id))),
      Expenses: T.Expenses.filter(e => e.unit_id === id), Maintenance: T.Maintenance.filter(m => m.unit_id === id),
      Documents: [...docsFor('Unit', id), ...docsFor('Lease', [...leaseIds])]
    };
  },
  tenant: (id) => ({
    Invoices: T.Invoices.filter(i => i.tenant_id === id), Payments: T.Payments.filter(p => p.tenant_id === id),
    Maintenance: T.Maintenance.filter(m => m.tenant_id === id),
    Documents: [...docsFor('Tenant', id), ...docsFor('Lease', T.Leases.filter(l => l.tenant_id === id).map(l => l.id))]
  }),
  lease: (id) => {
    const invoices = T.Invoices.filter(i => i.lease_id === id);
    const invIds = new Set(invoices.map(i => i.id));
    return { Invoices: invoices, Payments: T.Payments.filter(p => p.lease_id === id || invIds.has(p.invoice_id)),
             Documents: docsFor('Lease', id) };
  }
};
const ids = (rows) => rows.map(r => r.id).sort();
const page = (table, p = {}, token = admin) => call('page', { table, ...p }, token);
async function everything(table, p = {}) {
  const out = [];
  for (let n = 1; ; n++) {
    const res = await page(table, { ...p, page: n, pageSize: 100 });
    out.push(...res.rows);
    if (n * 100 >= res.total) return { rows: out, total: res.total };
  }
}

// ── paging ──────────────────────────────────────────────────────────────────
console.log('\n— pages —');
await check('pages cover every row exactly once, newest first by default', async () => {
  const seen = [];
  const first = await page('Invoices', { pageSize: 7 });
  assert(first.total === T.Invoices.length, `total ${first.total}, expected ${T.Invoices.length}`);
  for (let n = 1; n <= Math.ceil(first.total / 7); n++) seen.push(...(await page('Invoices', { page: n, pageSize: 7 })).rows);
  same(seen.map(r => r.id), T.Invoices.slice().sort(byOrder('due_date', 'desc')).map(r => r.id), 'order across pages');
});
await check('a page past the end returns the last page, not nothing', async () => {
  const last = await page('Payments', { page: 9999, pageSize: 10 });
  assert(last.page === Math.ceil(T.Payments.length / 10), 'page ' + last.page);
  assert(last.rows.length > 0, 'the last page is empty');
});
await check('page size is capped, and only an export may ask for more', async () => {
  const big = await page('Invoices', { pageSize: 100000 });
  assert(big.pageSize === 100 && big.rows.length <= 100, 'pageSize ' + big.pageSize);
  const exported = await page('Invoices', { pageSize: 100000, export: true });
  assert(exported.pageSize === 5000 && exported.rows.length === T.Invoices.length, 'export pageSize ' + exported.pageSize);
});
await check('sorting follows the column: numbers as numbers, blanks first going up', async () => {
  for (const [col, dir] of [['total', 'asc'], ['total', 'desc'], ['period_start', 'asc'], ['status', 'desc']]) {
    const res = await everything('Invoices', { sort: col, dir });
    same(res.rows.map(r => r.id), T.Invoices.slice().sort(byOrder(col, dir)).map(r => r.id), `sorted by ${col} ${dir}`);
  }
});
await check('an unknown or hostile sort column falls back to the default order', async () => {
  const res = await page('Invoices', { sort: 'due_date; drop table invoices; --', dir: 'asc', pageSize: 100 });
  same(res.rows.map(r => r.id), T.Invoices.slice().sort(byOrder('due_date', 'desc')).slice(0, 100).map(r => r.id), 'fallback order');
  assert((await box.readTable('Invoices')).length === T.Invoices.length, 'the invoices table was touched');
});
await check('filters are exact matches on real columns only', async () => {
  const res = await everything('Invoices', { filters: { status: 'Paid', type: 'Rent' } });
  same(ids(res.rows), ids(T.Invoices.filter(i => i.status === 'Paid' && i.type === 'Rent')), 'Paid rent invoices');
  const bad = await box.handle('page', { table: 'Invoices', filters: { 'status = status or 1=1 --': 'x' } }, admin);
  assert(bad.ok === false && /cannot filter/i.test(bad.error), 'a made-up column was accepted: ' + JSON.stringify(bad));
});

console.log('\n— search —');
await check("a tenant's name finds their invoices and payments", async () => {
  const z = tenants[2];
  same(ids((await everything('Invoices', { q: 'zebediah' })).rows), ids(T.Invoices.filter(i => i.tenant_id === z.id)), 'invoices');
  same(ids((await everything('Payments', { q: 'ZEBEDIAH' })).rows), ids(T.Payments.filter(p => p.tenant_id === z.id)), 'payments');
});
await check('property names, unit numbers and ids are searchable', async () => {
  same(ids((await everything('Expenses', { q: 'palm court' })).rows), ids(T.Expenses.filter(e => e.property_id === P2.id)), 'by property');
  same(ids((await everything('Maintenance', { q: 'A-102' })).rows), ids(T.Maintenance.filter(m => m.unit_id === units[1].id)), 'by unit');
  const one = T.Payments[3];
  assert((await page('Payments', { q: one.id })).rows.some(p => p.id === one.id), 'payment id not found');
});
await check('% and _ in a search are matched literally', async () => {
  const pct = await everything('Invoices', { q: '50%_' });
  same(ids(pct.rows), ids(T.Invoices.filter(i => i.tenant_id === tenants[4].id)), 'literal 50%_');
  assert((await page('Invoices', { q: '%' })).total === T.Invoices.filter(i => i.tenant_id === tenants[4].id).length,
         'a lone % matched everything');
});

console.log('\n— worked-out columns —');
await check('"Paid on" is the date of the latest payment against each invoice', async () => {
  const res = await everything('Invoices');
  for (const inv of res.rows) {
    const want = T.Payments.filter(p => p.invoice_id === inv.id).reduce((m, p) => (p.payment_date > m ? p.payment_date : m), '');
    assert(inv.last_paid === want, `${inv.id}: ${inv.last_paid} vs ${want}`);
  }
  const sorted = await everything('Invoices', { sort: 'last_paid', dir: 'desc' });
  const lp = sorted.rows.map(r => r.last_paid);
  assert(lp.every((v, i) => i === 0 || v === '' || lp[i - 1] >= v || lp[i - 1] === ''), 'not sorted by last payment');
});
await check('an export names every invoice its payments settle, beyond one page of them', async () => {
  const res = await page('Payments', { pageSize: 5000, export: true });
  const wanted = new Set(res.rows.map(p => p.invoice_id).filter(Boolean));
  assert(wanted.size > 0, 'no invoices referenced');
  same([...new Set(res.refs.invoices.map(i => i.id))].sort(), [...wanted].sort(), 'referenced invoices in an export');
});
await check('payments say whether they settle a deposit, and name their invoices', async () => {
  const res = await page('Payments', { pageSize: 100 });
  for (const p of res.rows) assert(p._deposit === isDepositPayment(p), p.id + ' _deposit wrong');
  const wanted = new Set(res.rows.map(p => p.invoice_id).filter(Boolean));
  same([...new Set((res.refs.invoices || []).map(i => i.id))].sort(), [...wanted].sort(), 'referenced invoices');
});

console.log('\n— Billing figures and filters —');
await check("Billing's figures match what its filters list", async () => {
  const snap = await call('bootstrap', { lean: true });
  const b = snap.billing;
  const week = new Date(today + 'T00:00:00Z'); week.setUTCDate(week.getUTCDate() + 7);
  const weekIso = week.toISOString().slice(0, 10);
  const oracle = {
    outstanding: T.Invoices.filter(i => OPEN.includes(i.status)),
    overdue: T.Invoices.filter(i => OPEN.includes(i.status) && i.due_date && i.due_date < today),
    week: T.Invoices.filter(i => OPEN.includes(i.status) && i.due_date >= today && i.due_date <= weekIso)
  };
  for (const key of Object.keys(oracle)) {
    same(b[key], { count: oracle[key].length, sum: sum(oracle[key], 'balance') }, key + ' figure');
    same(ids((await everything('Invoices', { preset: key })).rows), ids(oracle[key]), key + ' list');
  }
  const month = income(T.Payments).filter(p => String(p.payment_date || '').slice(0, 7) === today.slice(0, 7));
  same(b.month, { count: month.length, sum: sum(month) }, 'collected this month');
  same(ids((await everything('Payments', { preset: 'month' })).rows), ids(month), 'this month\'s payments');
});

console.log('\n— a record\'s own page —');
for (const [kind, table, rows] of [['property', 'Properties', [P1, P2, P3]], ['unit', 'Units', units],
                                    ['tenant', 'Tenants', tenants], ['lease', 'Leases', leases]]) {
  await check(`every ${kind}'s tabs and totals match its records`, async () => {
    for (const row of rows) {
      const want = SCOPE[kind](row.id);
      const s = await call('detail', { table, id: row.id });
      for (const t of Object.keys(want)) {
        const got = await everything(t, { scope: { kind, id: row.id } });
        same(ids(got.rows), ids(want[t]), `${row.id} ${t} tab`);
        const key = { Invoices: 'invoices', Payments: 'payments', Expenses: 'expenses', Maintenance: 'maintenance', Documents: 'documents' }[t];
        assert(s.counts[key] === want[t].length, `${row.id} ${t} count ${s.counts[key]} vs ${want[t].length}`);
      }
      if (want.Invoices) {
        assert(s.outstanding === owed(want.Invoices), `${row.id} outstanding ${s.outstanding} vs ${owed(want.Invoices)}`);
        same(s.recentInvoices.map(i => i.id), want.Invoices.slice().sort(byOrder('due_date', 'desc')).slice(0, 5).map(i => i.id), row.id + ' recent invoices');
        if (kind === 'tenant') {
          same(s.unpaid.map(i => i.id), want.Invoices.filter(i => OPEN.includes(i.status) && Number(i.balance) > 0)
            .sort(byOrder('due_date', 'asc')).map(i => i.id), row.id + ' unpaid');
        } else assert(s.unpaid === undefined, row.id + ' sent an unpaid list it does not show');
      }
      if (want.Payments) assert(s.collected === sum(income(want.Payments)), `${row.id} collected ${s.collected}`);
      if (want.Expenses) assert(s.spent === sum(opex(want.Expenses)), `${row.id} spent ${s.spent}`);
      if (want.Maintenance) {
        const open = want.Maintenance.filter(m => ['Open', 'In Progress', 'On Hold'].includes(m.status));
        assert(s.counts.openTickets === open.length, row.id + ' open tickets');
      }
      if (kind === 'property') same(s.series, monthlySeries(6, today, (x) => x.property_id === row.id), row.id + ' cash flow');
    }
  });
}
await check('a record cannot be asked for a scope it does not have', async () => {
  const r = await box.handle('page', { table: 'Expenses', scope: { kind: 'tenant', id: tenants[0].id } }, admin);
  assert(r.ok === false && /cannot list/i.test(r.error), JSON.stringify(r));
});
await check('an invoice page has its line items and payments', async () => {
  for (const inv of T.Invoices.slice(0, 12)) {
    const d = await call('detail', { table: 'Invoices', id: inv.id });
    assert(d.row && d.row.id === inv.id, 'row missing for ' + inv.id);
    same(d.items.map(i => i.id), T.InvoiceItems.filter(i => i.invoice_id === inv.id).map(i => i.id), inv.id + ' items');
    same(ids(d.payments), ids(T.Payments.filter(p => p.invoice_id === inv.id)), inv.id + ' payments');
  }
  assert((await call('detail', { table: 'Invoices', id: 'INV-99999' })).row === null, 'a missing invoice was found');
});
await check("a payment page shows the tenant's other payments", async () => {
  const p = T.Payments[2];
  const d = await call('detail', { table: 'Payments', id: p.id });
  const others = T.Payments.filter(x => x.tenant_id === p.tenant_id && x.id !== p.id);
  assert(d.othersCount === others.length, `othersCount ${d.othersCount} vs ${others.length}`);
  same(d.others.map(x => x.id), others.sort(byOrder('payment_date', 'desc')).slice(0, 6).map(x => x.id), 'other payments');
  assert(d.invoice && d.invoice.id === p.invoice_id, 'invoice missing');
});
await check('a finished ticket shows the expense it was booked as, and back', async () => {
  const done = T.Maintenance.find(m => m.status === 'Resolved');
  const d = await call('detail', { table: 'Maintenance', id: done.id });
  const expense = T.Expenses.find(e => e.reference === done.id);
  assert(d.expense && d.expense.id === expense.id, 'expense not found');
  const e = await call('detail', { table: 'Expenses', id: expense.id });
  assert(e.ticket && e.ticket.id === done.id, 'ticket not found from its expense');
});
await check("a lease's history is all of its invoices and payments", async () => {
  for (const lease of leases) {
    const h = await call('history', { table: 'Leases', id: lease.id });
    const want = SCOPE.lease(lease.id);
    same(ids(h.invoices), ids(want.Invoices), lease.id + ' invoices');
    same(ids(h.payments), ids(want.Payments), lease.id + ' payments');
  }
});

console.log('\n— what the browser keeps —');
await check('a lean start sends only the small tables, with their derived figures', async () => {
  const s = await call('bootstrap', { lean: true });
  for (const k of ['invoices', 'invoiceItems', 'payments', 'maintenance', 'expenses', 'documents', 'activity']) {
    assert(!(k in s), k + ' was sent whole');
  }
  for (const t of s.tenants) assert(t._owed === owed(T.Invoices.filter(i => i.tenant_id === t.id)), t.id + ' _owed');
  for (const u of s.units) assert(u._owed === owed(T.Invoices.filter(i => i.unit_id === u.id)), u.id + ' _owed');
  for (const p of s.properties) assert(p._owed === owed(T.Invoices.filter(i => i.property_id === p.id)), p.id + ' _owed');
  for (const l of s.leases) {
    same(l._deposit, depositLedger(l), l.id + ' deposit');
    const rentLines = new Set(T.InvoiceItems.filter(i => i.category === 'Rent').map(i => i.invoice_id));
    const through = T.Invoices.filter(i => i.lease_id === l.id && (i.type === 'Rent' || (i.period_start && rentLines.has(i.id))))
      .reduce((m, i) => (String(i.period_end || '') > m ? String(i.period_end).slice(0, 10) : m), '');
    assert(l._billed_through === through, `${l.id} billed through ${l._billed_through} vs ${through}`);
  }
});
await check('a payment refreshes the figures on leases and tenants even though no lease changed', async () => {
  const first = await call('bootstrap', { lean: true });
  const again = await call('bootstrap', { lean: true, known: first.hashes });
  same(again.unchanged.slice().sort(), ['leases', 'properties', 'tenants', 'units'], 'nothing changed');
  const due = (await box.readTable('Invoices')).find(i => OPEN.includes(i.status) && Number(i.balance) > 1);
  const after = await call('recordPayment', { invoice_id: due.id, amount: 1, method: 'Cash', withSnapshot: true, lean: true,
                                              known: first.hashes });
  const snap = after.snapshot;
  for (const k of ['leases', 'tenants']) assert(!snap.unchanged.includes(k), k + ' claimed unchanged after a payment');
  const t = snap.tenants.find(x => x.id === due.tenant_id);
  assert(t._owed === round2(first.tenants.find(x => x.id === due.tenant_id)._owed - 1), 'tenant _owed did not drop');
});
await check('a browser on the previous release still gets every table', async () => {
  const s = await call('bootstrap', {});
  assert(Array.isArray(s.invoices) && s.invoices.length > 0 && Array.isArray(s.payments), 'legacy start lost tables');
  assert(!s.lean && Array.isArray(s.activity), 'legacy start changed shape');
});

console.log('\n— dashboard and reports —');
await check('the dashboard lists match the old calculations', async () => {
  const [T2] = [await box.readTable('Payments')];
  T.Payments = T2; T.Invoices = await box.readTable('Invoices');
  invoiceById.clear(); T.Invoices.forEach(i => invoiceById.set(i.id, i));
  T.Payments.forEach((r, i) => { r._seq = i; }); T.Invoices.forEach((r, i) => { r._seq = i; });
  const d = (await call('bootstrap', { lean: true })).dashboard;
  same(d.series, monthlySeries(6, today), 'cash flow');
  const top = arrears().slice(0, 6);
  same(d.arrears.map(a => a.balance), top.map(a => a.balance), 'arrears balances');
  for (const a of d.arrears) {
    const o = arrears().find(x => x.tenant_id === a.tenant_id);
    same([a.invoices, a.oldest], [o.invoices, o.oldest], a.tenant_id + ' arrears detail');
  }
  const rank = { Urgent: 0, High: 1, Medium: 2, Low: 3 };
  const tickets = T.Maintenance.filter(m => ['Open', 'In Progress', 'On Hold'].includes(m.status))
    .sort((a, b) => (rank[a.priority] ?? 4) - (rank[b.priority] ?? 4));
  assert(d.open_tickets === tickets.length, 'open ticket count');
  same(d.tickets.map(m => m.id), tickets.slice(0, 8).map(m => m.id), 'ticket queue');
  const limit = new Date(today + 'T00:00:00Z'); limit.setUTCDate(limit.getUTCDate() + 60);
  const docs = T.Documents.filter(x => x.expiry_date && x.expiry_date <= limit.toISOString().slice(0, 10))
    .sort(byOrder('expiry_date', 'asc'));
  assert(d.expiring_documents === docs.length, 'expiring document count');
  same(d.documents.map(x => x.id), docs.slice(0, 6).map(x => x.id), 'expiring documents');
});
for (const [label, from, to, propertyId] of [['the year to date', today.slice(0, 4) + '-01-01', today, ''],
                                             ['one property over 14 months', shift(-14, 1), today, P1.id],
                                             ['a range with nothing in it', '2001-01-01', '2001-12-31', '']]) {
  await check(`reports match the old calculations for ${label}`, async () => {
    const rep = await call('report', { from, to, propertyId });
    const inRange = (d) => d && d >= from && d <= to;
    const matchProp = (x) => !propertyId || x.property_id === propertyId;
    const pays = T.Payments.filter(p => inRange(p.payment_date) && matchProp(p));
    const exps = T.Expenses.filter(e => inRange(e.date) && matchProp(e));
    const invs = T.Invoices.filter(i => inRange(i.due_date) && matchProp(i) && !['Void', 'Draft'].includes(i.status));
    same([rep.income, rep.opex, rep.deposits_in, rep.deposits_out],
         [sum(income(pays)), sum(opex(exps)), sum(pays.filter(isDepositPayment)), sum(exps.filter(e => e.category === 'Deposit Refund'))],
         'headline figures');
    same([rep.billed, rep.collected_on_billed],
         [round2(invs.reduce((s, i) => s + Number(i.total || i.amount || 0), 0)), sum(invs, 'amount_paid')], 'billed and collected');
    const cats = new Map();
    opex(exps).forEach(e => cats.set(e.category || 'Uncategorised', round2((cats.get(e.category || 'Uncategorised') || 0) + Number(e.amount))));
    same(rep.categories.map(c => [c.label, c.value]).sort(), [...cats.entries()].sort(), 'expenses by category');
    same(rep.series, monthlySeries(12, to, propertyId ? matchProp : null), 'cash flow by month');
    const keys = new Set([...T.Payments, ...T.Expenses, ...T.Invoices].map(x => x.property_id || ''));
    for (const k of keys) {
      const want = {
        inc: sum(income(T.Payments).filter(p => (p.property_id || '') === k && inRange(p.payment_date))),
        exp: sum(opex(T.Expenses).filter(e => (e.property_id || '') === k && inRange(e.date))),
        due: owed(T.Invoices.filter(i => (i.property_id || '') === k))
      };
      same(rep.byProperty[k] || { inc: 0, exp: 0, due: 0 }, want, `P&L for "${k || 'no property'}"`);
    }
    const buckets = [0, 0, 0, 0, 0];
    for (const inv of T.Invoices.filter(matchProp)) {
      const bal = Number(inv.balance || 0);
      if (bal <= 0 || ['Void', 'Draft'].includes(inv.status)) continue;
      const age = Math.round((new Date(today) - new Date(String(inv.due_date).slice(0, 10))) / 86400000);
      buckets[isNaN(age) || age < 0 ? 0 : age <= 30 ? 1 : age <= 60 ? 2 : age <= 90 ? 3 : 4] += bal;
    }
    same(rep.ageing.map(a => a.value), buckets.map(round2), 'arrears ageing');
    same(rep.debtors.map(a => a.balance), arrears(matchProp).slice(0, 10).map(a => a.balance), 'top debtors');
  });
}
await check('a report refuses a malformed date', async () => {
  const r = await box.handle('report', { from: "2026-01-01' or 1=1", to: '2026-02-01' }, admin);
  assert(r.ok === false, 'accepted: ' + JSON.stringify(r));
});

console.log('\n— who may read what —');
await check('a viewer may page invoices but not the audit trail; a manager may', async () => {
  await call('createUser', { name: 'V', phone: '9000000005', role: 'viewer', password: 'viewer-pass-1234' });
  await call('createUser', { name: 'M', phone: '9000000004', role: 'manager', password: 'manager-pass-1234' });
  const viewer = (await call('login', { phone: '9000000005', password: 'viewer-pass-1234' }, '')).token;
  const mgr = (await call('login', { phone: '9000000004', password: 'manager-pass-1234' }, '')).token;
  assert((await box.handle('page', { table: 'Invoices' }, viewer)).ok, 'viewer could not page invoices');
  assert((await box.handle('page', { table: 'ActivityLog' }, viewer)).ok === false, 'viewer paged the audit trail');
  assert((await box.handle('page', { table: 'ActivityLog' }, mgr)).ok, 'manager could not page the audit trail');
  const lean = await call('bootstrap', { lean: true }, viewer);
  assert(lean.tenants.every(t => /^X+9012$/.test(t.id_number)), 'viewer saw full ID numbers');
  assert(lean.tenants.every(t => typeof t._owed === 'number'), 'viewer lost the derived figures');
});
await check('the small tables and users cannot be paged, and nobody signed out can page anything', async () => {
  for (const table of ['Tenants', 'Users', 'Settings']) {
    const r = await box.handle('page', { table }, admin);
    assert(r.ok === false, table + ' was paged');
  }
  for (const action of ['page', 'detail', 'history', 'report']) {
    const r = await box.handle(action, { table: 'Invoices', from: '2026-01-01', to: '2026-02-01' }, '');
    assert(r.ok === false && r.error === 'AUTH_REQUIRED', action + ' answered without a session');
  }
});

await closeAll();
console.log('\n' + '─'.repeat(56));
console.log(fail ? `${fail} FAILED, ${pass} passed` : `ALL ${pass} PAGING CHECKS PASSED`);
process.exit(fail ? 1 : 0);
