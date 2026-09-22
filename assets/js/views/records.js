import { el, icon, money, date, badge, today, daysBetween, whatsappLink, emptyState, confirmDialog, toast,
         isoDate, safeUrl } from '../ui.js';
import { store } from '../store.js';
import { entities, tableFields, fieldByKey, rentDayLabel } from '../schema.js';
import { navigate, refreshView } from '../router.js';
import { dataTable } from '../components/table.js';
import { openEntityForm } from '../components/form.js';
import { detailPage, stat, statRow, panel, props, schemaProps, facts, notice, tabs, recordList, invoiceRow,
         paymentRow, leaseRow, ticketRow, documentRow, termProgress, entityCard, timeline, eventsFor, ref,
         copyable, avatar, hrefFor, DOC_ENTITY, awaiting } from '../components/detail.js';
import { recordPaymentFor, showInvoice, showReceipt, openInvoiceForm, voidInvoiceFor,
         invoiceMessage } from './invoices.js';
import { openRenewLease, openSettleDeposit } from './leases.js';

// ── shared by every record page ─────────────────────────────────────────────

export const OPEN = ['Unpaid', 'Partial', 'Overdue'];
export const sum = (rows, key = 'amount') => rows.reduce((s, r) => s + Number(r[key] || 0), 0);
export const newestFirst = (key) => (a, b) => String(b[key] || '').localeCompare(String(a[key] || ''));
/** What is still owed on a set of invoices. */
export const owed = (invoices) => sum(invoices.filter(i => OPEN.includes(i.status)), 'balance');
export const canPay = (i) => store.can('manager') && Number(i.balance) > 0 && !['Void', 'Draft'].includes(i.status);
export const country = () => store.settings.whatsapp_country_code || '91';
export const telHref = (phone) => 'tel:' + String(phone).replace(/[^\d+]/g, '');

export function btn(label, iconName, onClick, variant = 'btn-ghost') {
  return el('button', { class: 'btn ' + variant, type: 'button', onClick }, [icon(iconName, 16), ' ' + label]);
}
export const managerBtn = (...args) => (store.can('manager') ? btn(...args) : null);
export function linkBtn(label, iconName, href) {
  return el('a', { class: 'btn btn-ghost', href, target: '_blank', rel: 'noopener noreferrer' }, [icon(iconName, 16), ' ' + label]);
}
/** "View all" in a panel header, switching the page to that tab. */
export const viewAll = (go) => el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onClick: go }, ['View all']);

/** Where a record's list lives. Invoices and payments share the Billing screen. */
const LIST_OF = { invoices: ['billing', 'Billing'], payments: ['billing?tab=payments', 'Billing'] };
const listOf = (entity) => LIST_OF[entity] || [entity, entities[entity].title];

export function missing(entity) {
  const def = entities[entity];
  const [path, title] = listOf(entity);
  return el('div', { class: 'view' }, [
    el('h1', { text: def.singular + ' not found' }),
    emptyState(`This ${def.singular.toLowerCase()} does not exist, or it has been deleted.`,
      el('a', { class: 'btn btn-primary', href: '#/' + path }, ['Back to ' + title.toLowerCase()]))
  ]);
}

/** Delete a record from its own page, then go back to the list it came from. */
export function deleteBtn(entity, row) {
  if (!store.can('admin')) return null;
  const def = entities[entity];
  return el('button', {
    class: 'btn btn-ghost danger-text', type: 'button',
    onClick: async () => {
      const ok = await confirmDialog({
        title: `Delete ${def.singular.toLowerCase()} ${row.id}?`,
        message: 'This removes the record permanently. Linked records are not deleted.',
        confirmLabel: 'Delete'
      });
      if (!ok) return;
      try { await store.remove(entity, row.id); toast(`${def.singular} deleted`, 'ok'); navigate(listOf(entity)[0]); }
      catch (err) { toast(err.message, 'danger'); }
    }
  }, [icon('trash', 16), ' Delete']);
}

// ── related-record tables, used inside tabs ─────────────────────────────────

const columnsWithout = (entity, hide) => tableFields(entity).filter(c => !hide.includes(c.key));
const facet = (entity, key, label) => {
  const f = fieldByKey(entity, key);
  return f && f.options ? [{ key, label, options: f.options }] : [];
};

// Each takes `source` — { scope, preset, filters } — and the server pages it,
// newest first unless the reader sorts by a column.

export function invoiceTable(source, { hide = [], exportName } = {}) {
  return dataTable({
    entity: 'invoices', source,
    columns: columnsWithout('invoices', hide), filters: facet('invoices', 'status', 'All statuses'),
    onRowClick: (r) => navigate('invoices/' + r.id), exportName, emptyMessage: 'No invoices yet.',
    actions: [
      { label: 'View / print', icon: 'receipt', onClick: (r) => showInvoice(r) },
      { label: 'Record payment', icon: 'card', visible: canPay, onClick: (r) => recordPaymentFor(r, () => refreshView()) }
    ]
  });
}

