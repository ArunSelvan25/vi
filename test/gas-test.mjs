/**
 * Runs the pure date/billing logic out of Code.gs against stubbed Apps Script
 * globals, so the rent-period maths is verified before it ever hits Google.
 */
import fs from 'fs';
import vm from 'vm';

const src = fs.readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');

const pad = (n) => String(n).padStart(2, '0');
const sandbox = {
  Session: { getScriptTimeZone: () => 'Asia/Kolkata' },
  Utilities: {
    formatDate: (d, tz, fmt) => {
      if (fmt === 'yyyy-MM-dd') return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
      return d.toISOString();
    },
    getUuid: () => 'uuid-' + Math.random().toString(36).slice(2)
  },
  PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty: () => {} }) },
  SpreadsheetApp: {}, LockService: {}, MailApp: {}, ContentService: {},
  console
};
vm.createContext(sandbox);
vm.runInContext(src, sandbox);

const { periodsFor, addMonths, monthsBetween, round2, parseDate, fmtDate } = sandbox;

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

console.log('\n' + '─'.repeat(56));
console.log(fail ? `${fail} FAILED, ${pass} passed` : `ALL ${pass} BACKEND CHECKS PASSED`);
process.exit(fail ? 1 : 0);
