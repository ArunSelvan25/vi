/**
 * Generate rent, end to end: what each lease is offered, the invoices raised
 * from it, and every rule agreed for them (docs/RENT_GENERATION.md) — on the
 * real backend and a real Postgres (see pg-harness.mjs).
 *
 * Dates are built relative to today, so the checks hold whichever day they run.
 */
import { bootedSandbox, closeAll } from './pg-harness.mjs';

let failures = 0, passed = 0;
const check = async (name, fn) => {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failures++; console.log('  ✗ ' + name + '\n      ' + e.message); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/**
 * A portfolio for one test: a property, three units, three tenants, and a
 * lease on the first unit from the 20th two months ago, rent day 10 — so it
 * has a first part month (backlog), a whole month due this month (current),
 * and the next one after that.
 */
async function portfolio(leaseOver = {}) {
  const { box, admin } = await bootedSandbox();
  const today = box.today();
  const [Y, M] = today.split('-').map(Number);
  /** Day `d` of the month `offset` months from today's. */
  const on = (offset, d) => iso(new Date(Y, M - 1 + offset, d));
  const c = async (action, payload, token = admin) => box.handle(action, payload, token);
  const must = async (action, payload, token) => {
    const res = await c(action, payload, token);
    if (!res.ok) throw new Error(action + ' failed: ' + res.error);
    return res.data;
  };
  const prop = (await must('create', { table: 'Properties', data: { name: 'Sunrise', state: 'KA' } })).row;
  const units = [];
  for (const n of ['A-101', 'A-102', 'A-103']) {
    units.push((await must('create', { table: 'Units', data: { property_id: prop.id, unit_number: n } })).row);
  }
  const people = [];
  for (const [name, phone] of [['Anita Rao', '9880011111'], ['Karthik Menon', '9880022222'], ['Priya Shah', '9880033333']]) {
    people.push((await must('create', { table: 'Tenants', data: { full_name: name, phone } })).row);
  }
  const lease = (await must('create', { table: 'Leases', data: {
    property_id: prop.id, unit_id: units[0].id, tenant_id: people[0].id,
    start_date: on(-2, 20), rent_amount: 30000, rent_day: 10, grace_days: 5, late_fee: 500, ...leaseOver } })).row;
  const candidates = async () => (await must('rentCandidates', {})).leases;
  const candidate = async (id = lease.id) => (await candidates()).find(x => x.lease_id === id);
  /** What the screen sends back for one offered period. */
  const entry = (cand, period, extra = {}) => ({ lease_id: cand.lease_id, period_start: period.start,
                                                 period_end: period.end, rent: period.amount, ...extra });
  return { box, admin, c, must, today, on, prop, units, people, lease, candidates, candidate, entry };
}

console.log('\n— rent day is required —');
await check('a new lease without a rent day is refused, and one cannot be cleared', async () => {
  const { c, prop, units, people, lease } = await portfolio();
  const res = await c('create', { table: 'Leases', data: { property_id: prop.id, unit_id: units[1].id,
    tenant_id: people[1].id, start_date: '2026-01-01', rent_amount: 1000 } });
  assert(!res.ok && /Rent day is required/.test(res.error), 'accepted, or wrong error: ' + res.error);
  const cleared = await c('update', { table: 'Leases', id: lease.id, data: { rent_day: '' } });
  assert(!cleared.ok && /Rent day is required/.test(cleared.error), 'a rent day was cleared: ' + cleared.error);
});

await check('a lease saved before rent days were required is listed as needing one, and cannot be billed', async () => {
  const { box, c, candidate, lease, must } = await portfolio();
  await box.query('update leases set rent_day = null where id = $1', [lease.id]);
  const cand = await candidate();
  assert(cand.state === 'missing_rent_day', 'state ' + cand.state);
  // other edits to it still save
  await must('update', { table: 'Leases', id: lease.id, data: { notes: 'still editable' } });
  const res = await must('generateRent', { mode: 'issue', invoices: [{ lease_id: lease.id, period_start: '2026-01-01' }] });
  assert(res.created.length === 0 && /no rent day/.test(res.skipped[0].reason), JSON.stringify(res));
  void c;
});

console.log('\n— what each lease is offered —');
await check('a first part month (backlog) and this month’s whole month (current), with the next one after', async () => {
  const { candidate, on } = await portfolio();
  const cand = await candidate();
  assert(cand.state === 'ready', 'state ' + cand.state);
  const [stub, current] = cand.periods;
  assert(stub.kind === 'backlog' && stub.first_stub && stub.start === on(-2, 20) && stub.end === on(-1, 10), JSON.stringify(stub));
  assert(current.kind === 'current' && current.start === on(-1, 11) && current.end === on(0, 10) && current.amount === 30000,
         JSON.stringify(current));
  assert(cand.next.kind === 'future' && cand.next.start === on(0, 11) && cand.next.raise_from === on(1, 1), JSON.stringify(cand.next));
  assert(cand.joined && cand.joined.start === stub.start && cand.joined.end === current.end &&
         cand.joined.amount === Math.round((stub.amount + 30000) * 100) / 100, 'joined ' + JSON.stringify(cand.joined));
  assert(stub.lines.every(l => /^Rent · \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2} \(\d+\/\d+ days\)$/.test(l.text)),
         'part-month lines do not say their share: ' + stub.lines.map(l => l.text));
});