export function paymentTable(source, { hide = [], exportName } = {}) {
  return dataTable({
    entity: 'payments', source,
    columns: columnsWithout('payments', hide), filters: facet('payments', 'method', 'All methods'),
    onRowClick: (r) => navigate('payments/' + r.id), exportName, emptyMessage: 'No payments yet.',
    actions: [{ label: 'Receipt', icon: 'receipt', onClick: (r) => showReceipt(r) }]
  });
}

export function leaseTable(rows, { hide = [] } = {}) {
  return dataTable({
    entity: 'leases', rows: rows.slice().sort(newestFirst('start_date')),
    columns: columnsWithout('leases', hide), filters: facet('leases', 'status', 'All statuses'),
    onRowClick: (r) => navigate('leases/' + r.id), emptyMessage: 'No leases yet.'
  });
}

export function ticketTable(source, { hide = [] } = {}) {
  return dataTable({
    entity: 'maintenance', source,
    columns: columnsWithout('maintenance', hide), filters: facet('maintenance', 'status', 'All statuses'),
    onRowClick: (r) => navigate('maintenance/' + r.id), emptyMessage: 'No maintenance tickets.'
  });
}

export function expenseTable(source, { hide = [] } = {}) {
  return dataTable({
    entity: 'expenses', source,
    columns: columnsWithout('expenses', hide), filters: facet('expenses', 'category', 'All categories'),
    onRowClick: (r) => navigate('expenses/' + r.id), emptyMessage: 'No expenses recorded.'
  });
}

export function documentTable(source) {
  return dataTable({
    entity: 'documents', source,
    filters: facet('documents', 'category', 'All categories'),
    onRowClick: (r) => navigate('documents/' + r.id), emptyMessage: 'No documents linked.'
  });
}

export function expenseRow(e) {
  return el('a', { class: 'rec-row', href: hrefFor('expenses', e.id) }, [
    el('span', { class: 'rec-icon tone-warn' }, [icon('wallet', 15)]),
    el('span', { class: 'rec-main' }, [
      el('strong', { text: e.description || e.category || 'Expense' }),
      el('small', { class: 'muted', text: [e.category, e.vendor].filter(Boolean).join(' · ') })
    ]),
    el('span', { class: 'rec-side' }, [
      el('strong', { class: 'num', text: money(e.amount) }),
      el('small', { class: 'muted', text: date(e.date) })
    ])
  ]);
}

// ── cards that stand for a related record ───────────────────────────────────

export function tenantCard(tenant) {
  if (!tenant) return el('p', { class: 'muted', text: 'No tenant on record.' });
  const due = store.owedBy('tenants', tenant.id);
  return entityCard({
    entity: 'tenants', id: tenant.id, lead: avatar({ name: tenant.full_name, size: 'md' }),
    title: tenant.full_name, sub: tenant.occupation || tenant.status,
    rows: [
      ['Phone', tenant.phone ? copyable(tenant.phone, { label: 'Phone', href: telHref(tenant.phone) }) : null],
      ['Outstanding', el('span', { class: due > 0 ? 'neg' : 'pos', text: money(due) })],
      ['Email', tenant.email ? copyable(tenant.email, { label: 'Email', href: 'mailto:' + tenant.email }) : null, null, true]
    ]
  });
}

export function unitCard(unit) {
  if (!unit) return el('p', { class: 'muted', text: 'No unit on record.' });
  return entityCard({
    entity: 'units', id: unit.id, lead: avatar({ iconName: 'grid', size: 'md' }),
    title: unit.unit_number, sub: ref('properties', unit.property_id),
    rows: [
      ['Layout', [unit.bedrooms ? unit.bedrooms + ' BR' : null, unit.area_sqft ? unit.area_sqft + ' sq ft' : null,
                  unit.furnishing].filter(Boolean).join(' · ') || null],
      ['Market rent', money(unit.rent_amount)],
      ['Status', badge(unit.status)]
    ]
  });
}

export function leaseCard(lease) {
  if (!lease) return el('p', { class: 'muted', text: 'No lease on record.' });
  return entityCard({
    entity: 'leases', id: lease.id, lead: avatar({ iconName: 'file', size: 'md' }),
    title: 'Lease ' + lease.id, sub: [badge(lease.status), ' ', lease.frequency || 'Monthly', ' billing'],
    rows: [
      ['Rent', money(store.currentRent(lease)) + ' / mo'],
      lease.rent_day ? ['Rent day', rentDayLabel(lease.rent_day)] : null,
      ['Deposit held', money(store.depositLedger(lease).held)],
      ['Escalation', Number(lease.escalation_pct) ? lease.escalation_pct + '% yearly' : 'None']
    ],
    footer: termProgress(lease)
  });
}

// ── lease ───────────────────────────────────────────────────────────────────

/** The next anniversary on which an escalating rent goes up, within the term. */
function nextEscalation(lease) {
  if (!Number(lease.escalation_pct) || !lease.start_date || lease.status !== 'Active') return null;
  const d = new Date(lease.start_date + 'T00:00:00');
  if (isNaN(d)) return null;
  const t = today();
  while (isoDate(d) <= t) d.setFullYear(d.getFullYear() + 1);
  const on = isoDate(d);
  if (lease.end_date && on > lease.end_date) return null;
  return { on, rent: store.currentRent(lease, on) };
}

