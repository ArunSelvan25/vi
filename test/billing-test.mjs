/**
 * The pure date and billing logic of the backend: rent periods, rent-day
 * cycles and part months, late-fee grace — no database needed.
 */
import { periodsFor, addMonths, monthsBetween, round2, parseDate, fmtDate,
         rentDayPeriods, validRentDay, usesRentDay, lateFeeFrom } from '../supabase/functions/api/backend.js';

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

console.log('\n— date helpers —');
eq('addMonths keeps day of month', fmtDate(addMonths(parseDate('2026-01-15'), 1)), '2026-02-15');
eq('addMonths clamps 31 Jan + 1 month to 28 Feb', fmtDate(addMonths(parseDate('2026-01-31'), 1)), '2026-02-28');
eq('addMonths handles leap Feb', fmtDate(addMonths(parseDate('2024-01-31'), 1)), '2024-02-29');
eq('addMonths crosses a year', fmtDate(addMonths(parseDate('2026-11-15'), 3)), '2027-02-15');
eq('monthsBetween', monthsBetween(parseDate('2025-04-01'), parseDate('2026-07-01')), 15);
eq('round2', round2(1234.5678), 1234.57);

console.log('\n— monthly rent periods —');
const monthly = {
  id: 'L1', start_date: '2026-01-01', end_date: '2026-12-31',
  rent_amount: 20000, frequency: 'Monthly', grace_days: 5, escalation_pct: 0
};
const p1 = periodsFor(monthly, '2026-03-15');
eq('generates 3 periods up to mid-March', p1.length, 3);
eq('first period', p1[0], { start: '2026-01-01', end: '2026-01-31', due: '2026-01-06', amount: 20000 });
eq('second period end respects month length', p1[1].end, '2026-02-28');
eq('third period', p1[2], { start: '2026-03-01', end: '2026-03-31', due: '2026-03-06', amount: 20000 });

console.log('\n— lease end truncates the final period —');
const shortLease = { id:'L2', start_date:'2026-01-01', end_date:'2026-02-10', rent_amount:10000,
                     frequency:'Monthly', grace_days:0, escalation_pct:0 };
const p2 = periodsFor(shortLease, '2026-06-01');
eq('stops at lease end', p2.length, 2);
eq('final period clipped to the end date', p2[1].end, '2026-02-10');

console.log('\n— quarterly billing —');
const quarterly = { id:'L3', start_date:'2026-01-01', end_date:'2026-12-31', rent_amount:15000,
                    frequency:'Quarterly', grace_days:10, escalation_pct:0 };
const p3 = periodsFor(quarterly, '2026-12-31');
eq('4 quarters in a year', p3.length, 4);
eq('quarter charges 3x monthly rent', p3[0].amount, 45000);
eq('quarter spans 3 months', [p3[0].start, p3[0].end], ['2026-01-01', '2026-03-31']);
eq('grace days push the due date', p3[0].due, '2026-01-11');

console.log('\n— annual escalation —');
const escalating = { id:'L4', start_date:'2025-01-01', end_date:'2027-12-31', rent_amount:10000,
                     frequency:'Monthly', grace_days:0, escalation_pct:10 };
const p4 = periodsFor(escalating, '2027-01-31');
eq('year 1 rent unchanged', p4[0].amount, 10000);
eq('year 2 rent +10%', round2(p4[12].amount), 11000);
eq('year 3 rent +10% compounded', round2(p4[24].amount), 12100);

console.log('\n— edge cases —');
eq('no start date yields nothing', periodsFor({ start_date: '' }, '2026-01-01'), []);
eq('future lease yields nothing yet',
   periodsFor({ id:'L5', start_date:'2027-01-01', rent_amount:5000, frequency:'Monthly' }, '2026-06-01').length, 0);
eq('open-ended lease (no end date) still bills',
   periodsFor({ id:'L6', start_date:'2026-01-01', end_date:'', rent_amount:5000,
                frequency:'Monthly', grace_days:0 }, '2026-04-15').length, 4);
const p7 = periodsFor({ id:'L7', start_date:'2026-01-31', end_date:'2026-12-31', rent_amount:1000,
                        frequency:'Monthly', grace_days:0 }, '2026-04-01');
eq('lease starting on the 31st does not drift', p7.map(x => x.start),
   ['2026-01-31','2026-02-28','2026-03-31']);

console.log('\n— rent day: due on a fixed day, raised from the 1st of that month —');
const rd = (over) => ({ id: 'RD', frequency: 'Monthly', rent_amount: 30000, grace_days: 5, escalation_pct: 0, rent_day: 10, ...over });

const ex = rentDayPeriods(rd({ start_date: '2026-09-21' }), '2026-11-10');
eq('the worked example raises two invoices by 10 Nov', ex.length, 2);
eq('first: 21 Sep–10 Oct, due on the rent day, dated the day it was raised', ex[0],
   { start: '2026-09-21', end: '2026-10-10', issue: '2026-11-10', due: '2026-10-10', amount: 19677.42, prorated: true });
