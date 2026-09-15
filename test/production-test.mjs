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
  return /payment|void/i.test(del.error) ? null : 'unhelpful message: ' + del.error;
});

probe('an issued invoice is voided, never deleted — a draft can be deleted', () => {
  const { box, c, tenant } = portfolio();
  c('generateInvoices', { upto: box.today() });
  const issued = box.readTable('Invoices').find(i => i.type === 'Rent');
  const del = c('remove', { table: 'Invoices', id: issued.id });
  if (del.ok) return 'an issued invoice was deleted, leaving a gap in the numbering';
  if (!/void/i.test(del.error)) return 'the refusal does not point to voiding: ' + del.error;
  const draft = c('saveInvoice', { data: { tenant_id: tenant.id, due_date: '2030-01-01', status: 'Draft' },
    items: [{ description: 'Draft line', category: 'Other', quantity: 1, unit_amount: 10 }] }).data.invoice;
  const gone = c('remove', { table: 'Invoices', id: draft.id });
  if (!gone.ok) return 'a draft could not be deleted: ' + gone.error;
  return box.readTable('InvoiceItems').filter(i => i.invoice_id === draft.id).length ? 'line items orphaned' : null;
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
  // no deposit, so no invoice is raised to hold the lease in place
  const { box, c, tenant, lease } = portfolio({ deposit_amount: 0 });
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
    data: { tenant_id: t.id, due_date: '2030-01-10', status: 'Draft' },
    items: [{ description: 'Rent', category: 'Rent', quantity: 1, unit_amount: 1 },
            { description: 'Water', category: 'Water', quantity: 1, unit_amount: 1 }]
  }, admin).data.invoice;
  const del = box.handle('remove', { table: 'Invoices', id: inv.id }, admin);
  if (!del.ok) return 'the draft could not be deleted: ' + del.error;
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

console.log('\n— rent is billed once, however the invoice is edited —');

/** A running monthly lease that has three periods due, generated. */
function billedLease(leaseExtra = {}) {
  const { box, admin } = bootedSandbox();
  const c = (a, p, tok = admin) => box.handle(a, p, tok);
  const Y = Number(box.today().slice(0, 4));
  const prop = c('create', { table: 'Properties', data: { name: 'P' } }).data.row;
  const unit = c('create', { table: 'Units', data: { property_id: prop.id, unit_number: 'A' } }).data.row;
  const tenant = c('create', { table: 'Tenants', data: { full_name: 'T', phone: '9111111111' } }).data.row;
  const lease = c('create', { table: 'Leases', data: {
    property_id: prop.id, unit_id: unit.id, tenant_id: tenant.id,
    start_date: (Y - 1) + '-01-01', end_date: (Y + 1) + '-12-31',
    rent_amount: 10000, frequency: 'Monthly', grace_days: 5, ...leaseExtra } }).data.row;
  return { box, admin, c, prop, unit, tenant, lease };
}

const editLines = (box, inv, extra = []) => ({
  id: inv.id,
  data: { tenant_id: inv.tenant_id, property_id: inv.property_id, unit_id: inv.unit_id,
          lease_id: inv.lease_id, due_date: inv.due_date, issue_date: inv.issue_date,
          period_start: inv.period_start, period_end: inv.period_end, tax: 0, notes: '' },
  items: [...box.readTable('InvoiceItems').filter(i => i.invoice_id === inv.id)
            .map(i => ({ id: i.id, description: i.description, category: i.category,
                         quantity: i.quantity, unit_amount: i.unit_amount })), ...extra]
});

probe('adding an electricity line to a rent invoice does not get that month billed again', () => {
  const { box, c } = billedLease();
  c('generateInvoices', { upto: box.today() });
  const rent = box.readTable('Invoices').find(i => i.type === 'Rent');
  const saved = c('saveInvoice', editLines(box, rent,
    [{ description: 'EB 142 units', category: 'Electricity', quantity: 142, unit_amount: 8.5 }]));
  if (!saved.ok) return 'edit failed: ' + saved.error;
  if (saved.data.invoice.type !== 'Rent') return 'the rent invoice was relabelled ' + saved.data.invoice.type;
  const again = c('generateInvoices', { upto: box.today() });
  return again.data.created ? again.data.created + ' invoice(s) raised again for periods already billed' : null;
});

probe('a rent invoice already relabelled "Mixed" still counts as billed', () => {
  const { box, c } = billedLease();
  c('generateInvoices', { upto: box.today() });
  const rent = box.readTable('Invoices').find(i => i.type === 'Rent');
  // what an earlier build left in the sheet
  c('update', { table: 'Invoices', id: rent.id, data: { type: 'Mixed' } });
  const again = c('generateInvoices', { upto: box.today() });
  return again.data.created ? 'billed ' + rent.period_start + ' a second time' : null;
});

probe('an ad-hoc invoice is still relabelled when its lines change', () => {
  const { box, c, tenant } = billedLease();
  const made = c('saveInvoice', { data: { tenant_id: tenant.id, due_date: '2030-01-10' },
    items: [{ description: 'EB bill', category: 'Electricity', quantity: 1, unit_amount: 900 }] }).data.invoice;
  const edited = c('saveInvoice', editLines(box, made,
    [{ description: 'Water', category: 'Water', quantity: 1, unit_amount: 300 }])).data.invoice;
  return edited.type === 'Mixed' ? null : 'type stayed ' + edited.type;
});

probe('a void invoice cannot be edited back into arrears', () => {
  const { box, c, tenant } = billedLease();
  const inv = c('saveInvoice', { data: { tenant_id: tenant.id, due_date: '2030-01-01' },
    items: [{ description: 'Parking', category: 'Parking', quantity: 1, unit_amount: 500 }] }).data.invoice;
  c('update', { table: 'Invoices', id: inv.id, data: { status: 'Void' } });
  const r = c('saveInvoice', editLines(box, inv));
  if (r.ok) return 'a void invoice was edited';
  const after = box.readTable('Invoices').find(i => i.id === inv.id);
  return after.status === 'Void' && Number(after.balance) === 0 ? null : `status ${after.status}, balance ${after.balance}`;
});