await check('a first part month must be chosen: on its own, or with the next invoice', async () => {
  const { must, c, candidate, entry, lease } = await portfolio();
  const cand = await candidate();
  const asked = await c('generateRent', { mode: 'issue', invoices: [entry(cand, cand.periods[0])] });
  assert(!asked.ok && /first part month/.test(asked.error), 'billed without asking: ' + JSON.stringify(asked));
  const joined = await must('generateRent', { mode: 'issue',
    invoices: [entry(cand, cand.joined, { join_first: true })] });
  const inv = joined.created[0];
  assert(inv.period_start === cand.periods[0].start && inv.period_end === cand.periods[1].end, 'period ' + inv.period_start + '..' + inv.period_end);
  assert(inv.total === cand.joined.amount && inv.due_date === cand.periods[1].end, 'total ' + inv.total + ' due ' + inv.due_date);
  const after = await candidate(lease.id);
  assert(after.state === 'billed' && after.periods.length === 0 && after.last_billed.invoice_id === inv.id, JSON.stringify(after));
});

await check('the part month billed on its own, then this month separately', async () => {
  const { must, candidate, entry } = await portfolio();
  const cand = await candidate();
  const res = await must('generateRent', { mode: 'issue', invoices: [
    entry(cand, cand.periods[0], { join_first: false }), entry(cand, cand.periods[1])] });
  assert(res.created.length === 2 && res.skipped.length === 0, JSON.stringify(res.skipped));
  assert(res.created.every(i => i.type === 'Rent' && i.issue_date), 'not issued Rent invoices');
});

await check('the joined invoice and the month inside it cannot both be billed at once', async () => {
  const { must, candidate, entry } = await portfolio();
  const cand = await candidate();
  const res = await must('generateRent', { mode: 'issue', invoices: [
    entry(cand, cand.joined, { join_first: true }), entry(cand, cand.periods[1])] });
  assert(res.created.length === 1 && res.skipped.length === 1, 'created ' + res.created.length);
});

await check('nothing is billed twice: a second run skips the period and names the invoice', async () => {
  const { must, candidate, entry } = await portfolio();
  const cand = await candidate();
  const e = entry(cand, cand.periods[1]);
  const first = await must('generateRent', { mode: 'issue', invoices: [e] });
  const second = await must('generateRent', { mode: 'issue', invoices: [e] });
  assert(second.created.length === 0, 'billed twice');
  assert(second.skipped[0].reason.includes(first.created[0].id), second.skipped[0].reason);
});

await check('a voided rent invoice still counts its period as billed', async () => {
  const { must, candidate, entry } = await portfolio();
  const cand = await candidate();
  const inv = (await must('generateRent', { mode: 'issue', invoices: [entry(cand, cand.periods[1])] })).created[0];
  await must('voidInvoice', { id: inv.id, reason: 'raised in error' });
  const after = await candidate();
  assert(!after.periods.some(p => p.start === cand.periods[1].start), 'the voided period is offered again');
});

await check('a lease changed after the screen opened is skipped, not billed at a figure nobody saw', async () => {
  const { must, candidate, entry, lease } = await portfolio();
  const cand = await candidate();
  await must('update', { table: 'Leases', id: lease.id, data: { rent_amount: 32000 } });
  const res = await must('generateRent', { mode: 'issue', invoices: [entry(cand, cand.periods[1])] });
  assert(res.created.length === 0 && /changed after you opened/.test(res.skipped[0].reason), JSON.stringify(res.skipped));
});