/**
 * For a lease with a rent day: the next invoice Generate rent will raise —
 * when, for which days, and how a part month is worked out.
 */
function nextRentPanel(lease) {
  if (!['Active', 'Upcoming'].includes(lease.status)) return null;
  const next = store.nextRentInvoice(lease);
  if (!next) return null;
  const range = (a, b) => `${date(a)} – ${date(b)}`;
  return panel('Next rent invoice', el('div', { class: 'stack' }, [
    el('p', { class: 'pay-progress-text' }, [
      el('strong', { text: money(next.amount) }), ` due ${date(next.due)} for ${range(next.start, next.end)}`
    ]),
    facts([
      ['Can be raised from', date(next.raiseFrom)],
      ['Payment date', date(next.due)],
      Number(lease.late_fee) > 0 ? ['Late fee from', `${date(next.lateFeeFrom)} · ${money(lease.late_fee)}`] : null
    ]),
    next.partial
      ? el('div', { class: 'rent-lines' }, next.lines.map(l => el('div', { class: 'kv' }, [
          el('span', { text: `${range(l.start, l.end)} · ${l.days} of ${l.monthDays} days` }),
          el('strong', { text: money(l.amount) })
        ])))
      : null,
    el('p', { class: 'muted small', text: next.partial
      ? 'Part of a month is charged day by day, each month at the rent divided by its own number of days.'
      : `A full month from the day after one rent day (${rentDayLabel(lease.rent_day)}) to the next.` })
  ]), { action: next.raiseFrom <= today()
    ? el('span', { class: 'badge badge-warn', text: 'Ready — use Generate rent' })
    : el('span', { class: 'muted small', text: 'Generate rent raises it from ' + date(next.raiseFrom) }) });
}

export function leaseDetail(id, ctx = {}) {
  const lease = store.byId('leases', id);
  if (!lease) return missing('leases');
  return awaiting(() => store.detail('leases', id), (summary) => leasePage(lease, summary, ctx));
}