probe('a nightly run bills a lease whose stored status has not caught up', () => {
  const { box } = billedLease();
  const tab = box.__tabs.get('Leases');
  tab.rows[0][tab.headers.indexOf('status')] = 'Upcoming';
  box.invalidateAll();
  const r = box.generateInvoices({ upto: box.today() }, { role: 'admin', name: 'trigger' });
  return r.created ? null : 'no invoices for a lease that has been running since last year';
});

probe('generating a year of rent writes each tab once', () => {
  const { box, c } = billedLease();
  let appends = 0, blocks = 0;
  // count the writes that reach the two billing tabs, however the script opens them
  const book = box.SpreadsheetApp.getActiveSpreadsheet();
  box.SpreadsheetApp.getActiveSpreadsheet = () => ({
    insertSheet: book.insertSheet,
    getSheetByName(name) {
      const sh = book.getSheetByName(name);
      if (!sh || !['Invoices', 'InvoiceItems'].includes(name)) return sh;
      return { ...sh,
        appendRow(v) { appends++; return sh.appendRow(v); },
        getRange(...a) {
          const r = sh.getRange(...a), set = r.setValues;
          r.setValues = function (v) { blocks++; return set.call(this, v); };
          return r;
        } };
    }
  });
  const r = c('generateInvoices', { upto: box.today() });
  box.SpreadsheetApp.getActiveSpreadsheet = () => book;
  if (r.data.created < 12) return 'expected a year of periods, got ' + r.data.created;
  const items = box.readTable('InvoiceItems');
  if (items.length !== r.data.created) return r.data.created + ' invoices but ' + items.length + ' lines';
  const ids = new Set(box.readTable('Invoices').map(i => i.id));
  if (ids.size !== r.data.created) return 'invoice ids are not unique';
  if (items.some(i => !ids.has(i.invoice_id))) return 'a line points at an invoice that does not exist';
  return appends === 0 && blocks === 2 ? null : `${appends} appendRow and ${blocks} block writes`;
});

probe('a block write past the end of the sheet grows it first', () => {
  const { box, c } = billedLease();
  box.__tabs.get('Invoices').maxRows = 3;
  box.__tabs.get('InvoiceItems').maxRows = 3;
  const r = c('generateInvoices', { upto: box.today() });
  return r.ok ? null : 'generation failed: ' + r.error;
});

probe('the late fee is not charged on a security deposit', () => {
  const { box, c } = billedLease({ deposit_amount: 50000, late_fee: 500 });
  c('bootstrap', {});
  const dep = box.readTable('Invoices').find(i => i.type === 'Deposit');
  if (dep.status !== 'Overdue') return 'test set-up: deposit is ' + dep.status;
  return box.readTable('InvoiceItems').some(i => i.invoice_id === dep.id && i.category === 'Late Fee')
    ? 'a late fee was added to the deposit invoice' : null;
});

probe('the late fee is still charged on overdue rent', () => {
  const { box, c } = billedLease({ late_fee: 500 });
  c('generateInvoices', { upto: box.today() });
  c('bootstrap', {});
  return box.readTable('InvoiceItems').some(i => i.category === 'Late Fee')
    ? null : 'no late fee on any overdue rent invoice';
});

console.log('\n— a payment entered on the Payments page —');
probe('settles the invoice it is against', () => {
  const { box, c, tenant } = billedLease();
  c('generateInvoices', { upto: box.today() });
  const inv = box.readTable('Invoices')[0];
  const r = c('create', { table: 'Payments', data: {
    payment_date: box.today(), tenant_id: tenant.id, invoice_id: inv.id, amount: Number(inv.balance), method: 'UPI' } });
  if (!r.ok) return 'refused: ' + r.error;
  const after = box.readTable('Invoices').find(i => i.id === inv.id);
  return after.status === 'Paid' && Number(after.balance) === 0
    ? null : `invoice is ${after.status} with balance ${after.balance}`;
});

probe('cannot be more than the invoice still owes', () => {
  const { box, c } = billedLease();
  c('generateInvoices', { upto: box.today() });
  const inv = box.readTable('Invoices')[0];
  const r = c('create', { table: 'Payments', data: { payment_date: box.today(), invoice_id: inv.id, amount: 999999 } });
  return r.ok ? 'an overpayment was accepted' : null;
});

probe('cannot be taken on a void invoice', () => {
  const { box, c, tenant } = billedLease();
  const inv = c('saveInvoice', { data: { tenant_id: tenant.id, due_date: '2030-01-01' },
    items: [{ description: 'Parking', category: 'Parking', quantity: 1, unit_amount: 500 }] }).data.invoice;
  c('update', { table: 'Invoices', id: inv.id, data: { status: 'Void' } });
  return c('create', { table: 'Payments', data: { payment_date: box.today(), invoice_id: inv.id, amount: 100 } }).ok
    ? 'a payment was recorded on a void invoice' : null;
});

probe('editing its amount re-prices the invoice', () => {
  const { box, c } = billedLease();
  c('generateInvoices', { upto: box.today() });
  const inv = box.readTable('Invoices')[0];
  const pay = c('create', { table: 'Payments', data: { payment_date: box.today(), invoice_id: inv.id, amount: 4000 } }).data.row;
  const up = c('update', { table: 'Payments', id: pay.id, data: { amount: 10000 } });
  if (!up.ok) return 'raising it to the full balance was refused: ' + up.error;
  const after = box.readTable('Invoices').find(i => i.id === inv.id);
  if (after.status !== 'Paid') return 'invoice is ' + after.status + ' with balance ' + after.balance;
  const notes = c('update', { table: 'Payments', id: pay.id, data: { notes: 'cheque cleared' } });
  return notes.ok ? null : 'editing only the notes of a settled payment was refused: ' + notes.error;
});

probe('moving it to another invoice puts the first one back', () => {
  const { box, c } = billedLease();
  c('generateInvoices', { upto: box.today() });
  const [a, b] = box.readTable('Invoices');
  const pay = c('create', { table: 'Payments', data: { payment_date: box.today(), invoice_id: a.id, amount: 10000 } }).data.row;
  c('update', { table: 'Payments', id: pay.id, data: { invoice_id: b.id } });
  const inv = (id) => box.readTable('Invoices').find(i => i.id === id);
  if (Number(inv(a.id).balance) !== 10000) return 'the first invoice still shows ' + inv(a.id).balance + ' owed';
  return inv(b.id).status === 'Paid' ? null : 'the second invoice is ' + inv(b.id).status;
});