await check('an older period missed between billed ones is offered as backlog', async () => {
  const { must, candidate, entry } = await portfolio();
  const cand = await candidate();
  await must('generateRent', { mode: 'issue', invoices: [entry(cand, cand.periods[1])] });
  const after = await candidate();
  assert(after.state === 'backlog' && after.periods.length === 1 && after.periods[0].start === cand.periods[0].start,
         JSON.stringify(after.periods));
});

console.log('\n— drafts, charges and adjustments —');
await check('drafts: not issued, no issue date, nothing owed; issuing dates them today', async () => {
  const { must, candidate, entry, today, box } = await portfolio();
  const cand = await candidate();
  const res = await must('generateRent', { mode: 'draft', invoices: [entry(cand, cand.periods[1])] });
  const d = res.created[0];
  assert(d.status === 'Draft' && !d.issue_date, 'status ' + d.status + ', issue ' + d.issue_date);
  assert((await candidate()).periods.every(p => p.start !== cand.periods[1].start), 'a drafted period is offered again');
  const issued = await must('issueDrafts', { ids: [d.id] });
  const row = (await box.readTable('Invoices')).find(i => i.id === d.id);
  assert(issued.issued.length === 1 && row.issue_date === today && ['Unpaid', 'Overdue'].includes(row.status),
         'issued as ' + row.status + ' on ' + row.issue_date);
});

await check('extra charges: EB as units × rate, GST per line, and the rate suggested next time', async () => {
  const { must, candidate, entry, box } = await portfolio({ gst_rate: 18 });
  const cand = await candidate();
  const res = await must('generateRent', { mode: 'issue', invoices: [entry(cand, cand.periods[1], {
    extras: [{ description: 'Electricity · 142 units @ 8', category: 'Electricity', quantity: 142, unit_amount: 8, tax_rate: 0 }] })] });
  const inv = res.created[0];
  // 30000 rent + 18% GST on rent only, + 1136 EB
  assert(inv.amount === 31136 && inv.tax === 5400 && inv.total === 36536, `amount ${inv.amount} tax ${inv.tax} total ${inv.total}`);
  assert(inv.cgst === 2700 && inv.sgst === 2700, 'GST split ' + inv.cgst + '/' + inv.sgst);
  const eb = (await box.readTable('InvoiceItems')).find(i => i.invoice_id === inv.id && i.category === 'Electricity');
  assert(eb && Number(eb.amount) === 1136, 'EB line ' + JSON.stringify(eb));
  assert((await candidate()).last_eb_rate === 8, 'EB rate not suggested');
});

await check('an extra line cannot be rent, a late fee or a deposit', async () => {
  const { c, candidate, entry } = await portfolio();
  const cand = await candidate();
  const res = await c('generateRent', { mode: 'issue', invoices: [entry(cand, cand.periods[1], {
    extras: [{ description: 'more rent', category: 'Rent', quantity: 1, unit_amount: 5 }] })] });
  assert(!res.ok && /cannot be added as an extra/.test(res.error), JSON.stringify(res));
});

await check('a rent adjustment needs a reason, is its own line, and is logged', async () => {
  const { c, must, candidate, entry, box } = await portfolio();
  const cand = await candidate();
  const noReason = await c('generateRent', { mode: 'issue', invoices: [entry(cand, cand.periods[1], { adjust: { amount: 28000 } })] });
  assert(!noReason.ok && /reason/.test(noReason.error), 'accepted without a reason');
  const res = await must('generateRent', { mode: 'issue', invoices: [entry(cand, cand.periods[1], {
    adjust: { amount: 28000, reason: 'agreed discount' } })] });
  const inv = res.created[0];
  assert(inv.total === 28000, 'total ' + inv.total);
  const lines = (await box.readTable('InvoiceItems')).filter(i => i.invoice_id === inv.id);
  const adj = lines.find(l => l.description === 'Rent adjustment');
  assert(adj && Number(adj.amount) === -2000 && /30000 to 28000: agreed discount/.test(adj.notes), JSON.stringify(adj));
  assert(lines.some(l => Number(l.amount) === 30000), 'the calculated rent line is gone');
  const logged = (await box.readTable('ActivityLog')).some(a => a.action === 'rent-adjusted' && a.entity_id === inv.id);
  assert(logged, 'no rent-adjusted entry in the activity log');
});

console.log('\n— late fees —');
/** An overdue rent invoice, issued and due a month ago, past its grace. */
async function overdueRent(p) {
  const { must, lease, on } = p;
  const inv = (await must('saveInvoice', { data: { tenant_id: lease.tenant_id, lease_id: lease.id, unit_id: lease.unit_id,
    issue_date: on(-1, 1), due_date: on(-1, 10), period_start: on(-2, 20), period_end: on(-1, 10) },
    items: [{ description: 'Rent', category: 'Rent', quantity: 1, unit_amount: 21000 }] })).invoice;
  return inv;
}

