/**
 * Rent periods — the arithmetic behind Generate rent, with no database.
 *
 * Rent is billed for the time already lived (in arrears), on the lease's rent
 * day. With rent day 10:
 *
 *   a cycle      runs from the day after one rent day to the next rent day:
 *                11 Sep – 10 Oct, due 10 Oct
 *   a whole one  is one month's rent, whatever the month's length
 *   a part one   (the first days from move-in, the last days before move-out,
 *                or wherever earlier billing stopped) is charged day by day,
 *                each calendar month at the rent divided by its own days:
 *                20 Aug – 10 Sep = 12/31 of the rent + 10/30 of the rent
 *   rent day 31  means the last day of every month
 *
 * A monthly lease is billed one cycle per invoice. Quarterly, half-yearly and
 * yearly leases bundle 3, 6 or 12 consecutive cycles into one invoice, due on
 * the last cycle's rent day.
 *
 * What is already billed is given as date ranges (rent invoices, void or not,
 * and periods marked as billed outside the app). Only the days between them
 * are offered, so nothing is billed twice and a gap is never skipped.
 *
 * An invoice can be raised from the 1st of the month it is due in. Measured
 * against the day Generate rent is run:
 *   backlog  due before this month — never billed, offered unticked
 *   current  due this month
 *   future   due after this month — not raisable yet
 *
 * Dates are yyyy-MM-dd strings at the edges and local-midnight Dates inside,
 * built from y/m/d parts so no time zone can shift a day.
 */

export const CYCLES_PER_INVOICE = { Monthly: 1, Quarterly: 3, 'Half-Yearly': 6, Yearly: 12 };

/** Enough for a hundred years of monthly cycles; a guard against bad input, not a limit anyone meets. */
const MAX_CYCLES = 1200;

// ── dates ───────────────────────────────────────────────────────────────────