probe('takes its tenant and property from the invoice', () => {
  const { box, c, prop, tenant } = billedLease();
  c('generateInvoices', { upto: box.today() });
  const inv = box.readTable('Invoices')[0];
  const row = c('create', { table: 'Payments', data: { payment_date: box.today(), invoice_id: inv.id, amount: 10 } }).data.row;
  return row.tenant_id === tenant.id && row.property_id === prop.id
    ? null : `tenant ${row.tenant_id}, property ${row.property_id}`;
});

probe('money on account, with no invoice, is still accepted', () => {
  const { box, c, tenant } = billedLease();
  return c('create', { table: 'Payments', data: { payment_date: box.today(), tenant_id: tenant.id, amount: 2500 } }).ok
    ? null : 'a payment without an invoice was refused';
});

probe('voiding a payment recomputes its invoice once', () => {
  const { box, c } = billedLease();
  c('generateInvoices', { upto: box.today() });
  const inv = box.readTable('Invoices')[0];
  const p = c('recordPayment', { invoice_id: inv.id, amount: 1000 }).data.payment;
  let n = 0; const real = box.applyInvoiceTotals;
  box.applyInvoiceTotals = function () { n++; return real.apply(this, arguments); };
  const r = c('voidPayment', { id: p.id });
  box.applyInvoiceTotals = real;
  if (!r.ok || Number(r.data.invoice.balance) !== 10000) return 'void did not restore the invoice: ' + JSON.stringify(r);
  return n === 1 ? null : `recomputed ${n} times`;
});

console.log('\n— deposits —');
probe('a deposit nobody has paid cannot be refunded', () => {
  const { box, c, lease } = billedLease({ deposit_amount: 50000 });
  const r = c('update', { table: 'Leases', id: lease.id, data: { deposit_status: 'Refunded' } });
  if (r.ok) return 'marked refunded, booking ' + box.readTable('Expenses').filter(e => e.category === 'Deposit Refund').map(e => e.amount) + ' out';
  return box.readTable('Leases')[0].deposit_status === 'Pending' ? null : 'the lease was changed anyway';
});

probe('a refund books what was actually received', () => {
  const { box, c, lease } = billedLease({ deposit_amount: 50000 });
  const dep = box.readTable('Invoices').find(i => i.type === 'Deposit');
  c('recordPayment', { invoice_id: dep.id, amount: 30000 });
  const r = c('update', { table: 'Leases', id: lease.id, data: { deposit_status: 'Refunded' } });
  if (!r.ok) return 'refused after a part payment: ' + r.error;
  const exp = box.readTable('Expenses').filter(e => e.category === 'Deposit Refund');
  return exp.length === 1 && Number(exp[0].amount) === 30000 ? null : 'refund booked as ' + exp.map(e => e.amount);
});

probe('adding a deposit to an existing lease invoices it', () => {
  const { box, c, lease } = billedLease();
  c('update', { table: 'Leases', id: lease.id, data: { deposit_amount: 40000 } });
  const dep = box.readTable('Invoices').filter(i => i.type === 'Deposit');
  if (dep.length !== 1 || Number(dep[0].total) !== 40000) return dep.length + ' deposit invoice(s)';
  c('update', { table: 'Leases', id: lease.id, data: { deposit_amount: 45000 } });
  return box.readTable('Invoices').filter(i => i.type === 'Deposit').length === 1
    ? null : 'changing the amount raised a second deposit invoice';
});

probe('a deposit recorded as already held raises no invoice', () => {
  const { box, c, lease } = billedLease();
  c('update', { table: 'Leases', id: lease.id, data: { deposit_amount: 40000, deposit_status: 'Held' } });
  return box.readTable('Invoices').some(i => i.type === 'Deposit')
    ? 'billed a deposit the lease says was collected' : null;
});

console.log('\n— sheet and session hygiene —');
probe('text that looks like a formula is stored as text', () => {
  const { box, c } = billedLease();
  const payload = '=JOIN(",",Users!F2:G9)';
  const t = c('create', { table: 'Tenants', data: { full_name: 'X', phone: '9222222222', notes: payload } }).data.row;
  c('update', { table: 'Tenants', id: t.id, data: { occupation: '=1+1' } });
  c('update', { table: 'Tenants', id: t.id, data: { alt_phone: '9333333333' } });
  if (box.__formulas.length) return 'Sheets would have run: ' + box.__formulas.join(' | ');
  const back = box.readTable('Tenants').find(r => r.id === t.id);
  return back.notes === payload && back.occupation === '=1+1' ? null : 'the text did not read back as typed';
});

probe('a create cannot choose its own id', () => {
  const { box, c, tenant } = billedLease();
  const r = c('create', { table: 'Tenants', data: { id: tenant.id, full_name: 'Impostor', phone: '9333333333' } });
  return r.data.row.id !== tenant.id && box.readTable('Tenants').filter(t => t.id === tenant.id).length === 1
    ? null : 'two tenants now share ' + tenant.id;
});

probe('no user write hands back a password hash', () => {
  const { box, admin } = bootedSandbox();
  const made = box.handle('createUser', { name: 'M', phone: '9000000004', role: 'manager', password: 'manager-pass-1234' }, admin);
  const up = box.handle('update', { table: 'Users', id: made.data.row.id, data: { name: 'Manager' } }, admin);
  const leaked = [made.data.row, up.data.row].filter(r => 'salt' in r || 'password_hash' in r);
  return leaked.length ? leaked.length + ' response(s) carried salt/password_hash' : null;
});

probe('changing your password keeps you signed in, and ends your other sessions', () => {
  const { box, admin } = bootedSandbox();
  const other = box.handle('login', { phone: '9000000001', password: 'correct-horse' }, '').data.token;
  const r = box.handle('changePassword', { current: 'correct-horse', next: 'brand-new-pass-99' }, admin);
  if (!r.ok || !r.data.token) return 'no replacement session: ' + JSON.stringify(r);
  if (!box.handle('bootstrap', {}, r.data.token).ok) return 'the replacement session is refused';
  if (box.handle('bootstrap', {}, other).ok) return 'a session from before the change still works';
  return box.handle('bootstrap', {}, admin).ok ? 'the session it replaced still works' : null;
});