/** @param s the lease's summary from the server (store.detail) */
function leasePage(lease, s, ctx) {
  const id = lease.id;
  const scope = { kind: 'lease', id };
  const tenant = store.byId('tenants', lease.tenant_id);
  const unit = store.byId('units', lease.unit_id);
  const ledger = store.depositLedger(lease);
  const outstanding = s.outstanding;
  const collected = s.collected;
  const rentNow = store.currentRent(lease);
  const left = lease.end_date ? daysBetween(today(), lease.end_date) : null;
  const renewedTo = store.leases.find(l => l.renewed_from === id);
  const escalation = nextEscalation(lease);
  const again = () => refreshView();
  const canRenew = store.can('manager') && lease.end_date && lease.status !== 'Terminated' && !renewedTo;
  const alertDays = Number(store.settings.lease_expiry_alert_days || 45);

  let t = null;
  const overview = () => el('div', { class: 'tab-stack' }, [
    renewedTo
      ? notice(['Renewed as ', ref('leases', renewedTo.id, { text: renewedTo.id }),
                ` from ${date(renewedTo.start_date)}.`], 'info')
      : lease.status === 'Active' && left !== null && left <= alertDays
        ? notice(`This lease ends in ${left} day${left === 1 ? '' : 's'} (${date(lease.end_date)}).`, 'warn',
                 canRenew ? btn('Renew', 'renew', () => openRenewLease(lease, { onDone: again })) : null)
        : null,
    panel('Term', el('div', { class: 'stack' }, [
      termProgress(lease),
      facts([
        ['Rent now', money(rentNow) + ' / mo'],
        ['Base rent', money(lease.rent_amount) + ' / mo'],
        ['Billing', lease.frequency || 'Monthly'],
        ['Rent day', rentDayLabel(lease.rent_day) || null],
        ['Escalation', Number(lease.escalation_pct) ? lease.escalation_pct + '% yearly' : 'None'],
        escalation ? ['Next increase', `${date(escalation.on)} → ${money(escalation.rent)}`] : null,
        ['Grace days', lease.grace_days !== '' && lease.grace_days !== undefined ? String(lease.grace_days) : null],
        ['Late fee', Number(lease.late_fee) ? money(lease.late_fee) : null],
        ['GST on rent', Number(lease.gst_rate) ? lease.gst_rate + '%' : null]
      ])
    ])),
    nextRentPanel(lease),
    el('div', { class: 'grid-2' }, [
      panel('Tenant', tenantCard(tenant)),
      panel('Unit', unitCard(unit))
    ]),
    panel('Security deposit', el('div', { class: 'stack' }, [
      facts([
        ['Agreed', money(lease.deposit_amount)],
        ['Received', money(ledger.received)],
        ledger.applied ? ['Applied to arrears', money(ledger.applied)] : null,
        ledger.refunded ? ['Refunded', money(ledger.refunded)] : null,
        ['Held now', money(ledger.held), ledger.held > 0 ? 'ok' : null],
        ['Status', badge(lease.deposit_status || 'Pending')]
      ])
    ]), {
      action: store.can('manager') && ledger.held > 0
        ? el('button', { class: 'btn btn-ghost btn-sm', onClick: () => openSettleDeposit(lease, { onDone: again }) }, ['Settle deposit'])
        : null
    }),
    el('div', { class: 'grid-2' }, [
      panel('Recent invoices', recordList(s.recentInvoices, invoiceRow,
        { limit: 5, empty: 'No invoices on this lease yet.' }),
        { flush: true, count: s.counts.invoices, action: s.counts.invoices > 5 ? viewAll(() => t.select('invoices')) : null }),
      panel('Recent payments', recordList(s.recentPayments, paymentRow, { limit: 5, empty: 'No payments yet.' }),
        { flush: true, count: s.counts.payments, action: s.counts.payments > 5 ? viewAll(() => t.select('payments')) : null })
    ])
  ]);

  t = tabs([
    { key: 'overview', label: 'Overview', render: overview },
    { key: 'invoices', label: 'Invoices', count: s.counts.invoices,
      render: () => invoiceTable({ scope }, { hide: ['tenant_id', 'property_id', 'unit_id'], exportName: 'lease-' + id + '-invoices' }) },
    { key: 'payments', label: 'Payments', count: s.counts.payments,
      render: () => paymentTable({ scope }, { hide: ['tenant_id', 'property_id'], exportName: 'lease-' + id + '-payments' }) },
    { key: 'documents', label: 'Documents', count: s.counts.documents, render: () => documentTable({ scope }) },
    { key: 'activity', label: 'Activity',
      render: () => awaiting(() => store.history('leases', id), (h) =>
        panel('Activity', timeline(eventsFor({ leases: [lease], invoices: h.invoices, payments: h.payments }))), { inline: true }) }
  ], { active: ctx.query?.tab, base: hrefFor('leases', id) });

  return detailPage({
    crumbs: [{ label: 'Leases', href: '#/leases' }, { label: id }],
    lead: avatar({ iconName: 'file' }),
    kind: 'Lease',
    title: id,
    badges: [badge(lease.status), lease.deposit_status ? badge('Deposit ' + lease.deposit_status.toLowerCase(),
             { Held: 'info', Refunded: 'ok', Pending: 'warn' }[lease.deposit_status] || 'muted') : null],
    subtitle: [ref('tenants', lease.tenant_id), ' · ', ref('units', lease.unit_id)],
    meta: [
      copyable(id, { label: 'Lease ID', mono: true }),
      [icon('clock', 14), `${date(lease.start_date)} – ${lease.end_date ? date(lease.end_date) : 'open-ended'}`],
      lease.renewed_from ? ['Renewal of ', ref('leases', lease.renewed_from, { text: lease.renewed_from })] : null
    ],
    actions: [
      canRenew ? btn('Renew', 'renew', () => openRenewLease(lease, { onDone: again })) : null,
      store.can('manager') && ledger.held > 0 ? btn('Settle deposit', 'wallet2', () => openSettleDeposit(lease, { onDone: again })) : null,
      managerBtn('Edit', 'edit', () => openEntityForm('leases', lease, { onSaved: again })),
      deleteBtn('leases', lease)
    ],
    stats: statRow([
      stat('Current rent', money(rentNow), null, 'per month'),
      stat('Outstanding', money(outstanding), outstanding > 0 ? 'danger' : 'ok'),
      stat('Collected', money(collected), 'ok', 'on this lease'),
      stat('Deposit held', money(ledger.held)),
      lease.status === 'Active' && left !== null
        ? stat('Ends in', `${left} day${left === 1 ? '' : 's'}`, left <= alertDays ? 'warn' : null, date(lease.end_date))
        : stat(lease.status === 'Upcoming' ? 'Starts' : 'Ended', date(lease.status === 'Upcoming' ? lease.start_date : lease.end_date))
    ]),
    main: t.el,
    aside: [
      panel('Lease details', props([
        ['Lease ID', copyable(id, { label: 'Lease ID', mono: true })],
        ['Tenant', ref('tenants', lease.tenant_id)],
        ['Property', ref('properties', lease.property_id)],
        ['Unit', ref('units', lease.unit_id, { short: true })],
        ['Start date', date(lease.start_date)],
        ['End date', lease.end_date ? date(lease.end_date) : 'Open-ended'],
        ['Billing frequency', lease.frequency || 'Monthly'],
        ['Rent day', rentDayLabel(lease.rent_day) || null],
        ['Monthly rent (base)', money(lease.rent_amount)],
        ['Security deposit', money(lease.deposit_amount)],
        ['Renewed from', lease.renewed_from ? ref('leases', lease.renewed_from, { text: lease.renewed_from }) : null],
        ['Renewed as', renewedTo ? ref('leases', renewedTo.id, { text: renewedTo.id }) : null],
        ['Notes', lease.notes ? el('span', { class: 'prewrap', text: lease.notes }) : null],
        ['Created', lease.created_at ? date(lease.created_at) : null],
        ['Last updated', lease.updated_at ? date(lease.updated_at) : null]
      ]))
    ]
  });
}

// ── invoice ─────────────────────────────────────────────────────────────────