await check('the daily job adds no late fee; the next invoice offers it, unticked, and carries it when ticked', async () => {
  const p = await portfolio();
  const { must, candidate, entry, box } = p;
  const old = await overdueRent(p);
  await box.dailyMaintenanceJob();
  assert(!(await box.readTable('InvoiceItems')).some(i => i.category === 'Late Fee'), 'the daily job charged a fee');
  const cand = await candidate();
  assert(cand.late_fees.length === 1 && cand.late_fees[0].invoice_id === old.id && cand.late_fees[0].fee === 500,
         JSON.stringify(cand.late_fees));
  // not ticked: nothing charged, and it is offered again (the draft is then thrown away)
  const draft = (await must('generateRent', { mode: 'draft', invoices: [entry(cand, cand.periods[0])] })).created[0];
  await must('remove', { table: 'Invoices', id: draft.id });
  const again = await candidate();
  assert(again.late_fees.length === 1, 'an unticked fee was not offered again');
  // ticked: a line on the new invoice, naming the overdue one
  const res = await must('generateRent', { mode: 'issue', invoices: [entry(again, again.periods[0], { late_fees: [old.id] })] });
  const fee = (await box.readTable('InvoiceItems')).find(i => i.invoice_id === res.created[0].id && i.category === 'Late Fee');
  assert(fee && fee.late_fee_for === old.id && Number(fee.amount) === 500, JSON.stringify(fee));
  assert((await candidate()).late_fees.length === 0, 'the charged fee is still offered');
});

await check('an invoice raised after its due date gets its grace from the day it was issued', async () => {
  const { must, candidate, entry, box } = await portfolio({ grace_days: 5 });
  const cand = await candidate();
  // the part month was due last month; raised today, its grace runs from today
  const res = await must('generateRent', { mode: 'issue', invoices: [entry(cand, cand.periods[0], { join_first: false })] });
  const inv = res.created[0];
  assert(inv.status === 'Overdue', 'status ' + inv.status);
  assert((await candidate()).late_fees.every(f => f.invoice_id !== inv.id), 'a fee is offered inside the grace');
  const charge = await box.handle('chargeLateFee', { invoice_id: inv.id }, (await bootedAdmin(box)));
  assert(!charge.ok && /grace days/.test(charge.error), 'charged inside the grace: ' + charge.error);
});

await check('waived for good, with a reason: never offered again, and cannot then be charged', async () => {
  const p = await portfolio();
  const { c, must, candidate, box } = p;
  const old = await overdueRent(p);
  const noReason = await c('waiveLateFee', { invoice_id: old.id });
  assert(!noReason.ok, 'waived without a reason');
  await must('waiveLateFee', { invoice_id: old.id, reason: 'hospital stay' });
  assert((await candidate()).late_fees.length === 0, 'a waived fee is still offered');
  const charge = await c('chargeLateFee', { invoice_id: old.id });
  assert(!charge.ok && /waived/.test(charge.error), 'charged after waiving');
  assert((await box.readTable('ActivityLog')).some(a => a.action === 'late-fee-waived'), 'not logged');
});

await check('the invoice page shows where its late fee stands', async () => {
  const p = await portfolio();
  const old = await overdueRent(p);
  const d = await p.must('detail', { table: 'Invoices', id: old.id });
  assert(d.late_fee && d.late_fee.eligible && d.late_fee.fee === 500, JSON.stringify(d.late_fee));
});

console.log('\n— billed outside the app —');
await check('marking a period needs a reason, stops it being offered, and can be undone', async () => {
  const { c, must, candidate, lease, box } = await portfolio();
  const cand = await candidate();
  const stub = cand.periods[0];
  const noReason = await c('markRentOffline', { lease_id: lease.id, period_starts: [stub.start] });
  assert(!noReason.ok, 'marked without a reason');
  const marked = (await must('markRentOffline', { lease_id: lease.id, period_starts: [stub.start],
                                                  reason: 'collected in cash before the app' })).marked[0];
  const after = await candidate();
  assert(!after.periods.some(p => p.start === stub.start), 'still offered');
  assert(after.offline.length === 1 && after.offline[0].reason === 'collected in cash before the app', JSON.stringify(after.offline));
  assert((await box.readTable('Invoices')).every(i => i.type !== 'Rent'), 'an invoice was created');
  await must('undoRentOffline', { id: marked.id });
  assert((await candidate()).periods.some(p => p.start === stub.start), 'not offered again after undo');
});

