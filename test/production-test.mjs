/**
 * Production-readiness probes: the failures that only appear once real people
 * with real roles use the app, rather than a single administrator in testing.
 */
import fs from 'fs';
import { makeSandbox, bootedSandbox } from './gas-harness.mjs';
import { csvSafeValue } from '../assets/js/ui.js';

const src = fs.readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');

let issues = [];
const probe = (name, fn) => {
  try { const r = fn(); if (r) { issues.push([name, r]); console.log('  ✗ ' + name + '\n      ' + r); }
        else console.log('  ✓ ' + name); }
  catch (e) { issues.push([name, 'threw: ' + e.message]); console.log('  ✗ ' + name + '\n      threw: ' + e.message); }
};
const boot = () => { const { box, admin } = bootedSandbox(); return { b: box, admin }; };

console.log('\n— role handling under real load —');
probe('a viewer can sign in and load the app when invoices are overdue', () => {
  const { b, admin } = boot();
  b.handle('createUser', { name: 'V', phone: '9000000003', role: 'viewer', password: 'viewer-pass-1234' }, admin);
  // an overdue invoice, which is what refreshStatuses wants to rewrite
  const t = b.handle('create', { table: 'Tenants', data: { full_name: 'T', phone: '9111111111' } }, admin).data.row;
  b.handle('create', { table: 'Invoices', data: {
    tenant_id: t.id, type: 'Rent', due_date: '2020-01-01', amount: 1000, total: 1000,
    amount_paid: 0, balance: 1000, status: 'Unpaid' } }, admin);

  const viewer = b.handle('login', { phone: '9000000003', password: 'viewer-pass-1234' }, '').data.token;
  const r = b.handle('bootstrap', {}, viewer);
  return r.ok ? null : 'viewer bootstrap FAILED: ' + r.error;
});

probe('a manager can sign in and load the app', () => {
  const { b, admin } = boot();
  b.handle('createUser', { name: 'M', phone: '9000000004', role: 'manager', password: 'manager-pass-1234' }, admin);
  const t = b.handle('create', { table: 'Tenants', data: { full_name: 'T', phone: '9111111111' } }, admin).data.row;
  b.handle('create', { table: 'Invoices', data: {
    tenant_id: t.id, type: 'Rent', due_date: '2020-01-01', amount: 1000, total: 1000,
    amount_paid: 0, balance: 1000, status: 'Unpaid' } }, admin);
  const mgr = b.handle('login', { phone: '9000000004', password: 'manager-pass-1234' }, '').data.token;
  const r = b.handle('bootstrap', {}, mgr);
  return r.ok ? null : 'manager bootstrap FAILED: ' + r.error;
});

console.log('\n— invoice integrity —');
probe('a manually created invoice gets a usable balance and status', () => {
  const { b, admin } = boot();
  const t = b.handle('create', { table: 'Tenants', data: { full_name: 'T', phone: '9111111111' } }, admin).data.row;
  const inv = b.handle('create', { table: 'Invoices', data: {
    tenant_id: t.id, type: 'Utility', due_date: '2030-01-01', amount: 500, tax: 50 } }, admin).data.row;
  const problems = [];
  if (inv.total === '' || inv.total === undefined) problems.push('total is blank (help text promises amount+tax)');
  if (inv.balance === '' || inv.balance === undefined) problems.push('balance is blank');
  if (!inv.status) problems.push('status is blank');
  return problems.length ? problems.join('; ') : null;
});

probe('recording a payment on a manual invoice settles it', () => {
  const { b, admin } = boot();
  const t = b.handle('create', { table: 'Tenants', data: { full_name: 'T', phone: '9111111111' } }, admin).data.row;
  const inv = b.handle('create', { table: 'Invoices', data: {
    tenant_id: t.id, type: 'Utility', due_date: '2030-01-01', amount: 500 } }, admin).data.row;
  const r = b.handle('recordPayment', { invoice_id: inv.id, amount: 500, method: 'Cash' }, admin);
  if (!r.ok) return 'payment failed: ' + r.error;
  return r.data.invoice.status === 'Paid' ? null
       : 'status is "' + r.data.invoice.status + '", balance ' + r.data.invoice.balance;
});

console.log('\n— the landlord workflow, end to end —');

/** property → unit → tenant → lease, exactly as the forms submit it. */
function portfolio(leaseOverrides) {
  const { box, admin } = bootedSandbox();
  const c = (a, p) => box.handle(a, p, admin);
  const prop = c('create', { table: 'Properties', data: { name: 'Sunrise' } }).data.row;
  const unit = c('create', { table: 'Units', data: {
    property_id: prop.id, unit_number: 'A-101', rent_amount: 28000 } }).data.row;
  const tenant = c('create', { table: 'Tenants', data: {
    full_name: 'Anita Rao', phone: '9880011111' } }).data.row;
  const lease = c('create', { table: 'Leases', data: Object.assign({
    property_id: prop.id, unit_id: unit.id, tenant_id: tenant.id,
    start_date: '2026-01-01', end_date: '2026-12-31',
    rent_amount: 28000, deposit_amount: 150000, grace_days: 5,
    status: ''                                   // the form's untouched dropdown
  }, leaseOverrides || {}) });
  return { box, admin, c, prop, unit, tenant, lease };
}

probe('a new record starts in a real status, not blank', () => {
  const { box } = portfolio();
  const problems = [];
  const p = box.readTable('Properties')[0], u = box.readTable('Units')[0],
        t = box.readTable('Tenants')[0];
  if (p.status !== 'Active') problems.push('property: ' + JSON.stringify(p.status));
  if (u.status === '') problems.push('unit status is blank');
  if (t.status !== 'Active') problems.push('tenant: ' + JSON.stringify(t.status));
  return problems.length ? problems.join('; ') : null;
});

probe('saving an active lease marks its unit Occupied straight away', () => {
  const { box, lease } = portfolio();
  if (!lease.ok) return 'lease could not be saved: ' + lease.error;
  const status = box.readTable('Units')[0].status;
  return status === 'Occupied' ? null : 'unit reads ' + JSON.stringify(status) + ' with no page reload';
});

probe('a lease saved with the status left blank still becomes Active', () => {
  const { lease } = portfolio();
  return lease.data.row.status === 'Active' ? null : 'status is ' + JSON.stringify(lease.data.row.status);
});

probe('Generate rent works on a lease the moment it is saved', () => {
  const { box, c } = portfolio();
  const gen = c('generateInvoices', { upto: box.today() });
  if (!gen.ok) return 'failed: ' + gen.error;
  return gen.data.created > 0 ? null : 'created 0 invoices for an active lease';
});

probe('Generate rent is idempotent — running it twice bills nothing extra', () => {
  const { box, c } = portfolio();
  const first = c('generateInvoices', { upto: box.today() }).data.created;
  const second = c('generateInvoices', { upto: box.today() }).data.created;
  return second === 0 ? null : `first run ${first}, second run ${second} (double billing)`;
});

probe('a future lease is Upcoming and bills nothing yet', () => {
  const { box, c, lease } = portfolio({ start_date: '2027-01-01', end_date: '2027-12-31' });
  if (lease.data.row.status !== 'Upcoming') return 'status is ' + lease.data.row.status;
  if (box.readTable('Units')[0].status === 'Occupied') return 'a future lease already marks the unit Occupied';
  return c('generateInvoices', { upto: box.today() }).data.created === 0
    ? null : 'a lease that has not started was billed';
});

probe('terminating a lease frees the unit at once', () => {
  const { box, c, lease } = portfolio();
  c('update', { table: 'Leases', id: lease.data.row.id, data: { status: 'Terminated' } });
  const status = box.readTable('Units')[0].status;
  return status === 'Vacant' ? null : 'unit still reads ' + JSON.stringify(status);
});

probe('a unit under maintenance is not overwritten by occupancy sync', () => {
  const { box, c, unit } = portfolio();
  c('update', { table: 'Units', id: unit.id, data: { status: 'Under Maintenance' } });
  c('bootstrap', {});
  const status = box.readTable('Units')[0].status;
  return status === 'Under Maintenance' ? null : 'manual status lost, now ' + JSON.stringify(status);
});