function lineItemsTable(inv, items) {
  const lines = items.length ? items
    : [{ description: inv.type || 'Charge', category: inv.type, quantity: 1, unit_amount: inv.amount, amount: inv.amount }];
  const gst = lines.some(i => Number(i.tax_rate) > 0);
  const cols = gst ? 5 : 4;
  const foot = (label, value, cls) => el('tr', { class: cls || null }, [
    el('td', { colspan: String(cols - 1), class: 'num foot-label', text: label }),
    el('td', { class: 'num', text: value })
  ]);
  const taxRows = [];
  if (Number(inv.tax)) {
    if (Number(inv.igst) > 0) taxRows.push(foot('IGST', money(inv.igst)));
    else if (Number(inv.cgst) > 0 || Number(inv.sgst) > 0) {
      taxRows.push(foot('CGST', money(inv.cgst)), foot('SGST / UTGST', money(inv.sgst)));
    } else taxRows.push(foot(gst ? 'GST' : 'Tax', money(inv.tax)));
  }
  return el('div', { class: 'table-scroll' }, [el('table', { class: 'data-table line-table' }, [
    el('thead', {}, [el('tr', {}, [
      el('th', { text: 'Description' }), el('th', { class: 'num', text: 'Qty' }),
      el('th', { class: 'num', text: 'Unit price' }), gst ? el('th', { class: 'num', text: 'GST' }) : null,
      el('th', { class: 'num', text: 'Amount' })
    ])]),
    el('tbody', {}, lines.map(it => el('tr', {}, [
      el('td', { class: 'wrap' }, [el('strong', { text: it.description }),
                                   it.category ? el('small', { class: 'muted block', text: it.category }) : null]),
      el('td', { class: 'num', text: String(Number(it.quantity) || 1) }),
      el('td', { class: 'num', text: money(it.unit_amount ?? it.amount) }),
      gst ? el('td', { class: 'num', text: (Number(it.tax_rate) || 0) + '%' }) : null,
      el('td', { class: 'num', text: money(it.amount) })
    ]))),
    el('tfoot', {}, [
      foot('Subtotal', money(inv.amount)),
      ...taxRows,
      foot('Total', money(inv.total || inv.amount), 'foot-strong'),
      foot('Paid', '− ' + money(inv.amount_paid)),
      foot('Balance due', money(inv.balance), 'foot-strong')
    ])
  ])]);
}

/**
 * The one line that says where an invoice stands: how much of it is paid, and
 * what is left and by when — with the bar filling as payments come in.
 */
function paymentProgress(inv, payments, dueIn) {
  if (['Void', 'Draft'].includes(inv.status)) return null;
  const total = Number(inv.total || inv.amount || 0);
  const paid = Number(inv.amount_paid || 0);
  const balance = Number(inv.balance || 0);
  const pct = total > 0 ? Math.min(100, Math.round(paid / total * 100)) : 0;
  const late = balance > 0 && inv.due_date && inv.due_date < today();
  const last = payments[0];
  const text = balance <= 0
    ? [el('strong', { text: 'Paid in full' }), last ? ` · last payment ${date(last.payment_date)}` : '']
    : [
        'Paid ', el('strong', { text: money(paid) }), ' of ', el('strong', { text: money(total) }), ' · ',
        el('strong', { class: late ? 'neg' : '', text: money(balance) }),
        late ? ` was due ${date(inv.due_date)}`
          : dueIn === 0 ? ' due today'
          : dueIn !== null ? ` due in ${dueIn} day${dueIn === 1 ? '' : 's'}` : ' due'
      ];
  return el('div', { class: 'pay-progress panel' }, [
    el('p', { class: 'pay-progress-text' }, text),
    el('div', { class: 'term-track', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100',
                'aria-valuenow': String(pct), 'aria-label': 'Share of the invoice paid' },
       [el('div', { class: 'term-fill' + (balance <= 0 ? ' tone-ok' : late ? ' tone-danger' : ''), style: `width:${pct}%` })])
  ]);
}

export function invoiceDetail(id) {
  return awaiting(() => store.detail('invoices', id),
                  (d) => (d.row ? invoicePage(d.row, d.items, d.payments) : missing('invoices')));
}