probe('signing in can return the workbook in the same response', () => {
  const { box } = bootedSandbox();
  const plain = box.handle('login', { phone: '9000000001', password: 'correct-horse' }, '');
  if ('snapshot' in plain.data) return 'a snapshot was sent without being asked for';
  const r = box.handle('login', { phone: '9000000001', password: 'correct-horse', withSnapshot: true }, '');
  if (!r.ok || !r.data.snapshot || !Array.isArray(r.data.snapshot.properties)) return 'no snapshot: ' + JSON.stringify(r).slice(0, 200);
  if (JSON.stringify(r.data.snapshot).includes('password_hash')) return 'the snapshot carries password hashes';
  return r.data.snapshot.user.id === r.data.user.id ? null : 'snapshot built for a different user';
});

probe('a failed sign-in never returns a snapshot', () => {
  const { box } = bootedSandbox();
  const r = box.handle('login', { phone: '9000000001', password: 'wrong-password', withSnapshot: true }, '');
  return r.ok || r.data ? 'failed sign-in returned data' : null;
});

probe('the audit log keeps numbering from its last row', () => {
  const { box, c } = billedLease();
  const ids = box.readTable('ActivityLog').map(r => r.id);
  if (new Set(ids).size !== ids.length) return 'duplicate audit ids: ' + ids.join(',');
  const nums = ids.map(i => parseInt(i.split('-')[1], 10));
  return nums.every((n, i) => i === 0 || n === nums[i - 1] + 1) ? null : 'ids out of sequence: ' + ids.join(',');
});

probe('menu functions work from a time-driven trigger, where there is no UI', () => {
  const { box, c } = billedLease();
  box.SpreadsheetApp.getUi = () => { throw new Error('Cannot call SpreadsheetApp.getUi() from this context.'); };
  const quiet = box.console; box.console = { log() {} };
  try {
    box.menuGenerate(); box.menuRefresh(); box.menuReminders();
  } catch (e) { return 'threw: ' + e.message; }
  finally { box.console = quiet; }
  return box.readTable('Invoices').some(i => i.type === 'Rent') ? null : 'menuGenerate raised no invoices';
});

// ════════════════════════════════════════════════════════════════════════════
// Second review: concurrency, money, speed, features, security policy
// ════════════════════════════════════════════════════════════════════════════