console.log('\n— a unit cannot be let twice —');
probe('an overlapping lease on the same unit is refused', () => {
  const { c, prop, unit } = portfolio();
  const other = c('create', { table: 'Tenants', data: { full_name: 'K', phone: '9940033333' } }).data.row;
  const clash = c('create', { table: 'Leases', data: {
    property_id: prop.id, unit_id: unit.id, tenant_id: other.id,
    start_date: '2026-06-01', end_date: '2027-05-31', rent_amount: 30000 } });
  return clash.ok ? 'the unit was let to two tenants at once' : null;
});

probe('a lease starting after the previous one ends is allowed', () => {
  const { c, prop, unit, lease } = portfolio();
  c('update', { table: 'Leases', id: lease.data.row.id, data: { status: 'Terminated' } });
  const other = c('create', { table: 'Tenants', data: { full_name: 'K', phone: '9940033333' } }).data.row;
  const next = c('create', { table: 'Leases', data: {
    property_id: prop.id, unit_id: unit.id, tenant_id: other.id,
    start_date: '2027-01-01', end_date: '2027-12-31', rent_amount: 30000 } });
  return next.ok ? null : 'a non-overlapping lease was blocked: ' + next.error;
});

probe('a lease ending before it starts is refused', () => {
  const { c, prop, unit, tenant } = portfolio();
  const bad = c('create', { table: 'Leases', data: {
    property_id: prop.id, unit_id: unit.id, tenant_id: tenant.id,
    start_date: '2026-12-31', end_date: '2026-01-01', rent_amount: 1 } });
  return bad.ok ? 'a backwards date range was accepted' : null;
});

console.log('\n— money cannot go missing —');
probe('deleting a payment restores the invoice balance', () => {
  const { box, c } = portfolio();
  c('generateInvoices', { upto: box.today() });
  const inv = box.readTable('Invoices')[0];
  c('recordPayment', { invoice_id: inv.id, amount: Number(inv.balance), method: 'UPI' });
  const paid = box.readTable('Invoices').find(i => i.id === inv.id);
  if (paid.status !== 'Paid') return 'payment did not settle the invoice';
  const pay = box.readTable('Payments')[0];
  const del = c('remove', { table: 'Payments', id: pay.id });
  if (!del.ok) return 'delete failed: ' + del.error;
  const after = box.readTable('Invoices').find(i => i.id === inv.id);
  if (Number(after.amount_paid) !== 0) return 'amount_paid is still ' + after.amount_paid;
  if (Number(after.balance) !== Number(inv.balance)) return 'balance is ' + after.balance;
  return null;
});

probe('an invoice with a payment against it cannot be deleted', () => {
  const { box, c } = portfolio();
  c('generateInvoices', { upto: box.today() });
  const inv = box.readTable('Invoices')[0];
  c('recordPayment', { invoice_id: inv.id, amount: 100, method: 'Cash' });
  const del = c('remove', { table: 'Invoices', id: inv.id });
  if (del.ok) return 'deleted, orphaning the payment record';
  return /payment/i.test(del.error) ? null : 'unhelpful message: ' + del.error;
});

probe('an invoice with no payments can still be deleted', () => {
  const { box, c } = portfolio();
  c('generateInvoices', { upto: box.today() });
  const inv = box.readTable('Invoices')[0];
  const del = c('remove', { table: 'Invoices', id: inv.id });
  if (!del.ok) return 'blocked without reason: ' + del.error;
  return box.readTable('InvoiceItems').filter(i => i.invoice_id === inv.id).length
    ? 'line items orphaned' : null;
});

probe('a payment never pushes any balance negative', () => {
  const { box, c } = portfolio();
  c('generateInvoices', { upto: box.today() });
  const invoices = box.readTable('Invoices');
  const owedInTotal = invoices.reduce((s, i) => s + Number(i.balance || 0), 0);

  // more than the tenant owes in total must be refused outright
  const tooMuch = c('recordPayment', { invoice_id: invoices[0].id, amount: owedInTotal + 5000 });
  if (tooMuch.ok) return 'accepted more than the tenant owes in total';

  // a part payment still works
  const partial = c('recordPayment', { invoice_id: invoices[0].id, amount: 1000 });
  if (!partial.ok) return 'a valid part payment was blocked: ' + partial.error;

  // settling everything at once is allowed, and spreads across the invoices
  const rest = box.readTable('Invoices').reduce((s, i) => s + Number(i.balance || 0), 0);
  const settle = c('recordPayment', { invoice_id: invoices[0].id, amount: rest });
  if (!settle.ok) return 'clearing the full arrears was blocked: ' + settle.error;

  const after = box.readTable('Invoices');
  if (after.some(i => Number(i.balance) < -0.009)) return 'a balance went negative';
  return after.every(i => i.status === 'Paid') ? null : 'not every invoice was settled';
});

probe('paying an already-settled invoice is refused', () => {
  const { box, c } = portfolio();
  c('generateInvoices', { upto: box.today() });
  const inv = box.readTable('Invoices')[0];
  c('recordPayment', { invoice_id: inv.id, amount: Number(inv.balance) });
  return c('recordPayment', { invoice_id: inv.id, amount: 500 }).ok
    ? 'a second payment was taken on a settled invoice' : null;
});

console.log('\n— referential integrity —');
probe('records other rows depend on cannot be deleted', () => {
  const { c, prop, unit, tenant } = portfolio();
  const problems = [];
  if (c('remove', { table: 'Tenants', id: tenant.id }).ok) problems.push('tenant with a lease was deleted');
  if (c('remove', { table: 'Units', id: unit.id }).ok) problems.push('unit with a lease was deleted');
  if (c('remove', { table: 'Properties', id: prop.id }).ok) problems.push('property with units was deleted');
  return problems.length ? problems.join('; ') : null;
});

probe('the block explains what is in the way', () => {
  const { c, tenant } = portfolio();
  const err = c('remove', { table: 'Tenants', id: tenant.id }).error || '';
  return /1 lease/.test(err) ? null : 'unhelpful message: ' + err;
});

probe('deleting is allowed once the dependents are gone', () => {
  const { box, c, tenant, lease } = portfolio();
  // a lease with a deposit raises an invoice, which itself blocks the lease
  box.readTable('Invoices').forEach(i => c('remove', { table: 'Invoices', id: i.id }));
  const leaseGone = c('remove', { table: 'Leases', id: lease.data.row.id });
  if (!leaseGone.ok) return 'the lease could not be removed: ' + leaseGone.error;
  const del = c('remove', { table: 'Tenants', id: tenant.id });
  if (!del.ok) return 'still blocked: ' + del.error;
  return box.readTable('Units')[0].status === 'Vacant'
    ? null : 'removing the lease did not free the unit';
});

probe('a lease cannot be deleted while its deposit invoice exists', () => {
  const { c, lease } = portfolio();
  const r = c('remove', { table: 'Leases', id: lease.data.row.id });
  return r.ok ? 'the lease was deleted, orphaning its deposit invoice' : null;
});

console.log('\n— reported figures reflect the live portfolio —');
probe('a sold property drops out of the headline numbers', () => {
  const { box, admin } = bootedSandbox();
  const c = (a, p) => box.handle(a, p, admin);
  const Y = Number(box.today().slice(0, 4));
  const prop = c('create', { table: 'Properties', data: { name: 'Sold', status: 'Sold' } }).data.row;
  const unit = c('create', { table: 'Units', data: { property_id: prop.id, unit_number: 'A' } }).data.row;
  const t = c('create', { table: 'Tenants', data: { full_name: 'T', phone: '9111111111' } }).data.row;
  c('create', { table: 'Leases', data: { property_id: prop.id, unit_id: unit.id, tenant_id: t.id,
    start_date: (Y - 1) + '-01-01', end_date: (Y + 1) + '-12-31',
    rent_amount: 10000, deposit_amount: 50000 } });
  const s = c('stats', {}).data;
  const bad = [];
  if (s.properties !== 0) bad.push('properties ' + s.properties);
  if (s.units !== 0) bad.push('units ' + s.units);
  if (s.monthly_rent_roll !== 0) bad.push('rent roll ' + s.monthly_rent_roll);
  if (s.deposits_held !== 0) bad.push('deposits ' + s.deposits_held);
  return bad.length ? 'sold property still counted: ' + bad.join(', ') : null;
});