/** @param items its line items, and `payments` those against it, newest first */
function invoicePage(inv, items, payments) {
  const id = inv.id;
  const tenant = store.byId('tenants', inv.tenant_id);
  const open = OPEN.includes(inv.status);
  const late = open && inv.due_date && inv.due_date < today() ? daysBetween(inv.due_date, today()) : 0;
  const dueIn = open && inv.due_date && !late ? daysBetween(today(), inv.due_date) : null;
  const again = () => refreshView();
  const wa = tenant?.phone && inv.status !== 'Draft' ? whatsappLink(tenant.phone, invoiceMessage(inv), country()) : '';
  const period = inv.period_start ? `${date(inv.period_start)} – ${date(inv.period_end)}` : null;

  const events = [
    inv.status !== 'Draft' ? { date: inv.issue_date || inv.due_date, icon: 'receipt', tone: 'info', order: 0,
      title: 'Invoice issued', meta: 'Total ' + money(inv.total || inv.amount) } : null,
    inv.last_reminded ? { date: inv.last_reminded, icon: 'mail', tone: 'muted', order: 1, title: 'Reminder sent' } : null,
    late ? { date: inv.due_date, icon: 'alert', tone: 'danger', order: 1, title: 'Payment due — not received in full' } : null,
    ...payments.map(p => ({ date: p.payment_date, icon: 'card', tone: 'ok', order: 2,
      title: ['Payment ', ref('payments', p.id, { text: money(p.amount) }), ' received'],
      meta: [p.method, p.reference].filter(Boolean).join(' · ') }))
  ].filter(Boolean);

  const main = [
    inv.status === 'Void' ? notice(['This invoice is void and nothing is owed on it.',
                                    inv.notes ? el('small', { class: 'block', text: inv.notes }) : null], 'muted') : null,
    inv.status === 'Draft' ? notice('Draft — this invoice has not been issued to the tenant yet.', 'info',
                                    store.can('manager') ? btn('Edit & issue', 'edit', () => openInvoiceForm(inv, { onSaved: again, items })) : null) : null,
    late ? notice(`Overdue by ${late} day${late === 1 ? '' : 's'} — ${money(inv.balance)} still to collect.`, 'danger',
                  canPay(inv) ? btn('Record payment', 'card', () => recordPaymentFor(inv, again)) : null) : null,
    paymentProgress(inv, payments, dueIn),
    panel('Line items', lineItemsTable(inv, items), { flush: true, count: items.length || 1 }),
    panel('Payments', recordList(payments, paymentRow, { empty: 'No payments recorded against this invoice.' }), {
      flush: true, count: payments.length,
      action: canPay(inv) ? el('button', { class: 'btn btn-ghost btn-sm', onClick: () => recordPaymentFor(inv, again) },
                               [icon('plus', 14), ' Record payment']) : null
    }),
    panel('Activity', timeline(events))
  ];

  return detailPage({
    crumbs: [{ label: 'Billing', href: '#/billing' }, { label: id }],
    lead: avatar({ iconName: 'receipt' }),
    kind: (inv.type || 'Invoice') + ' invoice',
    title: id,
    badges: [badge(inv.status)],
    subtitle: ['Billed to ', ref('tenants', inv.tenant_id), inv.unit_id ? [' · ', ref('units', inv.unit_id)] : null].flat().filter(Boolean),
    meta: [
      copyable(id, { label: 'Invoice ID', mono: true }),
      period ? [icon('clock', 14), period] : null,
      [icon('receipt', 14), 'Due ' + date(inv.due_date)]
    ],
    actions: [
      canPay(inv) ? btn('Record payment', 'card', () => recordPaymentFor(inv, again), 'btn-primary') : null,
      btn('Print / PDF', 'print', () => showInvoice(inv, { items, payments })),
      wa ? linkBtn('WhatsApp', 'whatsapp', wa) : null,
      store.can('manager') && inv.status !== 'Void' ? btn('Edit', 'edit', () => openInvoiceForm(inv, { onSaved: again, items })) : null,
      store.can('manager') && !['Void', 'Draft'].includes(inv.status) && !(Number(inv.amount_paid) > 0)
        ? el('button', { class: 'btn btn-ghost danger-text', onClick: () => voidInvoiceFor(inv, again) }, [icon('ban', 16), ' Void'])
        : null,
      inv.status === 'Draft' ? deleteBtn('invoices', inv) : null
    ],
    stats: statRow([
      stat('Total', money(inv.total || inv.amount)),
      stat('Paid', money(inv.amount_paid), Number(inv.amount_paid) > 0 ? 'ok' : null),
      stat('Balance due', money(inv.balance), Number(inv.balance) > 0 && inv.status !== 'Void' ? 'danger' : 'ok'),
      stat('Due date', date(inv.due_date), late ? 'danger' : null,
           late ? `${late} days overdue` : dueIn !== null ? (dueIn === 0 ? 'due today' : `in ${dueIn} days`) : null)
    ]),
    main,
    aside: [
      panel('Billed to', tenantCard(tenant)),
      panel('Invoice details', props([
        ['Invoice ID', copyable(id, { label: 'Invoice ID', mono: true })],
        ['Type', inv.type],
        ['Property', ref('properties', inv.property_id)],
        ['Unit', ref('units', inv.unit_id, { short: true })],
        ['Lease', inv.lease_id ? ref('leases', inv.lease_id, { text: inv.lease_id }) : null],
        ['Issue date', inv.issue_date ? date(inv.issue_date) : null],
        ['Due date', date(inv.due_date)],
        ['Period', period],
        ['Place of supply', inv.place_of_supply],
        ['Last reminded', inv.last_reminded ? date(inv.last_reminded) : null],
        ['Notes', inv.notes && inv.status !== 'Void' ? el('span', { class: 'prewrap', text: inv.notes }) : null]
      ]))
    ]
  });
}

// ── payment ─────────────────────────────────────────────────────────────────

export function paymentDetail(id) {
  return awaiting(() => store.detail('payments', id), (d) => (d.row ? paymentPage(d) : missing('payments')));
}

