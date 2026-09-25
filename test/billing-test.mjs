/**
 * The pure date and billing logic of the backend — rent periods (rent.js),
 * rent days and late-fee grace — no database needed.
 *
 * The rent-period checks are the worked examples agreed for Generate rent
 * (docs/RENT_GENERATION.md), run against a fixed "today".
 */
import { monthsBetween, round2, parseDate, validRentDay, lateFeeFrom } from '../supabase/functions/api/backend.js';
import { rentPeriods, joinFirstStub, rentOn, unbilledGaps } from '../supabase/functions/api/rent.js';

let pass = 0, fail = 0;
/** Compare only the keys the expectation names, so added detail is not a failure. */
const subset = (actual, expected) => {
  if (Array.isArray(expected) || typeof expected !== 'object' || expected === null) return actual;
  const out = {};
  for (const k of Object.keys(expected)) out[k] = actual ? actual[k] : undefined;
  return out;
};

const eq = (name, actual, expected) => {
  const a = JSON.stringify(subset(actual, expected)), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + '\n      expected ' + e + '\n      got      ' + a); }
};

/** A period as the tests compare it: its dates, kind and amount. */
const brief = (p) => p && [p.kind, p.start, p.end, p.due, p.amount];
const lines = (p) => p.lines.map(l => [l.start, l.end, l.days, l.monthDays, l.amount]);

console.log('\n— date helpers —');
eq('monthsBetween', monthsBetween(parseDate('2025-04-01'), parseDate('2026-07-01')), 15);
eq('round2', round2(1234.5678), 1234.57);

console.log('\n— rent day and late-fee grace —');
const rd = (over) => ({ id: 'RD', frequency: 'Monthly', rent_amount: 30000, grace_days: 5, escalation_pct: 0, rent_day: 10, ...over });

eq('grace days follow the due date: due the 10th with 5 days’ grace, the late fee is from the 16th',
   lateFeeFrom(rd({}), { due_date: '2026-10-10', issue_date: '2026-10-01' }), '2026-10-16');
eq('no grace days: the late fee is from the day after the due date',
   lateFeeFrom(rd({ grace_days: '' }), { due_date: '2026-10-10' }), '2026-10-11');
eq('an invoice raised after its due date: the grace days count from the day it was issued',
   lateFeeFrom(rd({}), { due_date: '2026-09-10', issue_date: '2026-09-25' }), '2026-10-01');
eq('valid rent days are the 1st–28th and 31 (last day)',
   [0, 1, 28, 29, 30, 31, '10', '', null, 'x', 10.5].map(validRentDay), [null, 1, 28, null, null, 31, 10, null, null, null, null]);

console.log('\n— rent periods: the agreed examples, run on 25 Sep 2026 —');
const L = (over) => ({ rent_amount: 30000, escalation_pct: 0, frequency: 'Monthly', rent_day: 10, grace_days: 5, ...over });
const asOf = '2026-09-25';