probe('an active property still counts normally', () => {
  const { box, admin } = bootedSandbox();
  const c = (a, p) => box.handle(a, p, admin);
  const Y = Number(box.today().slice(0, 4));
  const prop = c('create', { table: 'Properties', data: { name: 'Live' } }).data.row;
  const unit = c('create', { table: 'Units', data: { property_id: prop.id, unit_number: 'A' } }).data.row;
  const t = c('create', { table: 'Tenants', data: { full_name: 'T', phone: '9111111111' } }).data.row;
  c('create', { table: 'Leases', data: { property_id: prop.id, unit_id: unit.id, tenant_id: t.id,
    start_date: (Y - 1) + '-01-01', end_date: (Y + 1) + '-12-31',
    rent_amount: 10000, deposit_amount: 50000 } });
  // the deposit is only "held" once its invoice is paid
  const dep = box.readTable('Invoices').find(i => i.type === 'Deposit');
  c('recordPayment', { invoice_id: dep.id, amount: 50000, method: 'Bank Transfer' });
  const s = c('stats', {}).data;
  return (s.properties === 1 && s.units === 1 && s.occupied_units === 1 &&
          s.monthly_rent_roll === 10000 && s.deposits_held === 50000)
    ? null : 'live property miscounted: ' + JSON.stringify(s);
});

console.log('\n— money stays attributable and auditable —');
probe('voiding an invoice that holds money is refused', () => {
  const { box, admin } = bootedSandbox();
  const c = (a, p) => box.handle(a, p, admin);
  const t = c('create', { table: 'Tenants', data: { full_name: 'T', phone: '9111111111' } }).data.row;
  const inv = c('create', { table: 'Invoices', data: {
    tenant_id: t.id, due_date: '2030-01-01', amount: 1000, total: 1000 } }).data.row;
  c('recordPayment', { invoice_id: inv.id, amount: 400, method: 'Cash' });
  const voided = c('update', { table: 'Invoices', id: inv.id, data: { status: 'Void' } });
  if (voided.ok) return 'voided while holding 400 — the receipt is orphaned';
  const clean = c('create', { table: 'Invoices', data: {
    tenant_id: t.id, due_date: '2030-01-01', amount: 500, total: 500 } }).data.row;
  return c('update', { table: 'Invoices', id: clean.id, data: { status: 'Void' } }).ok
    ? null : 'an unpaid invoice could not be voided';
});

probe('a payment is always attributed to a property when one can be worked out', () => {
  const { box, admin } = bootedSandbox();
  const c = (a, p) => box.handle(a, p, admin);
  const prop = c('create', { table: 'Properties', data: { name: 'P' } }).data.row;
  const unit = c('create', { table: 'Units', data: { property_id: prop.id, unit_number: 'A' } }).data.row;
  const t = c('create', { table: 'Tenants', data: { full_name: 'T', phone: '9111111111' } }).data.row;
  // the form leaves Property blank but a Unit is chosen
  const inv = c('saveInvoice', { data: { tenant_id: t.id, unit_id: unit.id, due_date: '2030-01-01' },
    items: [{ description: 'Rent', category: 'Rent', quantity: 1, unit_amount: 1000 }] }).data.invoice;
  if (inv.property_id !== prop.id) return 'invoice property not inferred from the unit';
  c('recordPayment', { invoice_id: inv.id, amount: 1000, method: 'Cash' });
  const pay = box.readTable('Payments')[0];
  return pay.property_id === prop.id ? null : 'payment property is ' + JSON.stringify(pay.property_id);
});

probe('resolving a maintenance ticket stamps its completion date', () => {
  const { box, admin } = bootedSandbox();
  const c = (a, p) => box.handle(a, p, admin);
  const prop = c('create', { table: 'Properties', data: { name: 'P' } }).data.row;
  const m = c('create', { table: 'Maintenance', data: {
    property_id: prop.id, title: 'Tap', reported_date: '2020-01-15', cost: 5000 } }).data.row;
  c('update', { table: 'Maintenance', id: m.id, data: { status: 'Resolved' } });
  const after = box.readTable('Maintenance')[0];
  if (!after.completed_date) return 'no completion date — the cost dates to 2020';
  // an explicit date must not be overwritten
  const m2 = c('create', { table: 'Maintenance', data: {
    property_id: prop.id, title: 'Pump', status: 'Resolved', completed_date: '2026-05-05' } }).data.row;
  return box.readTable('Maintenance').find(x => x.id === m2.id).completed_date === '2026-05-05'
    ? null : 'an explicit completion date was overwritten';
});

console.log('\n— tenant lifecycle —');
probe('a tenant becomes Past when their last lease ends', () => {
  const { box, admin } = bootedSandbox();
  const c = (a, p) => box.handle(a, p, admin);
  const Y = Number(box.today().slice(0, 4));
  const prop = c('create', { table: 'Properties', data: { name: 'P' } }).data.row;
  const unit = c('create', { table: 'Units', data: { property_id: prop.id, unit_number: 'A' } }).data.row;
  const t = c('create', { table: 'Tenants', data: { full_name: 'T', phone: '9111111111' } }).data.row;
  const l = c('create', { table: 'Leases', data: { property_id: prop.id, unit_id: unit.id,
    tenant_id: t.id, start_date: (Y - 1) + '-01-01', end_date: (Y + 1) + '-12-31',
    rent_amount: 1000 } }).data.row;
  if (box.readTable('Tenants')[0].status !== 'Active') return 'a housed tenant is not Active';
  c('update', { table: 'Leases', id: l.id, data: { status: 'Terminated' } });
  if (box.readTable('Tenants')[0].status !== 'Past') {
    return 'still ' + box.readTable('Tenants')[0].status + ' after their only lease ended';
  }
  return c('stats', {}).data.tenants === 0 ? null : 'the dashboard still counts them';
});

probe('a prospect with no lease is left alone', () => {
  const { box, admin } = bootedSandbox();
  const c = (a, p) => box.handle(a, p, admin);
  c('create', { table: 'Tenants', data: { full_name: 'Maybe', phone: '9111111111', status: 'Prospect' } });
  c('bootstrap', {});
  const status = box.readTable('Tenants')[0].status;
  return status === 'Prospect' ? null : 'a prospect was changed to ' + status;
});

probe('signing a new lease makes a past tenant Active again', () => {
  const { box, admin } = bootedSandbox();
  const c = (a, p) => box.handle(a, p, admin);
  const Y = Number(box.today().slice(0, 4));
  const prop = c('create', { table: 'Properties', data: { name: 'P' } }).data.row;
  const unit = c('create', { table: 'Units', data: { property_id: prop.id, unit_number: 'A' } }).data.row;
  const t = c('create', { table: 'Tenants', data: { full_name: 'T', phone: '9111111111' } }).data.row;
  const l = c('create', { table: 'Leases', data: { property_id: prop.id, unit_id: unit.id,
    tenant_id: t.id, start_date: (Y - 2) + '-01-01', end_date: (Y - 1) + '-12-31',
    rent_amount: 1000 } }).data.row;
  if (box.readTable('Tenants')[0].status !== 'Past') return 'an expired lease did not make them Past';
  c('create', { table: 'Leases', data: { property_id: prop.id, unit_id: unit.id, tenant_id: t.id,
    start_date: (Y - 1) + '-01-01', end_date: (Y + 1) + '-12-31', rent_amount: 1200 } });
  return box.readTable('Tenants')[0].status === 'Active'
    ? null : 'a re-signed tenant is still ' + box.readTable('Tenants')[0].status;
});

