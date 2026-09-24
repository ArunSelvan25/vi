/**
 * Production-readiness probes for the backend: the failures that only appear
 * once real people with real roles use the app, rather than a single
 * administrator in testing.
 */
import fs from 'fs';
import { makeSandbox, bootedSandbox, closeAll } from './pg-harness.mjs';
import { csvSafeValue } from '../assets/js/ui.js';

const src = fs.readFileSync(new URL('../supabase/functions/api/backend.js', import.meta.url), 'utf8');

let issues = [];
const probe = async (name, fn) => {
  try { const r = await fn(); if (r) { issues.push([name, r]); console.log('  ✗ ' + name + '\n      ' + r); }
        else console.log('  ✓ ' + name); }
  catch (e) { issues.push([name, 'threw: ' + e.message]); console.log('  ✗ ' + name + '\n      threw: ' + e.message); }
};
const boot = async () => { const { box, admin } = await bootedSandbox(); return { b: box, admin }; };

console.log('\n— role handling under real load —');
await probe('a viewer can sign in and load the app when invoices are overdue', async () => {
  const { b, admin } = await boot();
  await b.handle('createUser', { name: 'V', phone: '9000000003', role: 'viewer', password: 'viewer-pass-1234' }, admin);
  // an overdue invoice, which is what refreshStatuses wants to rewrite
  const t = (await b.handle('create', { table: 'Tenants', data: { full_name: 'T', phone: '9111111111' } }, admin)).data.row;
  await b.handle('create', { table: 'Invoices', data: {
    tenant_id: t.id, type: 'Rent', due_date: '2020-01-01', amount: 1000, total: 1000,
    amount_paid: 0, balance: 1000, status: 'Unpaid' } }, admin);

  const viewer = (await b.handle('login', { phone: '9000000003', password: 'viewer-pass-1234' }, '')).data.token;
  const r = await b.handle('bootstrap', {}, viewer);
  return r.ok ? null : 'viewer bootstrap FAILED: ' + r.error;
});

await probe('a manager can sign in and load the app', async () => {
  const { b, admin } = await boot();
  await b.handle('createUser', { name: 'M', phone: '9000000004', role: 'manager', password: 'manager-pass-1234' }, admin);
  const t = (await b.handle('create', { table: 'Tenants', data: { full_name: 'T', phone: '9111111111' } }, admin)).data.row;
  await b.handle('create', { table: 'Invoices', data: {
    tenant_id: t.id, type: 'Rent', due_date: '2020-01-01', amount: 1000, total: 1000,
    amount_paid: 0, balance: 1000, status: 'Unpaid' } }, admin);
  const mgr = (await b.handle('login', { phone: '9000000004', password: 'manager-pass-1234' }, '')).data.token;
  const r = await b.handle('bootstrap', {}, mgr);
  return r.ok ? null : 'manager bootstrap FAILED: ' + r.error;
});

console.log('\n— invoice integrity —');
await probe('a manually created invoice gets a usable balance and status', async () => {
  const { b, admin } = await boot();
  const t = (await b.handle('create', { table: 'Tenants', data: { full_name: 'T', phone: '9111111111' } }, admin)).data.row;
  const inv = (await b.handle('create', { table: 'Invoices', data: {
    tenant_id: t.id, type: 'Utility', due_date: '2030-01-01', amount: 500, tax: 50 } }, admin)).data.row;
  const problems = [];
  if (inv.total === '' || inv.total === undefined) problems.push('total is blank (help text promises amount+tax)');
  if (inv.balance === '' || inv.balance === undefined) problems.push('balance is blank');
  if (!inv.status) problems.push('status is blank');
  return problems.length ? problems.join('; ') : null;
});

await probe('recording a payment on a manual invoice settles it', async () => {
  const { b, admin } = await boot();
  const t = (await b.handle('create', { table: 'Tenants', data: { full_name: 'T', phone: '9111111111' } }, admin)).data.row;
  const inv = (await b.handle('create', { table: 'Invoices', data: {
    tenant_id: t.id, type: 'Utility', due_date: '2030-01-01', amount: 500 } }, admin)).data.row;
  const r = await b.handle('recordPayment', { invoice_id: inv.id, amount: 500, method: 'Cash' }, admin);
  if (!r.ok) return 'payment failed: ' + r.error;
  return r.data.invoice.status === 'Paid' ? null
       : 'status is "' + r.data.invoice.status + '", balance ' + r.data.invoice.balance;
});

console.log('\n— the landlord workflow, end to end —');

/** property → unit → tenant → lease, exactly as the forms submit it. */
async function portfolio(leaseOverrides) {
  const { box, admin } = await bootedSandbox();
  const c = async (a, p) => (await box.handle(a, p, admin));
  const prop = (await c('create', { table: 'Properties', data: { name: 'Sunrise' } })).data.row;
  const unit = (await c('create', { table: 'Units', data: {
    property_id: prop.id, unit_number: 'A-101', rent_amount: 28000 } })).data.row;
  const tenant = (await c('create', { table: 'Tenants', data: {
    full_name: 'Anita Rao', phone: '9880011111' } })).data.row;
  const lease = await c('create', { table: 'Leases', data: Object.assign({
    property_id: prop.id, unit_id: unit.id, tenant_id: tenant.id,
    start_date: '2026-01-01', end_date: '2026-12-31',
    rent_amount: 28000, deposit_amount: 150000, grace_days: 5,
    status: ''                                   // the form's untouched dropdown
  }, leaseOverrides || {}) });
  return { box, admin, c, prop, unit, tenant, lease };
}

/**
 * Raise the first lease's rent by hand, one invoice a month from its start up
 * to `upto` — what the landlord does from the Billing page each month.
 */
async function raiseRent(box, c, upto = box.today()) {
  const lease = (await box.readTable('Leases'))[0];
  const day = (iso, months, days = 0) => {
    const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
    return new Date(Date.UTC(y, m - 1 + months, d + days)).toISOString().slice(0, 10);
  };
  const raised = [];
  for (let i = 0; ; i++) {
    const start = day(lease.start_date, i);
    if (start > upto || (lease.end_date && start > lease.end_date)) break;
    const r = await c('saveInvoice', { data: {
      tenant_id: lease.tenant_id, lease_id: lease.id, unit_id: lease.unit_id,
      period_start: start, period_end: day(lease.start_date, i + 1, -1), issue_date: start,
      due_date: day(start, 0, Number(lease.grace_days) || 0) },
      items: [{ description: 'Rent', category: 'Rent', quantity: 1, unit_amount: Number(lease.rent_amount),
                tax_rate: Number(lease.gst_rate) || 0 }] });
    if (!r.ok) throw new Error('saveInvoice failed: ' + r.error);
    raised.push(r.data.invoice);
  }
  return raised;
}

await probe('a new record starts in a real status, not blank', async () => {
  const { box } = await portfolio();
  const problems = [];
  const p = (await box.readTable('Properties'))[0], u = (await box.readTable('Units'))[0],
        t = (await box.readTable('Tenants'))[0];
  if (p.status !== 'Active') problems.push('property: ' + JSON.stringify(p.status));
  if (u.status === '') problems.push('unit status is blank');
  if (t.status !== 'Active') problems.push('tenant: ' + JSON.stringify(t.status));
  return problems.length ? problems.join('; ') : null;
});

await probe('saving an active lease marks its unit Occupied straight away', async () => {
  const { box, lease } = await portfolio();
  if (!lease.ok) return 'lease could not be saved: ' + lease.error;
  const status = (await box.readTable('Units'))[0].status;
  return status === 'Occupied' ? null : 'unit reads ' + JSON.stringify(status) + ' with no page reload';
});

await probe('a lease saved with the status left blank still becomes Active', async () => {
  const { lease } = await portfolio();
  return lease.data.row.status === 'Active' ? null : 'status is ' + JSON.stringify(lease.data.row.status);
});

await probe('a future lease is Upcoming and does not occupy the unit yet', async () => {
  const { box, lease } = await portfolio({ start_date: '2027-01-01', end_date: '2027-12-31' });
  if (lease.data.row.status !== 'Upcoming') return 'status is ' + lease.data.row.status;
  return (await box.readTable('Units'))[0].status === 'Occupied' ? 'a future lease already marks the unit Occupied' : null;
});

await probe('terminating a lease frees the unit at once', async () => {
  const { box, c, lease } = await portfolio();
  await c('update', { table: 'Leases', id: lease.data.row.id, data: { status: 'Terminated' } });
  const status = (await box.readTable('Units'))[0].status;
  return status === 'Vacant' ? null : 'unit still reads ' + JSON.stringify(status);
});

await probe('a unit under maintenance is not overwritten by occupancy sync', async () => {
  const { box, c, unit } = await portfolio();
  await c('update', { table: 'Units', id: unit.id, data: { status: 'Under Maintenance' } });
  await c('bootstrap', {});
  const status = (await box.readTable('Units'))[0].status;
  return status === 'Under Maintenance' ? null : 'manual status lost, now ' + JSON.stringify(status);
});

console.log('\n— a unit cannot be let twice —');
await probe('an overlapping lease on the same unit is refused', async () => {
  const { c, prop, unit } = await portfolio();
  const other = (await c('create', { table: 'Tenants', data: { full_name: 'K', phone: '9940033333' } })).data.row;
  const clash = await c('create', { table: 'Leases', data: {
    property_id: prop.id, unit_id: unit.id, tenant_id: other.id,
    start_date: '2026-06-01', end_date: '2027-05-31', rent_amount: 30000 } });
  return clash.ok ? 'the unit was let to two tenants at once' : null;
});

await probe('a lease starting after the previous one ends is allowed', async () => {
  const { c, prop, unit, lease } = await portfolio();
  await c('update', { table: 'Leases', id: lease.data.row.id, data: { status: 'Terminated' } });
  const other = (await c('create', { table: 'Tenants', data: { full_name: 'K', phone: '9940033333' } })).data.row;
  const next = await c('create', { table: 'Leases', data: {
    property_id: prop.id, unit_id: unit.id, tenant_id: other.id,
    start_date: '2027-01-01', end_date: '2027-12-31', rent_amount: 30000 } });
  return next.ok ? null : 'a non-overlapping lease was blocked: ' + next.error;
});

await probe('a lease ending before it starts is refused', async () => {
  const { c, prop, unit, tenant } = await portfolio();
  const bad = await c('create', { table: 'Leases', data: {
    property_id: prop.id, unit_id: unit.id, tenant_id: tenant.id,
    start_date: '2026-12-31', end_date: '2026-01-01', rent_amount: 1 } });
  return bad.ok ? 'a backwards date range was accepted' : null;
});

console.log('\n— money cannot go missing —');
await probe('deleting a payment restores the invoice balance', async () => {
  const { box, c } = await portfolio();
  await raiseRent(box, c);
  const inv = (await box.readTable('Invoices'))[0];
  await c('recordPayment', { invoice_id: inv.id, amount: Number(inv.balance), method: 'UPI' });
  const paid = (await box.readTable('Invoices')).find(i => i.id === inv.id);
  if (paid.status !== 'Paid') return 'payment did not settle the invoice';
  const pay = (await box.readTable('Payments'))[0];
  const del = await c('remove', { table: 'Payments', id: pay.id });
  if (!del.ok) return 'delete failed: ' + del.error;
  const after = (await box.readTable('Invoices')).find(i => i.id === inv.id);
  if (Number(after.amount_paid) !== 0) return 'amount_paid is still ' + after.amount_paid;
  if (Number(after.balance) !== Number(inv.balance)) return 'balance is ' + after.balance;
  return null;
});

await probe('an invoice with a payment against it cannot be deleted', async () => {
  const { box, c } = await portfolio();
  await raiseRent(box, c);
  const inv = (await box.readTable('Invoices'))[0];
  await c('recordPayment', { invoice_id: inv.id, amount: 100, method: 'Cash' });
  const del = await c('remove', { table: 'Invoices', id: inv.id });
  if (del.ok) return 'deleted, orphaning the payment record';
  return /payment|void/i.test(del.error) ? null : 'unhelpful message: ' + del.error;
});

await probe('an issued invoice is voided, never deleted — a draft can be deleted', async () => {
  const { box, c, tenant } = await portfolio();
  await raiseRent(box, c);
  const issued = (await box.readTable('Invoices')).find(i => i.type === 'Rent');
  const del = await c('remove', { table: 'Invoices', id: issued.id });
  if (del.ok) return 'an issued invoice was deleted, leaving a gap in the numbering';
  if (!/void/i.test(del.error)) return 'the refusal does not point to voiding: ' + del.error;
  const draft = (await c('saveInvoice', { data: { tenant_id: tenant.id, due_date: '2030-01-01', status: 'Draft' },
    items: [{ description: 'Draft line', category: 'Other', quantity: 1, unit_amount: 10 }] })).data.invoice;
  const gone = await c('remove', { table: 'Invoices', id: draft.id });
  if (!gone.ok) return 'a draft could not be deleted: ' + gone.error;
  return (await box.readTable('InvoiceItems')).filter(i => i.invoice_id === draft.id).length ? 'line items orphaned' : null;
});