await check('the generic API cannot write those records directly', async () => {
  const { c, lease } = await portfolio();
  const res = await c('create', { table: 'RentOffline', data: { lease_id: lease.id, period_start: '2020-01-01',
                                                                 period_end: '2020-01-31', reason: 'x' } });
  assert(!res.ok, 'created through the generic API');
});

console.log('\n— other leases —');
await check('terminated with no end date: not billed until the move-out date is set', async () => {
  const { must, candidate, lease, on } = await portfolio();
  await must('update', { table: 'Leases', id: lease.id, data: { status: 'Terminated' } });
  assert((await candidate()).state === 'open_termination', 'billed a terminated lease with no end');
  await must('update', { table: 'Leases', id: lease.id, data: { end_date: on(0, 5) } });
  const cand = await candidate();
  const final = cand.periods.find(p => p.final);
  assert(final && final.end === on(0, 5), 'no final bill to the end date: ' + JSON.stringify(cand.periods));
});

await check('quarterly: three rent-day cycles on one invoice, three times the monthly rent', async () => {
  const { must, prop, units, people, candidate, on } = await portfolio();
  const q = (await must('create', { table: 'Leases', data: { property_id: prop.id, unit_id: units[1].id,
    tenant_id: people[1].id, start_date: on(-3, 11), rent_amount: 10000, rent_day: 10, frequency: 'Quarterly' } })).row;
  const cand = await candidate(q.id);
  const first = cand.periods[0] || cand.next;
  assert(first.start === on(-3, 11) && first.end === on(0, 10) && first.amount === 30000, JSON.stringify(first));
});

await check('a rent invoice with no period is listed so it can be checked against the offer', async () => {
  const { must, candidate, lease } = await portfolio();
  const inv = (await must('saveInvoice', { data: { tenant_id: lease.tenant_id, lease_id: lease.id, due_date: '2030-01-01' },
    items: [{ description: 'Rent', category: 'Rent', quantity: 1, unit_amount: 30000 }] })).invoice;
  assert((await candidate()).unperioded.some(u => u.id === inv.id), 'not listed');
});

await check('invoices are numbered by property, then unit', async () => {
  const { must, prop, units, people, candidates, entry, on } = await portfolio();
  // B-lease on A-103 created first, A-102 second: numbering must still follow the units
  for (const [u, t] of [[units[2], people[2]], [units[1], people[1]]]) {
    await must('create', { table: 'Leases', data: { property_id: prop.id, unit_id: u.id, tenant_id: t.id,
      start_date: on(-1, 11), rent_amount: 1000, rent_day: 10 } });
  }
  const list = await candidates();
  const current = list.flatMap(cand => cand.periods.filter(p => p.kind === 'current').map(p => entry(cand, p))).reverse();
  const res = await must('generateRent', { mode: 'issue', invoices: current });
  const unitsInOrder = res.created.map(i => i.unit_id);
  assert(JSON.stringify(unitsInOrder) === JSON.stringify(units.map(u => u.id)), unitsInOrder.join(', '));
  const ids = res.created.map(i => i.id);
  assert(JSON.stringify([...ids].sort()) === JSON.stringify(ids), 'numbers out of order: ' + ids.join(', '));
});

console.log('\n— who may —');
await check('a viewer cannot see or generate rent', async () => {
  const { box, must, c, lease } = await portfolio();
  await must('createUser', { name: 'V', phone: '9000000002', password: 'viewer-pass-123', role: 'viewer' });
  const login = await c('login', { phone: '9000000002', password: 'viewer-pass-123' }, '');
  const token = login.data.token;
  assert(!(await c('rentCandidates', {}, token)).ok, 'a viewer listed rent candidates');
  assert(!(await c('generateRent', { mode: 'issue', invoices: [{ lease_id: lease.id }] }, token)).ok, 'a viewer generated rent');
  void box;
});

/** The admin token for a sandbox, signing in again. */
async function bootedAdmin(box) {
  return (await box.handle('login', { phone: '9000000001', password: 'correct-horse' }, '')).data.token;
}

await closeAll();
console.log('\n' + '─'.repeat(56));
console.log(failures ? `${failures} RENT CHECK(S) FAILED, ${passed} passed` : `ALL ${passed} RENT CHECKS PASSED`);
process.exit(failures ? 1 : 0);
