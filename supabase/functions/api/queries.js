/**
 * Server-side paging, and the figures the browser used to work out from whole
 * tables: a record's summary, the dashboard lists, the reports.
 *
 * The browser keeps the small tables — properties, units, tenants, leases —
 * and asks for the growing ones (invoices and their line items, payments,
 * expenses, maintenance, documents, the audit trail) a page at a time.
 *
 * Which rows belong to a property, unit, tenant, lease or invoice is defined
 * once, here, in SQL (SCOPES). A tab's rows and the totals above it come from
 * the same definition, so they cannot disagree.
 *
 * The money rules mirror the ones the browser used:
 *   income    a payment that does not settle a Deposit invoice
 *   spent     an expense that is not a Deposit Refund
 *   owed      the balance of an Unpaid, Partial or Overdue invoice
 */
import { TABLES } from './schema.js';
import { mapRow } from './db.js';

export const OPEN = ['Unpaid', 'Partial', 'Overdue'];
const ACTIVE_TICKET = ['Open', 'In Progress', 'On Hold'];

/** The most rows one page may hold, and one export. */
export const MAX_PAGE = 100;
export const MAX_EXPORT = 5000;

/**
 * The tables the browser pages through: their default order, the columns a
 * search looks in, and the names it matches through (a tenant's name finds
 * their invoices).
 */
export const PAGED = {
  Invoices:     { sort: 'due_date', dir: 'desc', refs: ['tenant', 'property', 'unit'],
                  search: ['id', 'type', 'status', 'notes', 'lease_id'] },
  InvoiceItems: { sort: 'seq', dir: 'asc', refs: [], search: ['description', 'category'] },
  Payments:     { sort: 'payment_date', dir: 'desc', refs: ['tenant', 'property'],
                  search: ['id', 'reference', 'method', 'notes', 'invoice_id', 'received_by'] },
  Maintenance:  { sort: 'reported_date', dir: 'desc', refs: ['property', 'unit', 'tenant'],
                  search: ['id', 'title', 'description', 'vendor_name', 'category', 'status', 'priority'] },
  Expenses:     { sort: 'date', dir: 'desc', refs: ['property', 'unit'],
                  search: ['id', 'description', 'vendor', 'category', 'reference', 'payment_method'] },
  Documents:    { sort: 'issue_date', dir: 'desc', refs: [],
                  search: ['id', 'title', 'category', 'notes', 'entity_type', 'entity_id'] },
  ActivityLog:  { sort: 'seq', dir: 'desc', refs: [],
                  search: ['actor', 'action', 'entity', 'entity_id', 'details'] }
};

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A payment that settles a security deposit is held for the tenant, not income. */
const isDeposit = (tx) => tx`exists (select 1 from invoices di where di.id = t.invoice_id and di.type = 'Deposit')`;

/** Columns worked out per row, beyond the table's own. */
const EXTRA = {
  Invoices: {
    select: (tx) => tx`, (select max(lp.payment_date) from payments lp where lp.invoice_id = t.id)::text as last_paid`,
    apply: (row, raw) => { row.last_paid = raw.last_paid || ''; },
    sortable: ['last_paid']
  },
  Payments: {
    select: (tx) => tx`, ${isDeposit(tx)} as _deposit`,
    apply: (row, raw) => { row._deposit = raw._deposit === true; },
    sortable: []
  }
};

/** A search matching the names people see in place of an id. */
const NAME_MATCH = {
  tenant:   (tx, like) => tx`t.tenant_id in (select id from tenants where full_name ilike ${like})`,
  property: (tx, like) => tx`t.property_id in (select id from properties where name ilike ${like})`,
  unit:     (tx, like) => tx`t.unit_id in (select id from units where unit_number ilike ${like})`
};

const docsOf = (tx, type, id) => tx`(t.entity_type = ${type} and t.entity_id = ${id})`;