console.log('\n— part periods are billed pro rata —');
probe('a lease ending mid-period is charged only for the days it covers', () => {
  const box = makeSandbox();
  const periods = box.periodsFor({ start_date: '2026-01-01', end_date: '2026-03-10',
    rent_amount: 30000, frequency: 'Monthly', grace_days: 0 }, '2026-06-01');
  if (periods.length !== 3) return periods.length + ' periods, expected 3';
  if (periods[0].amount !== 30000 || periods[1].amount !== 30000) return 'full months were altered';
  const last = periods[2];
  const want = Math.round(30000 * (10 / 31) * 100) / 100;
  if (Math.abs(last.amount - want) > 0.01) return `part month billed ${last.amount}, expected ${want}`;
  return last.prorated ? null : 'the part period is not flagged as pro rata';
});

probe('a mid-month start bills whole periods, then a part period at the end', () => {
  const box = makeSandbox();
  const periods = box.periodsFor({ start_date: '2026-01-15', end_date: '2026-04-30',
    rent_amount: 30000, frequency: 'Monthly', grace_days: 0 }, '2026-06-01');
  const full = periods.filter(p => !p.prorated);
  const part = periods.filter(p => p.prorated);
  if (full.length !== 3) return full.length + ' full periods, expected 3';
  if (part.length !== 1) return part.length + ' part periods, expected 1';
  return full.every(p => p.amount === 30000) ? null : 'a full period was pro-rated';
});

probe('an open-ended lease is never pro-rated', () => {
  const box = makeSandbox();
  const periods = box.periodsFor({ start_date: '2026-01-01', end_date: '',
    rent_amount: 30000, frequency: 'Monthly', grace_days: 0 }, '2026-04-15');
  return periods.some(p => p.prorated) ? 'a period was pro-rated with no end date' : null;
});

probe('a quarterly lease pro-rates against the whole quarter', () => {
  const box = makeSandbox();
  const periods = box.periodsFor({ start_date: '2026-01-01', end_date: '2026-02-15',
    rent_amount: 10000, frequency: 'Quarterly', grace_days: 0 }, '2026-06-01');
  const p = periods[0];
  if (!p.prorated) return 'not flagged';
  const want = Math.round(30000 * (p.days / p.fullDays) * 100) / 100;
  return Math.abs(p.amount - want) > 0.01 ? `billed ${p.amount}, expected ${want}` : null;
});

console.log('\n— settings that are configured are actually used —');
probe('invoice_prefix drives new invoice numbers', () => {
  const { box, admin } = bootedSandbox();
  const c = (a, p) => box.handle(a, p, admin);
  c('update', { table: 'Settings', id: 'invoice_prefix', data: { value: 'BILL' } });
  const t = c('create', { table: 'Tenants', data: { full_name: 'T', phone: '9111111111' } }).data.row;
  const inv = c('saveInvoice', { data: { tenant_id: t.id, due_date: '2030-01-01' },
    items: [{ description: 'Rent', category: 'Rent', quantity: 1, unit_amount: 100 }] }).data.invoice;
  return /^BILL-/.test(inv.id) ? null : 'invoice numbered ' + inv.id;
});

probe('a late fee on the lease is charged once when an invoice goes overdue', () => {
  const { box, admin } = bootedSandbox();
  const c = (a, p) => box.handle(a, p, admin);
  const Y = Number(box.today().slice(0, 4));
  const prop = c('create', { table: 'Properties', data: { name: 'P' } }).data.row;
  const unit = c('create', { table: 'Units', data: { property_id: prop.id, unit_number: 'A' } }).data.row;
  const t = c('create', { table: 'Tenants', data: { full_name: 'T', phone: '9111111111' } }).data.row;
  c('create', { table: 'Leases', data: { property_id: prop.id, unit_id: unit.id, tenant_id: t.id,
    start_date: (Y - 1) + '-01-01', end_date: (Y + 1) + '-12-31',
    rent_amount: 10000, grace_days: 0, late_fee: 500 } });
  c('generateInvoices', { upto: box.today() });
  c('bootstrap', {});                                   // housekeeping applies the fees

  const overdue = box.readTable('Invoices').filter(i => i.status === 'Overdue');
  if (!overdue.length) return 'no overdue invoices to test with';
  const fees = box.readTable('InvoiceItems').filter(i => i.category === 'Late Fee');
  if (fees.length !== overdue.length) return `${overdue.length} overdue but ${fees.length} fees`;
  if (fees.some(f => Number(f.amount) !== 500)) return 'the fee amount is wrong';

  const inv = box.readTable('Invoices').find(i => i.id === overdue[0].id);
  if (Number(inv.total) !== 10500) return 'the fee did not reach the invoice total: ' + inv.total;

  // running housekeeping again must not stack a second fee
  c('bootstrap', {});
  const again = box.readTable('InvoiceItems').filter(i => i.category === 'Late Fee').length;
  return again === fees.length ? null : `fees grew from ${fees.length} to ${again} on a second run`;
});

probe('no late fee is charged when the lease has none', () => {
  const { box, admin } = bootedSandbox();
  const c = (a, p) => box.handle(a, p, admin);
  const Y = Number(box.today().slice(0, 4));
  const prop = c('create', { table: 'Properties', data: { name: 'P' } }).data.row;
  const unit = c('create', { table: 'Units', data: { property_id: prop.id, unit_number: 'A' } }).data.row;
  const t = c('create', { table: 'Tenants', data: { full_name: 'T', phone: '9111111111' } }).data.row;
  c('create', { table: 'Leases', data: { property_id: prop.id, unit_id: unit.id, tenant_id: t.id,
    start_date: (Y - 1) + '-01-01', end_date: (Y + 1) + '-12-31', rent_amount: 10000, grace_days: 0 } });
  c('generateInvoices', { upto: box.today() });
  c('bootstrap', {});
  return box.readTable('InvoiceItems').filter(i => i.category === 'Late Fee').length
    ? 'a fee was charged with no late_fee set' : null;
});

console.log('\n— paying more than one invoice at once —');
probe('an advance payment is spread over the tenant\'s outstanding invoices', () => {
  const { box, admin } = bootedSandbox();
  const c = (a, p) => box.handle(a, p, admin);
  const t = c('create', { table: 'Tenants', data: { full_name: 'T', phone: '9111111111' } }).data.row;
  const mk = due => c('saveInvoice', { data: { tenant_id: t.id, due_date: due },
    items: [{ description: 'Rent', category: 'Rent', quantity: 1, unit_amount: 10000 }] }).data.invoice;
  const jan = mk('2030-01-01'), feb = mk('2030-02-01'), mar = mk('2030-03-01');

  const r = c('recordPayment', { invoice_id: jan.id, amount: 25000, method: 'Bank Transfer' });
  if (!r.ok) return 'a two-and-a-half month payment was refused: ' + r.error;

  const after = id => box.readTable('Invoices').find(i => i.id === id);
  const problems = [];
  if (after(jan.id).status !== 'Paid') problems.push('january ' + after(jan.id).status);
  if (after(feb.id).status !== 'Paid') problems.push('february ' + after(feb.id).status);
  if (Number(after(mar.id).amount_paid) !== 5000) problems.push('march paid ' + after(mar.id).amount_paid);
  if (box.readTable('Invoices').some(i => Number(i.balance) < 0)) problems.push('a balance went negative');
  if (box.readTable('Payments').length !== 3) problems.push(box.readTable('Payments').length + ' payment rows');
  return problems.length ? problems.join('; ') : null;
});

probe('paying more than the tenant owes in total is still refused', () => {
  const { box, admin } = bootedSandbox();
  const c = (a, p) => box.handle(a, p, admin);
  const t = c('create', { table: 'Tenants', data: { full_name: 'T', phone: '9111111111' } }).data.row;
  const inv = c('saveInvoice', { data: { tenant_id: t.id, due_date: '2030-01-01' },
    items: [{ description: 'Rent', category: 'Rent', quantity: 1, unit_amount: 10000 }] }).data.invoice;
  const r = c('recordPayment', { invoice_id: inv.id, amount: 15000 });
  if (r.ok) return 'accepted 15000 against a single 10000 invoice with nothing else owing';
  return Number(box.readTable('Invoices')[0].balance) === 10000 ? null : 'the invoice was altered anyway';
});