eq('…each month charged by its own days: 10/30 of Sep, 10/31 of Oct',
   ex[0].lines.map(l => [l.start, l.end, l.days, l.monthDays, l.amount]),
   [['2026-09-21', '2026-09-30', 10, 30, 10000], ['2026-10-01', '2026-10-10', 10, 31, 9677.42]]);
eq('then a whole cycle, 11 Oct–10 Nov, is one month’s rent', ex[1],
   { start: '2026-10-11', end: '2026-11-10', due: '2026-11-10', amount: 30000, prorated: false });
eq('a whole cycle is a single line', ex[1].lines.length, 1);

eq('nothing is raised before the month the rent day falls in',
   rentDayPeriods(rd({ start_date: '2026-09-21' }), '2026-09-30').length, 0);
eq('from the 1st of that month it can be raised: dated that day, due on the 10th',
   rentDayPeriods(rd({ start_date: '2026-09-21' }), '2026-10-01')[0],
   { start: '2026-09-21', end: '2026-10-10', issue: '2026-10-01', due: '2026-10-10', amount: 19677.42 });
eq('on the 31st, next month’s rent is still not raised',
   rentDayPeriods(rd({ start_date: '2026-09-21' }), '2026-10-31').length, 1);
eq('grace days follow the due date: due the 10th with 5 days’ grace, the late fee is from the 16th',
   lateFeeFrom(rd({}), '2026-10-10'), '2026-10-16');
eq('starting the day after a rent day: no part month, the first invoice is a full month',
   rentDayPeriods(rd({ start_date: '2026-10-11' }), '2026-11-10')[0],
   { start: '2026-10-11', end: '2026-11-10', amount: 30000, prorated: false });
eq('starting on the rent day itself: that one day, then full months',
   rentDayPeriods(rd({ start_date: '2026-10-10' }), '2026-10-10')[0],
   { start: '2026-10-10', end: '2026-10-10', amount: 967.74, prorated: true });

const last = rentDayPeriods(rd({ start_date: '2027-01-15', rent_day: 31, rent_amount: 31000 }), '2027-03-31');
eq('"last day of month" follows each month’s length, February included',
   last.map(c => [c.end, c.amount]), [['2027-01-31', 17000], ['2027-02-28', 31000], ['2027-03-31', 31000]]);
eq('the 28th through a leap February stays whole months',
   rentDayPeriods(rd({ start_date: '2028-01-29', rent_day: 28 }), '2028-03-28').map(c => [c.start, c.end, c.amount]),
   [['2028-01-29', '2028-02-28', 30000], ['2028-02-29', '2028-03-28', 30000]]);

const ending = rentDayPeriods(rd({ start_date: '2026-10-11', end_date: '2027-01-20', rent_amount: 31000 }), '2027-02-01');
eq('a lease ending between rent days is billed to its end date, day by day',
   ending[ending.length - 1], { start: '2027-01-11', end: '2027-01-20', due: '2027-01-20', amount: 10000, prorated: true });
eq('…after three whole months', ending.length, 4);

const resumed = rentDayPeriods(rd({ start_date: '2026-09-20', rent_amount: 31000 }), '2026-11-10', '2026-10-19');
eq('a rent day set on a lease already billed to 19 Oct carries on from 20 Oct', resumed.map(c => [c.start, c.end, c.amount]),
   [['2026-10-20', '2026-11-10', 22333.33]]);
eq('…and a day already billed is never billed again',
   rentDayPeriods(rd({ start_date: '2026-09-21' }), '2026-11-10', '2026-11-10').length, 0);

const esc = rentDayPeriods(rd({ start_date: '2026-01-11', rent_amount: 10000, escalation_pct: 10 }), '2027-02-10');
eq('a cycle is charged at the rent in force on its first day (10% from the anniversary)',
   esc.slice(-2).map(c => [c.start, c.amount]), [['2026-12-11', 10000], ['2027-01-11', 11000]]);

eq('valid rent days are the 1st–28th and 31 (last day)',
   [0, 1, 28, 29, 30, 31, '10', '', null, 'x', 10.5].map(validRentDay), [null, 1, 28, null, null, 31, 10, null, null, null, null]);
eq('only a monthly lease bills on its rent day',
   [rd({ frequency: 'Quarterly' }), rd({ rent_day: '' }), rd({}), rd({ frequency: '' })].map(usesRentDay),
   [false, false, true, true]);

console.log('\n' + '─'.repeat(56));
console.log(fail ? `${fail} FAILED, ${pass} passed` : `ALL ${pass} BACKEND CHECKS PASSED`);
process.exit(fail ? 1 : 0);