/** Which rows of a table belong to a record. Anything not listed cannot be asked for. */
const SCOPES = {
  property: {
    Invoices:    (tx, id) => tx`t.property_id = ${id}`,
    Payments:    (tx, id) => tx`t.property_id = ${id}`,
    Maintenance: (tx, id) => tx`t.property_id = ${id}`,
    Expenses:    (tx, id) => tx`t.property_id = ${id}`,
    Documents:   (tx, id) => tx`(${docsOf(tx, 'Property', id)}
      or (t.entity_type = 'Unit' and t.entity_id in (select id from units where property_id = ${id}))
      or (t.entity_type = 'Lease' and t.entity_id in (select id from leases where property_id = ${id})))`
  },
  unit: {
    Invoices:    (tx, id) => tx`t.unit_id = ${id}`,
    // a payment belongs to the unit through the invoice it settles or the lease it was taken on
    Payments:    (tx, id) => tx`(t.invoice_id in (select id from invoices where unit_id = ${id})
      or t.lease_id in (select id from leases where unit_id = ${id}))`,
    Maintenance: (tx, id) => tx`t.unit_id = ${id}`,
    Expenses:    (tx, id) => tx`t.unit_id = ${id}`,
    Documents:   (tx, id) => tx`(${docsOf(tx, 'Unit', id)}
      or (t.entity_type = 'Lease' and t.entity_id in (select id from leases where unit_id = ${id})))`
  },
  tenant: {
    Invoices:    (tx, id) => tx`t.tenant_id = ${id}`,
    Payments:    (tx, id) => tx`t.tenant_id = ${id}`,
    Maintenance: (tx, id) => tx`t.tenant_id = ${id}`,
    // their own documents, and those of every lease they hold or share
    Documents:   (tx, id) => tx`(${docsOf(tx, 'Tenant', id)}
      or (t.entity_type = 'Lease' and (t.entity_id in (select id from leases where tenant_id = ${id})
                                       or t.entity_id in (select lease_id from lease_tenants where tenant_id = ${id}))))`
  },
  lease: {
    Invoices:    (tx, id) => tx`t.lease_id = ${id}`,
    Payments:    (tx, id) => tx`(t.lease_id = ${id} or t.invoice_id in (select id from invoices where lease_id = ${id}))`,
    Documents:   (tx, id) => docsOf(tx, 'Lease', id)
  },
  invoice: {
    Payments:     (tx, id) => tx`t.invoice_id = ${id}`,
    InvoiceItems: (tx, id) => tx`t.invoice_id = ${id}`
  }
};

/** Named filters the screens offer: Billing's figures, the open tickets, and so on. */
const PRESETS = {
  Invoices: {
    outstanding: (tx) => tx`t.status in ${tx(OPEN)}`,
    overdue:     (tx) => tx`t.status in ${tx(OPEN)} and t.due_date < current_date`,
    week:        (tx) => tx`t.status in ${tx(OPEN)} and t.due_date >= current_date and t.due_date <= current_date + 7`,
    unpaid:      (tx) => tx`t.status in ${tx(OPEN)} and t.balance > 0`,
    // what a deposit can be applied to at move-out
    arrears:     (tx) => tx`t.status in ${tx(OPEN)} and t.balance > 0 and t.type is distinct from 'Deposit'`
  },
  Payments: {
    month: (tx) => tx`to_char(t.payment_date, 'YYYY-MM') = to_char(current_date, 'YYYY-MM') and not ${isDeposit(tx)}`
  },
  Maintenance: {
    open: (tx) => tx`t.status in ${tx(ACTIVE_TICKET)}`
  },
  Documents: {
    expiring: (tx) => tx`t.expiry_date is not null and t.expiry_date <= current_date + 60`
  }
};

const all = (tx, parts, joiner) => parts.reduce((a, b) => (joiner === 'or' ? tx`${a} or ${b}` : tx`${a} and ${b}`));

function scopeWhere(tx, table, scope) {
  const make = SCOPES[scope.kind] && SCOPES[scope.kind][table];
  if (!make) throw new Error('Cannot list ' + table + ' for a ' + scope.kind);
  if (scope.id === undefined || scope.id === null || scope.id === '') throw new Error('A ' + scope.kind + ' id is required');
  return make(tx, String(scope.id));
}

export function hasScope(kind, table) {
  return !!(SCOPES[kind] && SCOPES[kind][table]);
}