console.log('\n— a deposit is only "held" once it is received —');

function leaseWithDeposit(amount) {
  const { box, admin } = bootedSandbox();
  const c = (a, p) => box.handle(a, p, admin);
  const Y = Number(box.today().slice(0, 4));
  const prop = c('create', { table: 'Properties', data: { name: 'P' } }).data.row;
  const unit = c('create', { table: 'Units', data: { property_id: prop.id, unit_number: 'A' } }).data.row;
  const t = c('create', { table: 'Tenants', data: { full_name: 'Anita', phone: '9111111111' } }).data.row;
  const lease = c('create', { table: 'Leases', data: {
    property_id: prop.id, unit_id: unit.id, tenant_id: t.id,
    start_date: (Y - 1) + '-01-01', end_date: (Y + 1) + '-12-31',
    rent_amount: 28000, deposit_amount: amount } }).data.row;
  return { box, c, prop, unit, tenant: t, lease };
}

probe('signing a lease raises an invoice for the deposit', () => {
  const { box, lease } = leaseWithDeposit(150000);
  const dep = box.readTable('Invoices').filter(i => i.type === 'Deposit');
  if (dep.length !== 1) return dep.length + ' deposit invoices, expected 1';
  if (Number(dep[0].total) !== 150000) return 'invoiced ' + dep[0].total;
  if (dep[0].lease_id !== lease.id) return 'not linked to the lease';
  const items = box.readTable('InvoiceItems').filter(i => i.invoice_id === dep[0].id);
  return items.length === 1 ? null : 'the deposit invoice has no line item';
});

probe('an unreceived deposit is not counted as held, but is counted as owed', () => {
  const { c, box } = leaseWithDeposit(150000);
  if (box.readTable('Leases')[0].deposit_status !== 'Pending') return 'lease is not Pending';
  const s = c('stats', {}).data;
  if (s.deposits_held !== 0) return 'deposits held shows ' + s.deposits_held + ' before receipt';
  return s.outstanding >= 150000 ? null : 'the deposit is not in outstanding: ' + s.outstanding;
});

probe('paying the deposit invoice marks it held', () => {
  const { c, box } = leaseWithDeposit(150000);
  const dep = box.readTable('Invoices').find(i => i.type === 'Deposit');
  c('recordPayment', { invoice_id: dep.id, amount: 150000, method: 'Bank Transfer' });
  if (box.readTable('Leases')[0].deposit_status !== 'Held') {
    return 'lease still ' + box.readTable('Leases')[0].deposit_status;
  }
  return c('stats', {}).data.deposits_held === 150000 ? null : 'not counted as held';
});

probe('a part-paid deposit is not yet held', () => {
  const { c, box } = leaseWithDeposit(150000);
  const dep = box.readTable('Invoices').find(i => i.type === 'Deposit');
  c('recordPayment', { invoice_id: dep.id, amount: 50000, method: 'Cash' });
  return box.readTable('Leases')[0].deposit_status === 'Pending'
    ? null : 'a part payment marked the deposit held';
});

probe('deleting the deposit payment puts it back to pending', () => {
  const { c, box } = leaseWithDeposit(150000);
  const dep = box.readTable('Invoices').find(i => i.type === 'Deposit');
  c('recordPayment', { invoice_id: dep.id, amount: 150000, method: 'Cash' });
  const pay = box.readTable('Payments').find(p => p.invoice_id === dep.id);
  c('remove', { table: 'Payments', id: pay.id });
  if (box.readTable('Leases')[0].deposit_status !== 'Pending') return 'still Held after reversal';
  return c('stats', {}).data.deposits_held === 0 ? null : 'still counted as held';
});

probe('re-saving a lease never bills the deposit twice', () => {
  const { c, box, lease } = leaseWithDeposit(150000);
  c('update', { table: 'Leases', id: lease.id, data: { notes: 'touched' } });
  c('update', { table: 'Leases', id: lease.id, data: { notes: 'touched again' } });
  const dep = box.readTable('Invoices').filter(i => i.type === 'Deposit');
  return dep.length === 1 ? null : dep.length + ' deposit invoices after re-saving';
});

probe('a lease with no deposit raises no invoice', () => {
  const { box } = leaseWithDeposit(0);
  return box.readTable('Invoices').filter(i => i.type === 'Deposit').length
    ? 'an invoice was raised for a zero deposit' : null;
});

console.log('\n— a repair cost is counted exactly once —');
probe('a completed ticket books its cost as an expense', () => {
  const { box, admin } = bootedSandbox();
  const c = (a, p) => box.handle(a, p, admin);
  const prop = c('create', { table: 'Properties', data: { name: 'P' } }).data.row;
  const m = c('create', { table: 'Maintenance', data: { property_id: prop.id, title: 'Tap',
    category: 'Plumbing', vendor_name: 'AquaCare', reported_date: '2026-09-01' } }).data.row;

  if (box.readTable('Expenses').length) return 'an open ticket already booked an expense';
  c('update', { table: 'Maintenance', id: m.id, data: { cost: 5000 } });
  if (box.readTable('Expenses').length) return 'a cost on an open ticket booked an expense';

  c('update', { table: 'Maintenance', id: m.id, data: { status: 'Resolved' } });
  const exp = box.readTable('Expenses');
  if (exp.length !== 1) return exp.length + ' expenses after resolving, expected 1';
  if (Number(exp[0].amount) !== 5000) return 'booked ' + exp[0].amount;
  if (exp[0].reference !== m.id) return 'the expense is not linked back to the ticket';
  if (exp[0].property_id !== prop.id) return 'not attributed to the property';
  return null;
});

probe('correcting the cost updates the expense rather than adding one', () => {
  const { box, admin } = bootedSandbox();
  const c = (a, p) => box.handle(a, p, admin);
  const prop = c('create', { table: 'Properties', data: { name: 'P' } }).data.row;
  const m = c('create', { table: 'Maintenance', data: { property_id: prop.id, title: 'Tap',
    status: 'Resolved', cost: 5000 } }).data.row;
  c('update', { table: 'Maintenance', id: m.id, data: { cost: 6500 } });
  const exp = box.readTable('Expenses');
  if (exp.length !== 1) return exp.length + ' expenses after a correction';
  return Number(exp[0].amount) === 6500 ? null : 'expense still shows ' + exp[0].amount;
});

probe('reopening or deleting a ticket withdraws its expense', () => {
  const { box, admin } = bootedSandbox();
  const c = (a, p) => box.handle(a, p, admin);
  const prop = c('create', { table: 'Properties', data: { name: 'P' } }).data.row;
  const m = c('create', { table: 'Maintenance', data: { property_id: prop.id, title: 'Tap',
    status: 'Resolved', cost: 5000 } }).data.row;
  c('update', { table: 'Maintenance', id: m.id, data: { status: 'In Progress' } });
  if (box.readTable('Expenses').length) return 'a reopened ticket kept its expense';
  c('update', { table: 'Maintenance', id: m.id, data: { status: 'Closed' } });
  if (box.readTable('Expenses').length !== 1) return 'closing again did not rebook it';
  c('remove', { table: 'Maintenance', id: m.id });
  return box.readTable('Expenses').length ? 'deleting the ticket orphaned its expense' : null;
});

probe('a ticket cost is never counted twice in the reports', () => {
  const { box, admin } = bootedSandbox();
  const c = (a, p) => box.handle(a, p, admin);
  const prop = c('create', { table: 'Properties', data: { name: 'P' } }).data.row;
  c('create', { table: 'Maintenance', data: { property_id: prop.id, title: 'Tap',
    status: 'Resolved', completed_date: box.today(), cost: 5000 } });
  // the app's own figure for this month must be the cost once, not twice
  const spend = c('stats', {}).data.expenses_this_month;
  return spend === 5000 ? null : 'expenses_this_month is ' + spend + ', expected 5000';
});