{
  const ps = rentPeriods(L({ start_date: '2026-08-20' }), { asOf });
  eq('A · moved in 20 Aug, rent day 10: the first invoice is 20 Aug – 10 Sep, due 10 Sep, ₹21,612.90',
     brief(ps[0]), ['current', '2026-08-20', '2026-09-10', '2026-09-10', 21612.9]);
  eq('A · a part month is charged day by day at each month’s own length, one line per month',
     lines(ps[0]), [['2026-08-20', '2026-08-31', 12, 31, 11612.9], ['2026-09-01', '2026-09-10', 10, 30, 10000]]);
  eq('A · it opens the lease, so the screen asks how to bill it', ps[0].first_stub, true);
  eq('A · the next invoice, 11 Sep – 10 Oct, is a whole month, raisable from 1 Oct',
     [...brief(ps[1]), ps[1].raise_from], ['future', '2026-09-11', '2026-10-10', '2026-10-10', 30000, '2026-10-01']);
  eq('A · nothing after the first invoice not yet due', ps.length, 2);
}
{
  const ps = rentPeriods(L({ start_date: '2026-01-05', rent_day: 5 }), { asOf, billed: [{ start: '2026-01-05', end: '2026-09-05' }] });
  eq('B · billed to 5 Sep: nothing raisable until 1 Oct', ps.map(brief), [['future', '2026-09-06', '2026-10-05', '2026-10-05', 30000]]);
}
{
  const ps = rentPeriods(L({ start_date: '2026-01-29', rent_day: 28, rent_amount: 25000 }),
                        { asOf, billed: [{ start: '2026-01-29', end: '2026-08-28' }] });
  eq('C · rent day 28: 29 Aug – 28 Sep is due this month', brief(ps[0]), ['current', '2026-08-29', '2026-09-28', '2026-09-28', 25000]);
}
{
  const ps = rentPeriods(L({ start_date: '2026-06-02', rent_day: 1, rent_amount: 20000 }), { asOf });
  eq('D · never billed since June: older months are backlog, the one due this month is current',
     ps.map(p => [p.kind, p.start, p.end]),
     [['backlog', '2026-06-02', '2026-07-01'], ['backlog', '2026-07-02', '2026-08-01'],
      ['current', '2026-08-02', '2026-09-01'], ['future', '2026-09-02', '2026-10-01']]);
}
{
  const ps = rentPeriods(L({ start_date: '2026-01-11', end_date: '2026-09-20', rent_amount: 18000 }),
                        { asOf, billed: [{ start: '2026-01-11', end: '2026-09-10' }] });
  eq('G · ended 20 Sep: the final bill is 11–20 Sep, 10/30 of the rent, due on the last day',
     [...brief(ps[0]), ps[0].final], ['current', '2026-09-11', '2026-09-20', '2026-09-20', 6000, true]);
  eq('G · and nothing after it', ps.length, 1);
}
{
  const ps = rentPeriods(L({ start_date: '2026-07-20', frequency: 'Quarterly' }), { asOf: '2026-10-02' });
  eq('quarterly · three rent-day cycles on one invoice: 20 Jul – 10 Oct, due 10 Oct',
     brief(ps[0]), ['current', '2026-07-20', '2026-10-10', '2026-10-10', 81290.32]);
  eq('quarterly · the next is 11 Oct – 10 Jan, three whole months',
     brief(ps[1]), ['future', '2026-10-11', '2027-01-10', '2027-01-10', 90000]);
  eq('quarterly · a first part month is not asked about: it is one of the three cycles', ps[0].first_stub, false);
}
{
  const ps = rentPeriods(L({ start_date: '2026-09-08' }), { asOf });
  eq('a lease from 8 Sep: 8–10 Sep on its own is 3/30 of the rent', brief(ps[0]), ['current', '2026-09-08', '2026-09-10', '2026-09-10', 3000]);
  const joined = joinFirstStub(ps);
  eq('…or joined with the next invoice: 8 Sep – 10 Oct, due 10 Oct, raisable from 1 Oct',
     [joined.kind, joined.start, joined.end, joined.due, joined.amount, joined.raise_from],
     ['future', '2026-09-08', '2026-10-10', '2026-10-10', 33000, '2026-10-01']);
  eq('nothing to join once the first part month is billed',
     joinFirstStub(rentPeriods(L({ start_date: '2026-09-08' }), { asOf, billed: [{ start: '2026-09-08', end: '2026-09-10' }] })), null);
}
{
  const ps = rentPeriods(L({ start_date: '2026-01-31', rent_day: 31 }), { asOf: '2026-04-05' });
  eq('rent day 31 is the last day of every month, February included',
     ps.slice(1).map(p => [p.start, p.end, p.amount]),
     [['2026-02-01', '2026-02-28', 30000], ['2026-03-01', '2026-03-31', 30000], ['2026-04-01', '2026-04-30', 30000], ['2026-05-01', '2026-05-31', 30000]]);
}
{
  const ps = rentPeriods(L({ start_date: '2026-06-11' }), { asOf,
    billed: [{ start: '2026-06-11', end: '2026-07-10' }, { start: '2026-08-11', end: '2026-09-10' }] });
  eq('a month missed between two billed ones is offered, not skipped',
     ps.map(p => [p.kind, p.start, p.end]), [['backlog', '2026-07-11', '2026-08-10'], ['future', '2026-09-11', '2026-10-10']]);
}
{
  const ps = rentPeriods(L({ start_date: '2026-01-01' }), { asOf, billed: [{ start: '2026-01-01', end: '2026-08-04' }] });
  eq('billing that stopped on another day carries on from there: a part cycle up to the next rent day, then whole ones',
     ps.map(brief),
     [['backlog', '2026-08-05', '2026-08-10', '2026-08-10', 5806.45], ['current', '2026-08-11', '2026-09-10', '2026-09-10', 30000],
      ['future', '2026-09-11', '2026-10-10', '2026-10-10', 30000]]);
}
{
  const ps = rentPeriods(L({ start_date: '2025-09-11', escalation_pct: 5 }), { asOf: '2026-10-02',
    billed: [{ start: '2025-09-11', end: '2026-08-10' }] });
  eq('escalation: a cycle starting on or after the anniversary is at the raised rent',
     ps.map(p => [p.start, p.amount]), [['2026-08-11', 30000], ['2026-09-11', 31500], ['2026-10-11', 31500]]);
  eq('rentOn matches the rent in force', [rentOn(L({ start_date: '2025-09-11', escalation_pct: 5 }), '2026-09-10'),
                                          rentOn(L({ start_date: '2025-09-11', escalation_pct: 5 }), '2026-09-11')], [30000, 31500]);
}
eq('no rent day, no periods', rentPeriods(L({ start_date: '2026-01-01', rent_day: '' }), { asOf }), []);
eq('gaps: a fully billed ended lease has none',
   unbilledGaps({ start_date: '2026-01-01', end_date: '2026-03-31' }, [{ start: '2026-01-01', end: '2026-03-31' }]), []);

console.log('\n' + '─'.repeat(56));
console.log(fail ? `${fail} FAILED, ${pass} passed` : `ALL ${pass} BACKEND CHECKS PASSED`);
process.exit(fail ? 1 : 0);