function searchWhere(tx, table, q) {
  const def = PAGED[table];
  // % and _ in what was typed are matched literally
  const like = '%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
  const parts = def.search.map(c => tx`${tx(c)}::text ilike ${like}`);
  def.refs.forEach(ref => parts.push(NAME_MATCH[ref](tx, like)));
  return tx`(${all(tx, parts, 'or')})`;
}

function whereFor(tx, table, p) {
  const cols = TABLES[table].cols;
  const parts = [];
  if (p.scope) parts.push(scopeWhere(tx, table, p.scope));
  if (p.preset) {
    const make = PRESETS[table] && PRESETS[table][p.preset];
    if (!make) throw new Error('Unknown filter: ' + p.preset);
    parts.push(make(tx));
  }
  for (const [k, v] of Object.entries(p.filters || {})) {
    if (v === '' || v === null || v === undefined) continue;
    if (!Object.prototype.hasOwnProperty.call(cols, k)) throw new Error('Cannot filter ' + table + ' by ' + k);
    parts.push(tx`${tx(k)}::text = ${String(v)}`);
  }
  if (Array.isArray(p.ids)) {
    const ids = p.ids.slice(0, MAX_PAGE).map(String);
    parts.push(ids.length ? tx`t.id in ${tx(ids)}` : tx`false`);
  }
  const q = String(p.q || '').trim();
  if (q) parts.push(searchWhere(tx, table, q));
  return parts.length ? all(tx, parts, 'and') : tx`true`;
}

function orderFor(tx, table, p) {
  const def = PAGED[table];
  const extra = (EXTRA[table] && EXTRA[table].sortable) || [];
  const known = (c) => c === 'seq' || extra.includes(c) || Object.prototype.hasOwnProperty.call(TABLES[table].cols, c);
  const chosen = p.sort && known(p.sort);
  const col = chosen ? p.sort : def.sort;
  const dir = chosen ? (p.dir === 'desc' ? 'desc' : 'asc') : def.dir;
  // blanks first going up and last going down, as the browser sorted them;
  // rows that tie follow the order they were added in, the same way round
  return dir === 'asc'
    ? tx`order by ${tx(col)} asc nulls first, t.seq asc`
    : tx`order by ${tx(col)} desc nulls last, t.seq desc`;
}

/**
 * One page of a table.
 *
 * @param p.scope    { kind: property|unit|tenant|lease|invoice, id }
 * @param p.preset   a named filter (PRESETS)
 * @param p.filters  { column: value } — exact matches, as the list's dropdowns
 * @param p.q        free-text search
 * @param p.sort / p.dir
 * @param p.page / p.pageSize
 * @param p.export   allows a page as large as MAX_EXPORT, for CSV downloads
 * @param p.ids      only these rows (by id)
 */
export async function listPage(r, table, p = {}) {
  if (!PAGED[table]) throw new Error('Cannot page ' + table);
  const tx = r.tx;
  const where = whereFor(tx, table, p);
  const [{ n }] = await tx`select count(*)::int as n from ${tx(TABLES[table].sql)} t where ${where}`;
  const total = Number(n) || 0;

  const pageSize = Math.max(1, Math.min(parseInt(p.pageSize, 10) || 25, p.export ? MAX_EXPORT : MAX_PAGE));
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, parseInt(p.page, 10) || 1), pages);
  const extra = EXTRA[table];

  const raw = await tx`
    select t.* ${extra ? extra.select(tx) : tx``}
    from ${tx(TABLES[table].sql)} t
    where ${where}
    ${orderFor(tx, table, p)}
    limit ${pageSize} offset ${(page - 1) * pageSize}`;
  const rows = raw.map(x => {
    const row = mapRow(table, x);
    if (extra) extra.apply(row, x);
    return row;
  });

  return { rows, total, page, pageSize, refs: await refsFor(r, table, rows) };
}

/** The growing tables the global search looks in, in the order it lists them. */
export const SEARCHED = ['Invoices', 'Payments', 'Maintenance', 'Expenses', 'Documents'];

/**
 * The global search: the first `limit` matches in each table `tables` names,
 * with how many match in all, searched as each list's own search box does.
 */