console.log('\n— refunding a deposit is money out —');
probe('marking a deposit refunded records the expense, once', () => {
  const { box, admin } = bootedSandbox();
  const c = (a, p) => box.handle(a, p, admin);
  const Y = Number(box.today().slice(0, 4));
  const prop = c('create', { table: 'Properties', data: { name: 'P' } }).data.row;
  const unit = c('create', { table: 'Units', data: { property_id: prop.id, unit_number: 'A' } }).data.row;
  const t = c('create', { table: 'Tenants', data: { full_name: 'Anita', phone: '9111111111' } }).data.row;
  const l = c('create', { table: 'Leases', data: { property_id: prop.id, unit_id: unit.id,
    tenant_id: t.id, start_date: (Y - 1) + '-01-01', end_date: (Y + 1) + '-12-31',
    rent_amount: 1000, deposit_amount: 50000, deposit_status: 'Held' } }).data.row;

  if (c('stats', {}).data.deposits_held !== 50000) return 'the deposit was not counted as held';
  c('update', { table: 'Leases', id: l.id, data: { deposit_status: 'Refunded' } });

  const expenses = box.readTable('Expenses').filter(e => e.category === 'Deposit Refund');
  if (expenses.length !== 1) return expenses.length + ' refund expenses, expected 1';
  if (Number(expenses[0].amount) !== 50000) return 'refund recorded as ' + expenses[0].amount;
  if (expenses[0].property_id !== prop.id) return 'the refund is not attributed to the property';
  if (c('stats', {}).data.deposits_held !== 0) return 'the liability was not released';

  c('update', { table: 'Leases', id: l.id, data: { deposit_status: 'Refunded', notes: 'again' } });
  const again = box.readTable('Expenses').filter(e => e.category === 'Deposit Refund').length;
  return again === 1 ? null : 'saving the lease again wrote a duplicate refund';
});