await probe('a payment never pushes any balance negative', async () => {
  const { box, c } = await portfolio();
  await raiseRent(box, c);
  const invoices = await box.readTable('Invoices');
  const owedInTotal = invoices.reduce((s, i) => s + Number(i.balance || 0), 0);

  // more than the tenant owes in total must be refused outright
  const tooMuch = await c('recordPayment', { invoice_id: invoices[0].id, amount: owedInTotal + 5000 });
  if (tooMuch.ok) return 'accepted more than the tenant owes in total';

  // a part payment still works
  const partial = await c('recordPayment', { invoice_id: invoices[0].id, amount: 1000 });
  if (!partial.ok) return 'a valid part payment was blocked: ' + partial.error;

  // settling everything at once is allowed, and spreads across the invoices
  const rest = (await box.readTable('Invoices')).reduce((s, i) => s + Number(i.balance || 0), 0);
  const settle = await c('recordPayment', { invoice_id: invoices[0].id, amount: rest });
  if (!settle.ok) return 'clearing the full arrears was blocked: ' + settle.error;

  const after = await box.readTable('Invoices');
  if (after.some(i => Number(i.balance) < -0.009)) return 'a balance went negative';
  return after.every(i => i.status === 'Paid') ? null : 'not every invoice was settled';
});

await probe('paying an already-settled invoice is refused', async () => {
  const { box, c } = await portfolio();
  await raiseRent(box, c);
  const inv = (await box.readTable('Invoices'))[0];
  await c('recordPayment', { invoice_id: inv.id, amount: Number(inv.balance) });
  return (await c('recordPayment', { invoice_id: inv.id, amount: 500 })).ok
    ? 'a second payment was taken on a settled invoice' : null;
});

console.log('\n— referential integrity —');
await probe('records other rows depend on cannot be deleted', async () => {
  const { c, prop, unit, tenant } = await portfolio();
  const problems = [];
  if ((await c('remove', { table: 'Tenants', id: tenant.id })).ok) problems.push('tenant with a lease was deleted');
  if ((await c('remove', { table: 'Units', id: unit.id })).ok) problems.push('unit with a lease was deleted');
  if ((await c('remove', { table: 'Properties', id: prop.id })).ok) problems.push('property with units was deleted');
  return problems.length ? problems.join('; ') : null;
});

await probe('the block explains what is in the way', async () => {
  const { c, tenant } = await portfolio();
  const err = (await c('remove', { table: 'Tenants', id: tenant.id })).error || '';
  return /1 lease/.test(err) ? null : 'unhelpful message: ' + err;
});

await probe('deleting is allowed once the dependents are gone', async () => {
  // no deposit, so no invoice is raised to hold the lease in place
  const { box, c, tenant, lease } = await portfolio({ deposit_amount: 0 });
  const leaseGone = await c('remove', { table: 'Leases', id: lease.data.row.id });
  if (!leaseGone.ok) return 'the lease could not be removed: ' + leaseGone.error;
  const del = await c('remove', { table: 'Tenants', id: tenant.id });
  if (!del.ok) return 'still blocked: ' + del.error;
  return (await box.readTable('Units'))[0].status === 'Vacant'
    ? null : 'removing the lease did not free the unit';
});

await probe('a lease cannot be deleted while its deposit invoice exists', async () => {
  const { c, lease } = await portfolio();
  const r = await c('remove', { table: 'Leases', id: lease.data.row.id });
  return r.ok ? 'the lease was deleted, orphaning its deposit invoice' : null;
});

console.log('\n— reported figures reflect the live portfolio —');
await probe('a sold property drops out of the headline numbers', async () => {
  const { box, admin } = await bootedSandbox();
  const c = async (a, p) => (await box.handle(a, p, admin));
  const Y = Number(box.today().slice(0, 4));
  const prop = (await c('create', { table: 'Properties', data: { name: 'Sold', status: 'Sold' } })).data.row;
  const unit = (await c('create', { table: 'Units', data: { property_id: prop.id, unit_number: 'A' } })).data.row;
  const t = (await c('create', { table: 'Tenants', data: { full_name: 'T', phone: '9111111111' } })).data.row;
  await c('create', { table: 'Leases', data: { property_id: prop.id, unit_id: unit.id, tenant_id: t.id,
    start_date: (Y - 1) + '-01-01', end_date: (Y + 1) + '-12-31',
    rent_amount: 10000, deposit_amount: 50000 } });
  const s = (await c('stats', {})).data;
  const bad = [];
  if (s.properties !== 0) bad.push('properties ' + s.properties);
  if (s.units !== 0) bad.push('units ' + s.units);
  if (s.monthly_rent_roll !== 0) bad.push('rent roll ' + s.monthly_rent_roll);
  if (s.deposits_held !== 0) bad.push('deposits ' + s.deposits_held);
  return bad.length ? 'sold property still counted: ' + bad.join(', ') : null;
});

await probe('an active property still counts normally', async () => {
  const { box, admin } = await bootedSandbox();
  const c = async (a, p) => (await box.handle(a, p, admin));
  const Y = Number(box.today().slice(0, 4));
  const prop = (await c('create', { table: 'Properties', data: { name: 'Live' } })).data.row;
  const unit = (await c('create', { table: 'Units', data: { property_id: prop.id, unit_number: 'A' } })).data.row;
  const t = (await c('create', { table: 'Tenants', data: { full_name: 'T', phone: '9111111111' } })).data.row;
  await c('create', { table: 'Leases', data: { property_id: prop.id, unit_id: unit.id, tenant_id: t.id,
    start_date: (Y - 1) + '-01-01', end_date: (Y + 1) + '-12-31',
    rent_amount: 10000, deposit_amount: 50000 } });
  // the deposit is only "held" once its invoice is paid
  const dep = (await box.readTable('Invoices')).find(i => i.type === 'Deposit');
  await c('recordPayment', { invoice_id: dep.id, amount: 50000, method: 'Bank Transfer' });
  const s = (await c('stats', {})).data;
  return (s.properties === 1 && s.units === 1 && s.occupied_units === 1 &&
          s.monthly_rent_roll === 10000 && s.deposits_held === 50000)
    ? null : 'live property miscounted: ' + JSON.stringify(s);
});

console.log('\n— money stays attributable and auditable —');
await probe('voiding an invoice that holds money is refused', async () => {
  const { box, admin } = await bootedSandbox();
  const c = async (a, p) => (await box.handle(a, p, admin));
  const t = (await c('create', { table: 'Tenants', data: { full_name: 'T', phone: '9111111111' } })).data.row;
  const inv = (await c('create', { table: 'Invoices', data: {
    tenant_id: t.id, due_date: '2030-01-01', amount: 1000, total: 1000 } })).data.row;
  await c('recordPayment', { invoice_id: inv.id, amount: 400, method: 'Cash' });
  const voided = await c('update', { table: 'Invoices', id: inv.id, data: { status: 'Void' } });
  if (voided.ok) return 'voided while holding 400 — the receipt is orphaned';
  const clean = (await c('create', { table: 'Invoices', data: {
    tenant_id: t.id, due_date: '2030-01-01', amount: 500, total: 500 } })).data.row;
  return (await c('update', { table: 'Invoices', id: clean.id, data: { status: 'Void' } })).ok
    ? null : 'an unpaid invoice could not be voided';
});

await probe('a payment is always attributed to a property when one can be worked out', async () => {
  const { box, admin } = await bootedSandbox();
  const c = async (a, p) => (await box.handle(a, p, admin));
  const prop = (await c('create', { table: 'Properties', data: { name: 'P' } })).data.row;
  const unit = (await c('create', { table: 'Units', data: { property_id: prop.id, unit_number: 'A' } })).data.row;
  const t = (await c('create', { table: 'Tenants', data: { full_name: 'T', phone: '9111111111' } })).data.row;
  // the form leaves Property blank but a Unit is chosen
  const inv = (await c('saveInvoice', { data: { tenant_id: t.id, unit_id: unit.id, due_date: '2030-01-01' },
    items: [{ description: 'Rent', category: 'Rent', quantity: 1, unit_amount: 1000 }] })).data.invoice;
  if (inv.property_id !== prop.id) return 'invoice property not inferred from the unit';
  await c('recordPayment', { invoice_id: inv.id, amount: 1000, method: 'Cash' });
  const pay = (await box.readTable('Payments'))[0];
  return pay.property_id === prop.id ? null : 'payment property is ' + JSON.stringify(pay.property_id);
});

await probe('resolving a maintenance ticket stamps its completion date', async () => {
  const { box, admin } = await bootedSandbox();
  const c = async (a, p) => (await box.handle(a, p, admin));
  const prop = (await c('create', { table: 'Properties', data: { name: 'P' } })).data.row;
  const m = (await c('create', { table: 'Maintenance', data: {
    property_id: prop.id, title: 'Tap', reported_date: '2020-01-15', cost: 5000 } })).data.row;
  await c('update', { table: 'Maintenance', id: m.id, data: { status: 'Resolved' } });
  const after = (await box.readTable('Maintenance'))[0];
  if (!after.completed_date) return 'no completion date — the cost dates to 2020';
  // an explicit date must not be overwritten
  const m2 = (await c('create', { table: 'Maintenance', data: {
    property_id: prop.id, title: 'Pump', status: 'Resolved', completed_date: '2026-05-05' } })).data.row;
  return (await box.readTable('Maintenance')).find(x => x.id === m2.id).completed_date === '2026-05-05'
    ? null : 'an explicit completion date was overwritten';
});

console.log('\n— tenant lifecycle —');
await probe('a tenant becomes Past when their last lease ends', async () => {
  const { box, admin } = await bootedSandbox();
  const c = async (a, p) => (await box.handle(a, p, admin));
  const Y = Number(box.today().slice(0, 4));
  const prop = (await c('create', { table: 'Properties', data: { name: 'P' } })).data.row;
  const unit = (await c('create', { table: 'Units', data: { property_id: prop.id, unit_number: 'A' } })).data.row;
  const t = (await c('create', { table: 'Tenants', data: { full_name: 'T', phone: '9111111111' } })).data.row;
  const l = (await c('create', { table: 'Leases', data: { property_id: prop.id, unit_id: unit.id,
    tenant_id: t.id, start_date: (Y - 1) + '-01-01', end_date: (Y + 1) + '-12-31',
    rent_amount: 1000 } })).data.row;
  if ((await box.readTable('Tenants'))[0].status !== 'Active') return 'a housed tenant is not Active';
  await c('update', { table: 'Leases', id: l.id, data: { status: 'Terminated' } });
  if ((await box.readTable('Tenants'))[0].status !== 'Past') {
    return 'still ' + (await box.readTable('Tenants'))[0].status + ' after their only lease ended';
  }
  return (await c('stats', {})).data.tenants === 0 ? null : 'the dashboard still counts them';
});

await probe('a prospect with no lease is left alone', async () => {
  const { box, admin } = await bootedSandbox();
  const c = async (a, p) => (await box.handle(a, p, admin));
  await c('create', { table: 'Tenants', data: { full_name: 'Maybe', phone: '9111111111', status: 'Prospect' } });
  await c('bootstrap', {});
  const status = (await box.readTable('Tenants'))[0].status;
  return status === 'Prospect' ? null : 'a prospect was changed to ' + status;
});

await probe('signing a new lease makes a past tenant Active again', async () => {
  const { box, admin } = await bootedSandbox();
  const c = async (a, p) => (await box.handle(a, p, admin));
  const Y = Number(box.today().slice(0, 4));
  const prop = (await c('create', { table: 'Properties', data: { name: 'P' } })).data.row;
  const unit = (await c('create', { table: 'Units', data: { property_id: prop.id, unit_number: 'A' } })).data.row;
  const t = (await c('create', { table: 'Tenants', data: { full_name: 'T', phone: '9111111111' } })).data.row;
  const l = (await c('create', { table: 'Leases', data: { property_id: prop.id, unit_id: unit.id,
    tenant_id: t.id, start_date: (Y - 2) + '-01-01', end_date: (Y - 1) + '-12-31',
    rent_amount: 1000 } })).data.row;
  if ((await box.readTable('Tenants'))[0].status !== 'Past') return 'an expired lease did not make them Past';
  await c('create', { table: 'Leases', data: { property_id: prop.id, unit_id: unit.id, tenant_id: t.id,
    start_date: (Y - 1) + '-01-01', end_date: (Y + 1) + '-12-31', rent_amount: 1200 } });
  return (await box.readTable('Tenants'))[0].status === 'Active'
    ? null : 'a re-signed tenant is still ' + (await box.readTable('Tenants'))[0].status;
});

console.log('\n— settings that are configured are actually used —');
await probe('invoice_prefix drives new invoice numbers', async () => {
  const { box, admin } = await bootedSandbox();
  const c = async (a, p) => (await box.handle(a, p, admin));
  await c('update', { table: 'Settings', id: 'invoice_prefix', data: { value: 'BILL' } });
  const t = (await c('create', { table: 'Tenants', data: { full_name: 'T', phone: '9111111111' } })).data.row;
  const inv = (await c('saveInvoice', { data: { tenant_id: t.id, due_date: '2030-01-01' },
    items: [{ description: 'Rent', category: 'Rent', quantity: 1, unit_amount: 100 }] })).data.invoice;
  return /^BILL-/.test(inv.id) ? null : 'invoice numbered ' + inv.id;
});