export async function searchAll(r, q, limit, tables = SEARCHED) {
  const out = {};
  for (const table of tables) {
    const { rows, total, refs } = await listPage(r, table, { q, pageSize: limit });
    out[table] = { rows, total, refs };
  }
  return out;
}

/**
 * Rows a page points at that the browser does not keep: the invoice a payment
 * settles, so the page can name it.
 */
async function refsFor(r, table, rows) {
  if (table !== 'Payments') return {};
  const ids = [...new Set(rows.map(x => x.invoice_id).filter(Boolean))];
  const invoices = [];
  // an export can point at thousands; they are fetched a page's worth at a time
  for (let i = 0; i < ids.length; i += MAX_PAGE) {
    const chunk = ids.slice(i, i + MAX_PAGE);
    invoices.push(...(await listPage(r, 'Invoices', { ids: chunk, pageSize: MAX_PAGE })).rows);
  }
  return invoices.length ? { invoices } : {};
}

async function first(r, table, p) {
  return (await listPage(r, table, { ...p, pageSize: 1 })).rows[0] || null;
}

/** Everything a scoped list holds, up to MAX_EXPORT rows. */
async function everything(r, table, p) {
  return (await listPage(r, table, { ...p, pageSize: MAX_EXPORT, export: true })).rows;
}

// ── a record's page ─────────────────────────────────────────────────────────

/** The date in the app's time zone (the session's zone is set per request). */
export async function todayOf(r) {
  const [{ d }] = await r.tx`select current_date::text as d`;
  return d;
}

/** The first day of each of `months` months ending with the month of `endIso`, oldest first. */
function monthKeys(months, endIso) {
  const [y, m] = endIso.split('-').map(Number);
  const keys = [];
  for (let i = months - 1; i >= 0; i--) keys.push(new Date(Date.UTC(y, m - 1 - i, 1)).toISOString().slice(0, 7));
  return keys;
}