console.log('\n— invoice line items —');
probe('one invoice carries several kinds of charge, summed correctly', () => {
  const { box, admin } = bootedSandbox();
  const t = box.handle('create', { table: 'Tenants', data: { full_name: 'T', phone: '9111111111' } }, admin).data.row;
  const r = box.handle('saveInvoice', {
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

probe('a single-category invoice is labelled with that category', () => {
  const { box, admin } = bootedSandbox();
  const t = box.handle('create', { table: 'Tenants', data: { full_name: 'T', phone: '9111111111' } }, admin).data.row;
  const r = box.handle('saveInvoice', {
    data: { tenant_id: t.id, due_date: '2030-01-10' },
    items: [{ description: 'EB bill', category: 'Electricity', quantity: 100, unit_amount: 9 }]
  }, admin);
  return r.data.invoice.type === 'Electricity' ? null : 'type is ' + r.data.invoice.type;
});

probe('editing the lines re-prices the invoice and leaves no orphan rows', () => {
  const { box, admin } = bootedSandbox();
  const t = box.handle('create', { table: 'Tenants', data: { full_name: 'T', phone: '9111111111' } }, admin).data.row;
  const first = box.handle('saveInvoice', {
    data: { tenant_id: t.id, due_date: '2030-01-10' },
    items: [{ description: 'Rent', category: 'Rent', quantity: 1, unit_amount: 28000 },
            { description: 'Water', category: 'Water', quantity: 1, unit_amount: 600 }]
  }, admin).data;

  const second = box.handle('saveInvoice', {
    id: first.invoice.id,
    data: { tenant_id: t.id, due_date: '2030-01-10' },
    items: [{ id: first.items[0].id, description: 'Rent', category: 'Rent', quantity: 1, unit_amount: 30000 },
            { description: 'Parking', category: 'Parking', quantity: 2, unit_amount: 500 }]
  }, admin).data;

  const problems = [];
  if (Number(second.invoice.amount) !== 31000) problems.push('amount is ' + second.invoice.amount + ', expected 31000');
  const stored = box.readTable('InvoiceItems').filter(i => i.invoice_id === first.invoice.id);
  if (stored.length !== 2) problems.push(stored.length + ' rows stored, expected 2 (water should be gone)');
  if (stored.some(i => i.category === 'Water')) problems.push('the removed line is still in the sheet');
  return problems.length ? problems.join('; ') : null;
});

probe('payments survive an edit to the lines', () => {
  const { box, admin } = bootedSandbox();
  const t = box.handle('create', { table: 'Tenants', data: { full_name: 'T', phone: '9111111111' } }, admin).data.row;
  const made = box.handle('saveInvoice', {
    data: { tenant_id: t.id, due_date: '2030-01-10' },
    items: [{ description: 'Rent', category: 'Rent', quantity: 1, unit_amount: 10000 }]
  }, admin).data;
  box.handle('recordPayment', { invoice_id: made.invoice.id, amount: 4000, method: 'UPI' }, admin);
  const after = box.handle('saveInvoice', {
    id: made.invoice.id,
    data: { tenant_id: t.id, due_date: '2030-01-10' },
    items: [{ id: made.items[0].id, description: 'Rent', category: 'Rent', quantity: 1, unit_amount: 10000 },
            { description: 'EB bill', category: 'Electricity', quantity: 1, unit_amount: 2000 }]
  }, admin).data.invoice;
  if (Number(after.amount_paid) !== 4000) return 'payment lost: amount_paid is ' + after.amount_paid;
  if (Number(after.balance) !== 8000) return 'balance is ' + after.balance + ', expected 8000';
  if (after.status !== 'Partial') return 'status is ' + after.status;
  return null;
});

probe('tax is added on top of the line total', () => {
  const { box, admin } = bootedSandbox();
  const t = box.handle('create', { table: 'Tenants', data: { full_name: 'T', phone: '9111111111' } }, admin).data.row;
  const inv = box.handle('saveInvoice', {
    data: { tenant_id: t.id, due_date: '2030-01-10', tax: 180 },
    items: [{ description: 'Internet', category: 'Internet', quantity: 1, unit_amount: 1000 }]
  }, admin).data.invoice;
  return Number(inv.total) === 1180 && Number(inv.amount) === 1000
    ? null : `amount ${inv.amount} / tax ${inv.tax} / total ${inv.total}`;
});

probe('deleting an invoice deletes its lines', () => {
  const { box, admin } = bootedSandbox();
  const t = box.handle('create', { table: 'Tenants', data: { full_name: 'T', phone: '9111111111' } }, admin).data.row;
  const inv = box.handle('saveInvoice', {
    data: { tenant_id: t.id, due_date: '2030-01-10' },
    items: [{ description: 'Rent', category: 'Rent', quantity: 1, unit_amount: 1 },
            { description: 'Water', category: 'Water', quantity: 1, unit_amount: 1 }]
  }, admin).data.invoice;
  box.handle('remove', { table: 'Invoices', id: inv.id }, admin);
  const left = box.readTable('InvoiceItems').filter(i => i.invoice_id === inv.id).length;
  return left ? left + ' orphan line item(s) left behind' : null;
});

probe('an invoice with no lines is refused', () => {
  const { box, admin } = bootedSandbox();
  const r = box.handle('saveInvoice', { data: { due_date: '2030-01-10' }, items: [] }, admin);
  return r.ok ? 'an empty invoice was accepted' : null;
});

probe('a line with no description is refused', () => {
  const { box, admin } = bootedSandbox();
  const r = box.handle('saveInvoice', {
    data: { due_date: '2030-01-10' },
    items: [{ description: '  ', category: 'Rent', quantity: 1, unit_amount: 100 }]
  }, admin);
  return r.ok ? 'a nameless line was accepted' : null;
});

probe('generated rent invoices also get a line item', () => {
  const { box, admin } = bootedSandbox();
  const t = box.handle('create', { table: 'Tenants', data: { full_name: 'T', phone: '9111111111' } }, admin).data.row;
  const p = box.handle('create', { table: 'Properties', data: { name: 'P' } }, admin).data.row;
  const u = box.handle('create', { table: 'Units', data: { property_id: p.id, unit_number: 'A' } }, admin).data.row;
  // dates must straddle today, or the lease is correctly Expired and bills nothing
  const year = Number(box.today().slice(0, 4));
  box.handle('create', { table: 'Leases', data: {
    property_id: p.id, unit_id: u.id, tenant_id: t.id,
    start_date: (year - 1) + '-01-01', end_date: (year + 1) + '-12-31',
    rent_amount: 5000, frequency: 'Monthly' } }, admin);
  const r = box.handle('generateInvoices', { upto: box.today() }, admin);
  if (!r.data.created) return 'no invoices generated';
  const items = box.readTable('InvoiceItems');
  if (items.length !== r.data.created) {
    return `${r.data.created} invoices but ${items.length} line items`;
  }
  return items.every(i => i.category === 'Rent') ? null : 'a generated line is not categorised as Rent';
});

console.log('\n— privilege boundaries —');
probe('a manager cannot change organisation settings', () => {
  const { b, admin } = boot();
  b.handle('createUser', { name: 'M', phone: '9000000004', role: 'manager', password: 'manager-pass-1234' }, admin);
  const mgr = b.handle('login', { phone: '9000000004', password: 'manager-pass-1234' }, '').data.token;
  const r = b.handle('update', { table: 'Settings', id: 'session_hours', data: { value: '9999' } }, mgr);
  return r.ok ? 'a manager rewrote session_hours (UI says admin-only)' : null;
});

probe('the last administrator cannot be deleted', () => {
  const { b, admin } = boot();
  const me = b.readTable('Users')[0];
  const r = b.handle('remove', { table: 'Users', id: me.id }, admin);
  return r.ok ? 'the only admin deleted themselves — nobody can sign in now' : null;
});

console.log('\n— unauthenticated GET surface —');
probe('doGet does not reflect a caller-supplied JSONP callback', () => {
  if (!/params\.callback/.test(src)) return null;
  const hasSanitiser = /callback[\s\S]{0,200}(replace|test|match)\(/.test(
    src.slice(src.indexOf('function doGet'), src.indexOf('function doPost')));
  return hasSanitiser ? null
    : 'doGet echoes params.callback into a JAVASCRIPT response unsanitised (JSONP injection)';
});

probe('doGet does not accept a session token in the query string', () => {
  const doGet = src.slice(src.indexOf('function doGet'), src.indexOf('function doPost'));
  return /params\.token/.test(doGet)
    ? 'doGet takes a token from the URL — tokens leak into browser history, logs and Referer'
    : null;
});

console.log('\n— write amplification (Apps Script has a 6-minute limit) —');
probe('generating many invoices does not re-read the sheet per row', () => {
  const { b, admin } = boot();
  let reads = 0;
  const realRead = b.readTable;
  b.readTable = function (n) { reads++; return realRead.apply(this, arguments); };
  const t = b.handle('create', { table: 'Tenants', data: { full_name: 'T', phone: '9111111111' } }, admin).data.row;
  const p = b.handle('create', { table: 'Properties', data: { name: 'P' } }, admin).data.row;
  const u = b.handle('create', { table: 'Units', data: { property_id: p.id, unit_number: 'A' } }, admin).data.row;
  b.handle('create', { table: 'Leases', data: {
    property_id: p.id, unit_id: u.id, tenant_id: t.id, start_date: '2024-01-01',
    end_date: '2026-12-31', rent_amount: 1000, frequency: 'Monthly', status: 'Active' } }, admin);
  reads = 0;
  const r = b.handle('generateInvoices', { upto: '2026-09-08' }, admin);
  const created = r.data.created;
  b.readTable = realRead;
  return reads > created * 2
    ? `${created} invoices caused ${reads} full table reads (~${(reads / created).toFixed(1)} per invoice)`
    : null;
});

console.log('\n— CSV export —');
probe('CSV export neutralises spreadsheet formulas but keeps money readable', () => {
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

console.log('\n— connecting to a sheet that already has data —');
probe('setup never deletes rows, columns or unrelated tabs', () => {
  const box = makeSandbox();
  const tabs = box.__tabs;
  tabs.set('Properties', {
    headers: ['id', 'name', 'city', 'my_own_column'],
    rows: [['PRP-00001', 'Sunrise', 'Bengaluru', 'keep me'],
           ['PRP-00002', 'Palm Court', 'Chennai', 'keep me too']]
  });
  tabs.set('My Notes', { headers: ['note'], rows: [['do not touch this']] });

  box.handle('setup', { adminPhone: '9000000001', adminPassword: 'correct-horse-battery' }, '');
  const admin = box.handle('login', { phone: '9000000001', password: 'correct-horse-battery' }, '').data.token;
  const snapshot = () => JSON.stringify([tabs.get('Properties'), tabs.get('My Notes')]);

  const problems = [];
  const props = tabs.get('Properties');
  if (props.rows.length !== 2) problems.push('rows went 2 -> ' + props.rows.length);
  if (props.headers.slice(0, 4).join() !== 'id,name,city,my_own_column') {
    problems.push('existing columns were reordered or replaced: ' + props.headers.slice(0, 4).join());
  }
  if (props.rows.map(r => r[3]).join('|') !== 'keep me|keep me too') {
    problems.push('a hand-added column lost its values');
  }
  if (!props.headers.includes('status')) problems.push('missing schema columns were not added');
  if (JSON.stringify(tabs.get('My Notes').rows) !== '[["do not touch this"]]') {
    problems.push('an unrelated tab was modified');
  }

  // repeated connections must be inert
  const stable = snapshot();
  for (let i = 0; i < 5; i++) box.handle('setup', {}, '');
  box.handle('setup', {}, admin);
  box.handle('setup', {}, admin);
  if (snapshot() !== stable) problems.push('re-running setup changed existing data');

  return problems.length ? problems.join('; ') : null;
});

probe('Code.gs contains no bulk-destructive spreadsheet calls', () => {
  const banned = ['clearContents', 'clearFormats', '.clear(', 'deleteSheet',
                  'deleteColumns(', 'removeSheet'];
  const hits = banned.filter(b => src.includes(b));
  if (hits.length) return 'found: ' + hits.join(', ');

  // deleteRows is allowed in exactly one place: trimming the audit trail.
  const uses = [...src.matchAll(/deleteRows\s*\(/g)].length;
  if (uses === 0) return null;
  const prune = src.slice(src.indexOf('function pruneActivityLog'),
                          src.indexOf('function pruneActivityLog') + 600);
  if (uses > 1) return `deleteRows used ${uses} times — only log pruning may use it`;
  if (!/sheetFor\('ActivityLog'\)/.test(prune) || !/deleteRows/.test(prune)) {
    return 'deleteRows is used outside pruneActivityLog';
  }
  return null;
});

probe('pruning the audit trail never touches a data tab', () => {
  const { box, admin } = bootedSandbox();
  const c = (a, p) => box.handle(a, p, admin);
  const t = c('create', { table: 'Tenants', data: { full_name: 'Keep me', phone: '9111111111' } }).data.row;

  // push the log well past its ceiling
  const log = box.__tabs.get('ActivityLog');
  for (let i = 0; i < 6000; i++) log.rows.push(['LOG-' + i, '2020-01-01T00:00:00', 'x', 'noise', 'X', '', '']);
  const before = log.rows.length;
  c('refreshStatuses', {});
  const after = box.__tabs.get('ActivityLog').rows.length;

  if (after >= before) return `log not pruned (${before} -> ${after})`;
  if (after > 5200) return 'log still oversized: ' + after;
  if (!box.readTable('Tenants').some(x => x.id === t.id)) return 'a tenant row was destroyed';
  // the newest entries are the ones that must survive
  const ids = box.__tabs.get('ActivityLog').rows.map(r => r[0]);
  return ids.includes('LOG-5999') ? null : 'pruning removed the most recent entries';
});

console.log('\n— break-glass recovery —');
probe('recovers an account migrated from email sign-in (no phone yet)', () => {
  const box = makeSandbox();
  box.handle('setup', { adminPhone: '9880011111', adminPassword: 'correct-horse-battery' }, '');
  // reproduce the migrated state: the account exists but its phone cell is empty
  const tab = box.__tabs.get('Users');
  tab.rows[0][tab.headers.indexOf('phone')] = '';
  if (box.handle('login', { phone: '9880011111', password: 'correct-horse-battery' }, '').ok) {
    return 'test set-up failed — login should be broken here';
  }
  box.recoverAccess('+91 98800 11111', 'brand-new-pass-1', 'Administrator');
  const after = box.handle('login', { phone: '9880011111', password: 'brand-new-pass-1' }, '');
  if (!after.ok) return 'still locked out: ' + after.error;
  if (after.data.user.role !== 'admin') return 'recovered as ' + after.data.user.role;
  return box.readTable('Users').length === 1 ? null
       : 'recovery created a duplicate account instead of adopting the existing one';
});

probe('recovery adds the phone column when the sheet predates it', () => {
  const box = makeSandbox();
  box.handle('setup', { adminPhone: '9880011111', adminPassword: 'correct-horse-battery' }, '');
  const tab = box.__tabs.get('Users');
  const i = tab.headers.indexOf('phone');
  tab.headers.splice(i, 1);                       // column never existed
  tab.rows.forEach(r => r.splice(i, 1));
  box.recoverAccess('9880011111', 'brand-new-pass-1', 'Administrator');
  if (!box.__tabs.get('Users').headers.includes('phone')) return 'phone column was not added';
  return box.handle('login', { phone: '9880011111', password: 'brand-new-pass-1' }, '').ok
    ? null : 'cannot sign in after recovery';
});

probe('recovery clears an existing sign-in lockout', () => {
  const box = makeSandbox();
  box.handle('setup', { adminPhone: '9880011111', adminPassword: 'correct-horse-battery' }, '');
  for (let i = 0; i < 6; i++) box.handle('login', { phone: '9880011111', password: 'x' }, '');
  if (!/Too many/.test(box.handle('login', { phone: '9880011111', password: 'correct-horse-battery' }, '').error || '')) {
    return 'test set-up failed — should be locked out here';
  }
  box.recoverAccess('9880011111', 'brand-new-pass-1', 'Administrator');
  const r = box.handle('login', { phone: '9880011111', password: 'brand-new-pass-1' }, '');
  return r.ok ? null : 'still throttled after recovery: ' + r.error;
});

probe('recovery creates an administrator when the Users tab is empty', () => {
  const box = makeSandbox();
  box.ensureSchema();
  box.recoverAccess('9880011111', 'brand-new-pass-1', 'Owner');
  const r = box.handle('login', { phone: '9880011111', password: 'brand-new-pass-1' }, '');
  return r.ok && r.data.user.role === 'admin' ? null : 'could not sign in: ' + JSON.stringify(r);
});

probe('recovery is not reachable from the public endpoint', () => {
  const box = makeSandbox();
  box.handle('setup', { adminPhone: '9880011111', adminPassword: 'correct-horse-battery' }, '');
  const r = box.handle('recoverAccess', { phone: '9999999999', password: 'take-over-12345' }, '');
  return r.ok ? 'recoverAccess is exposed as a web action — anyone could seize the workspace' : null;
});

console.log('\n— the script is structurally whole —');
probe('every routed action resolves to a function that exists', () => {
  const box = makeSandbox();
  const router = src.slice(src.indexOf('function handle('), src.indexOf('function ok(data)'));
  // the optional object key must include its colon, or the greedy name group
  // swallows the first half of the function name (recordPayment -> Payment)
  const actions = [...router.matchAll(
    /case '([a-zA-Z]+)':\s*(?:requireRole\([^)]*\);\s*)?return ok\(\{?\s*(?:[a-z_]+:\s*)?([a-zA-Z_]+)\s*\(/g)];
  if (actions.length < 15) return 'only parsed ' + actions.length + ' actions — the router shape changed';
  const missing = actions
    .map(m => m[2])
    .filter(fn => !['ok', 'readTable', 'readTableForClient'].includes(fn))
    .filter(fn => typeof box[fn] !== 'function');
  return missing.length ? 'router calls undefined function(s): ' + [...new Set(missing)].join(', ') : null;
});

probe('every function the script calls is defined somewhere in it', () => {
  const box = makeSandbox();
  // the helpers the rest of the file leans on — losing one to a bad edit is
  // silent until the exact path that uses it runs
  const required = ['saveInvoice', 'itemsOfInvoice', 'applyInvoiceTotals', 'periodsFor',
                    'generateInvoices', 'recordPayment', 'refreshStatuses', 'applyLateFees',
                    'recordDepositRefund', 'inferProperty', 'assertNoDependents',
                    'assertUnitIsFree', 'deriveLeaseStatus', 'ensureSchema', 'recoverAccess',
                    'hashPassword', 'hashPasswordLegacy', 'passwordMatches', 'normalisePhone',
                    'assertPasswordAcceptable', 'pruneActivityLog', 'readTableForClient'];
  const missing = required.filter(fn => typeof box[fn] !== 'function');
  return missing.length ? 'missing: ' + missing.join(', ') : null;
});

console.log('\n— session lifecycle —');
probe('disabling a user ends their session immediately', () => {
  const { box, admin } = bootedSandbox();
  box.handle('createUser', { name: 'L', phone: '9000000009', role: 'manager', password: 'manager-pass-1234' }, admin);
  const theirs = box.handle('login', { phone: '9000000009', password: 'manager-pass-1234' }, '').data.token;
  const id = box.readTable('Users').filter(u => u.phone === '9000000009')[0].id;
  if (!box.handle('bootstrap', {}, theirs).ok) return 'they could not read before being disabled';
  box.handle('setUserActive', { id, active: false }, admin);
  return box.handle('bootstrap', {}, theirs).ok
    ? 'a disabled user kept full access on their existing session'
    : null;
});

probe('demoting a user takes effect on their open session', () => {
  const { box, admin } = bootedSandbox();
  box.handle('createUser', { name: 'D', phone: '9000000010', role: 'manager', password: 'manager-pass-1234' }, admin);
  const theirs = box.handle('login', { phone: '9000000010', password: 'manager-pass-1234' }, '').data.token;
  const id = box.readTable('Users').filter(u => u.phone === '9000000010')[0].id;
  box.handle('setUserRole', { id, role: 'viewer' }, admin);
  return box.handle('create', { table: 'Tenants', data: { full_name: 'X', phone: '9' } }, theirs).ok
    ? 'a demoted manager could still write'
    : null;
});

probe('an administrator can reset a forgotten password', () => {
  const { box, admin } = bootedSandbox();
  box.handle('createUser', { name: 'F', phone: '9000000011', role: 'manager', password: 'old-pass-12345' }, admin);
  const id = box.readTable('Users').filter(u => u.phone === '9000000011')[0].id;
  const r = box.handle('resetPassword', { id, password: 'newer-pass-1234' }, admin);
  if (!r.ok) return 'reset failed: ' + r.error;
  if (box.handle('login', { phone: '9000000011', password: 'old-pass-12345' }, '').ok) {
    return 'the old password still works';
  }
  const after = box.handle('login', { phone: '9000000011', password: 'newer-pass-1234' }, '');
  return after.ok ? null : 'the new password does not work: ' + after.error;
});

probe('a manager cannot reset anyone\'s password', () => {
  const { box, admin } = bootedSandbox();
  box.handle('createUser', { name: 'M', phone: '9000000012', role: 'manager', password: 'manager-pass-1234' }, admin);
  const mgr = box.handle('login', { phone: '9000000012', password: 'manager-pass-1234' }, '').data.token;
  const adminId = box.readTable('Users').filter(u => u.phone === '9000000001')[0].id;
  return box.handle('resetPassword', { id: adminId, password: 'takenover1' }, mgr).ok
    ? 'a manager reset the administrator password — full takeover'
    : null;
});

console.log('\n' + '─'.repeat(60));
if (issues.length) {
  console.log(`${issues.length} PRODUCTION ISSUE(S) FOUND`);
  process.exit(1);
}
console.log('ALL PRODUCTION CHECKS PASSED');