/** @param d the payment, the invoice it settles, and the tenant's other payments (store.detail) */
function paymentPage(d) {
  const p = d.row;
  const id = p.id;
  const inv = d.invoice;
  const tenant = store.byId('tenants', p.tenant_id);
  const lease = p.lease_id ? store.byId('leases', p.lease_id) : (inv?.lease_id ? store.byId('leases', inv.lease_id) : null);
  const deposit = store.isDepositPayment(p);
  const others = d.others;
  const again = () => refreshView();

  return detailPage({
    crumbs: [
      { label: 'Billing', href: '#/billing?tab=payments' },
      inv ? { label: inv.id, href: hrefFor('invoices', inv.id) } : null,
      { label: 'Payment ' + id }
    ].filter(Boolean),
    lead: avatar({ iconName: 'card', tone: 'ok' }),
    kind: deposit ? 'Deposit payment' : p.method === 'Deposit Adjustment' ? 'Deposit adjustment' : 'Payment received',
    title: money(p.amount),
    badges: [badge(p.method || 'Payment', 'info'), deposit ? badge('Deposit', 'muted') : null],
    subtitle: ['From ', ref('tenants', p.tenant_id), ' on ' + date(p.payment_date)],
    meta: [
      copyable(id, { label: 'Payment ID', mono: true }),
      p.reference ? ['Ref ', copyable(p.reference, { label: 'Reference', mono: true })] : null
    ],
    actions: [
      btn('Receipt', 'receipt', () => showReceipt(p), 'btn-primary'),
      managerBtn('Edit', 'edit', () => openEntityForm('payments', p, { onSaved: again })),
      deleteBtn('payments', p)
    ],
    main: [
      panel('Applied to', inv
        ? entityCard({
            entity: 'invoices', id: inv.id, lead: avatar({ iconName: 'receipt', size: 'md' }),
            title: 'Invoice ' + inv.id,
            sub: [inv.type, inv.period_start ? `${date(inv.period_start)} – ${date(inv.period_end)}` : 'due ' + date(inv.due_date)]
              .filter(Boolean).join(' · '),
            rows: [
              ['Invoice total', money(inv.total || inv.amount)],
              ['Paid to date', money(inv.amount_paid)],
              ['Balance now', el('span', { class: Number(inv.balance) > 0 ? 'neg' : 'pos', text: money(inv.balance) })],
              ['Status', badge(inv.status)]
            ]
          })
        : el('p', { class: 'muted', text: 'Received on account — not applied to a particular invoice.' })),
      el('div', { class: 'grid-2' }, [
        panel('Tenant', tenantCard(tenant)),
        lease ? panel('Lease', leaseCard(lease)) : panel('Property', el('p', {}, [ref('properties', p.property_id)]))
      ]),
      panel('Other payments from this tenant', recordList(others, paymentRow, { limit: 6, empty: 'No other payments.' }),
            { flush: true, count: d.othersCount })
    ],
    aside: panel('Payment details', props([
      ['Payment ID', copyable(id, { label: 'Payment ID', mono: true })],
      ['Amount', money(p.amount)],
      ['Date', date(p.payment_date)],
      ['Method', p.method],
      ['Reference', p.reference ? copyable(p.reference, { label: 'Reference', mono: true }) : null],
      ['Received by', p.received_by],
      ['Tenant', ref('tenants', p.tenant_id)],
      ['Property', ref('properties', p.property_id)],
      ['Invoice', p.invoice_id ? ref('invoices', p.invoice_id, { text: p.invoice_id }) : 'On account'],
      ['Lease', lease ? ref('leases', lease.id, { text: lease.id }) : null],
      ['Notes', p.notes ? el('span', { class: 'prewrap', text: p.notes }) : null],
      ['Recorded', p.created_at ? date(p.created_at) : null]
    ]))
  });
}

// ── maintenance, expenses, documents ────────────────────────────────────────

const ENTITY_ICON = { maintenance: 'wrench', expenses: 'wallet', documents: 'folder' };

/** @param expense the expense a finished ticket's cost was booked as, if any */
function maintenanceMain(m, expense) {
  const openDays = m.reported_date ? daysBetween(m.reported_date, m.completed_date || today()) : null;
  const tenant = m.tenant_id ? store.byId('tenants', m.tenant_id) : null;
  const unit = m.unit_id ? store.byId('units', m.unit_id) : null;
  return [
    panel('Issue', el('div', { class: 'stack' }, [
      m.description ? el('p', { class: 'prewrap', text: m.description }) : el('p', { class: 'muted', text: 'No description given.' }),
      facts([
        ['Category', m.category], ['Priority', badge(m.priority)], ['Status', badge(m.status)],
        ['Reported', date(m.reported_date)], ['Scheduled', m.scheduled_date ? date(m.scheduled_date) : null],
        ['Completed', m.completed_date ? date(m.completed_date) : null],
        openDays !== null ? [m.completed_date ? 'Took' : 'Open for', `${openDays} day${openDays === 1 ? '' : 's'}`] : null
      ])
    ])),
    el('div', { class: 'grid-2' }, [
      panel('Location', unit ? unitCard(unit) : el('p', {}, [ref('properties', m.property_id)])),
      panel('Reported by', tenant ? tenantCard(tenant) : el('p', { class: 'muted', text: 'Not reported by a tenant.' }))
    ]),
    panel('Vendor & cost', facts([
      ['Vendor', m.vendor_name || '—'],
      ['Phone', m.vendor_phone ? copyable(m.vendor_phone, { label: 'Vendor phone', href: telHref(m.vendor_phone) }) : null],
      ['Cost', Number(m.cost) ? money(m.cost) : '—']
    ])),
    expense ? panel('Booked as expense', recordList([expense], expenseRow), { flush: true }) : null
  ];
}