const lastDayOf = (key) => {
  const [y, m] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

/**
 * Collected and spent per month, deposits in and out left out.
 * @param match a condition on the payment / expense rows (`t`), e.g. one property
 */
async function monthlySeries(r, months, endIso, match) {
  const tx = r.tx;
  const keys = monthKeys(months, endIso);
  const from = keys[0] + '-01', to = lastDayOf(keys[keys.length - 1]);
  const cond = match || tx`true`;
  const income = await tx`
    select to_char(t.payment_date, 'YYYY-MM') as k, sum(t.amount) as v from payments t
    where t.payment_date between ${from} and ${to} and not ${isDeposit(tx)} and ${cond} group by 1`;
  const spent = await tx`
    select to_char(t.date, 'YYYY-MM') as k, sum(t.amount) as v from expenses t
    where t.date between ${from} and ${to} and t.category is distinct from 'Deposit Refund' and ${cond} group by 1`;
  const inc = Object.fromEntries(income.map(x => [x.k, round2(x.v)]));
  const exp = Object.fromEntries(spent.map(x => [x.k, round2(x.v)]));
  return keys.map(k => ({ key: k, income: inc[k] || 0, expense: exp[k] || 0, net: round2((inc[k] || 0) - (exp[k] || 0)) }));
}

/**
 * What a property, unit, tenant or lease page shows above its tabs: how many
 * of each related record there are, the money figures, and the few most
 * recent. The tabs themselves page through the same scopes.
 */
export async function scopeSummary(r, kind, id) {
  const tx = r.tx;
  const scope = { kind, id: String(id) };
  const where = (table) => scopeWhere(tx, table, scope);
  const out = { counts: {} };

  if (hasScope(kind, 'Invoices')) {
    const [a] = await tx`
      select count(*)::int as n, coalesce(sum(t.balance) filter (where t.status in ${tx(OPEN)}), 0) as owed
      from invoices t where ${where('Invoices')}`;
    out.counts.invoices = a.n;
    out.outstanding = round2(a.owed);
    out.recentInvoices = (await listPage(r, 'Invoices', { scope, pageSize: 5 })).rows;
  }
  if (kind === 'tenant') {
    // every unpaid invoice, oldest first — a tenant page lists them with a pay button
    out.unpaid = (await listPage(r, 'Invoices', { scope, preset: 'unpaid', sort: 'due_date', dir: 'asc', pageSize: MAX_PAGE })).rows;
  }
  if (hasScope(kind, 'Payments')) {
    const [a] = await tx`
      select count(*)::int as n, coalesce(sum(t.amount) filter (where not ${isDeposit(tx)}), 0) as income
      from payments t where ${where('Payments')}`;
    out.counts.payments = a.n;
    out.collected = round2(a.income);
    const recent = await listPage(r, 'Payments', { scope, pageSize: 5 });
    out.recentPayments = recent.rows;
    out.refs = recent.refs;
  }
  if (hasScope(kind, 'Expenses')) {
    const [a] = await tx`
      select count(*)::int as n,
             coalesce(sum(t.amount) filter (where t.category is distinct from 'Deposit Refund'), 0) as spent
      from expenses t where ${where('Expenses')}`;
    out.counts.expenses = a.n;
    out.spent = round2(a.spent);
    out.recentExpenses = (await listPage(r, 'Expenses', { scope, pageSize: 5 })).rows;
  }
  if (hasScope(kind, 'Maintenance')) {
    const [a] = await tx`
      select count(*)::int as n, count(*) filter (where t.status in ${tx(ACTIVE_TICKET)})::int as open
      from maintenance t where ${where('Maintenance')}`;
    out.counts.maintenance = a.n;
    out.counts.openTickets = a.open;
    out.openTickets = (await listPage(r, 'Maintenance', { scope, preset: 'open', pageSize: 6 })).rows;
  }
  if (hasScope(kind, 'Documents')) {
    const [a] = await tx`select count(*)::int as n from documents t where ${where('Documents')}`;
    out.counts.documents = a.n;
  }
  if (kind === 'property') {
    out.series = await monthlySeries(r, 6, await todayOf(r), tx`t.property_id = ${String(id)}`);
  }
  return out;
}

/**
 * Everything behind a record's Activity tab or statement: its invoices,
 * payments and tickets in full. A lease, unit or tenant has a bounded history.
 */
export async function scopeHistory(r, kind, id) {
  const scope = { kind, id: String(id) };
  const out = {};
  if (hasScope(kind, 'Invoices')) out.invoices = await everything(r, 'Invoices', { scope });
  if (hasScope(kind, 'Payments')) out.payments = await everything(r, 'Payments', { scope });
  if (hasScope(kind, 'Maintenance')) out.maintenance = await everything(r, 'Maintenance', { scope });
  return out;
}

/** An invoice, payment, ticket, expense or document, with what its page shows beside it. */
export async function recordDetail(r, table, id) {
  const row = await first(r, table, { ids: [String(id)] });
  if (!row) return { row: null };
  const out = { row };
  if (table === 'Invoices') {
    out.items = await everything(r, 'InvoiceItems', { scope: { kind: 'invoice', id } });
    out.payments = await everything(r, 'Payments', { scope: { kind: 'invoice', id } });
  }
  if (table === 'Payments') {
    out.invoice = row.invoice_id ? await first(r, 'Invoices', { ids: [row.invoice_id] }) : null;
    if (row.tenant_id) {
      const others = await listPage(r, 'Payments', { filters: { tenant_id: row.tenant_id }, pageSize: 7 });
      out.others = others.rows.filter(x => x.id !== row.id).slice(0, 6);
      out.othersCount = others.total - (others.rows.some(x => x.id === row.id) ? 1 : 0);
      out.refs = others.refs;
    } else {
      out.others = [];
      out.othersCount = 0;
    }
  }
  if (table === 'Maintenance') {
    // a finished ticket's cost is booked as an expense that names it
    out.expense = await first(r, 'Expenses', { filters: { reference: row.id } });
  }
  if (table === 'Expenses' && row.reference) {
    out.ticket = await first(r, 'Maintenance', { ids: [row.reference] });
  }
  return out;
}

// ── dashboard ───────────────────────────────────────────────────────────────

/** Owed per tenant, biggest first. */
async function arrearsList(r, match, limit) {
  const tx = r.tx;
  const rows = await tx`
    select t.tenant_id, sum(t.balance) as balance, count(*)::int as invoices, min(t.due_date)::text as oldest
    from invoices t
    where t.balance > 0 and t.status not in ('Void', 'Draft') and ${match || tx`true`}
    group by t.tenant_id order by sum(t.balance) desc limit ${limit}`;
  return rows.map(x => ({ tenant_id: x.tenant_id || '', balance: round2(x.balance), invoices: x.invoices, oldest: x.oldest || '' }));
}

/** The dashboard's lists and trend, alongside the headline figures in stats. */
export async function dashboardData(r) {
  const tx = r.tx;
  const today = await todayOf(r);
  const [y, m, d] = today.split('-').map(Number);
  // the same stretch of last month, to compare this month's collections with
  const lastStart = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10);
  const lastLen = new Date(Date.UTC(y, m - 1, 0)).getUTCDate();
  const lastSameDay = new Date(Date.UTC(y, m - 2, Math.min(d, lastLen))).toISOString().slice(0, 10);
  const [prev] = await tx`
    select coalesce(sum(t.amount), 0) as v from payments t
    where t.payment_date between ${lastStart} and ${lastSameDay} and not ${isDeposit(tx)}`;

  const [tickets] = await tx`select count(*)::int as n from maintenance t where t.status in ${tx(ACTIVE_TICKET)}`;
  const openTickets = (await tx`
    select t.* from maintenance t where t.status in ${tx(ACTIVE_TICKET)}
    order by case t.priority when 'Urgent' then 0 when 'High' then 1 when 'Medium' then 2 when 'Low' then 3 else 4 end, t.seq
    limit 8`).map(x => mapRow('Maintenance', x));

  const expiring = await listPage(r, 'Documents', { preset: 'expiring', sort: 'expiry_date', dir: 'asc', pageSize: 6 });

  return {
    prev_collected: round2(prev.v),
    series: await monthlySeries(r, 6, today),
    arrears: await arrearsList(r, null, 6),
    open_tickets: tickets.n,
    tickets: openTickets,
    expiring_documents: expiring.total,
    documents: expiring.rows
  };
}