export function day(v) {
  if (!v) return null;
  if (v instanceof Date) return new Date(v.getFullYear(), v.getMonth(), v.getDate());
  const m = String(v).slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

export function iso(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

const plusDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const lastOfMonth = (d) => new Date(d.getFullYear(), d.getMonth() + 1, 0);
const firstOfMonth = (d) => new Date(d.getFullYear(), d.getMonth(), 1);
const daysIncl = (a, b) => Math.round((b - a) / 86400000) + 1;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// ── rent day and rent ───────────────────────────────────────────────────────

/** 1–28, or 31 for "the last day of the month"; anything else is no rent day. */
export function validRentDay(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isInteger(n) && ((n >= 1 && n <= 28) || n === 31) ? n : null;
}

/** The rent day in a month; months may overflow (-1 is last December). */
export function rentDayIn(year, month, rentDay) {
  const first = new Date(year, month, 1);
  return new Date(first.getFullYear(), first.getMonth(), Math.min(rentDay, lastOfMonth(first).getDate()));
}

/**
 * The monthly rent in force on a date: the lease rent, raised by the annual
 * escalation on each anniversary of the lease start.
 */
export function rentOn(lease, onDate) {
  const base = Number(lease.rent_amount) || 0;
  const pct = Number(lease.escalation_pct) || 0;
  const start = day(lease.start_date), at = day(onDate);
  if (!pct || !start || !at || at < start) return round2(base);
  const months = (at.getFullYear() - start.getFullYear()) * 12 + (at.getMonth() - start.getMonth()) -
                 (at.getDate() < start.getDate() ? 1 : 0);
  return round2(base * Math.pow(1 + pct / 100, Math.floor(Math.max(0, months) / 12)));
}

// ── cycles ──────────────────────────────────────────────────────────────────

/**
 * The cycle that starts on `from` and ends on the next rent day, or on `until`
 * when that comes first. Its lines say how it is charged.
 */
export function cycleFrom(lease, from, until, rentDay) {
  let close = rentDayIn(from.getFullYear(), from.getMonth(), rentDay);
  if (close < from) close = rentDayIn(from.getFullYear(), from.getMonth() + 1, rentDay);
  const end = until && until < close ? until : close;
  const opened = plusDays(rentDayIn(close.getFullYear(), close.getMonth() - 1, rentDay), 1);
  const whole = +from === +opened && +end === +close;
  const rent = rentOn(lease, from);

  const lines = [];
  if (whole) {
    lines.push({ start: iso(from), end: iso(end), days: daysIncl(from, end), monthDays: null, rent, amount: rent });
  } else {
    for (let at = from; at <= end;) {
      const monthEnd = lastOfMonth(at);
      const to = monthEnd < end ? monthEnd : end;
      const days = daysIncl(at, to), monthDays = monthEnd.getDate();
      lines.push({ start: iso(at), end: iso(to), days, monthDays, rent, amount: round2(rent * days / monthDays) });
      at = plusDays(to, 1);
    }
  }
  return { start: iso(from), end: iso(end), whole, rent, lines, amount: round2(lines.reduce((s, l) => s + l.amount, 0)) };
}

/**
 * The days of a lease no rent covers yet, as [start, end] Date pairs; `end` is
 * null for an open-ended lease. `billed` is a list of { start, end } ranges.
 */
export function unbilledGaps(lease, billed) {
  const start = day(lease.start_date);
  if (!start) return [];
  const leaseEnd = lease.end_date ? day(lease.end_date) : null;
  const ranges = (billed || [])
    .map(b => ({ s: day(b.start), e: day(b.end) }))
    .filter(b => b.s && b.e && b.e >= b.s)
    .sort((a, b) => a.s - b.s);

  const gaps = [];
  let cursor = start;
  for (const b of ranges) {
    if (leaseEnd && cursor > leaseEnd) break;
    if (b.e < cursor) continue;
    if (b.s > cursor) {
      const upTo = plusDays(b.s, -1);
      gaps.push([cursor, leaseEnd && leaseEnd < upTo ? leaseEnd : upTo]);
    }
    cursor = plusDays(b.e, 1);
  }
  if (!leaseEnd || cursor <= leaseEnd) gaps.push([cursor, leaseEnd]);
  return gaps;
}

// ── invoices-to-be ──────────────────────────────────────────────────────────

/**
 * Every unbilled invoice a lease has up to the end of `asOf`'s month, then the
 * first one after it (so the screen can say when the next is due). Each is
 *
 *   { start, end, due, raise_from, kind: 'backlog'|'current'|'future',
 *     cycles, lines, amount, first_stub, final }
 *
 * `first_stub` marks a part cycle that opens the lease itself: the screen asks
 * whether to bill it on its own or together with the next invoice.
 */
export function rentPeriods(lease, { billed = [], asOf } = {}) {
  const rentDay = validRentDay(lease.rent_day);
  const today = day(asOf);
  if (rentDay === null || !today || !day(lease.start_date)) return [];
  const per = CYCLES_PER_INVOICE[lease.frequency || 'Monthly'] || 1;
  const monthStart = firstOfMonth(today), horizon = lastOfMonth(today);
  const leaseStart = day(lease.start_date);
  const leaseEnd = lease.end_date ? day(lease.end_date) : null;

  const out = [];
  let count = 0, sawFuture = false;
  for (const [gapStart, gapEnd] of unbilledGaps(lease, billed)) {
    let at = gapStart, bundle = [];
    const emit = () => {
      const first = bundle[0], last = bundle[bundle.length - 1];
      const due = day(last.end);
      const kind = due < monthStart ? 'backlog' : due <= horizon ? 'current' : 'future';
      const lines = bundle.flatMap(c => c.lines);
      out.push({
        start: first.start, end: last.end, due: last.end, raise_from: iso(firstOfMonth(due)), kind,
        cycles: bundle, lines, amount: round2(lines.reduce((s, l) => s + l.amount, 0)),
        first_stub: per === 1 && !first.whole && +day(first.start) === +leaseStart,
        final: !!leaseEnd && +due === +leaseEnd
      });
      bundle = [];
      if (kind === 'future') sawFuture = true;
    };
    while ((!gapEnd || at <= gapEnd) && count < MAX_CYCLES && !sawFuture) {
      const cycle = cycleFrom(lease, at, gapEnd, rentDay);
      bundle.push(cycle);
      count++;
      at = plusDays(day(cycle.end), 1);
      if (bundle.length === per || (gapEnd && at > gapEnd)) emit();
    }
    if (bundle.length && !sawFuture) emit();
    if (sawFuture) break;
  }
  return out;
}

/**
 * A first part cycle billed together with the invoice after it: one invoice
 * from move-in to the second rent day. Null when there is nothing to join.
 */
export function joinFirstStub(periods) {
  const [stub, next] = periods;
  if (!stub || !stub.first_stub || !next || day(next.start) - plusDays(day(stub.end), 1) !== 0) return null;
  const lines = [...stub.lines, ...next.lines];
  return {
    ...next, start: stub.start, cycles: [...stub.cycles, ...next.cycles], lines,
    amount: round2(lines.reduce((s, l) => s + l.amount, 0)), first_stub: false, joined: true
  };
}

/** What a rent line says on the invoice: its dates, and for a part month its share. */
export function rentLineText(line) {
  return 'Rent · ' + line.start + ' to ' + line.end + (line.monthDays ? ' (' + line.days + '/' + line.monthDays + ' days)' : '');
}

/**
 * The first day a late fee may be charged on an overdue invoice: the grace
 * days count from its due date, or from the day it was issued when that is
 * later — an invoice raised after its due date cannot have been paid on time.
 */
export function lateFeeFrom(lease, invoice) {
  const due = day(invoice.due_date);
  if (!due) return '';
  const issued = day(invoice.issue_date);
  const from = issued && issued > due ? issued : due;
  return iso(plusDays(from, (parseInt(lease.grace_days || 0, 10) || 0) + 1));
}