await probe('a late fee on the lease is charged once when an invoice goes overdue', async () => {
  const { box, admin } = await bootedSandbox();
  const c = async (a, p) => (await box.handle(a, p, admin));
  const Y = Number(box.today().slice(0, 4));
  const prop = (await c('create', { table: 'Properties', data: { name: 'P' } })).data.row;
  const unit = (await c('create', { table: 'Units', data: { property_id: prop.id, unit_number: 'A' } })).data.row;
  const t = (await c('create', { table: 'Tenants', data: { full_name: 'T', phone: '9111111111' } })).data.row;
  await c('create', { table: 'Leases', data: { property_id: prop.id, unit_id: unit.id, tenant_id: t.id,
    start_date: (Y - 1) + '-01-01', end_date: (Y + 1) + '-12-31',
    rent_amount: 10000, grace_days: 0, late_fee: 500 } });
  await raiseRent(box, c);
  await box.refreshStatuses();                                // the next housekeeping run applies the fees

  const overdue = (await box.readTable('Invoices')).filter(i => i.status === 'Overdue');
  if (!overdue.length) return 'no overdue invoices to test with';
  const fees = (await box.readTable('InvoiceItems')).filter(i => i.category === 'Late Fee');
  if (fees.length !== overdue.length) return `${overdue.length} overdue but ${fees.length} fees`;
  if (fees.some(f => Number(f.amount) !== 500)) return 'the fee amount is wrong';

  const inv = (await box.readTable('Invoices')).find(i => i.id === overdue[0].id);
  if (Number(inv.total) !== 10500) return 'the fee did not reach the invoice total: ' + inv.total;

  // running housekeeping again must not stack a second fee
  await box.refreshStatuses();
  const again = (await box.readTable('InvoiceItems')).filter(i => i.category === 'Late Fee').length;
  return again === fees.length ? null : `fees grew from ${fees.length} to ${again} on a second run`;
});

await probe('no late fee is charged when the lease has none', async () => {
  const { box, admin } = await bootedSandbox();
  const c = async (a, p) => (await box.handle(a, p, admin));
  const Y = Number(box.today().slice(0, 4));
  const prop = (await c('create', { table: 'Properties', data: { name: 'P' } })).data.row;
  const unit = (await c('create', { table: 'Units', data: { property_id: prop.id, unit_number: 'A' } })).data.row;
  const t = (await c('create', { table: 'Tenants', data: { full_name: 'T', phone: '9111111111' } })).data.row;
  await c('create', { table: 'Leases', data: { property_id: prop.id, unit_id: unit.id, tenant_id: t.id,
    start_date: (Y - 1) + '-01-01', end_date: (Y + 1) + '-12-31', rent_amount: 10000, grace_days: 0 } });
  await raiseRent(box, c);
  await box.refreshStatuses();
  return (await box.readTable('InvoiceItems')).filter(i => i.category === 'Late Fee').length
    ? 'a fee was charged with no late_fee set' : null;
});

console.log('\n— paying more than one invoice at once —');
await probe('an advance payment is spread over the tenant\'s outstanding invoices', async () => {
  const { box, admin } = await bootedSandbox();
  const c = async (a, p) => (await box.handle(a, p, admin));
  const t = (await c('create', { table: 'Tenants', data: { full_name: 'T', phone: '9111111111' } })).data.row;
  const mk = async due => (await c('saveInvoice', { data: { tenant_id: t.id, due_date: due },
    items: [{ description: 'Rent', category: 'Rent', quantity: 1, unit_amount: 10000 }] })).data.invoice;
  const jan = await mk('2030-01-01'), feb = await mk('2030-02-01'), mar = await mk('2030-03-01');

  const r = await c('recordPayment', { invoice_id: jan.id, amount: 25000, method: 'Bank Transfer' });
  if (!r.ok) return 'a two-and-a-half month payment was refused: ' + r.error;

  const after = async id => (await box.readTable('Invoices')).find(i => i.id === id);
  const problems = [];
  if ((await after(jan.id)).status !== 'Paid') problems.push('january ' + (await after(jan.id)).status);
  if ((await after(feb.id)).status !== 'Paid') problems.push('february ' + (await after(feb.id)).status);
  if (Number((await after(mar.id)).amount_paid) !== 5000) problems.push('march paid ' + (await after(mar.id)).amount_paid);
  if ((await box.readTable('Invoices')).some(i => Number(i.balance) < 0)) problems.push('a balance went negative');
  if ((await box.readTable('Payments')).length !== 3) problems.push((await box.readTable('Payments')).length + ' payment rows');
  return problems.length ? problems.join('; ') : null;
});

await probe('paying more than the tenant owes in total is still refused', async () => {
  const { box, admin } = await bootedSandbox();
  const c = async (a, p) => (await box.handle(a, p, admin));
  const t = (await c('create', { table: 'Tenants', data: { full_name: 'T', phone: '9111111111' } })).data.row;
  const inv = (await c('saveInvoice', { data: { tenant_id: t.id, due_date: '2030-01-01' },
    items: [{ description: 'Rent', category: 'Rent', quantity: 1, unit_amount: 10000 }] })).data.invoice;
  const r = await c('recordPayment', { invoice_id: inv.id, amount: 15000 });
  if (r.ok) return 'accepted 15000 against a single 10000 invoice with nothing else owing';
  return Number((await box.readTable('Invoices'))[0].balance) === 10000 ? null : 'the invoice was altered anyway';
});

console.log('\n— a deposit is only "held" once it is received —');

async function leaseWithDeposit(amount) {
  const { box, admin } = await bootedSandbox();
  const c = async (a, p) => (await box.handle(a, p, admin));
  const Y = Number(box.today().slice(0, 4));
  const prop = (await c('create', { table: 'Properties', data: { name: 'P' } })).data.row;
  const unit = (await c('create', { table: 'Units', data: { property_id: prop.id, unit_number: 'A' } })).data.row;
  const t = (await c('create', { table: 'Tenants', data: { full_name: 'Anita', phone: '9111111111' } })).data.row;
  const lease = (await c('create', { table: 'Leases', data: {
    property_id: prop.id, unit_id: unit.id, tenant_id: t.id,
    start_date: (Y - 1) + '-01-01', end_date: (Y + 1) + '-12-31',
    rent_amount: 28000, deposit_amount: amount } })).data.row;
  return { box, c, prop, unit, tenant: t, lease };
}

await probe('signing a lease raises an invoice for the deposit', async () => {
  const { box, lease } = await leaseWithDeposit(150000);
  const dep = (await box.readTable('Invoices')).filter(i => i.type === 'Deposit');
  if (dep.length !== 1) return dep.length + ' deposit invoices, expected 1';
  if (Number(dep[0].total) !== 150000) return 'invoiced ' + dep[0].total;
  if (dep[0].lease_id !== lease.id) return 'not linked to the lease';
  const items = (await box.readTable('InvoiceItems')).filter(i => i.invoice_id === dep[0].id);
  return items.length === 1 ? null : 'the deposit invoice has no line item';
});

await probe('an unreceived deposit is not counted as held, but is counted as owed', async () => {
  const { c, box } = await leaseWithDeposit(150000);
  if ((await box.readTable('Leases'))[0].deposit_status !== 'Pending') return 'lease is not Pending';
  const s = (await c('stats', {})).data;
  if (s.deposits_held !== 0) return 'deposits held shows ' + s.deposits_held + ' before receipt';
  return s.outstanding >= 150000 ? null : 'the deposit is not in outstanding: ' + s.outstanding;
});

await probe('paying the deposit invoice marks it held', async () => {
  const { c, box } = await leaseWithDeposit(150000);
  const dep = (await box.readTable('Invoices')).find(i => i.type === 'Deposit');
  await c('recordPayment', { invoice_id: dep.id, amount: 150000, method: 'Bank Transfer' });
  if ((await box.readTable('Leases'))[0].deposit_status !== 'Held') {
    return 'lease still ' + (await box.readTable('Leases'))[0].deposit_status;
  }
  return (await c('stats', {})).data.deposits_held === 150000 ? null : 'not counted as held';
});

await probe('a part-paid deposit is not yet held', async () => {
  const { c, box } = await leaseWithDeposit(150000);
  const dep = (await box.readTable('Invoices')).find(i => i.type === 'Deposit');
  await c('recordPayment', { invoice_id: dep.id, amount: 50000, method: 'Cash' });
  return (await box.readTable('Leases'))[0].deposit_status === 'Pending'
    ? null : 'a part payment marked the deposit held';
});

await probe('deleting the deposit payment puts it back to pending', async () => {
  const { c, box } = await leaseWithDeposit(150000);
  const dep = (await box.readTable('Invoices')).find(i => i.type === 'Deposit');
  await c('recordPayment', { invoice_id: dep.id, amount: 150000, method: 'Cash' });
  const pay = (await box.readTable('Payments')).find(p => p.invoice_id === dep.id);
  await c('remove', { table: 'Payments', id: pay.id });
  if ((await box.readTable('Leases'))[0].deposit_status !== 'Pending') return 'still Held after reversal';
  return (await c('stats', {})).data.deposits_held === 0 ? null : 'still counted as held';
});

await probe('re-saving a lease never bills the deposit twice', async () => {
  const { c, box, lease } = await leaseWithDeposit(150000);
  await c('update', { table: 'Leases', id: lease.id, data: { notes: 'touched' } });
  await c('update', { table: 'Leases', id: lease.id, data: { notes: 'touched again' } });
  const dep = (await box.readTable('Invoices')).filter(i => i.type === 'Deposit');
  return dep.length === 1 ? null : dep.length + ' deposit invoices after re-saving';
});

await probe('a lease with no deposit raises no invoice', async () => {
  const { box } = await leaseWithDeposit(0);
  return (await box.readTable('Invoices')).filter(i => i.type === 'Deposit').length
    ? 'an invoice was raised for a zero deposit' : null;
});

console.log('\n— a repair cost is counted exactly once —');
await probe('a completed ticket books its cost as an expense', async () => {
  const { box, admin } = await bootedSandbox();
  const c = async (a, p) => (await box.handle(a, p, admin));
  const prop = (await c('create', { table: 'Properties', data: { name: 'P' } })).data.row;
  const m = (await c('create', { table: 'Maintenance', data: { property_id: prop.id, title: 'Tap',
    category: 'Plumbing', vendor_name: 'AquaCare', reported_date: '2026-09-01' } })).data.row;

  if ((await box.readTable('Expenses')).length) return 'an open ticket already booked an expense';
  await c('update', { table: 'Maintenance', id: m.id, data: { cost: 5000 } });
  if ((await box.readTable('Expenses')).length) return 'a cost on an open ticket booked an expense';

  await c('update', { table: 'Maintenance', id: m.id, data: { status: 'Resolved' } });
  const exp = await box.readTable('Expenses');
  if (exp.length !== 1) return exp.length + ' expenses after resolving, expected 1';
  if (Number(exp[0].amount) !== 5000) return 'booked ' + exp[0].amount;
  if (exp[0].reference !== m.id) return 'the expense is not linked back to the ticket';
  if (exp[0].property_id !== prop.id) return 'not attributed to the property';
  return null;
});

await probe('correcting the cost updates the expense rather than adding one', async () => {
  const { box, admin } = await bootedSandbox();
  const c = async (a, p) => (await box.handle(a, p, admin));
  const prop = (await c('create', { table: 'Properties', data: { name: 'P' } })).data.row;
  const m = (await c('create', { table: 'Maintenance', data: { property_id: prop.id, title: 'Tap',
    status: 'Resolved', cost: 5000 } })).data.row;
  await c('update', { table: 'Maintenance', id: m.id, data: { cost: 6500 } });
  const exp = await box.readTable('Expenses');
  if (exp.length !== 1) return exp.length + ' expenses after a correction';
  return Number(exp[0].amount) === 6500 ? null : 'expense still shows ' + exp[0].amount;
});

await probe('reopening or deleting a ticket withdraws its expense', async () => {
  const { box, admin } = await bootedSandbox();
  const c = async (a, p) => (await box.handle(a, p, admin));
  const prop = (await c('create', { table: 'Properties', data: { name: 'P' } })).data.row;
  const m = (await c('create', { table: 'Maintenance', data: { property_id: prop.id, title: 'Tap',
    status: 'Resolved', cost: 5000 } })).data.row;
  await c('update', { table: 'Maintenance', id: m.id, data: { status: 'In Progress' } });
  if ((await box.readTable('Expenses')).length) return 'a reopened ticket kept its expense';
  await c('update', { table: 'Maintenance', id: m.id, data: { status: 'Closed' } });
  if ((await box.readTable('Expenses')).length !== 1) return 'closing again did not rebook it';
  await c('remove', { table: 'Maintenance', id: m.id });
  return (await box.readTable('Expenses')).length ? 'deleting the ticket orphaned its expense' : null;
});

await probe('a ticket cost is never counted twice in the reports', async () => {
  const { box, admin } = await bootedSandbox();
  const c = async (a, p) => (await box.handle(a, p, admin));
  const prop = (await c('create', { table: 'Properties', data: { name: 'P' } })).data.row;
  await c('create', { table: 'Maintenance', data: { property_id: prop.id, title: 'Tap',
    status: 'Resolved', completed_date: box.today(), cost: 5000 } });
  // the app's own figure for this month must be the cost once, not twice
  const spend = (await c('stats', {})).data.expenses_this_month;
  return spend === 5000 ? null : 'expenses_this_month is ' + spend + ', expected 5000';
});