/** The figures Billing's header shows and filters by. */
export async function billingFigures(r) {
  const tx = r.tx;
  const [inv] = await tx`
    select
      count(*) filter (where t.status in ${tx(OPEN)})::int as outstanding_n,
      coalesce(sum(t.balance) filter (where t.status in ${tx(OPEN)}), 0) as outstanding,
      count(*) filter (where t.status in ${tx(OPEN)} and t.due_date < current_date)::int as overdue_n,
      coalesce(sum(t.balance) filter (where t.status in ${tx(OPEN)} and t.due_date < current_date), 0) as overdue,
      count(*) filter (where t.status in ${tx(OPEN)} and t.due_date >= current_date and t.due_date <= current_date + 7)::int as week_n,
      coalesce(sum(t.balance) filter (where t.status in ${tx(OPEN)} and t.due_date >= current_date and t.due_date <= current_date + 7), 0) as week,
      count(*)::int as invoices
    from invoices t`;
  const [pay] = await tx`
    select count(*) filter (where ${PRESETS.Payments.month(tx)})::int as month_n,
           coalesce(sum(t.amount) filter (where ${PRESETS.Payments.month(tx)}), 0) as month,
           count(*)::int as payments
    from payments t`;
  return {
    invoices: inv.invoices, payments: pay.payments,
    outstanding: { count: inv.outstanding_n, sum: round2(inv.outstanding) },
    overdue: { count: inv.overdue_n, sum: round2(inv.overdue) },
    week: { count: inv.week_n, sum: round2(inv.week) },
    month: { count: pay.month_n, sum: round2(pay.month) }
  };
}

// ── reports ─────────────────────────────────────────────────────────────────

/**
 * Everything the Reports screen shows for a date range and, optionally, one
 * property. Per-property figures always cover every property, so the owner
 * statements (which list all of an owner's properties) come from the same call.
 */