/** @param ticket the maintenance ticket this expense books the cost of, if any */
function expenseMain(e, ticket) {
  const lease = e.reference ? store.byId('leases', e.reference) : null;
  const receipt = safeUrl(e.receipt_url);
  return [
    panel('Expense', facts([
      ['Amount', money(e.amount)], ['Date', date(e.date)], ['Category', e.category], ['Paid via', e.payment_method],
      ['Vendor', e.vendor], ['Reference', e.reference ? copyable(e.reference, { label: 'Reference', mono: true }) : null]
    ]), { action: receipt ? el('a', { class: 'btn btn-ghost btn-sm', href: receipt, target: '_blank', rel: 'noopener noreferrer' },
                               ['Receipt ', icon('external', 13)]) : null }),
    el('div', { class: 'grid-2' }, [
      panel('Property', el('div', { class: 'stack' }, [
        el('p', {}, [ref('properties', e.property_id)]),
        e.unit_id ? el('p', { class: 'muted' }, ['Unit ', ref('units', e.unit_id, { short: true })]) : null
      ])),
      ticket ? panel('Maintenance ticket', recordList([ticket], ticketRow), { flush: true })
        : lease ? panel('Deposit refund for', recordList([lease], leaseRow), { flush: true }) : null
    ])
  ];
}

function documentMain(d) {
  const href = safeUrl(d.url);
  const target = DOC_ENTITY[d.entity_type];
  const expired = d.expiry_date && d.expiry_date < today();
  const left = d.expiry_date ? daysBetween(today(), d.expiry_date) : null;
  return [
    expired ? notice(`Expired on ${date(d.expiry_date)}.`, 'danger')
      : left !== null && left <= 60 ? notice(`Expires in ${left} day${left === 1 ? '' : 's'} (${date(d.expiry_date)}).`, 'warn') : null,
    panel('File', href
      ? el('div', { class: 'file-row' }, [
          avatar({ iconName: 'folder', size: 'md' }),
          el('div', { class: 'file-name' }, [el('strong', { text: d.title }), el('small', { class: 'muted', text: new URL(href).host })]),
          el('a', { class: 'btn btn-primary btn-sm', href, target: '_blank', rel: 'noopener noreferrer' }, ['Open ', icon('external', 13)]),
          copyable(href, { label: 'Link', display: 'Copy link', compact: true })
        ])
      : el('p', { class: 'muted', text: 'No valid link stored for this document.' })),
    panel('Linked to', target && d.entity_id
      ? el('p', {}, [d.entity_type + ' ', ref(target, d.entity_id)])
      : el('p', { class: 'muted', text: d.entity_type ? `${d.entity_type} ${d.entity_id || ''}` : 'Not linked to a record.' }))
  ];
}

/** The page for records that are simpler than a lease or an invoice. */
export function recordDetail(entity, id) {
  return awaiting(() => store.detail(entity, id), (d) => (d.row ? recordPage(entity, d) : missing(entity)));
}

function recordPage(entity, d) {
  const def = entities[entity];
  const row = d.row;
  const id = row.id;
  const again = () => refreshView();
  const title = row[def.labelKey] || id;
  const where = [row.property_id ? ref('properties', row.property_id) : null,
                 row.unit_id ? ref('units', row.unit_id, { short: true }) : null].filter(Boolean);
  const main = entity === 'maintenance' ? maintenanceMain(row, d.expense)
    : entity === 'expenses' ? expenseMain(row, d.ticket)
    : documentMain(row);

  return detailPage({
    crumbs: [{ label: def.title, href: '#/' + entity }, { label: id }],
    lead: avatar({ iconName: ENTITY_ICON[entity] || def.icon }),
    kind: entity === 'expenses' ? (row.category || 'Expense') : entity === 'documents' ? (row.category || 'Document') : def.singular,
    title: entity === 'expenses' ? money(row.amount) : title,
    badges: [row.status ? badge(row.status) : null, row.priority ? badge(row.priority) : null],
    subtitle: entity === 'expenses' ? [row.description || '', where.length ? ' · ' : '', ...where.flatMap((w, i) => i ? [' · ', w] : [w])]
      : where.length ? where.flatMap((w, i) => i ? [' · ', w] : [w]) : null,
    meta: [copyable(id, { label: def.singular + ' ID', mono: true })],
    actions: [
      entity === 'documents' && safeUrl(row.url) ? linkBtn('Open file', 'external', safeUrl(row.url)) : null,
      managerBtn('Edit', 'edit', () => openEntityForm(entity, row, { onSaved: again })),
      deleteBtn(entity, row)
    ],
    main,
    aside: panel(def.singular + ' details', schemaProps(entity, row))
  });
}