console.log('\n— refunding a deposit is money out —');
await probe('marking a deposit refunded records the expense, once', async () => {
  const { box, admin } = await bootedSandbox();
  const c = async (a, p) => (await box.handle(a, p, admin));
  const Y = Number(box.today().slice(0, 4));
  const prop = (await c('create', { table: 'Properties', data: { name: 'P' } })).data.row;
  const unit = (await c('create', { table: 'Units', data: { property_id: prop.id, unit_number: 'A' } })).data.row;
  const t = (await c('create', { table: 'Tenants', data: { full_name: 'Anita', phone: '9111111111' } })).data.row;
  const l = (await c('create', { table: 'Leases', data: { property_id: prop.id, unit_id: unit.id,
    tenant_id: t.id, start_date: (Y - 1) + '-01-01', end_date: (Y + 1) + '-12-31',
    rent_amount: 1000, deposit_amount: 50000, deposit_status: 'Held' } })).data.row;

  if ((await c('stats', {})).data.deposits_held !== 50000) return 'the deposit was not counted as held';
  await c('update', { table: 'Leases', id: l.id, data: { deposit_status: 'Refunded' } });

  const expenses = (await box.readTable('Expenses')).filter(e => e.category === 'Deposit Refund');
  if (expenses.length !== 1) return expenses.length + ' refund expenses, expected 1';
  if (Number(expenses[0].amount) !== 50000) return 'refund recorded as ' + expenses[0].amount;
  if (expenses[0].property_id !== prop.id) return 'the refund is not attributed to the property';
  if ((await c('stats', {})).data.deposits_held !== 0) return 'the liability was not released';

  await c('update', { table: 'Leases', id: l.id, data: { deposit_status: 'Refunded', notes: 'again' } });
  const again = (await box.readTable('Expenses')).filter(e => e.category === 'Deposit Refund').length;
  return again === 1 ? null : 'saving the lease again wrote a duplicate refund';
});

console.log('\n— invoice line items —');
await probe('one invoice carries several kinds of charge, summed correctly', async () => {
  const { box, admin } = await bootedSandbox();
  const t = (await box.handle('create', { table: 'Tenants', data: { full_name: 'T', phone: '9111111111' } }, admin)).data.row;
  const r = await box.handle('saveInvoice', {
    data: { tenant_id: t.id, due_date: '2030-01-10' },
    items: [
      { description: 'Rent',    category: 'Rent',        quantity: 1,   unit_amount: 28000 },
      { description: 'EB bill', category: 'Electricity', quantity: 142, unit_amount: 8.5 },
      { description: 'Water',   category: 'Water',       quantity: 1,   unit_amount: 600 }
    ]
  }, admin);
  if (!r.ok) return 'save failed: ' + r.error;
  const inv = r.data.invoice;
  if (r.data.items.length !== 3) return 'expected 3 lines, got ' + r.data.items.length;
  if (Number(inv.amount) !== 29807) return 'amount is ' + inv.amount + ', expected 29807';
  if (Number(inv.balance) !== 29807) return 'balance is ' + inv.balance;
  if (inv.type !== 'Mixed') return 'type is ' + inv.type + ', expected Mixed';
  return null;
});

await probe('a single-category invoice is labelled with that category', async () => {
  const { box, admin } = await bootedSandbox();
  const t = (await box.handle('create', { table: 'Tenants', data: { full_name: 'T', phone: '9111111111' } }, admin)).data.row;
  const r = await box.handle('saveInvoice', {
    data: { tenant_id: t.id, due_date: '2030-01-10' },
    items: [{ description: 'EB bill', category: 'Electricity', quantity: 100, unit_amount: 9 }]
  }, admin);
  return r.data.invoice.type === 'Electricity' ? null : 'type is ' + r.data.invoice.type;
});

await probe('editing the lines re-prices the invoice and leaves no orphan rows', async () => {
  const { box, admin } = await bootedSandbox();
  const t = (await box.handle('create', { table: 'Tenants', data: { full_name: 'T', phone: '9111111111' } }, admin)).data.row;
  const first = (await box.handle('saveInvoice', {
    data: { tenant_id: t.id, due_date: '2030-01-10' },
    items: [{ description: 'Rent', category: 'Rent', quantity: 1, unit_amount: 28000 },
            { description: 'Water', category: 'Water', quantity: 1, unit_amount: 600 }]
  }, admin)).data;

  const second = (await box.handle('saveInvoice', {
    id: first.invoice.id,
    data: { tenant_id: t.id, due_date: '2030-01-10' },
    items: [{ id: first.items[0].id, description: 'Rent', category: 'Rent', quantity: 1, unit_amount: 30000 },
            { description: 'Parking', category: 'Parking', quantity: 2, unit_amount: 500 }]
  }, admin)).data;

  const problems = [];
  if (Number(second.invoice.amount) !== 31000) problems.push('amount is ' + second.invoice.amount + ', expected 31000');
  const stored = (await box.readTable('InvoiceItems')).filter(i => i.invoice_id === first.invoice.id);
  if (stored.length !== 2) problems.push(stored.length + ' rows stored, expected 2 (water should be gone)');
  if (stored.some(i => i.category === 'Water')) problems.push('the removed line is still stored');
  return problems.length ? problems.join('; ') : null;
});

await probe('payments survive an edit to the lines', async () => {
  const { box, admin } = await bootedSandbox();
  const t = (await box.handle('create', { table: 'Tenants', data: { full_name: 'T', phone: '9111111111' } }, admin)).data.row;
  const made = (await box.handle('saveInvoice', {
    data: { tenant_id: t.id, due_date: '2030-01-10' },
    items: [{ description: 'Rent', category: 'Rent', quantity: 1, unit_amount: 10000 }]
  }, admin)).data;
  await box.handle('recordPayment', { invoice_id: made.invoice.id, amount: 4000, method: 'UPI' }, admin);
  const after = (await box.handle('saveInvoice', {
    id: made.invoice.id,
    data: { tenant_id: t.id, due_date: '2030-01-10' },
    items: [{ id: made.items[0].id, description: 'Rent', category: 'Rent', quantity: 1, unit_amount: 10000 },
            { description: 'EB bill', category: 'Electricity', quantity: 1, unit_amount: 2000 }]
  }, admin)).data.invoice;
  if (Number(after.amount_paid) !== 4000) return 'payment lost: amount_paid is ' + after.amount_paid;
  if (Number(after.balance) !== 8000) return 'balance is ' + after.balance + ', expected 8000';
  if (after.status !== 'Partial') return 'status is ' + after.status;
  return null;
});

await probe('tax is added on top of the line total', async () => {
  const { box, admin } = await bootedSandbox();
  const t = (await box.handle('create', { table: 'Tenants', data: { full_name: 'T', phone: '9111111111' } }, admin)).data.row;
  const inv = (await box.handle('saveInvoice', {
    data: { tenant_id: t.id, due_date: '2030-01-10', tax: 180 },
    items: [{ description: 'Internet', category: 'Internet', quantity: 1, unit_amount: 1000 }]
  }, admin)).data.invoice;
  return Number(inv.total) === 1180 && Number(inv.amount) === 1000
    ? null : `amount ${inv.amount} / tax ${inv.tax} / total ${inv.total}`;
});

await probe('deleting an invoice deletes its lines', async () => {
  const { box, admin } = await bootedSandbox();
  const t = (await box.handle('create', { table: 'Tenants', data: { full_name: 'T', phone: '9111111111' } }, admin)).data.row;
  const inv = (await box.handle('saveInvoice', {
    data: { tenant_id: t.id, due_date: '2030-01-10', status: 'Draft' },
    items: [{ description: 'Rent', category: 'Rent', quantity: 1, unit_amount: 1 },
            { description: 'Water', category: 'Water', quantity: 1, unit_amount: 1 }]
  }, admin)).data.invoice;
  const del = await box.handle('remove', { table: 'Invoices', id: inv.id }, admin);
  if (!del.ok) return 'the draft could not be deleted: ' + del.error;
  const left = (await box.readTable('InvoiceItems')).filter(i => i.invoice_id === inv.id).length;
  return left ? left + ' orphan line item(s) left behind' : null;
});

await probe('an invoice with no lines is refused', async () => {
  const { box, admin } = await bootedSandbox();
  const r = await box.handle('saveInvoice', { data: { due_date: '2030-01-10' }, items: [] }, admin);
  return r.ok ? 'an empty invoice was accepted' : null;
});

await probe('a line with no description is refused', async () => {
  const { box, admin } = await bootedSandbox();
  const r = await box.handle('saveInvoice', {
    data: { due_date: '2030-01-10' },
    items: [{ description: '  ', category: 'Rent', quantity: 1, unit_amount: 100 }]
  }, admin);
  return r.ok ? 'a nameless line was accepted' : null;
});

console.log('\n— privilege boundaries —');
await probe('a manager cannot change organisation settings', async () => {
  const { b, admin } = await boot();
  await b.handle('createUser', { name: 'M', phone: '9000000004', role: 'manager', password: 'manager-pass-1234' }, admin);
  const mgr = (await b.handle('login', { phone: '9000000004', password: 'manager-pass-1234' }, '')).data.token;
  const r = await b.handle('update', { table: 'Settings', id: 'session_hours', data: { value: '9999' } }, mgr);
  return r.ok ? 'a manager rewrote session_hours (UI says admin-only)' : null;
});

await probe('the last administrator cannot be deleted', async () => {
  const { b, admin } = await boot();
  const me = (await b.readTable('Users'))[0];
  const r = await b.handle('remove', { table: 'Users', id: me.id }, admin);
  return r.ok ? 'the only admin deleted themselves — nobody can sign in now' : null;
});

console.log('\n— CSV export —');
await probe('CSV export neutralises spreadsheet formulas but keeps money readable', () => {
  const cases = [
    ['Anita Rao',            'Anita Rao'],
    ['-\u20b94,000',            '-\u20b94,000'],           // negative money stays clean
    ['-1234.5',              '-1234.5'],
    ['\u20b928,000',            '\u20b928,000'],
    ['=1+1',                 "'=1+1"],
    ["=cmd|'/C calc'!A0",    "'=cmd|'/C calc'!A0"],
    ['@SUM(A1:A9)',          "'@SUM(A1:A9)"],
    ['-2+3+cmd|x',           "'-2+3+cmd|x"],
    ['+91 98800 11111',      "'+91 98800 11111"]              // imports as text, not a formula
  ];
  const bad = cases.filter(([input, want]) => csvSafeValue(input) !== want)
                   .map(([input, want]) => `${JSON.stringify(input)} -> ${JSON.stringify(csvSafeValue(input))}, expected ${JSON.stringify(want)}`);
  return bad.length ? bad.join('; ') : null;
});

console.log('\n— connecting to a database that already has data —');
await probe('setup on a database that already holds data changes none of it', async () => {
  const box = await makeSandbox();
  // data already there before anyone has signed in
  await box.query(`insert into properties (id, name, city) values
                   ('PRP-00001', 'Sunrise', 'Bengaluru'), ('PRP-00002', 'Palm Court', 'Chennai')`);
  await box.query(`update settings set value = 'My Portfolio' where key = 'org_name'`);
  const snapshot = async () => JSON.stringify([
    await box.query('select id, name, city, row_version from properties order by id'),
    await box.query('select key, value from settings order by key')]);
  const before = await snapshot();

  await box.handle('setup', { adminPhone: '9000000001', adminPassword: 'correct-horse-battery' }, '');
  const admin = (await box.handle('login', { phone: '9000000001', password: 'correct-horse-battery' }, '')).data.token;
  if (await snapshot() !== before) return 'the first setup changed existing data';

  for (let i = 0; i < 5; i++) await box.handle('setup', {}, '');
  await box.handle('setup', {}, admin);
  await box.handle('setup', {}, admin);
  return await snapshot() === before ? null : 're-running setup changed existing data';
});

