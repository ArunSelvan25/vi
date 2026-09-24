/**
 * The pure date and billing logic of the backend: rent days and late-fee
 * grace — no database needed.
 */
import { monthsBetween, round2, parseDate, validRentDay, usesRentDay, lateFeeFrom } from '../supabase/functions/api/backend.js';

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
eq('monthsBetween', monthsBetween(parseDate('2025-04-01'), parseDate('2026-07-01')), 15);
eq('round2', round2(1234.5678), 1234.57);

console.log('\n— rent day and late-fee grace —');
const rd = (over) => ({ id: 'RD', frequency: 'Monthly', rent_amount: 30000, grace_days: 5, escalation_pct: 0, rent_day: 10, ...over });

eq('grace days follow the due date: due the 10th with 5 days’ grace, the late fee is from the 16th',
   lateFeeFrom(rd({}), '2026-10-10'), '2026-10-16');
eq('no grace days: the late fee is from the day after the due date',
   lateFeeFrom(rd({ grace_days: '' }), '2026-10-10'), '2026-10-11');
eq('valid rent days are the 1st–28th and 31 (last day)',
   [0, 1, 28, 29, 30, 31, '10', '', null, 'x', 10.5].map(validRentDay), [null, 1, 28, null, null, 31, 10, null, null, null, null]);
eq('only a monthly lease has a rent day',
   [rd({ frequency: 'Quarterly' }), rd({ rent_day: '' }), rd({}), rd({ frequency: '' })].map(usesRentDay),
   [false, false, true, true]);

console.log('\n' + '─'.repeat(56));
console.log(fail ? `${fail} FAILED, ${pass} passed` : `ALL ${pass} BACKEND CHECKS PASSED`);
process.exit(fail ? 1 : 0);
