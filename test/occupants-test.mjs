/**
 * More than one person on a lease: one primary tenant, who is billed, and any
 * number of co-tenants and occupants living with them. Every probe runs the
 * real backend on a real Postgres (see pg-harness.mjs).
 */
import { bootedSandbox, closeAll } from './pg-harness.mjs';

let failures = 0, passed = 0;
const check = async (name, fn) => {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failures++; console.log('  ✗ ' + name + '\n      ' + e.message); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

/** A property, a unit, three people and — unless told otherwise — a lease for the first of them. */
async function household({ lease = {}, occupants } = {}) {
  const { box, admin } = await bootedSandbox();
  const c = async (action, payload, token = admin) => box.handle(action, payload, token);
  const must = async (action, payload, token) => {
    const res = await c(action, payload, token);
    if (!res.ok) throw new Error(action + ' failed: ' + res.error);
    return res.data;
  };
  const prop = (await must('create', { table: 'Properties', data: { name: 'Sunrise' } })).row;
  const unit = (await must('create', { table: 'Units', data: { property_id: prop.id, unit_number: 'A-101', rent_amount: 20000 } })).row;
  const person = async (name, phone) => (await must('create', { table: 'Tenants', data: { full_name: name, phone } })).row;
  const anita = await person('Anita Rao', '9880011111');
  const priya = await person('Priya Shah', '9880022222');
  const ravi = await person('Ravi Kumar', '9880033333');
  const payload = { table: 'Leases', data: {
    property_id: prop.id, unit_id: unit.id, tenant_id: anita.id,
    start_date: '2026-01-01', end_date: '2026-12-31', rent_amount: 20000, deposit_amount: 0, rent_day: 1, ...lease } };
  if (occupants) payload.occupants = occupants({ anita, priya, ravi });
  const res = await c('create', payload);
  return { box, admin, c, must, prop, unit, anita, priya, ravi, leaseRes: res, lease: res.ok ? res.data.row : null };
}

const occupantsOf = async (box, leaseId) => (await box.readTable('LeaseTenants')).filter(o => o.lease_id === leaseId);

console.log('\n— saving a household —');

await check('a lease is saved with its occupants in one request', async () => {
  const { box, lease, leaseRes, priya, ravi } = await household({ occupants: ({ priya, ravi }) => [
    { tenant_id: priya.id, role: 'Co-tenant', relationship: 'Friend' },
    { tenant_id: ravi.id, role: 'Occupant', relationship: 'Roommate' }
  ] });
  assert(leaseRes.ok, leaseRes.error);
  const rows = await occupantsOf(box, lease.id);
  assert(rows.length === 2, 'expected 2 occupants, found ' + rows.length);
  const p = rows.find(o => o.tenant_id === priya.id);
  assert(p.role === 'Co-tenant' && p.relationship === 'Friend', JSON.stringify(p));
  assert(rows.find(o => o.tenant_id === ravi.id).role === 'Occupant', 'role lost');
});

await check('the app receives each lease with its occupants', async () => {
  const { c, lease, priya } = await household({ occupants: ({ priya }) => [{ tenant_id: priya.id, relationship: 'Friend' }] });
  const boot = (await c('bootstrap', { lean: true })).data;
  const l = boot.leases.find(x => x.id === lease.id);
  assert(Array.isArray(l._occupants) && l._occupants.length === 1, JSON.stringify(l._occupants));
  const o = l._occupants[0];
  assert(o.tenant_id === priya.id && o.role === 'Co-tenant' && o.id && o._v, JSON.stringify(o));
});

await check('a lease without occupants still saves exactly as before', async () => {
  const { leaseRes, box, lease } = await household();
  assert(leaseRes.ok, leaseRes.error);
  assert((await occupantsOf(box, lease.id)).length === 0, 'occupants appeared from nowhere');
  assert(lease.status === 'Active', 'status ' + lease.status);
});

await check('the primary tenant cannot also be listed as an occupant — and nothing is saved', async () => {
  const { box, leaseRes } = await household({ occupants: ({ anita }) => [{ tenant_id: anita.id }] });
  assert(!leaseRes.ok, 'accepted the primary tenant as their own occupant');
  assert(/primary tenant/.test(leaseRes.error), leaseRes.error);
  assert((await box.readTable('Leases')).length === 0, 'the lease was saved without its household');
});

await check('the same person cannot be listed twice', async () => {
  const { leaseRes } = await household({ occupants: ({ priya }) => [{ tenant_id: priya.id }, { tenant_id: priya.id }] });
  assert(!leaseRes.ok && /listed twice/.test(leaseRes.error), leaseRes.error);
});

await check('an occupant row with no person chosen is refused', async () => {
  const { leaseRes } = await household({ occupants: () => [{ tenant_id: '', relationship: 'Friend' }] });
  assert(!leaseRes.ok && /Choose a person/.test(leaseRes.error), leaseRes.error);
});

await check('move dates must make sense and sit inside the term', async () => {
  const bad = [
    [{ move_in_date: '2026-05-01', move_out_date: '2026-04-01' }, /move out before they move in/],
    [{ move_out_date: '2025-12-01' }, /before .* starts/],
    [{ move_in_date: '2027-02-01' }, /after .* ends/]
  ];
  for (const [dates, re] of bad) {
    const { leaseRes } = await household({ occupants: ({ priya }) => [{ tenant_id: priya.id, ...dates }] });
    assert(!leaseRes.ok && re.test(leaseRes.error), JSON.stringify(dates) + ' → ' + (leaseRes.error || 'accepted'));
  }
});

await check('an unknown role is refused', async () => {
  const { leaseRes } = await household({ occupants: ({ priya }) => [{ tenant_id: priya.id, role: 'Landlord' }] });
  assert(!leaseRes.ok && /Co-tenant or an Occupant/.test(leaseRes.error), leaseRes.error);
});

console.log('\n— editing a household —');

await check('saving the list adds, updates and removes in one go', async () => {
  const { box, must, lease, priya, ravi } = await household({ occupants: ({ priya }) => [{ tenant_id: priya.id }] });
  const [p] = await occupantsOf(box, lease.id);
  await must('saveOccupants', { lease_id: lease.id, occupants_seen: [p.id],
    occupants: [{ id: p.id, _v: p._v, tenant_id: priya.id, role: 'Occupant', relationship: 'Sister' }, { tenant_id: ravi.id }] });
  let rows = await occupantsOf(box, lease.id);
  assert(rows.length === 2, 'expected 2, found ' + rows.length);
  assert(rows.find(o => o.id === p.id).relationship === 'Sister', 'update lost');
  await must('saveOccupants', { lease_id: lease.id, occupants: [], occupants_seen: rows.map(o => o.id) });
  rows = await occupantsOf(box, lease.id);
  assert(rows.length === 0, 'removal ignored: ' + rows.length + ' left');
});

await check('someone added by another user meanwhile is kept, not silently dropped', async () => {
  const { box, must, lease, priya, ravi } = await household({ occupants: ({ priya }) => [{ tenant_id: priya.id }] });
  const [p] = await occupantsOf(box, lease.id);
  // user B adds Ravi while user A still has the form open with only Priya
  await must('saveOccupants', { lease_id: lease.id, occupants_seen: [p.id],
    occupants: [{ id: p.id, _v: p._v, tenant_id: priya.id }, { tenant_id: ravi.id }] });
  // user A saves the list as they saw it, with Priya's relationship changed
  const fresh = (await occupantsOf(box, lease.id)).find(o => o.id === p.id);
  await must('saveOccupants', { lease_id: lease.id, occupants_seen: [p.id],
    occupants: [{ id: p.id, _v: fresh._v, tenant_id: priya.id, relationship: 'Friend' }] });
  const rows = await occupantsOf(box, lease.id);
  assert(rows.some(o => o.tenant_id === ravi.id), 'Ravi, added by someone else, was dropped');
});

await check('an occupant changed by someone else since the form opened is not overwritten', async () => {
  const { box, c, must, lease, priya } = await household({ occupants: ({ priya }) => [{ tenant_id: priya.id }] });
  const [p] = await occupantsOf(box, lease.id);
  await must('saveOccupants', { lease_id: lease.id, occupants_seen: [p.id],
    occupants: [{ id: p.id, _v: p._v, tenant_id: priya.id, relationship: 'Friend' }] });
  const stale = await c('saveOccupants', { lease_id: lease.id, occupants_seen: [p.id],
    occupants: [{ id: p.id, _v: p._v, tenant_id: priya.id, relationship: 'Cousin' }] });
  assert(!stale.ok && /changed by someone else/.test(stale.error), stale.error || 'stale save accepted');
  assert((await occupantsOf(box, lease.id))[0].relationship === 'Friend', 'stale save overwrote the change');
});

await check('the lease form saves occupants with the lease on update, too', async () => {
  const { box, must, lease, priya } = await household();
  await must('update', { table: 'Leases', id: lease.id, expected_version: lease._v,
    data: { rent_amount: 21000 }, occupants: [{ tenant_id: priya.id, relationship: 'Friend' }], occupants_seen: [] });
  const rows = await occupantsOf(box, lease.id);
  assert(rows.length === 1 && rows[0].tenant_id === priya.id, JSON.stringify(rows));
  assert((await box.readTable('Leases'))[0].rent_amount === 21000, 'lease change lost');
});

await check('a lease update that does not send occupants leaves them alone', async () => {
  const { box, must, lease, priya } = await household({ occupants: ({ priya }) => [{ tenant_id: priya.id }] });
  await must('update', { table: 'Leases', id: lease.id, data: { notes: 'painted' } });
  assert((await occupantsOf(box, lease.id)).length === 1, 'an unrelated edit dropped the occupants');
});

await check('choosing an occupant as the new primary tenant takes them off the occupants list', async () => {
  const { box, must, lease, priya } = await household({ occupants: ({ priya }) => [{ tenant_id: priya.id }] });
  await must('update', { table: 'Leases', id: lease.id, data: { tenant_id: priya.id } });
  assert((await occupantsOf(box, lease.id)).length === 0, 'Priya is primary and still listed as an occupant');
});

await check('a viewer cannot change who lives on a lease', async () => {
  const { box, c, lease, priya } = await household();
  await c('createUser', { name: 'V', phone: '9000000003', role: 'viewer', password: 'viewer-pass-1234' });
  const viewer = (await c('login', { phone: '9000000003', password: 'viewer-pass-1234' }, '')).data.token;
  const res = await c('saveOccupants', { lease_id: lease.id, occupants: [{ tenant_id: priya.id }] }, viewer);
  assert(!res.ok, 'viewer changed the household');
  const direct = await c('create', { table: 'LeaseTenants', data: { lease_id: lease.id, tenant_id: priya.id } }, viewer);
  assert(!direct.ok, 'viewer wrote LeaseTenants directly');
  assert((await occupantsOf(box, lease.id)).length === 0, 'rows written');
});

await check('writing the occupant table directly goes through the same rules', async () => {
  const { c, lease, anita, priya } = await household();
  const self = await c('create', { table: 'LeaseTenants', data: { lease_id: lease.id, tenant_id: anita.id } });
  assert(!self.ok && /primary tenant/.test(self.error), self.error || 'accepted');
  const okRow = await c('create', { table: 'LeaseTenants', data: { lease_id: lease.id, tenant_id: priya.id } });
  assert(okRow.ok && okRow.data.row.role === 'Co-tenant', okRow.error || JSON.stringify(okRow.data.row));
  const twice = await c('create', { table: 'LeaseTenants', data: { lease_id: lease.id, tenant_id: priya.id } });
  assert(!twice.ok && /already on/.test(twice.error), twice.error || 'accepted twice');
});

console.log('\n— statuses —');

await check('a co-tenant on a live lease is Active, and Past once they move out', async () => {
  const { box, must, lease, priya } = await household();
  // recorded as a prospect first, then added to the lease
  await must('update', { table: 'Tenants', id: priya.id, data: { status: 'Prospect' } });
  assert((await box.readTable('Tenants')).find(x => x.id === priya.id).status === 'Prospect', 'setup');
  await must('saveOccupants', { lease_id: lease.id, occupants: [{ tenant_id: priya.id }] });
  const t = (await box.readTable('Tenants')).find(x => x.id === priya.id);
  assert(t.status === 'Active', 'co-tenant reads ' + t.status);
  const [p] = await occupantsOf(box, lease.id);
  await must('saveOccupants', { lease_id: lease.id, occupants_seen: [p.id],
    occupants: [{ id: p.id, _v: p._v, tenant_id: priya.id, move_out_date: '2026-01-15' }] });
  const today = box.today();
  const after = (await box.readTable('Tenants')).find(x => x.id === priya.id).status;
  assert(after === (today > '2026-01-15' ? 'Past' : 'Active'), 'after moving out: ' + after);
});

await check('a co-tenant becomes Past when the lease ends', async () => {
  const { box, must, lease, priya } = await household({ occupants: ({ priya }) => [{ tenant_id: priya.id }] });
  await must('update', { table: 'Leases', id: lease.id, data: { status: 'Terminated' } });
  const status = (await box.readTable('Tenants')).find(x => x.id === priya.id).status;
  assert(status === 'Past', 'reads ' + status);
});

console.log('\n— changing the primary tenant —');

await check('an occupant can be made primary; the previous primary becomes a co-tenant', async () => {
  const { box, must, lease, anita, priya } = await household({
    occupants: ({ priya }) => [{ tenant_id: priya.id, relationship: 'Friend' }] });
  const res = await must('setPrimaryTenant', { lease_id: lease.id, tenant_id: priya.id, expected_version: lease._v });
  assert(res.lease.tenant_id === priya.id, 'primary is ' + res.lease.tenant_id);
  const rows = await occupantsOf(box, lease.id);
  assert(rows.length === 1 && rows[0].tenant_id === anita.id && rows[0].role === 'Co-tenant', JSON.stringify(rows));
  assert(rows[0].relationship === 'Friend', 'relationship lost in the swap');
});

await check('only someone on the lease, still living there, can be made primary', async () => {
  const { box, c, must, lease, priya, ravi } = await household({
    occupants: ({ priya }) => [{ tenant_id: priya.id, move_in_date: '2026-01-01', move_out_date: '2026-01-10' }] });
  const stranger = await c('setPrimaryTenant', { lease_id: lease.id, tenant_id: ravi.id });
  assert(!stranger.ok && /not on/.test(stranger.error), stranger.error || 'accepted');
  if (box.today() > '2026-01-10') {
    const gone = await c('setPrimaryTenant', { lease_id: lease.id, tenant_id: priya.id });
    assert(!gone.ok && /moved out/.test(gone.error), gone.error || 'accepted');
  }
});

await check('a stale page cannot swap the primary tenant', async () => {
  const { c, must, lease, priya } = await household({ occupants: ({ priya }) => [{ tenant_id: priya.id }] });
  await must('update', { table: 'Leases', id: lease.id, data: { notes: 'edited elsewhere' } });
  const res = await c('setPrimaryTenant', { lease_id: lease.id, tenant_id: priya.id, expected_version: lease._v });
  assert(!res.ok && /changed by someone else/.test(res.error), res.error || 'accepted');
});

await check('after a swap, settling the deposit still clears arrears billed to the previous primary', async () => {
  const { box, must, lease, anita, priya } = await household({
    lease: { deposit_amount: 50000, deposit_status: 'Held' }, occupants: ({ priya }) => [{ tenant_id: priya.id }] });
  await must('saveInvoice', { data: { tenant_id: anita.id, lease_id: lease.id, unit_id: lease.unit_id,
    period_start: '2026-01-01', period_end: '2026-01-31', due_date: '2026-01-01' },
    items: [{ description: 'Rent · January', category: 'Rent', quantity: 1, unit_amount: 20000 }] });
  const owed = (await box.readTable('Invoices')).find(i => i.lease_id === lease.id && i.type === 'Rent');
  assert(owed && owed.tenant_id === anita.id, 'no rent invoice for Anita');
  await must('setPrimaryTenant', { lease_id: lease.id, tenant_id: priya.id });
  const res = await must('settleDeposit', { lease_id: lease.id, apply_to_arrears: true });
  assert(res.applied.some(a => a.invoice_id === owed.id), 'Anita\'s arrears on this lease were skipped');
});

console.log('\n— the rest of the app —');

await check('a tenant still on someone\'s lease cannot be deleted', async () => {
  const { c, priya } = await household({ occupants: ({ priya }) => [{ tenant_id: priya.id }] });
  const res = await c('remove', { table: 'Tenants', id: priya.id });
  assert(!res.ok && /shared lease/.test(res.error), res.error || 'deleted');
});

await check('deleting a lease takes its occupants with it', async () => {
  const { box, must, lease, priya } = await household({ occupants: ({ priya }) => [{ tenant_id: priya.id }] });
  await must('remove', { table: 'Leases', id: lease.id });
  assert((await box.readTable('LeaseTenants')).length === 0, 'orphan occupant rows left');
  assert((await box.readTable('Tenants')).some(t => t.id === priya.id), 'the person was deleted too');
});

await check('renewing a lease carries over everyone still living there', async () => {
  const { box, must, lease, priya, ravi } = await household({ occupants: ({ priya, ravi }) => [
    { tenant_id: priya.id, relationship: 'Friend' },
    { tenant_id: ravi.id, move_out_date: '2026-06-30' }
  ] });
  const res = await must('renewLease', { id: lease.id, end_date: '2027-12-31' });
  const rows = await occupantsOf(box, res.lease.id);
  assert(rows.length === 1 && rows[0].tenant_id === priya.id && rows[0].relationship === 'Friend', JSON.stringify(rows));
  assert((await occupantsOf(box, lease.id)).length === 2, 'the old lease lost its history');
});

await check('renewing without the household leaves it on the old lease', async () => {
  const { box, must, lease, priya } = await household({ occupants: ({ priya }) => [{ tenant_id: priya.id }] });
  const res = await must('renewLease', { id: lease.id, end_date: '2027-12-31', carry_occupants: false });
  assert((await occupantsOf(box, res.lease.id)).length === 0, 'occupants carried over anyway');
});

await check('an occupant\'s page shows the documents of the lease they share', async () => {
  const { must, lease, priya } = await household({ occupants: ({ priya }) => [{ tenant_id: priya.id }] });
  await must('create', { table: 'Documents', data: { title: 'Agreement', entity_type: 'Lease', entity_id: lease.id,
                                                      url: 'https://example.com/a' } });
  const page = await must('page', { table: 'Documents', scope: { kind: 'tenant', id: priya.id } });
  assert(page.total === 1, 'found ' + page.total);
});

await check('saving occupants tells the browser its leases changed', async () => {
  const { c, must, lease, priya } = await household();
  const first = (await c('bootstrap', { lean: true })).data;
  const res = await must('saveOccupants', { lease_id: lease.id, occupants: [{ tenant_id: priya.id }],
                                            withSnapshot: true, lean: true, known: first.hashes });
  assert(!res.snapshot.unchanged.includes('leases'), 'leases claimed unchanged after an occupant was added');
  assert(res.snapshot.leases.find(l => l.id === lease.id)._occupants.length === 1, 'snapshot lacks the occupant');
});

await closeAll();
console.log('\n' + '─'.repeat(56));
if (failures) { console.log(`${failures} OCCUPANT CHECK${failures === 1 ? '' : 'S'} FAILED (${passed} passed)`); process.exit(1); }
console.log(`ALL ${passed} OCCUPANT CHECKS PASSED`);