await probe('the backend never drops, truncates or bulk-deletes tables', async () => {
  const code = src + fs.readFileSync(new URL('../supabase/functions/api/db.js', import.meta.url), 'utf8');
  const banned = [/\btruncate\b/i, /\bdrop\s+(table|database|schema)\b/i, /\balter\s+table\b/i];
  const hits = banned.filter(re => re.test(code)).map(String);
  if (hits.length) return 'found: ' + hits.join(', ');
  // deletes are by primary key, or confined to the audit trail, the sign-in
  // throttle and expired session revocations
  const deletes = [...code.matchAll(/delete from ([^\s`]+)/g)].map(m => m[1]);
  const allowed = ['activity_log', 'login_throttle', 'revoked_sessions', '${r.tx(t.sql)}'];
  const other = deletes.filter(t => !allowed.includes(t));
  return other.length ? 'unexpected delete from: ' + other.join(', ') : null;
});

await probe('pruning the audit trail never touches a data tab', async () => {
  const { box, admin } = await bootedSandbox();
  const c = async (a, p) => (await box.handle(a, p, admin));
  const t = (await c('create', { table: 'Tenants', data: { full_name: 'Keep me', phone: '9111111111' } })).data.row;

  // push the log well past its ceiling
  await box.query(`insert into activity_log (id, timestamp, actor, action, entity)
                   select 'NOISE-' || g, '2020-01-01', 'x', 'noise', 'X' from generate_series(0, 5999) g`);
  const count = async () => Number((await box.query('select count(*) as n from activity_log'))[0].n);
  const before = await count();
  await c('refreshStatuses', {});
  const after = await count();

  if (after >= before) return `log not pruned (${before} -> ${after})`;
  if (after > 5200) return 'log still oversized: ' + after;
  if (!(await box.readTable('Tenants')).some(x => x.id === t.id)) return 'a tenant row was destroyed';
  // the newest entries are the ones that must survive
  const ids = (await box.query('select id from activity_log')).map(r => r.id);
  if (ids.includes('NOISE-0')) return 'pruning kept the oldest entries';
  return ids.includes('NOISE-5999') ? null : 'pruning removed the most recent entries';
});

console.log('\n— break-glass recovery —');
await probe('recovers an account migrated from email sign-in (no phone yet)', async () => {
  const box = await makeSandbox();
  await box.handle('setup', { adminPhone: '9880011111', adminPassword: 'correct-horse-battery' }, '');
  // reproduce the migrated state: the account exists but its phone cell is empty
  await box.query(`update app_users set phone = ''`);
  if ((await box.handle('login', { phone: '9880011111', password: 'correct-horse-battery' }, '')).ok) {
    return 'test set-up failed — login should be broken here';
  }
  await box.recoverAccess('+91 98800 11111', 'brand-new-pass-1', 'Administrator');
  const after = await box.handle('login', { phone: '9880011111', password: 'brand-new-pass-1' }, '');
  if (!after.ok) return 'still locked out: ' + after.error;
  if (after.data.user.role !== 'admin') return 'recovered as ' + after.data.user.role;
  return (await box.readTable('Users')).length === 1 ? null
       : 'recovery created a duplicate account instead of adopting the existing one';
});

await probe('recovery clears an existing sign-in lockout', async () => {
  const box = await makeSandbox();
  await box.handle('setup', { adminPhone: '9880011111', adminPassword: 'correct-horse-battery' }, '');
  for (let i = 0; i < 6; i++) await box.handle('login', { phone: '9880011111', password: 'x' }, '');
  if (!/Too many/.test((await box.handle('login', { phone: '9880011111', password: 'correct-horse-battery' }, '')).error || '')) {
    return 'test set-up failed — should be locked out here';
  }
  await box.recoverAccess('9880011111', 'brand-new-pass-1', 'Administrator');
  const r = await box.handle('login', { phone: '9880011111', password: 'brand-new-pass-1' }, '');
  return r.ok ? null : 'still throttled after recovery: ' + r.error;
});

await probe('recovery creates an administrator when the Users tab is empty', async () => {
  const box = await makeSandbox();
  await box.recoverAccess('9880011111', 'brand-new-pass-1', 'Owner');
  const r = await box.handle('login', { phone: '9880011111', password: 'brand-new-pass-1' }, '');
  return r.ok && r.data.user.role === 'admin' ? null : 'could not sign in: ' + JSON.stringify(r);
});

await probe('recovery is not reachable from the public endpoint', async () => {
  const box = await makeSandbox();
  await box.handle('setup', { adminPhone: '9880011111', adminPassword: 'correct-horse-battery' }, '');
  const r = await box.handle('recoverAccess', { phone: '9999999999', password: 'take-over-12345' }, '');
  return r.ok ? 'recoverAccess is exposed as a web action — anyone could seize the workspace' : null;
});

console.log('\n— the backend is structurally whole —');
await probe('every action the SPA calls is routed to something that runs', async () => {
  const { box, admin } = await bootedSandbox();
  const dir = new URL('../assets/js/', import.meta.url);
  const files = [];
  const walkDir = (u) => fs.readdirSync(u, { withFileTypes: true }).forEach(e =>
    e.isDirectory() ? walkDir(new URL(e.name + '/', u)) : e.name.endsWith('.js') && files.push(new URL(e.name, u)));
  walkDir(dir);
  const actions = new Set();
  files.forEach(f => [...fs.readFileSync(f, 'utf8').matchAll(/\b(?:api|act)\('([a-zA-Z]+)'/g)]
    .forEach(m => actions.add(m[1])));
  if (actions.size < 10) return 'only found ' + actions.size + ' actions in the SPA — the call shape changed';
  const broken = [];
  for (const action of actions) {
    if (action === 'setup' || action === 'login' || action === 'ping') continue;
    const r = await box.handle(action, {}, admin);
    if (!r.ok && /Unknown action|is not defined|is not a function|Cannot read prop/.test(r.error)) {
      broken.push(action + ': ' + r.error);
    }
  }
  return broken.length ? broken.join('; ') : null;
});

console.log('\n— session lifecycle —');
await probe('disabling a user ends their session immediately', async () => {
  const { box, admin } = await bootedSandbox();
  await box.handle('createUser', { name: 'L', phone: '9000000009', role: 'manager', password: 'manager-pass-1234' }, admin);
  const theirs = (await box.handle('login', { phone: '9000000009', password: 'manager-pass-1234' }, '')).data.token;
  const id = (await box.readTable('Users')).filter(u => u.phone === '9000000009')[0].id;
  if (!(await box.handle('bootstrap', {}, theirs)).ok) return 'they could not read before being disabled';
  await box.handle('setUserActive', { id, active: false }, admin);
  return (await box.handle('bootstrap', {}, theirs)).ok
    ? 'a disabled user kept full access on their existing session'
    : null;
});

await probe('demoting a user takes effect on their open session', async () => {
  const { box, admin } = await bootedSandbox();
  await box.handle('createUser', { name: 'D', phone: '9000000010', role: 'manager', password: 'manager-pass-1234' }, admin);
  const theirs = (await box.handle('login', { phone: '9000000010', password: 'manager-pass-1234' }, '')).data.token;
  const id = (await box.readTable('Users')).filter(u => u.phone === '9000000010')[0].id;
  await box.handle('setUserRole', { id, role: 'viewer' }, admin);
  return (await box.handle('create', { table: 'Tenants', data: { full_name: 'X', phone: '9' } }, theirs)).ok
    ? 'a demoted manager could still write'
    : null;
});

await probe('an administrator can reset a forgotten password', async () => {
  const { box, admin } = await bootedSandbox();
  await box.handle('createUser', { name: 'F', phone: '9000000011', role: 'manager', password: 'old-pass-12345' }, admin);
  const id = (await box.readTable('Users')).filter(u => u.phone === '9000000011')[0].id;
  const r = await box.handle('resetPassword', { id, password: 'newer-pass-1234' }, admin);
  if (!r.ok) return 'reset failed: ' + r.error;
  if ((await box.handle('login', { phone: '9000000011', password: 'old-pass-12345' }, '')).ok) {
    return 'the old password still works';
  }
  const after = await box.handle('login', { phone: '9000000011', password: 'newer-pass-1234' }, '');
  return after.ok ? null : 'the new password does not work: ' + after.error;
});

await probe('a manager cannot reset anyone\'s password', async () => {
  const { box, admin } = await bootedSandbox();
  await box.handle('createUser', { name: 'M', phone: '9000000012', role: 'manager', password: 'manager-pass-1234' }, admin);
  const mgr = (await box.handle('login', { phone: '9000000012', password: 'manager-pass-1234' }, '')).data.token;
  const adminId = (await box.readTable('Users')).filter(u => u.phone === '9000000001')[0].id;
  return (await box.handle('resetPassword', { id: adminId, password: 'takenover1' }, mgr)).ok
    ? 'a manager reset the administrator password — full takeover'
    : null;
});

console.log('\n— editing an invoice —');

/** A monthly lease that has been running since the start of last year. */
async function billedLease(leaseExtra = {}) {
  const { box, admin } = await bootedSandbox();
  const c = async (a, p, tok = admin) => (await box.handle(a, p, tok));
  const Y = Number(box.today().slice(0, 4));
  const prop = (await c('create', { table: 'Properties', data: { name: 'P' } })).data.row;
  const unit = (await c('create', { table: 'Units', data: { property_id: prop.id, unit_number: 'A' } })).data.row;
  const tenant = (await c('create', { table: 'Tenants', data: { full_name: 'T', phone: '9111111111' } })).data.row;
  const lease = (await c('create', { table: 'Leases', data: {
    property_id: prop.id, unit_id: unit.id, tenant_id: tenant.id,
    start_date: (Y - 1) + '-01-01', end_date: (Y + 1) + '-12-31',
    rent_amount: 10000, frequency: 'Monthly', grace_days: 5, ...leaseExtra } })).data.row;
  return { box, admin, c, prop, unit, tenant, lease };
}

const editLines = async (box, inv, extra = []) => ({
  id: inv.id,
  data: { tenant_id: inv.tenant_id, property_id: inv.property_id, unit_id: inv.unit_id,
          lease_id: inv.lease_id, due_date: inv.due_date, issue_date: inv.issue_date,
          period_start: inv.period_start, period_end: inv.period_end, tax: 0, notes: '' },
  items: [...(await box.readTable('InvoiceItems')).filter(i => i.invoice_id === inv.id)
            .map(i => ({ id: i.id, description: i.description, category: i.category,
                         quantity: i.quantity, unit_amount: i.unit_amount })), ...extra]
});

await probe('an ad-hoc invoice is still relabelled when its lines change', async () => {
  const { box, c, tenant } = await billedLease();
  const made = (await c('saveInvoice', { data: { tenant_id: tenant.id, due_date: '2030-01-10' },
    items: [{ description: 'EB bill', category: 'Electricity', quantity: 1, unit_amount: 900 }] })).data.invoice;
  const edited = (await c('saveInvoice', (await editLines(box, made,
    [{ description: 'Water', category: 'Water', quantity: 1, unit_amount: 300 }])))).data.invoice;
  return edited.type === 'Mixed' ? null : 'type stayed ' + edited.type;
});

await probe('a void invoice cannot be edited back into arrears', async () => {
  const { box, c, tenant } = await billedLease();
  const inv = (await c('saveInvoice', { data: { tenant_id: tenant.id, due_date: '2030-01-01' },
    items: [{ description: 'Parking', category: 'Parking', quantity: 1, unit_amount: 500 }] })).data.invoice;
  await c('update', { table: 'Invoices', id: inv.id, data: { status: 'Void' } });
  const r = await c('saveInvoice', (await editLines(box, inv)));
  if (r.ok) return 'a void invoice was edited';
  const after = (await box.readTable('Invoices')).find(i => i.id === inv.id);
  return after.status === 'Void' && Number(after.balance) === 0 ? null : `status ${after.status}, balance ${after.balance}`;
});

await probe('the late fee is not charged on a security deposit', async () => {
  const { box, c } = await billedLease({ deposit_amount: 50000, late_fee: 500 });
  await c('bootstrap', {});
  const dep = (await box.readTable('Invoices')).find(i => i.type === 'Deposit');
  if (dep.status !== 'Overdue') return 'test set-up: deposit is ' + dep.status;
  return (await box.readTable('InvoiceItems')).some(i => i.invoice_id === dep.id && i.category === 'Late Fee')
    ? 'a late fee was added to the deposit invoice' : null;
});

await probe('the late fee is still charged on overdue rent', async () => {
  const { box, c } = await billedLease({ late_fee: 500 });
  await raiseRent(box, c);
  await box.refreshStatuses();
  return (await box.readTable('InvoiceItems')).some(i => i.category === 'Late Fee')
    ? null : 'no late fee on any overdue rent invoice';
});

console.log('\n— a payment entered on the Payments page —');
await probe('settles the invoice it is against', async () => {
  const { box, c, tenant } = await billedLease();
  await raiseRent(box, c);
  const inv = (await box.readTable('Invoices'))[0];
  const r = await c('create', { table: 'Payments', data: {
    payment_date: box.today(), tenant_id: tenant.id, invoice_id: inv.id, amount: Number(inv.balance), method: 'UPI' } });
  if (!r.ok) return 'refused: ' + r.error;
  const after = (await box.readTable('Invoices')).find(i => i.id === inv.id);
  return after.status === 'Paid' && Number(after.balance) === 0
    ? null : `invoice is ${after.status} with balance ${after.balance}`;
});

await probe('cannot be more than the invoice still owes', async () => {
  const { box, c } = await billedLease();
  await raiseRent(box, c);
  const inv = (await box.readTable('Invoices'))[0];
  const r = await c('create', { table: 'Payments', data: { payment_date: box.today(), invoice_id: inv.id, amount: 999999 } });
  return r.ok ? 'an overpayment was accepted' : null;
});

await probe('cannot be taken on a void invoice', async () => {
  const { box, c, tenant } = await billedLease();
  const inv = (await c('saveInvoice', { data: { tenant_id: tenant.id, due_date: '2030-01-01' },
    items: [{ description: 'Parking', category: 'Parking', quantity: 1, unit_amount: 500 }] })).data.invoice;
  await c('update', { table: 'Invoices', id: inv.id, data: { status: 'Void' } });
  return (await c('create', { table: 'Payments', data: { payment_date: box.today(), invoice_id: inv.id, amount: 100 } })).ok
    ? 'a payment was recorded on a void invoice' : null;
});

await probe('editing its amount re-prices the invoice', async () => {
  const { box, c } = await billedLease();
  await raiseRent(box, c);
  const inv = (await box.readTable('Invoices'))[0];
  const pay = (await c('create', { table: 'Payments', data: { payment_date: box.today(), invoice_id: inv.id, amount: 4000 } })).data.row;
  const up = await c('update', { table: 'Payments', id: pay.id, data: { amount: 10000 } });
  if (!up.ok) return 'raising it to the full balance was refused: ' + up.error;
  const after = (await box.readTable('Invoices')).find(i => i.id === inv.id);
  if (after.status !== 'Paid') return 'invoice is ' + after.status + ' with balance ' + after.balance;
  const notes = await c('update', { table: 'Payments', id: pay.id, data: { notes: 'cheque cleared' } });
  return notes.ok ? null : 'editing only the notes of a settled payment was refused: ' + notes.error;
});

await probe('moving it to another invoice puts the first one back', async () => {
  const { box, c } = await billedLease();
  await raiseRent(box, c);
  const [a, b] = await box.readTable('Invoices');
  const pay = (await c('create', { table: 'Payments', data: { payment_date: box.today(), invoice_id: a.id, amount: 10000 } })).data.row;
  await c('update', { table: 'Payments', id: pay.id, data: { invoice_id: b.id } });
  const inv = async (id) => (await box.readTable('Invoices')).find(i => i.id === id);
  if (Number((await inv(a.id)).balance) !== 10000) return 'the first invoice still shows ' + (await inv(a.id)).balance + ' owed';
  return (await inv(b.id)).status === 'Paid' ? null : 'the second invoice is ' + (await inv(b.id)).status;
});

await probe('takes its tenant and property from the invoice', async () => {
  const { box, c, prop, tenant } = await billedLease();
  await raiseRent(box, c);
  const inv = (await box.readTable('Invoices'))[0];
  const row = (await c('create', { table: 'Payments', data: { payment_date: box.today(), invoice_id: inv.id, amount: 10 } })).data.row;
  return row.tenant_id === tenant.id && row.property_id === prop.id
    ? null : `tenant ${row.tenant_id}, property ${row.property_id}`;
});

await probe('money on account, with no invoice, is still accepted', async () => {
  const { box, c, tenant } = await billedLease();
  return (await c('create', { table: 'Payments', data: { payment_date: box.today(), tenant_id: tenant.id, amount: 2500 } })).ok
    ? null : 'a payment without an invoice was refused';
});

await probe('voiding a payment recomputes its invoice once', async () => {
  const { box, c } = await billedLease();
  await raiseRent(box, c);
  const inv = (await box.readTable('Invoices'))[0];
  const p = (await c('recordPayment', { invoice_id: inv.id, amount: 1000 })).data.payment;
  const mark = box.queries.length;
  const r = await c('voidPayment', { id: p.id });
  const n = box.queries.slice(mark).filter(q => q.startsWith('update "invoices"')).length;
  if (!r.ok || Number(r.data.invoice.balance) !== 10000) return 'void did not restore the invoice: ' + JSON.stringify(r);
  return n === 1 ? null : `recomputed ${n} times`;
});

console.log('\n— deposits —');
await probe('a deposit nobody has paid cannot be refunded', async () => {
  const { box, c, lease } = await billedLease({ deposit_amount: 50000 });
  const r = await c('update', { table: 'Leases', id: lease.id, data: { deposit_status: 'Refunded' } });
  if (r.ok) return 'marked refunded, booking ' + (await box.readTable('Expenses')).filter(e => e.category === 'Deposit Refund').map(e => e.amount) + ' out';
  return (await box.readTable('Leases'))[0].deposit_status === 'Pending' ? null : 'the lease was changed anyway';
});

await probe('a refund books what was actually received', async () => {
  const { box, c, lease } = await billedLease({ deposit_amount: 50000 });
  const dep = (await box.readTable('Invoices')).find(i => i.type === 'Deposit');
  await c('recordPayment', { invoice_id: dep.id, amount: 30000 });
  const r = await c('update', { table: 'Leases', id: lease.id, data: { deposit_status: 'Refunded' } });
  if (!r.ok) return 'refused after a part payment: ' + r.error;
  const exp = (await box.readTable('Expenses')).filter(e => e.category === 'Deposit Refund');
  return exp.length === 1 && Number(exp[0].amount) === 30000 ? null : 'refund booked as ' + exp.map(e => e.amount);
});

await probe('adding a deposit to an existing lease invoices it', async () => {
  const { box, c, lease } = await billedLease();
  await c('update', { table: 'Leases', id: lease.id, data: { deposit_amount: 40000 } });
  const dep = (await box.readTable('Invoices')).filter(i => i.type === 'Deposit');
  if (dep.length !== 1 || Number(dep[0].total) !== 40000) return dep.length + ' deposit invoice(s)';
  await c('update', { table: 'Leases', id: lease.id, data: { deposit_amount: 45000 } });
  return (await box.readTable('Invoices')).filter(i => i.type === 'Deposit').length === 1
    ? null : 'changing the amount raised a second deposit invoice';
});

await probe('a deposit recorded as already held raises no invoice', async () => {
  const { box, c, lease } = await billedLease();
  await c('update', { table: 'Leases', id: lease.id, data: { deposit_amount: 40000, deposit_status: 'Held' } });
  return (await box.readTable('Invoices')).some(i => i.type === 'Deposit')
    ? 'billed a deposit the lease says was collected' : null;
});

console.log('\n— data and session hygiene —');
await probe('text that looks like a formula is stored as text', async () => {
  const { box, c } = await billedLease();
  const payload = '=JOIN(",",Users!F2:G9)';
  const t = (await c('create', { table: 'Tenants', data: { full_name: 'X', phone: '9222222222', notes: payload } })).data.row;
  await c('update', { table: 'Tenants', id: t.id, data: { occupation: '=1+1' } });
  await c('update', { table: 'Tenants', id: t.id, data: { alt_phone: '9333333333' } });
  const back = (await box.readTable('Tenants')).find(r => r.id === t.id);
  return back.notes === payload && back.occupation === '=1+1' ? null : 'the text did not read back as typed';
});

await probe('a create cannot choose its own id', async () => {
  const { box, c, tenant } = await billedLease();
  const r = await c('create', { table: 'Tenants', data: { id: tenant.id, full_name: 'Impostor', phone: '9333333333' } });
  return r.data.row.id !== tenant.id && (await box.readTable('Tenants')).filter(t => t.id === tenant.id).length === 1
    ? null : 'two tenants now share ' + tenant.id;
});

await probe('no user write hands back a password hash', async () => {
  const { box, admin } = await bootedSandbox();
  const made = await box.handle('createUser', { name: 'M', phone: '9000000004', role: 'manager', password: 'manager-pass-1234' }, admin);
  const up = await box.handle('update', { table: 'Users', id: made.data.row.id, data: { name: 'Manager' } }, admin);
  const leaked = [made.data.row, up.data.row].filter(r => 'salt' in r || 'password_hash' in r);
  return leaked.length ? leaked.length + ' response(s) carried salt/password_hash' : null;
});

await probe('changing your password keeps you signed in, and ends your other sessions', async () => {
  const { box, admin } = await bootedSandbox();
  const other = (await box.handle('login', { phone: '9000000001', password: 'correct-horse' }, '')).data.token;
  const r = await box.handle('changePassword', { current: 'correct-horse', next: 'brand-new-pass-99' }, admin);
  if (!r.ok || !r.data.token) return 'no replacement session: ' + JSON.stringify(r);
  if (!(await box.handle('bootstrap', {}, r.data.token)).ok) return 'the replacement session is refused';
  if ((await box.handle('bootstrap', {}, other)).ok) return 'a session from before the change still works';
  return (await box.handle('bootstrap', {}, admin)).ok ? 'the session it replaced still works' : null;
});

await probe('signing in can return all the data in the same response', async () => {
  const { box } = await bootedSandbox();
  const plain = await box.handle('login', { phone: '9000000001', password: 'correct-horse' }, '');
  if ('snapshot' in plain.data) return 'a snapshot was sent without being asked for';
  const r = await box.handle('login', { phone: '9000000001', password: 'correct-horse', withSnapshot: true }, '');
  if (!r.ok || !r.data.snapshot || !Array.isArray(r.data.snapshot.properties)) return 'no snapshot: ' + JSON.stringify(r).slice(0, 200);
  if (JSON.stringify(r.data.snapshot).includes('password_hash')) return 'the snapshot carries password hashes';
  return r.data.snapshot.user.id === r.data.user.id ? null : 'snapshot built for a different user';
});

await probe('a failed sign-in never returns a snapshot', async () => {
  const { box } = await bootedSandbox();
  const r = await box.handle('login', { phone: '9000000001', password: 'wrong-password', withSnapshot: true }, '');
  return r.ok || r.data ? 'failed sign-in returned data' : null;
});

await probe('the audit log keeps numbering from its last row', async () => {
  const { box, c } = await billedLease();
  const ids = (await box.readTable('ActivityLog')).map(r => r.id);
  if (new Set(ids).size !== ids.length) return 'duplicate audit ids: ' + ids.join(',');
  const nums = ids.map(i => parseInt(i.split('-')[1], 10));
  return nums.every((n, i) => i === 0 || n === nums[i - 1] + 1) ? null : 'ids out of sequence: ' + ids.join(',');
});

await probe('the scheduled jobs run with nobody signed in', async () => {
  const { box, c } = await billedLease();
  await raiseRent(box, c);
  await box.query(`update invoices set status = 'Unpaid'`);        // stale since yesterday
  const maintenance = await box.dailyMaintenanceJob();
  if (!maintenance || maintenance.changes < 1) return 'housekeeping did nothing: ' + JSON.stringify(maintenance);
  if (!(await box.readTable('Invoices')).some(i => i.status === 'Overdue')) return 'overdue invoices were not flagged';
  // reminders are switched off in settings by default: the job must be a quiet no-op
  const reminders = await box.dailyReminderJob();
  return reminders && reminders.sent === 0 && box.emails.length === 0 ? null : 'the reminder job sent mail while switched off';
});

// ════════════════════════════════════════════════════════════════════════════
// Second review: concurrency, money, speed, features, security policy
// ════════════════════════════════════════════════════════════════════════════

const shift = (iso, days) => {
  const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const rowOf = async (box, table, id) => (await box.readTable(table)).find(r => r.id === id);

console.log('\n— two people saving the same record —');
await probe('a save made on top of someone else\'s change is refused, and changes nothing', async () => {
  const { box, c, tenant } = await billedLease();
  const opened = await rowOf(box, 'Tenants', tenant.id);
  if (!opened._v) return 'rows carry no version';
  await c('update', { table: 'Tenants', id: tenant.id, data: { occupation: 'Doctor' }, expected_version: opened._v });
  const stale = await c('update', { table: 'Tenants', id: tenant.id, data: { occupation: 'Pilot' }, expected_version: opened._v });
  if (stale.ok) return 'the second save overwrote the first';
  if (!/^CONFLICT: /.test(stale.error)) return 'not reported as a conflict: ' + stale.error;
  return (await rowOf(box, 'Tenants', tenant.id)).occupation === 'Doctor' ? null : 'the refused save still wrote';
});

await probe('the version handed back with a save is the one the next save needs', async () => {
  const { box, c, tenant } = await billedLease();
  const first = await c('update', { table: 'Tenants', id: tenant.id, data: { occupation: 'A' },
                              expected_version: (await rowOf(box, 'Tenants', tenant.id))._v });
  if (!first.ok || !first.data.row._v) return 'no version returned: ' + JSON.stringify(first).slice(0, 160);
  const second = await c('update', { table: 'Tenants', id: tenant.id, data: { occupation: 'B' }, expected_version: first.data.row._v });
  return second.ok ? null : 'a save on the returned version was refused: ' + second.error;
});

await probe('an invoice edited on a stale copy is refused', async () => {
  const { box, c } = await billedLease();
  await raiseRent(box, c);
  const inv = (await box.readTable('Invoices'))[0];
  await c('recordPayment', { invoice_id: inv.id, amount: 100 });
  const r = await c('saveInvoice', { ...(await editLines(box, inv)), expected_version: inv._v });
  return r.ok ? 'saved over a payment recorded after the editor opened' : (/CONFLICT/.test(r.error) ? null : r.error);
});

await probe('two payments for the whole balance at the same moment: only one is taken', async () => {
  const { box, admin } = await bootedSandbox({ connections: 4 });
  const c = (a, p) => box.handle(a, p, admin);
  const t = (await c('create', { table: 'Tenants', data: { full_name: 'T', phone: '9111111111' } })).data.row;
  const inv = (await c('saveInvoice', { data: { tenant_id: t.id, due_date: '2030-01-01' },
    items: [{ description: 'Rent', category: 'Rent', quantity: 1, unit_amount: 10000 }] })).data.invoice;
  const results = await Promise.all([1, 2, 3].map(() =>
    c('recordPayment', { invoice_id: inv.id, amount: 10000, method: 'UPI' })));
  const taken = results.filter(r => r.ok).length;
  const pays = await box.readTable('Payments');
  const after = (await box.readTable('Invoices')).find(i => i.id === inv.id);
  if (taken !== 1) return taken + ' of 3 simultaneous full payments were accepted';
  if (pays.length !== 1) return pays.length + ' payment rows';
  return Number(after.balance) === 0 && after.status === 'Paid' ? null : 'invoice reads ' + after.balance + ' ' + after.status;
});

await probe('every request runs under the write lock, taken once and first', async () => {
  const { box, c, lease } = await billedLease({ deposit_amount: 1000 });
  const mark = box.queries.length;
  await c('update', { table: 'Leases', id: lease.id, data: { notes: 'touched', deposit_amount: 2000 } });
  const sent = box.queries.slice(mark).filter(q => !/^(begin|commit|rollback|savepoint|release)/i.test(q));
  const locks = sent.filter(q => /pg_advisory_xact_lock/.test(q)).length;
  if (locks !== 1) return `the lock was taken ${locks} times`;
  return /pg_advisory_xact_lock/.test(sent[0]) ? null : 'the first statement was not the lock: ' + sent[0];
});

await probe('a request that fails part-way leaves nothing behind', async () => {
  const { box, c, tenant } = await billedLease();
  const before = JSON.stringify([await box.readTable('Invoices'), await box.readTable('InvoiceItems')]);
  // the second line is refused after the invoice itself has been priced
  const r = await c('saveInvoice', { data: { tenant_id: tenant.id, due_date: '2030-01-01' },
    items: [{ description: 'Fine', category: 'Other', quantity: 1, unit_amount: 100 },
            { description: 'Bad', category: 'Other', quantity: 1, unit_amount: 100, tax_rate: 250 }] });
  if (r.ok) return 'an invalid GST rate was accepted';
  const after = JSON.stringify([await box.readTable('Invoices'), await box.readTable('InvoiceItems')]);
  if (after !== before) return 'a half-saved invoice was left behind';
  // and one that fails in the database, after writes, rolls back too
  const lease = await c('create', { table: 'Leases', data: { property_id: 'PRP-99999', unit_id: 'UNT-99999',
    tenant_id: tenant.id, start_date: '2030-01-01', rent_amount: 1, deposit_amount: 500 } });
  if (lease.ok) return 'a lease on a unit that does not exist was accepted';
  return (await box.readTable('Invoices')).length === JSON.parse(before)[0].length ? null : 'a deposit invoice survived the failed lease';
});

console.log('\n— invoice numbers and voiding —');
await probe('an invoice number is never issued twice, even after the newest is deleted', async () => {
  const { box, c, tenant } = await billedLease();
  const draft = (await c('saveInvoice', { data: { tenant_id: tenant.id, due_date: '2030-01-01', status: 'Draft' },
    items: [{ description: 'x', category: 'Other', quantity: 1, unit_amount: 1 }] })).data.invoice;
  await c('remove', { table: 'Invoices', id: draft.id });
  const next = (await c('saveInvoice', { data: { tenant_id: tenant.id, due_date: '2030-01-01' },
    items: [{ description: 'y', category: 'Other', quantity: 1, unit_amount: 1 }] })).data.invoice;
  return next.id !== draft.id ? null : draft.id + ' was issued twice';
});

await probe('voiding needs a reason, keeps the number and leaves nothing owed', async () => {
  const { box, c, tenant } = await billedLease();
  const inv = (await c('saveInvoice', { data: { tenant_id: tenant.id, due_date: '2020-01-01' },
    items: [{ description: 'Parking', category: 'Parking', quantity: 1, unit_amount: 500 }] })).data.invoice;
  if ((await c('voidInvoice', { id: inv.id, reason: '' })).ok) return 'voided without a reason';
  const r = await c('voidInvoice', { id: inv.id, reason: 'raised twice' });
  if (!r.ok) return 'void failed: ' + r.error;
  const after = await rowOf(box, 'Invoices', inv.id);
  if (after.status !== 'Void' || Number(after.balance) !== 0) return `status ${after.status}, balance ${after.balance}`;
  if (!/raised twice/.test(after.notes)) return 'the reason was not kept';
  if ((await c('stats', {})).data.outstanding !== 0) return 'a void invoice still counts as outstanding';
  return (await c('recordPayment', { invoice_id: inv.id, amount: 1 })).ok ? 'a void invoice took a payment' : null;
});

await probe('an invoice holding money cannot be voided', async () => {
  const { box, c } = await billedLease();
  await raiseRent(box, c);
  const inv = (await box.readTable('Invoices'))[0];
  await c('recordPayment', { invoice_id: inv.id, amount: 100 });
  const r = await c('voidInvoice', { id: inv.id, reason: 'x' });
  if (r.ok) return 'voided with a payment against it';
  return /received/.test(r.error) ? null : 'refused for the wrong reason: ' + r.error;
});

await probe('a draft is not payable and does not count as owed', async () => {
  const { c, tenant } = await billedLease();
  const d = (await c('saveInvoice', { data: { tenant_id: tenant.id, due_date: '2020-01-01', status: 'Draft' },
    items: [{ description: 'x', category: 'Other', quantity: 1, unit_amount: 900 }] })).data.invoice;
  if (d.status !== 'Draft') return 'saved as ' + d.status;
  if ((await c('recordPayment', { invoice_id: d.id, amount: 100 })).ok) return 'a draft took a payment';
  if ((await c('stats', {})).data.outstanding !== 0) return 'a draft counts as outstanding';
  const issued = (await c('saveInvoice', { id: d.id, data: { tenant_id: tenant.id, due_date: '2020-01-01', status: 'Unpaid' },
    items: [{ description: 'x', category: 'Other', quantity: 1, unit_amount: 900 }] })).data.invoice;
  return issued.status === 'Overdue' ? null : 'issuing a past-due draft left it ' + issued.status;
});

console.log('\n— GST —');
async function gstPortfolio(state, leaseGst = 18) {
  const w = await billedLease({ gst_rate: leaseGst });
  await w.c('update', { table: 'Settings', id: 'gstin', data: { value: '29ABCDE1234F1Z5' } });
  await w.c('update', { table: 'Properties', id: w.prop.id, data: { state } });
  return w;
}

await probe('rent on a lease with GST is taxed, split CGST + SGST within the state', async () => {
  const { box, c } = await gstPortfolio('Karnataka');
  await raiseRent(box, c);
  const inv = (await box.readTable('Invoices')).find(i => i.type === 'Rent');
  const want = { amount: 10000, tax: 1800, total: 11800, cgst: 900, sgst: 900, igst: 0 };
  const bad = Object.entries(want).filter(([k, v]) => Number(inv[k]) !== v);
  if (bad.length) return 'got ' + bad.map(([k]) => k + '=' + inv[k]).join(', ');
  return /^29-/.test(inv.place_of_supply) ? null : 'place of supply ' + inv.place_of_supply;
});

await probe('a property in another state is charged IGST', async () => {
  const { box, c } = await gstPortfolio('TN');
  await raiseRent(box, c);
  const inv = (await box.readTable('Invoices')).find(i => i.type === 'Rent');
  return Number(inv.igst) === 1800 && Number(inv.cgst) === 0 && /^33-/.test(inv.place_of_supply)
    ? null : `igst ${inv.igst}, cgst ${inv.cgst}, place ${inv.place_of_supply}`;
});

await probe('each line carries its own rate, and a late fee is taxed like the rent', async () => {
  const { box, c, tenant } = await gstPortfolio('KA', 18);
  const inv = (await c('saveInvoice', { data: { tenant_id: tenant.id, due_date: '2030-01-01' }, items: [
    { description: 'Rent', category: 'Rent', quantity: 1, unit_amount: 10000, tax_rate: 18 },
    { description: 'EB', category: 'Electricity', quantity: 100, unit_amount: 8, tax_rate: 0 }
  ] })).data.invoice;
  if (Number(inv.tax) !== 1800 || Number(inv.total) !== 12600) return `tax ${inv.tax}, total ${inv.total}`;
  await c('update', { table: 'Leases', id: (await box.readTable('Leases'))[0].id, data: { late_fee: 500 } });
  await raiseRent(box, c);
  await box.refreshStatuses();                                 // housekeeping adds the fee
  const fee = (await box.readTable('InvoiceItems')).find(i => i.category === 'Late Fee');
  return fee && Number(fee.tax_amount) === 90 ? null : 'late fee tax ' + (fee && fee.tax_amount);
});

await probe('an invoice with no line rates keeps its typed tax', async () => {
  const { c, tenant } = await billedLease();
  const inv = (await c('saveInvoice', { data: { tenant_id: tenant.id, due_date: '2030-01-01', tax: 180 },
    items: [{ description: 'Internet', category: 'Internet', quantity: 1, unit_amount: 1000 }] })).data.invoice;
  return Number(inv.tax) === 180 && Number(inv.total) === 1180 && inv.cgst === '' ? null
    : `tax ${inv.tax}, total ${inv.total}, cgst ${JSON.stringify(inv.cgst)}`;
});

await probe('a GSTIN that is not one is refused, for the business and for a tenant', async () => {
  const { c, tenant } = await billedLease();
  const a = await c('update', { table: 'Settings', id: 'gstin', data: { value: '29ABCDE1234' } });
  const b = await c('update', { table: 'Tenants', id: tenant.id, data: { gstin: 'not-a-gstin' } });
  const ok = await c('update', { table: 'Tenants', id: tenant.id, data: { gstin: '33abcde1234f1z5' } });
  if (a.ok || b.ok) return 'an invalid GSTIN was saved';
  return ok.ok && ok.data.row.gstin === '33ABCDE1234F1Z5' ? null : 'a valid GSTIN was not stored canonically';
});

console.log('\n— deposits are held money, not income —');
await probe('receiving or returning a deposit moves neither collected nor spent', async () => {
  const { box, c, lease } = await billedLease({ deposit_amount: 50000, start_date: box_today_minus(10) });
  const dep = (await box.readTable('Invoices')).find(i => i.type === 'Deposit');
  await c('recordPayment', { invoice_id: dep.id, amount: 50000, payment_date: box.today() });
  let s = (await c('stats', {})).data;
  if (s.collected_this_month !== 0) return 'a deposit counted as collected: ' + s.collected_this_month;
  if (s.deposits_held !== 50000) return 'deposits held ' + s.deposits_held;
  await c('update', { table: 'Leases', id: lease.id, data: { deposit_status: 'Refunded' } });
  s = (await c('stats', {})).data;
  if (s.expenses_this_month !== 0) return 'a refund counted as spend: ' + s.expenses_this_month;
  return s.deposits_held === 0 ? null : 'still held after the refund: ' + s.deposits_held;
});
function box_today_minus(n) { return shift(new Date().toISOString().slice(0, 10), -n); }

await probe('a terminated lease whose deposit has not been returned still owes it', async () => {
  const { box, c, lease } = await billedLease({ deposit_amount: 40000, deposit_status: 'Held' });
  await c('update', { table: 'Leases', id: lease.id, data: { status: 'Terminated' } });
  return (await c('stats', {})).data.deposits_held === 40000 ? null : 'deposits held ' + (await c('stats', {})).data.deposits_held;
});

await probe('move-out: the deposit pays arrears and deductions, and the rest is refunded', async () => {
  const { box, c, lease, tenant } = await billedLease({ deposit_amount: 100000, deposit_status: 'Held' });
  await raiseRent(box, c);
  const owed = (await box.readTable('Invoices')).filter(i => i.type === 'Rent' && Number(i.balance) > 0)
    .slice(1).map(i => i.id);
  // leave one unpaid month; pay the rest so arrears are small
  (await box.readTable('Invoices')).filter(i => i.type === 'Rent' && owed.includes(i.id))
    .forEach(async i => (await c('recordPayment', { invoice_id: i.id, amount: Number(i.balance) })));
  const arrears = (await box.readTable('Invoices')).filter(i => Number(i.balance) > 0 && i.type !== 'Deposit')
    .reduce((s, i) => s + Number(i.balance), 0);

  const r = await c('settleDeposit', { lease_id: lease.id, apply_to_arrears: true, end_lease: true,
    move_out_date: box.today(), refund_method: 'UPI', refund_reference: 'UTR1',
    deductions: [{ description: 'Repainting', amount: 7000 }, { description: 'Broken fan', amount: 1500 }] });
  if (!r.ok) return 'settle failed: ' + r.error;
  const problems = [];
  const left = (await box.readTable('Invoices')).filter(i => Number(i.balance) > 0 && i.type !== 'Deposit');
  if (left.length) problems.push(left.length + ' invoice(s) still owed');
  const ded = r.data.deduction_invoice;
  if (!ded || ded.type !== 'Deposit Deduction' || Number(ded.total) !== 8500 || ded.status !== 'Paid') {
    problems.push('deduction invoice ' + JSON.stringify(ded && { type: ded.type, total: ded.total, status: ded.status }));
  }
  const refund = 100000 - arrears - 8500;
  if (r.data.refunded !== refund) problems.push(`refunded ${r.data.refunded}, expected ${refund}`);
  const exp = (await box.readTable('Expenses')).filter(e => e.category === 'Deposit Refund');
  if (exp.length !== 1 || Number(exp[0].amount) !== refund) problems.push('refund expense ' + exp.map(e => e.amount));
  const l = await rowOf(box, 'Leases', lease.id);
  if (l.deposit_status !== 'Partially Refunded') problems.push('deposit status ' + l.deposit_status);
  if (l.status !== 'Terminated') problems.push('lease ' + l.status);
  if ((await rowOf(box, 'Units', (await box.readTable('Units'))[0].id)).status !== 'Vacant') problems.push('unit not freed');
  if ((await c('stats', {})).data.deposits_held !== 0) problems.push('still held ' + (await c('stats', {})).data.deposits_held);
  if ((await c('settleDeposit', { lease_id: lease.id })).ok) problems.push('settled twice');
  const adj = (await box.readTable('Payments')).filter(p => p.method === 'Deposit Adjustment');
  if (!adj.length || adj.some(p => p.tenant_id !== tenant.id)) problems.push('adjustments not recorded against the tenant');
  return problems.length ? problems.join('; ') : null;
});

await probe('deductions larger than the deposit leave the tenant owing the difference', async () => {
  const { box, c, lease } = await billedLease({ deposit_amount: 5000, deposit_status: 'Held', start_date: box_today_minus(3) });
  const r = await c('settleDeposit', { lease_id: lease.id, deductions: [{ description: 'Flooring', amount: 8000 }] });
  if (!r.ok) return r.error;
  const inv = r.data.deduction_invoice;
  return r.data.refunded === 0 && Number(inv.balance) === 3000 && (await rowOf(box, 'Leases', lease.id)).deposit_status === 'Forfeited'
    ? null : `refunded ${r.data.refunded}, still owed ${inv.balance}, status ${(await rowOf(box, 'Leases', lease.id)).deposit_status}`;
});

await probe('partial refunds cannot be typed into the lease form without the money', async () => {
  const { c, lease } = await billedLease({ deposit_amount: 5000, deposit_status: 'Held' });
  return (await c('update', { table: 'Leases', id: lease.id, data: { deposit_status: 'Partially Refunded' } })).ok
    ? 'a partial refund was recorded with no amount' : null;
});

await probe('changing the deposit re-prices its invoice, but never below what was paid', async () => {
  const { box, c, lease } = await billedLease({ deposit_amount: 50000 });
  const dep = async () => (await box.readTable('Invoices')).find(i => i.type === 'Deposit');
  await c('update', { table: 'Leases', id: lease.id, data: { deposit_amount: 60000 } });
  if (Number((await dep()).total) !== 60000) return 'deposit invoice still ' + (await dep()).total;
  await c('recordPayment', { invoice_id: (await dep()).id, amount: 30000 });
  if ((await c('update', { table: 'Leases', id: lease.id, data: { deposit_amount: 20000 } })).ok) return 'cut below the 30000 received';
  return (await box.readTable('Invoices')).filter(i => i.type === 'Deposit').length === 1 ? null : 'a second deposit invoice appeared';
});

console.log('\n— renewing a lease —');
await probe('a renewal starts the day after, at the escalated rent, and carries the deposit once', async () => {
  const Y = Number(new Date().toISOString().slice(0, 4));
  const { box, c, lease } = await billedLease({ start_date: (Y - 2) + '-01-01', end_date: shift(box_today_minus(0), 20),
                                          escalation_pct: 10, deposit_amount: 30000, deposit_status: 'Held' });
  if ((await c('renewLease', { id: lease.id, start_date: shift(box_today_minus(0), 5), end_date: (Y + 2) + '-12-31' })).ok) {
    return 'a renewal overlapping the current lease was accepted';
  }
  const r = await c('renewLease', { id: lease.id, end_date: (Y + 2) + '-12-31' });
  if (!r.ok) return r.error;
  const n = r.data.lease, old = await rowOf(box, 'Leases', lease.id);
  const problems = [];
  if (n.start_date !== shift(old.end_date, 1)) problems.push('starts ' + n.start_date);
  if (Number(n.rent_amount) !== 12100) problems.push('rent ' + n.rent_amount + ' (expected 10000 × 1.1²)');
  if (n.renewed_from !== lease.id) problems.push('not linked to ' + lease.id);
  if (n.deposit_status !== 'Held' || Number(n.deposit_amount) !== 30000) problems.push('new deposit ' + n.deposit_status + ' ' + n.deposit_amount);
  if (old.deposit_status !== 'Transferred') problems.push('old deposit ' + old.deposit_status);
  if ((await box.readTable('Invoices')).some(i => i.type === 'Deposit')) problems.push('a carried deposit was billed again');
  if ((await c('stats', {})).data.deposits_held !== 30000) problems.push('held ' + (await c('stats', {})).data.deposits_held);
  if ((await c('renewLease', { id: lease.id, end_date: (Y + 3) + '-12-31' })).ok) problems.push('renewed twice');
  return problems.length ? problems.join('; ') : null;
});

await probe('the rent roll uses the rent in force after escalation', async () => {
  const Y = Number(new Date().toISOString().slice(0, 4));
  const { c } = await billedLease({ start_date: (Y - 2) + '-01-01', end_date: (Y + 2) + '-12-31', escalation_pct: 10 });
  const roll = (await c('stats', {})).data.monthly_rent_roll;
  return roll === 12100 ? null : 'rent roll ' + roll + ', expected 12100';
});

console.log('\n— reminders keep to a schedule —');
async function reminderWorld() {
  const w = await billedLease();
  await w.c('update', { table: 'Tenants', id: w.tenant.id, data: { email: 't@example.com' } });
  const mails = w.box.emails;
  const raise = async (due) => (await w.c('saveInvoice', { data: { tenant_id: w.tenant.id, due_date: due },
    items: [{ description: 'Charge', category: 'Other', quantity: 1, unit_amount: 1000 }] })).data.invoice;
  return { ...w, mails, raise };
}

await probe('the daily job emails only on the scheduled days', async () => {
  const t = new Date().toISOString().slice(0, 10);
  const cases = [[3, true], [4, false], [0, true], [-7, true], [-8, false], [-30, true]];
  const wrong = [];
  for (const [offset, expect] of cases) {
    const { box, mails, raise } = await reminderWorld();
    await raise(shift(box.today(), offset));
    await box.sendReminders({ role: 'admin', name: 'job' }, { scheduled: true });
    if ((mails.length > 0) !== expect) wrong.push(`${offset} days: ${mails.length} sent`);
  }
  return wrong.length ? wrong.join('; ') : null;
});

await probe('one tenant gets one email for all their invoices, and never twice in a day', async () => {
  const { box, c, mails, raise } = await reminderWorld();
  await raise(shift(box.today(), -7)); await raise(shift(box.today(), -7)); await raise(shift(box.today(), -30));
  await c('sendReminders', {});
  if (mails.length !== 1) return mails.length + ' emails';
  if ((mails[0].body.match(/INV-/g) || []).length !== 3) return 'the email does not list all three invoices';
  await c('sendReminders', {});
  return mails.length === 1 ? null : 'reminded again the same day';
});

console.log('\n— speed —');
await probe('only the first load of the day runs housekeeping', async () => {
  const { box, c } = await billedLease();
  await raiseRent(box, c);
  // as if a day had passed: nothing has refreshed today, and one invoice is stale
  await box.query(`delete from app_state where key = 'LAST_REFRESH'`);
  const first_ = (await box.readTable('Invoices'))[0].id;
  await box.query(`update invoices set status = 'Unpaid' where id = $1`, [first_]);
  // housekeeping is the only thing that writes LAST_REFRESH
  const runsSince = (mark) => box.queries.slice(mark).filter(q => /insert into app_state.*"LAST_REFRESH"/.test(q)).length;
  let mark = box.queries.length;
  await c('bootstrap', {}); const first = runsSince(mark);
  mark = box.queries.length;
  await c('bootstrap', {}); await c('bootstrap', {});
  const runs = first + runsSince(mark);
  if (first !== 1) return 'the first load ran housekeeping ' + first + ' time(s)';
  if ((await box.readTable('Invoices'))[0].status !== 'Overdue') return 'the stale invoice was not fixed';
  return runs === 1 ? null : `later loads ran it ${runs - 1} more time(s)`;
});

await probe('a snapshot leaves out every tab that has not changed', async () => {
  const { c, tenant } = await billedLease();
  const full = (await c('bootstrap', {})).data;
  const again = (await c('bootstrap', { known: full.hashes })).data;
  if (again.unchanged.length !== Object.keys(full.hashes).length) return 'unchanged: ' + again.unchanged.join(',');
  if ('invoices' in again) return 'an unchanged tab was sent';
  const write = await c('update', { table: 'Tenants', id: tenant.id, data: { occupation: 'X' }, withSnapshot: true, known: full.hashes });
  const snap = write.data.snapshot;
  if (!Array.isArray(snap.tenants)) return 'the changed tab was left out';
  return snap.unchanged.includes('invoices') && !('invoices' in snap) ? null : 'an unchanged tab was sent with the write';
});

await probe('a change made directly in the table editor is picked up', async () => {
  const { box, c } = await billedLease();
  const full = (await c('bootstrap', {})).data;
  await box.query(`update tenants set occupation = 'Typed in the table editor'`);
  const again = (await c('bootstrap', { known: full.hashes })).data;
  return Array.isArray(again.tenants) && again.tenants[0].occupation === 'Typed in the table editor' ? null : 'the edit was missed';
});

await probe('a setting added by a new release reaches an existing deployment', async () => {
  const { box, admin } = await bootedSandbox();
  await box.query(`delete from settings where key = 'upi_id'`);
  const r = await box.handle('setup', {}, admin);
  if (!r.ok) return r.error;
  return (await box.readSettings()).upi_id !== undefined ? null : 'the new setting was not added';
});

console.log('\n— rent day —');
await probe('on a rent-day lease the grace days run after the rent day, before the late fee', async () => {
  const Y = Number((await bootedSandbox()).box.today().slice(0, 4)) - 1;
  const late = async (grace) => {
    const { box, c, lease, tenant } = await billedLease({ start_date: Y + '-01-11', rent_amount: 30000, rent_day: 10,
                                                    late_fee: 500, grace_days: grace });
    const inv = (await c('saveInvoice', { data: { tenant_id: tenant.id, lease_id: lease.id, due_date: Y + '-02-10',
      period_start: Y + '-01-11', period_end: Y + '-02-10' },
      items: [{ description: 'Rent', category: 'Rent', quantity: 1, unit_amount: 30000 }] })).data.invoice;
    await box.refreshStatuses();
    const row = await rowOf(box, 'Invoices', inv.id);
    const fees = (await box.readTable('InvoiceItems')).filter(i => i.invoice_id === inv.id && i.category === 'Late Fee');
    return { status: row.status, fees: fees.length };
  };
  const within = await late(100000), past = await late(5);   // a grace too long to have run out yet, and 5 days
  const problems = [];
  if (within.status !== 'Overdue' || within.fees) problems.push(`still in grace: ${within.status}, ${within.fees} late fee`);
  if (past.fees !== 1) problems.push(past.fees + ' late fees once the grace ran out');
  return problems.length ? problems.join('; ') : null;
});

await probe('a rent day outside the 1st–28th (or last day) is refused, and a renewal keeps it', async () => {
  const { box, c, lease } = await billedLease({ rent_day: 10 });
  const bad = await c('update', { table: 'Leases', id: lease.id, data: { rent_day: 30 } });
  if (bad.ok) return 'the 30th was accepted';
  if (!/Rent day/.test(bad.error)) return 'error was: ' + bad.error;
  const Y = Number(box.today().slice(0, 4));
  const r = await c('renewLease', { id: lease.id, end_date: (Y + 3) + '-12-31' });
  if (!r.ok) return r.error;
  return Number(r.data.lease.rent_day) === 10 ? null : 'renewal has rent day ' + JSON.stringify(r.data.lease.rent_day);
});

console.log('\n— records that point at a tenant —');
await probe('a tenant with maintenance tickets or documents cannot be deleted', async () => {
  const { box, admin } = await bootedSandbox();
  const c = async (a, p) => (await box.handle(a, p, admin));
  const prop = (await c('create', { table: 'Properties', data: { name: 'P' } })).data.row;
  const t1 = (await c('create', { table: 'Tenants', data: { full_name: 'A', phone: '1' } })).data.row;
  const t2 = (await c('create', { table: 'Tenants', data: { full_name: 'B', phone: '2' } })).data.row;
  await c('create', { table: 'Maintenance', data: { property_id: prop.id, tenant_id: t1.id, title: 'Leak' } });
  await c('create', { table: 'Documents', data: { entity_type: 'Tenant', entity_id: t2.id, title: 'ID', url: 'https://x' } });
  const a = await c('remove', { table: 'Tenants', id: t1.id }), b = await c('remove', { table: 'Tenants', id: t2.id });
  return a.ok || b.ok ? 'deleted a tenant other records point at' : null;
});

console.log('\n— time zones —');
await probe('dates never drift, whatever zone the app runs in', async () => {
  // west of UTC, where a date read through a JS Date at UTC midnight comes back a day early
  const { box, admin } = await bootedSandbox({ timeZone: 'America/Los_Angeles' });
  const c = async (a, p) => (await box.handle(a, p, admin));
  const prop = (await c('create', { table: 'Properties', data: { name: 'P' } })).data.row;
  const exp = (await c('create', { table: 'Expenses', data: { property_id: prop.id, date: '2026-03-01', amount: 1, description: 'a' } })).data.row;
  if ((await rowOf(box, 'Expenses', exp.id)).date !== '2026-03-01') return 'read back as ' + (await rowOf(box, 'Expenses', exp.id)).date;
  for (let i = 0; i < 3; i++) await c('update', { table: 'Expenses', id: exp.id, data: { description: 'edit ' + i } });
  const after = (await rowOf(box, 'Expenses', exp.id)).date;
  if (after !== '2026-03-01') return 'the date drifted to ' + after + ' after three saves';
  const snap = (await c('bootstrap', {})).data;
  if (snap.timezone !== 'America/Los_Angeles') return 'time zone not reported: ' + JSON.stringify(snap.timezone);
  // timestamps are the app's wall-clock time, not UTC
  const stamp = (await rowOf(box, 'Expenses', exp.id)).created_at;
  const la = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).format(new Date()).replace(', ', 'T');
  return stamp.slice(0, 13) === la.slice(0, 13) ? null : 'created_at ' + stamp + ' is not Los Angeles time (' + la + ')';
});

await closeAll();
console.log('\n' + '─'.repeat(60));
if (issues.length) {
  console.log(`${issues.length} PRODUCTION ISSUE(S) FOUND`);
  process.exit(1);
}
console.log('ALL PRODUCTION CHECKS PASSED');