const shift = (iso, days) => {
  const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const rowOf = (box, table, id) => box.readTable(table).find(r => r.id === id);

console.log('\n— two people saving the same record —');
probe('a save made on top of someone else\'s change is refused, and changes nothing', () => {
  const { box, c, tenant } = billedLease();
  const opened = rowOf(box, 'Tenants', tenant.id);
  if (!opened._v) return 'rows carry no version';
  c('update', { table: 'Tenants', id: tenant.id, data: { occupation: 'Doctor' }, expected_version: opened._v });
  const stale = c('update', { table: 'Tenants', id: tenant.id, data: { occupation: 'Pilot' }, expected_version: opened._v });
  if (stale.ok) return 'the second save overwrote the first';
  if (!/^CONFLICT: /.test(stale.error)) return 'not reported as a conflict: ' + stale.error;
  return rowOf(box, 'Tenants', tenant.id).occupation === 'Doctor' ? null : 'the refused save still wrote';
});

probe('the version handed back with a save is the one the next save needs', () => {
  const { box, c, tenant } = billedLease();
  const first = c('update', { table: 'Tenants', id: tenant.id, data: { occupation: 'A' },
                              expected_version: rowOf(box, 'Tenants', tenant.id)._v });
  if (!first.ok || !first.data.row._v) return 'no version returned: ' + JSON.stringify(first).slice(0, 160);
  const second = c('update', { table: 'Tenants', id: tenant.id, data: { occupation: 'B' }, expected_version: first.data.row._v });
  return second.ok ? null : 'a save on the returned version was refused: ' + second.error;
});

probe('an invoice edited on a stale copy is refused', () => {
  const { box, c } = billedLease();
  c('generateInvoices', { upto: box.today() });
  const inv = box.readTable('Invoices')[0];
  c('recordPayment', { invoice_id: inv.id, amount: 100 });
  const r = c('saveInvoice', { ...editLines(box, inv), expected_version: inv._v });
  return r.ok ? 'saved over a payment recorded after the editor opened' : (/CONFLICT/.test(r.error) ? null : r.error);
});

probe('a payment\'s balance check happens while the write lock is held', () => {
  const { box, c } = billedLease();
  c('generateInvoices', { upto: box.today() });
  const inv = box.readTable('Invoices')[0];
  const seen = [];
  const real = box.readTable;
  box.readTable = function (name) { if (name === 'Invoices') seen.push(box.__lock.held); return real.apply(this, arguments); };
  c('recordPayment', { invoice_id: inv.id, amount: 100 });
  box.readTable = real;
  return seen.length && seen.every(Boolean) ? null : 'invoices read outside the lock: ' + JSON.stringify(seen);
});

probe('one save takes the lock once, however much it sets off', () => {
  const { box, c, lease } = billedLease({ deposit_amount: 1000 });
  const before = box.__lock.acquisitions;
  c('update', { table: 'Leases', id: lease.id, data: { notes: 'touched', deposit_amount: 2000 } });
  const taken = box.__lock.acquisitions - before;
  return taken === 1 ? null : `the lock was taken ${taken} times`;
});

console.log('\n— invoice numbers and voiding —');
probe('an invoice number is never issued twice, even after the newest is deleted', () => {
  const { box, c, tenant } = billedLease();
  const draft = c('saveInvoice', { data: { tenant_id: tenant.id, due_date: '2030-01-01', status: 'Draft' },
    items: [{ description: 'x', category: 'Other', quantity: 1, unit_amount: 1 }] }).data.invoice;
  c('remove', { table: 'Invoices', id: draft.id });
  const next = c('saveInvoice', { data: { tenant_id: tenant.id, due_date: '2030-01-01' },
    items: [{ description: 'y', category: 'Other', quantity: 1, unit_amount: 1 }] }).data.invoice;
  return next.id !== draft.id ? null : draft.id + ' was issued twice';
});

probe('voiding needs a reason, keeps the number and leaves nothing owed', () => {
  const { box, c, tenant } = billedLease();
  const inv = c('saveInvoice', { data: { tenant_id: tenant.id, due_date: '2020-01-01' },
    items: [{ description: 'Parking', category: 'Parking', quantity: 1, unit_amount: 500 }] }).data.invoice;
  if (c('voidInvoice', { id: inv.id, reason: '' }).ok) return 'voided without a reason';
  const r = c('voidInvoice', { id: inv.id, reason: 'raised twice' });
  if (!r.ok) return 'void failed: ' + r.error;
  const after = rowOf(box, 'Invoices', inv.id);
  if (after.status !== 'Void' || Number(after.balance) !== 0) return `status ${after.status}, balance ${after.balance}`;
  if (!/raised twice/.test(after.notes)) return 'the reason was not kept';
  if (c('stats', {}).data.outstanding !== 0) return 'a void invoice still counts as outstanding';
  return c('recordPayment', { invoice_id: inv.id, amount: 1 }).ok ? 'a void invoice took a payment' : null;
});

probe('an invoice holding money cannot be voided', () => {
  const { box, c } = billedLease();
  c('generateInvoices', { upto: box.today() });
  const inv = box.readTable('Invoices')[0];
  c('recordPayment', { invoice_id: inv.id, amount: 100 });
  const r = c('voidInvoice', { id: inv.id, reason: 'x' });
  if (r.ok) return 'voided with a payment against it';
  return /received/.test(r.error) ? null : 'refused for the wrong reason: ' + r.error;
});

probe('a voided rent period is not billed again', () => {
  const { box, c } = billedLease();
  c('generateInvoices', { upto: box.today() });
  const inv = box.readTable('Invoices').find(i => i.type === 'Rent');
  const v = c('voidInvoice', { id: inv.id, reason: 'rent-free month' });
  if (!v.ok) return 'could not void: ' + v.error;
  return c('generateInvoices', { upto: box.today() }).data.created ? 'the voided month was billed again' : null;
});

probe('a draft is not payable and does not count as owed', () => {
  const { c, tenant } = billedLease();
  const d = c('saveInvoice', { data: { tenant_id: tenant.id, due_date: '2020-01-01', status: 'Draft' },
    items: [{ description: 'x', category: 'Other', quantity: 1, unit_amount: 900 }] }).data.invoice;
  if (d.status !== 'Draft') return 'saved as ' + d.status;
  if (c('recordPayment', { invoice_id: d.id, amount: 100 }).ok) return 'a draft took a payment';
  if (c('stats', {}).data.outstanding !== 0) return 'a draft counts as outstanding';
  const issued = c('saveInvoice', { id: d.id, data: { tenant_id: tenant.id, due_date: '2020-01-01', status: 'Unpaid' },
    items: [{ description: 'x', category: 'Other', quantity: 1, unit_amount: 900 }] }).data.invoice;
  return issued.status === 'Overdue' ? null : 'issuing a past-due draft left it ' + issued.status;
});

console.log('\n— GST —');
function gstPortfolio(state, leaseGst = 18) {
  const w = billedLease({ gst_rate: leaseGst });
  w.c('update', { table: 'Settings', id: 'gstin', data: { value: '29ABCDE1234F1Z5' } });
  w.c('update', { table: 'Properties', id: w.prop.id, data: { state } });
  return w;
}

probe('rent on a lease with GST is taxed, split CGST + SGST within the state', () => {
  const { box, c } = gstPortfolio('Karnataka');
  c('generateInvoices', { upto: box.today() });
  const inv = box.readTable('Invoices').find(i => i.type === 'Rent');
  const want = { amount: 10000, tax: 1800, total: 11800, cgst: 900, sgst: 900, igst: 0 };
  const bad = Object.entries(want).filter(([k, v]) => Number(inv[k]) !== v);
  if (bad.length) return 'got ' + bad.map(([k]) => k + '=' + inv[k]).join(', ');
  return /^29-/.test(inv.place_of_supply) ? null : 'place of supply ' + inv.place_of_supply;
});

probe('a property in another state is charged IGST', () => {
  const { box, c } = gstPortfolio('TN');
  c('generateInvoices', { upto: box.today() });
  const inv = box.readTable('Invoices').find(i => i.type === 'Rent');
  return Number(inv.igst) === 1800 && Number(inv.cgst) === 0 && /^33-/.test(inv.place_of_supply)
    ? null : `igst ${inv.igst}, cgst ${inv.cgst}, place ${inv.place_of_supply}`;
});

probe('each line carries its own rate, and a late fee is taxed like the rent', () => {
  const { box, c, tenant } = gstPortfolio('KA', 18);
  const inv = c('saveInvoice', { data: { tenant_id: tenant.id, due_date: '2030-01-01' }, items: [
    { description: 'Rent', category: 'Rent', quantity: 1, unit_amount: 10000, tax_rate: 18 },
    { description: 'EB', category: 'Electricity', quantity: 100, unit_amount: 8, tax_rate: 0 }
  ] }).data.invoice;
  if (Number(inv.tax) !== 1800 || Number(inv.total) !== 12600) return `tax ${inv.tax}, total ${inv.total}`;
  c('update', { table: 'Leases', id: box.readTable('Leases')[0].id, data: { late_fee: 500 } });
  c('generateInvoices', { upto: box.today() });
  const fee = box.readTable('InvoiceItems').find(i => i.category === 'Late Fee');
  return fee && Number(fee.tax_amount) === 90 ? null : 'late fee tax ' + (fee && fee.tax_amount);
});

probe('an invoice with no line rates keeps its typed tax', () => {
  const { c, tenant } = billedLease();
  const inv = c('saveInvoice', { data: { tenant_id: tenant.id, due_date: '2030-01-01', tax: 180 },
    items: [{ description: 'Internet', category: 'Internet', quantity: 1, unit_amount: 1000 }] }).data.invoice;
  return Number(inv.tax) === 180 && Number(inv.total) === 1180 && inv.cgst === '' ? null
    : `tax ${inv.tax}, total ${inv.total}, cgst ${JSON.stringify(inv.cgst)}`;
});

probe('a GSTIN that is not one is refused, for the business and for a tenant', () => {
  const { c, tenant } = billedLease();
  const a = c('update', { table: 'Settings', id: 'gstin', data: { value: '29ABCDE1234' } });
  const b = c('update', { table: 'Tenants', id: tenant.id, data: { gstin: 'not-a-gstin' } });
  const ok = c('update', { table: 'Tenants', id: tenant.id, data: { gstin: '33abcde1234f1z5' } });
  if (a.ok || b.ok) return 'an invalid GSTIN was saved';
  return ok.ok && ok.data.row.gstin === '33ABCDE1234F1Z5' ? null : 'a valid GSTIN was not stored canonically';
});

console.log('\n— deposits are held money, not income —');
probe('receiving or returning a deposit moves neither collected nor spent', () => {
  const { box, c, lease } = billedLease({ deposit_amount: 50000, start_date: box_today_minus(10) });
  const dep = box.readTable('Invoices').find(i => i.type === 'Deposit');
  c('recordPayment', { invoice_id: dep.id, amount: 50000, payment_date: box.today() });
  let s = c('stats', {}).data;
  if (s.collected_this_month !== 0) return 'a deposit counted as collected: ' + s.collected_this_month;
  if (s.deposits_held !== 50000) return 'deposits held ' + s.deposits_held;
  c('update', { table: 'Leases', id: lease.id, data: { deposit_status: 'Refunded' } });
  s = c('stats', {}).data;
  if (s.expenses_this_month !== 0) return 'a refund counted as spend: ' + s.expenses_this_month;
  return s.deposits_held === 0 ? null : 'still held after the refund: ' + s.deposits_held;
});
function box_today_minus(n) { return shift(new Date().toISOString().slice(0, 10), -n); }

probe('a terminated lease whose deposit has not been returned still owes it', () => {
  const { box, c, lease } = billedLease({ deposit_amount: 40000, deposit_status: 'Held' });
  c('update', { table: 'Leases', id: lease.id, data: { status: 'Terminated' } });
  return c('stats', {}).data.deposits_held === 40000 ? null : 'deposits held ' + c('stats', {}).data.deposits_held;
});

probe('move-out: the deposit pays arrears and deductions, and the rest is refunded', () => {
  const { box, c, lease, tenant } = billedLease({ deposit_amount: 100000, deposit_status: 'Held' });
  c('generateInvoices', { upto: box.today() });
  const owed = box.readTable('Invoices').filter(i => i.type === 'Rent' && Number(i.balance) > 0)
    .slice(1).map(i => i.id);
  // leave one unpaid month; pay the rest so arrears are small
  box.readTable('Invoices').filter(i => i.type === 'Rent' && owed.includes(i.id))
    .forEach(i => c('recordPayment', { invoice_id: i.id, amount: Number(i.balance) }));
  const arrears = box.readTable('Invoices').filter(i => Number(i.balance) > 0 && i.type !== 'Deposit')
    .reduce((s, i) => s + Number(i.balance), 0);

  const r = c('settleDeposit', { lease_id: lease.id, apply_to_arrears: true, end_lease: true,
    move_out_date: box.today(), refund_method: 'UPI', refund_reference: 'UTR1',
    deductions: [{ description: 'Repainting', amount: 7000 }, { description: 'Broken fan', amount: 1500 }] });
  if (!r.ok) return 'settle failed: ' + r.error;
  const problems = [];
  const left = box.readTable('Invoices').filter(i => Number(i.balance) > 0 && i.type !== 'Deposit');
  if (left.length) problems.push(left.length + ' invoice(s) still owed');
  const ded = r.data.deduction_invoice;
  if (!ded || ded.type !== 'Deposit Deduction' || Number(ded.total) !== 8500 || ded.status !== 'Paid') {
    problems.push('deduction invoice ' + JSON.stringify(ded && { type: ded.type, total: ded.total, status: ded.status }));
  }
  const refund = 100000 - arrears - 8500;
  if (r.data.refunded !== refund) problems.push(`refunded ${r.data.refunded}, expected ${refund}`);
  const exp = box.readTable('Expenses').filter(e => e.category === 'Deposit Refund');
  if (exp.length !== 1 || Number(exp[0].amount) !== refund) problems.push('refund expense ' + exp.map(e => e.amount));
  const l = rowOf(box, 'Leases', lease.id);
  if (l.deposit_status !== 'Partially Refunded') problems.push('deposit status ' + l.deposit_status);
  if (l.status !== 'Terminated') problems.push('lease ' + l.status);
  if (rowOf(box, 'Units', box.readTable('Units')[0].id).status !== 'Vacant') problems.push('unit not freed');
  if (c('stats', {}).data.deposits_held !== 0) problems.push('still held ' + c('stats', {}).data.deposits_held);
  if (c('settleDeposit', { lease_id: lease.id }).ok) problems.push('settled twice');
  const adj = box.readTable('Payments').filter(p => p.method === 'Deposit Adjustment');
  if (!adj.length || adj.some(p => p.tenant_id !== tenant.id)) problems.push('adjustments not recorded against the tenant');
  return problems.length ? problems.join('; ') : null;
});

probe('deductions larger than the deposit leave the tenant owing the difference', () => {
  const { box, c, lease } = billedLease({ deposit_amount: 5000, deposit_status: 'Held', start_date: box_today_minus(3) });
  const r = c('settleDeposit', { lease_id: lease.id, deductions: [{ description: 'Flooring', amount: 8000 }] });
  if (!r.ok) return r.error;
  const inv = r.data.deduction_invoice;
  return r.data.refunded === 0 && Number(inv.balance) === 3000 && rowOf(box, 'Leases', lease.id).deposit_status === 'Forfeited'
    ? null : `refunded ${r.data.refunded}, still owed ${inv.balance}, status ${rowOf(box, 'Leases', lease.id).deposit_status}`;
});

probe('partial refunds cannot be typed into the lease form without the money', () => {
  const { c, lease } = billedLease({ deposit_amount: 5000, deposit_status: 'Held' });
  return c('update', { table: 'Leases', id: lease.id, data: { deposit_status: 'Partially Refunded' } }).ok
    ? 'a partial refund was recorded with no amount' : null;
});

probe('changing the deposit re-prices its invoice, but never below what was paid', () => {
  const { box, c, lease } = billedLease({ deposit_amount: 50000 });
  const dep = () => box.readTable('Invoices').find(i => i.type === 'Deposit');
  c('update', { table: 'Leases', id: lease.id, data: { deposit_amount: 60000 } });
  if (Number(dep().total) !== 60000) return 'deposit invoice still ' + dep().total;
  c('recordPayment', { invoice_id: dep().id, amount: 30000 });
  if (c('update', { table: 'Leases', id: lease.id, data: { deposit_amount: 20000 } }).ok) return 'cut below the 30000 received';
  return box.readTable('Invoices').filter(i => i.type === 'Deposit').length === 1 ? null : 'a second deposit invoice appeared';
});

console.log('\n— renewing a lease —');
probe('a renewal starts the day after, at the escalated rent, and carries the deposit once', () => {
  const Y = Number(new Date().toISOString().slice(0, 4));
  const { box, c, lease } = billedLease({ start_date: (Y - 2) + '-01-01', end_date: shift(box_today_minus(0), 20),
                                          escalation_pct: 10, deposit_amount: 30000, deposit_status: 'Held' });
  if (c('renewLease', { id: lease.id, start_date: shift(box_today_minus(0), 5), end_date: (Y + 2) + '-12-31' }).ok) {
    return 'a renewal overlapping the current lease was accepted';
  }
  const r = c('renewLease', { id: lease.id, end_date: (Y + 2) + '-12-31' });
  if (!r.ok) return r.error;
  const n = r.data.lease, old = rowOf(box, 'Leases', lease.id);
  const problems = [];
  if (n.start_date !== shift(old.end_date, 1)) problems.push('starts ' + n.start_date);
  if (Number(n.rent_amount) !== 12100) problems.push('rent ' + n.rent_amount + ' (expected 10000 × 1.1²)');
  if (n.renewed_from !== lease.id) problems.push('not linked to ' + lease.id);
  if (n.deposit_status !== 'Held' || Number(n.deposit_amount) !== 30000) problems.push('new deposit ' + n.deposit_status + ' ' + n.deposit_amount);
  if (old.deposit_status !== 'Transferred') problems.push('old deposit ' + old.deposit_status);
  if (box.readTable('Invoices').some(i => i.type === 'Deposit')) problems.push('a carried deposit was billed again');
  if (c('stats', {}).data.deposits_held !== 30000) problems.push('held ' + c('stats', {}).data.deposits_held);
  if (c('renewLease', { id: lease.id, end_date: (Y + 3) + '-12-31' }).ok) problems.push('renewed twice');
  return problems.length ? problems.join('; ') : null;
});

probe('the rent roll uses the rent in force after escalation', () => {
  const Y = Number(new Date().toISOString().slice(0, 4));
  const { c } = billedLease({ start_date: (Y - 2) + '-01-01', end_date: (Y + 2) + '-12-31', escalation_pct: 10 });
  const roll = c('stats', {}).data.monthly_rent_roll;
  return roll === 12100 ? null : 'rent roll ' + roll + ', expected 12100';
});

console.log('\n— reminders keep to a schedule —');
function reminderWorld() {
  const w = billedLease();
  w.c('update', { table: 'Tenants', id: w.tenant.id, data: { email: 't@example.com' } });
  const mails = [];
  w.box.MailApp.sendEmail = (to, subject, body) => mails.push({ to, subject, body });
  const raise = (due) => w.c('saveInvoice', { data: { tenant_id: w.tenant.id, due_date: due },
    items: [{ description: 'Charge', category: 'Other', quantity: 1, unit_amount: 1000 }] }).data.invoice;
  return { ...w, mails, raise };
}

probe('the daily job emails only on the scheduled days', () => {
  const t = new Date().toISOString().slice(0, 10);
  const cases = [[3, true], [4, false], [0, true], [-7, true], [-8, false], [-30, true]];
  const wrong = [];
  for (const [offset, expect] of cases) {
    const { box, mails, raise } = reminderWorld();
    raise(shift(box.today(), offset));
    box.dailyReminderJob = box.dailyReminderJob;       // the job itself checks the setting
    box.sendReminders({ role: 'admin', name: 'job' }, { scheduled: true });
    if ((mails.length > 0) !== expect) wrong.push(`${offset} days: ${mails.length} sent`);
  }
  return wrong.length ? wrong.join('; ') : null;
});

probe('one tenant gets one email for all their invoices, and never twice in a day', () => {
  const { box, c, mails, raise } = reminderWorld();
  raise(shift(box.today(), -7)); raise(shift(box.today(), -7)); raise(shift(box.today(), -30));
  c('sendReminders', {});
  if (mails.length !== 1) return mails.length + ' emails';
  if ((mails[0].body.match(/INV-/g) || []).length !== 3) return 'the email does not list all three invoices';
  c('sendReminders', {});
  return mails.length === 1 ? null : 'reminded again the same day';
});

console.log('\n— speed —');
probe('only the first load of the day runs housekeeping', () => {
  const { box, c } = billedLease();
  c('generateInvoices', { upto: box.today() });
  // as if a day had passed: nothing has refreshed today, and one invoice is stale
  box.__props.delete('LAST_REFRESH');
  const tab = box.__tabs.get('Invoices');
  tab.rows[0][tab.headers.indexOf('status')] = 'Unpaid';
  box.invalidateAll();
  let runs = 0;
  const real = box.refreshStatuses;
  box.refreshStatuses = function () { runs++; return real.apply(this, arguments); };
  c('bootstrap', {}); const first = runs;
  c('bootstrap', {}); c('bootstrap', {});
  box.refreshStatuses = real;
  if (first !== 1) return 'the first load ran housekeeping ' + first + ' time(s)';
  if (box.readTable('Invoices')[0].status !== 'Overdue') return 'the stale invoice was not fixed';
  return runs === 1 ? null : `later loads ran it ${runs - 1} more time(s)`;
});

probe('a snapshot leaves out every tab that has not changed', () => {
  const { c, tenant } = billedLease();
  const full = c('bootstrap', {}).data;
  const again = c('bootstrap', { known: full.hashes }).data;
  if (again.unchanged.length !== Object.keys(full.hashes).length) return 'unchanged: ' + again.unchanged.join(',');
  if ('invoices' in again) return 'an unchanged tab was sent';
  const write = c('update', { table: 'Tenants', id: tenant.id, data: { occupation: 'X' }, withSnapshot: true, known: full.hashes });
  const snap = write.data.snapshot;
  if (!Array.isArray(snap.tenants)) return 'the changed tab was left out';
  return snap.unchanged.includes('invoices') && !('invoices' in snap) ? null : 'an unchanged tab was sent with the write';
});

probe('a change made directly in the sheet is picked up', () => {
  const { box, c } = billedLease();
  const full = c('bootstrap', {}).data;
  const tab = box.__tabs.get('Tenants');
  tab.rows[0][tab.headers.indexOf('occupation')] = 'Typed in the sheet';
  const again = c('bootstrap', { known: full.hashes }).data;
  return Array.isArray(again.tenants) && again.tenants[0].occupation === 'Typed in the sheet' ? null : 'the edit was missed';
});

probe('a deployment missing new columns gains them on first use', () => {
  const { box, admin } = bootedSandbox();
  const tab = box.__tabs.get('Tenants');
  const col = tab.headers.indexOf('gstin');
  tab.headers.splice(col, 1);
  box.__tabs.get('Settings').rows = box.__tabs.get('Settings').rows.filter(r => r[0] !== 'upi_id');
  box.__props.delete('SCHEMA_HASH');
  const t = box.handle('create', { table: 'Tenants', data: { full_name: 'G', phone: '9', gstin: '29ABCDE1234F1Z5' } }, admin);
  if (!t.ok) return t.error;
  if (!box.__tabs.get('Tenants').headers.includes('gstin')) return 'the column was not added';
  if (rowOf(box, 'Tenants', t.data.row.id).gstin !== '29ABCDE1234F1Z5') return 'the value was dropped';
  return box.readSettings().upi_id !== undefined ? null : 'the new setting was not added';
});

console.log('\n— meter readings —');
probe('a round of readings bills occupied units and records vacant ones', () => {
  const { box, c, prop, unit, tenant } = billedLease();
  const empty = c('create', { table: 'Units', data: { property_id: prop.id, unit_number: 'B' } }).data.row;
  const r = c('billMeterReadings', { property_id: prop.id, category: 'Electricity', rate: 8.5,
    reading_date: box.today(), due_date: shift(box.today(), 7), readings: [
      { unit_id: unit.id, previous_reading: 1000, current_reading: 1142 },
      { unit_id: empty.id, previous_reading: 50, current_reading: 60 }
    ] });
  if (!r.ok) return r.error;
  const problems = [];
  if (r.data.invoices.length !== 1) problems.push(r.data.invoices.length + ' invoices');
  const inv = r.data.invoices[0];
  if (inv && (inv.tenant_id !== tenant.id || Number(inv.total) !== 1207 || inv.type !== 'Electricity')) {
    problems.push(`invoice ${inv.tenant_id} ${inv.total} ${inv.type}`);
  }
  const line = box.readTable('InvoiceItems').find(i => inv && i.invoice_id === inv.id);
  if (!line || Number(line.quantity) !== 142 || !/1000 → 1142/.test(line.description)) problems.push('line ' + JSON.stringify(line));
  const readings = box.readTable('MeterReadings');
  if (readings.length !== 2) problems.push(readings.length + ' readings stored');
  if (!readings.some(x => x.unit_id === empty.id && !x.invoice_id)) problems.push('the vacant reading was not kept');
  if (c('remove', { table: 'Units', id: empty.id }).ok) problems.push('a unit with readings was deleted');
  return problems.length ? problems.join('; ') : null;
});

probe('a reading lower than the last one is refused', () => {
  const { box, c, prop, unit } = billedLease();
  const r = c('billMeterReadings', { property_id: prop.id, category: 'Water', rate: 1, reading_date: box.today(),
    readings: [{ unit_id: unit.id, previous_reading: 500, current_reading: 400 }] });
  return r.ok ? 'accepted a meter running backwards' : (box.readTable('MeterReadings').length ? 'stored anyway' : null);
});

console.log('\n— records that point at a tenant —');
probe('a tenant with maintenance tickets or documents cannot be deleted', () => {
  const { box, admin } = bootedSandbox();
  const c = (a, p) => box.handle(a, p, admin);
  const prop = c('create', { table: 'Properties', data: { name: 'P' } }).data.row;
  const t1 = c('create', { table: 'Tenants', data: { full_name: 'A', phone: '1' } }).data.row;
  const t2 = c('create', { table: 'Tenants', data: { full_name: 'B', phone: '2' } }).data.row;
  c('create', { table: 'Maintenance', data: { property_id: prop.id, tenant_id: t1.id, title: 'Leak' } });
  c('create', { table: 'Documents', data: { entity_type: 'Tenant', entity_id: t2.id, title: 'ID', url: 'https://x' } });
  const a = c('remove', { table: 'Tenants', id: t1.id }), b = c('remove', { table: 'Tenants', id: t2.id });
  return a.ok || b.ok ? 'deleted a tenant other records point at' : null;
});

console.log('\n— time zones —');
probe('dates survive a spreadsheet in a different time zone from the script', () => {
  const { box, admin } = bootedSandbox({ scriptTz: 'Asia/Kolkata', sheetTz: 'Australia/Sydney' });
  const c = (a, p) => box.handle(a, p, admin);
  const t = c('create', { table: 'Tenants', data: { full_name: 'Z', phone: '9' } }).data.row;
  const exp = c('create', { table: 'Expenses', data: { property_id: 'x', date: '2026-03-01', amount: 1, description: 'a' } }).data.row;
  if (rowOf(box, 'Expenses', exp.id).date !== '2026-03-01') return 'read back as ' + rowOf(box, 'Expenses', exp.id).date;
  for (let i = 0; i < 3; i++) c('update', { table: 'Expenses', id: exp.id, data: { description: 'edit ' + i } });
  const after = rowOf(box, 'Expenses', exp.id).date;
  if (after !== '2026-03-01') return 'the date drifted to ' + after + ' after three saves';
  return c('bootstrap', {}).data.timezones.sheet === 'Australia/Sydney' ? null : 'time zones not reported';
});

console.log('\n' + '─'.repeat(60));
if (issues.length) {
  console.log(`${issues.length} PRODUCTION ISSUE(S) FOUND`);
  process.exit(1);
}
console.log('ALL PRODUCTION CHECKS PASSED');