export async function reportData(r, { from, to, propertyId } = {}) {
  if (!DATE_RE.test(String(from || '')) || !DATE_RE.test(String(to || ''))) {
    throw new Error('A report needs a from and to date (yyyy-mm-dd).');
  }
  const tx = r.tx;
  const prop = propertyId ? tx`t.property_id = ${String(propertyId)}` : tx`true`;

  const [pay] = await tx`
    select coalesce(sum(t.amount) filter (where not ${isDeposit(tx)}), 0) as income,
           coalesce(sum(t.amount) filter (where ${isDeposit(tx)}), 0) as deposits_in
    from payments t where t.payment_date between ${from} and ${to} and ${prop}`;
  const [exp] = await tx`
    select coalesce(sum(t.amount) filter (where t.category is distinct from 'Deposit Refund'), 0) as opex,
           coalesce(sum(t.amount) filter (where t.category = 'Deposit Refund'), 0) as deposits_out
    from expenses t where t.date between ${from} and ${to} and ${prop}`;
  // a void invoice was never owed and a draft not yet sent, so neither is billed
  const [inv] = await tx`
    select coalesce(sum(case when t.total <> 0 then t.total else t.amount end), 0) as billed,
           coalesce(sum(t.amount_paid), 0) as collected
    from invoices t
    where t.due_date between ${from} and ${to} and t.status not in ('Void', 'Draft') and ${prop}`;

  const categories = await tx`
    select coalesce(t.category, 'Uncategorised') as label, sum(t.amount) as value from expenses t
    where t.date between ${from} and ${to} and t.category is distinct from 'Deposit Refund' and ${prop}
    group by 1 order by 2 desc`;

  // income and spend in the range, and what is owed now, per property ('' = none)
  const byProperty = {};
  const slot = (id) => (byProperty[id || ''] = byProperty[id || ''] || { inc: 0, exp: 0, due: 0 });
  (await tx`
    select t.property_id as id, sum(t.amount) as v from payments t
    where t.payment_date between ${from} and ${to} and not ${isDeposit(tx)} group by 1`)
    .forEach(x => { slot(x.id).inc = round2(x.v); });
  (await tx`
    select t.property_id as id, sum(t.amount) as v from expenses t
    where t.date between ${from} and ${to} and t.category is distinct from 'Deposit Refund' group by 1`)
    .forEach(x => { slot(x.id).exp = round2(x.v); });
  (await tx`
    select t.property_id as id, sum(t.balance) as v from invoices t where t.status in ${tx(OPEN)} group by 1`)
    .forEach(x => { slot(x.id).due = round2(x.v); });

  // how old the money owed is; due today counts as 1–30 days, as before
  const [age] = await tx`
    select
      coalesce(sum(t.balance) filter (where t.due_date is null or t.due_date > current_date), 0) as b0,
      coalesce(sum(t.balance) filter (where current_date - t.due_date between 0 and 30), 0) as b1,
      coalesce(sum(t.balance) filter (where current_date - t.due_date between 31 and 60), 0) as b2,
      coalesce(sum(t.balance) filter (where current_date - t.due_date between 61 and 90), 0) as b3,
      coalesce(sum(t.balance) filter (where current_date - t.due_date > 90), 0) as b4
    from invoices t where t.balance > 0 and t.status not in ('Void', 'Draft') and ${prop}`;

  return {
    income: round2(pay.income), deposits_in: round2(pay.deposits_in),
    opex: round2(exp.opex), deposits_out: round2(exp.deposits_out),
    billed: round2(inv.billed), collected_on_billed: round2(inv.collected),
    categories: categories.map(x => ({ label: x.label, value: round2(x.value) })),
    series: await monthlySeries(r, 12, to, propertyId ? prop : null),
    byProperty,
    ageing: [
      { label: 'Not yet due', value: round2(age.b0) }, { label: '1–30 days', value: round2(age.b1) },
      { label: '31–60 days', value: round2(age.b2) }, { label: '61–90 days', value: round2(age.b3) },
      { label: '90+ days', value: round2(age.b4) }
    ],
    debtors: await arrearsList(r, propertyId ? prop : null, 10)
  };
}
