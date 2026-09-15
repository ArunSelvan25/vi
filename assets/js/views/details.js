import { el, icon, money, date, badge, emptyState, daysBetween, today, modal, whatsappLink,
         printDocument, isoDate } from '../ui.js';
import { store } from '../store.js';
import { navigate, refreshView } from '../router.js';
import { dataTable } from '../components/table.js';
import { openEntityForm } from '../components/form.js';
import { recordPaymentFor, showInvoice, showReceipt } from './invoices.js';
import { openRenewLease, openSettleDeposit } from './leases.js';

function stat(label, value, tone) {
  return el('div', { class: 'stat' + (tone ? ' stat-' + tone : '') }, [
    el('span', { class: 'stat-label', text: label }),
    el('strong', { class: 'stat-value', text: value })
  ]);
}

function backLink(to, label) {
  return el('button', { class: 'back-link', onClick: () => navigate(to) }, ['‹ ' + label]);
}

function section(title, body, { action, count } = {}) {
  return el('section', { class: 'panel' }, [
    el('header', { class: 'panel-head' }, [
      el('h3', {}, [title, count !== undefined ? el('span', { class: 'panel-count', text: String(count) }) : null]),
      action || null
    ]),
    el('div', { class: 'panel-body' }, [body])
  ]);
}

// ── Property detail ─────────────────────────────────────────────────────────

export function propertyDetail(id) {
  const property = store.byId('properties', id);
  if (!property) return emptyState('Property not found.', backLink('properties', 'Back to properties'));

  const units = store.unitsOfProperty(id);
  const leases = store.leases.filter(l => l.property_id === id);
  const invoices = store.invoices.filter(i => i.property_id === id);
  const expenses = store.expenses.filter(e => e.property_id === id);
  const tickets = store.maintenance.filter(m => m.property_id === id);

  // deposits are held for tenants, so neither receiving nor returning one is income or spend
  const collected = store.incomePayments()
    .filter(p => p.property_id === id).reduce((s, p) => s + Number(p.amount || 0), 0);
  // a completed ticket's cost is written to Expenses, so it is already counted
  const spent = store.operatingExpenses(expenses).reduce((s, e) => s + Number(e.amount || 0), 0);
  const depositsHeld = leases.reduce((s, l) => s + store.depositLedger(l).held, 0);
  const outstanding = invoices
    .filter(i => ['Unpaid', 'Partial', 'Overdue'].includes(i.status))
    .reduce((s, i) => s + Number(i.balance || 0), 0);
  const occupied = units.filter(u => u.status === 'Occupied').length;
  const rentRoll = leases.filter(l => l.status === 'Active')
    .reduce((s, l) => s + store.currentRent(l), 0);

  const wrap = el('div', { class: 'view' }, [
    backLink('properties', 'Properties'),
    el('div', { class: 'view-head' }, [
      el('div', {}, [
        el('h1', { text: property.name }),
        el('p', { class: 'muted', text: [property.address_line1, property.address_line2, property.city,
                                         property.state, property.postal_code].filter(Boolean).join(', ') })
      ]),
      el('div', { class: 'head-actions' }, [
        badge(property.status),
        store.can('manager')
          ? el('button', { class: 'btn btn-ghost',
              onClick: () => openEntityForm('properties', property, { onSaved: () => refreshView() }) },
              [icon('edit', 16), ' Edit'])
          : null
      ])
    ]),

    el('div', { class: 'stat-row' }, [
      stat('Units', `${occupied}/${units.length} occupied`),
      stat('Rent roll', money(rentRoll)),
      stat('Collected (all time)', money(collected), 'ok'),
      stat('Spent (all time)', money(spent), 'warn'),
      stat('Outstanding', money(outstanding), outstanding > 0 ? 'danger' : null),
      stat('Net', money(collected - spent), collected - spent >= 0 ? 'ok' : 'danger'),
      depositsHeld ? stat('Deposits held', money(depositsHeld)) : null
    ]),

    section('Units',
      units.length
        ? el('div', { class: 'unit-grid' }, units.map(u => {
            const lease = store.activeLeaseForUnit(u.id);
            const tenant = lease ? store.byId('tenants', lease.tenant_id) : null;
            return el('div', { class: 'unit-card' }, [
              el('div', { class: 'unit-card-head' }, [
                el('strong', { text: u.unit_number }), badge(u.status)
              ]),
              el('p', { class: 'muted', text: [
                u.bedrooms ? u.bedrooms + ' BR' : null,
                u.area_sqft ? u.area_sqft + ' sq ft' : null,
                u.furnishing
              ].filter(Boolean).join(' · ') || '—' }),
              el('p', {}, [el('strong', { text: money(u.rent_amount) }), el('small', { class: 'muted', text: ' / month' })]),
              tenant
                ? el('button', { class: 'link', onClick: () => navigate('tenants/' + tenant.id) },
                    [icon('users', 14), ' ' + tenant.full_name])
                : el('span', { class: 'muted', text: 'No active tenant' })
            ]);
          }))
        : emptyState('No units yet.'),
      { count: units.length,
        action: store.can('manager')
          ? el('button', { class: 'btn btn-ghost btn-sm',
              onClick: () => openEntityForm('units', null,
                { overrides: { property_id: id }, onSaved: () => refreshView() }) },
              [icon('plus', 15), ' Add unit'])
          : null }),

    el('div', { class: 'grid-2' }, [
      section('Open maintenance',
        tickets.filter(t => ['Open', 'In Progress', 'On Hold'].includes(t.status)).length
          ? el('ul', { class: 'list' }, tickets
              .filter(t => ['Open', 'In Progress', 'On Hold'].includes(t.status))
              .map(t => el('li', { class: 'list-row' }, [
                el('span', { text: t.title }),
                el('span', { class: 'list-meta' }, [badge(t.priority), badge(t.status)])
              ])))
          : el('p', { class: 'muted', text: 'Nothing open.' })),
      section('Recent expenses',
        expenses.length
          ? el('ul', { class: 'list' }, expenses.slice(-8).reverse().map(e =>
              el('li', { class: 'list-row' }, [
                el('span', { text: `${date(e.date)} · ${e.category || 'Other'}` }),
                el('strong', { text: money(e.amount) })
              ])))
          : el('p', { class: 'muted', text: 'No expenses recorded.' }))
    ])
  ]);

  return wrap;
}

// ── Tenant detail ───────────────────────────────────────────────────────────

export function tenantDetail(id) {
  const tenant = store.byId('tenants', id);
  if (!tenant) return emptyState('Tenant not found.', backLink('tenants', 'Back to tenants'));

  const leases = store.leases.filter(l => l.tenant_id === id);
  const invoices = store.invoicesOfTenant(id);
  const payments = store.payments.filter(p => p.tenant_id === id);
  const outstanding = invoices
    .filter(i => ['Unpaid', 'Partial', 'Overdue'].includes(i.status))
    .reduce((s, i) => s + Number(i.balance || 0), 0);
  const paid = store.incomePayments(payments).reduce((s, p) => s + Number(p.amount || 0), 0);
  const activeLease = leases.find(l => l.status === 'Active');
  const depositHeld = leases.reduce((s, l) => s + store.depositLedger(l).held, 0);
  const country = store.settings.whatsapp_country_code || '91';
  const balanceText = [
    `Hello ${tenant.full_name},`, '',
    outstanding > 0
      ? `Your balance with ${store.settings.org_name || 'us'} is ${money(outstanding)}.`
      : `You have nothing outstanding with ${store.settings.org_name || 'us'}. Thank you.`,
    outstanding > 0 && store.settings.upi_id ? `Pay by UPI to ${store.settings.upi_id}.` : null
  ].filter(l => l !== null).join('\n');
  const wa = tenant.phone ? whatsappLink(tenant.phone, balanceText, country) : '';

  const contact = (label, value, href) => value
    ? el('div', { class: 'kv' }, [
        el('span', { text: label }),
        href ? el('a', { href: href + value, text: value }) : el('strong', { text: value })
      ])
    : null;

  return el('div', { class: 'view' }, [
    backLink('tenants', 'Tenants'),
    el('div', { class: 'view-head' }, [
      el('div', {}, [
        el('h1', { text: tenant.full_name }),
        el('p', { class: 'muted', text: activeLease
          ? store.label('units', activeLease.unit_id) + ' · lease ' + activeLease.id
          : 'No active lease' })
      ]),
      el('div', { class: 'head-actions' }, [
        badge(tenant.status),
        el('button', { class: 'btn btn-ghost', onClick: () => showStatement(tenant) },
           [icon('file', 16), ' Statement']),
        wa ? el('a', { class: 'btn btn-ghost', href: wa, target: '_blank', rel: 'noopener noreferrer' },
                [icon('whatsapp', 16), ' WhatsApp']) : null,
        store.can('manager')
          ? el('button', { class: 'btn btn-ghost',
              onClick: () => openEntityForm('tenants', tenant, { onSaved: () => refreshView() }) },
              [icon('edit', 16), ' Edit'])
          : null
      ])
    ]),

    el('div', { class: 'stat-row' }, [
      stat('Outstanding', money(outstanding), outstanding > 0 ? 'danger' : 'ok'),
      stat('Paid to date', money(paid), 'ok'),
      stat('Invoices', String(invoices.length)),
      stat('Leases', String(leases.length)),
      activeLease ? stat('Rent', money(store.currentRent(activeLease))) : null,
      depositHeld ? stat('Deposit held', money(depositHeld)) : null,
      activeLease && activeLease.end_date
        ? stat('Lease ends', date(activeLease.end_date),
               daysBetween(today(), activeLease.end_date) < 45 ? 'warn' : null)
        : null
    ].filter(Boolean)),

    el('div', { class: 'grid-2' }, [
      section('Contact', el('div', { class: 'kv-list' }, [
        contact('Phone', tenant.phone, 'tel:'),
        contact('Alt. phone', tenant.alt_phone, 'tel:'),
        contact('Email', tenant.email, 'mailto:'),
        contact('ID', tenant.id_number ? `${tenant.id_type || 'ID'} ${tenant.id_number}` : ''),
        contact('Occupation', tenant.occupation),
        contact('Emergency', tenant.emergency_name
          ? `${tenant.emergency_name} · ${tenant.emergency_phone || ''}`.trim() : '')
      ].filter(Boolean))),
      section('Leases',
        leases.length
          ? el('ul', { class: 'list' }, leases.map(l =>
              el('li', { class: 'list-row' }, [
                el('div', {}, [
                  el('strong', { text: store.label('units', l.unit_id) }),
                  el('br'),
                  el('small', { class: 'muted', text: `${date(l.start_date)} – ${date(l.end_date)}` })
                ]),
                el('span', { class: 'list-meta' }, [
                  el('span', { text: money(store.currentRent(l, l.status === 'Expired' ? l.end_date : today())) }),
                  badge(l.status),
                  store.can('manager') && l.end_date && l.status !== 'Terminated' &&
                    !store.leases.some(n => n.renewed_from === l.id)
                    ? el('button', { class: 'btn btn-ghost btn-sm',
                        onClick: () => openRenewLease(l, { onDone: () => refreshView() }) }, ['Renew'])
                    : null,
                  store.can('manager') && store.depositLedger(l).held > 0
                    ? el('button', { class: 'btn btn-ghost btn-sm',
                        onClick: () => openSettleDeposit(l, { onDone: () => refreshView() }) }, ['Settle deposit'])
                    : null
                ])
              ])))
          : el('p', { class: 'muted', text: 'No leases on record.' }))
    ]),

    section('Invoices & payments',
      invoices.length
        ? dataTable({
            entity: 'invoices',
            rows: invoices.slice().sort((a, b) => String(b.due_date).localeCompare(String(a.due_date))),
            onRowClick: (row) => showInvoice(row),
            exportName: 'tenant-' + id + '-invoices',
            actions: [
              { label: 'View', icon: 'receipt', onClick: (row) => showInvoice(row) },
              { label: 'Record payment', icon: 'card',
                visible: (row) => store.can('manager') && Number(row.balance) > 0 && !['Void', 'Draft'].includes(row.status),
                onClick: (row) => recordPaymentFor(row, () => refreshView()) }
            ]
          })
        : el('p', { class: 'muted', text: 'No invoices yet.' })),

    payments.length
      ? section('Payments received', dataTable({
          entity: 'payments',
          rows: payments.slice().sort((a, b) => String(b.payment_date).localeCompare(String(a.payment_date))),
          onRowClick: (row) => showReceipt(row),
          exportName: 'tenant-' + id + '-payments',
          actions: [{ label: 'Receipt', icon: 'receipt', onClick: (row) => showReceipt(row) }]
        }), { count: payments.length })
      : null
  ]);
}

// ── Tenant statement ────────────────────────────────────────────────────────

/**
 * Statement of account for a date range: opening balance, every invoice and
 * payment in the range with a running balance, closing balance — and where the
 * deposit stands. Invoices are what is owed and payments what reduces it, so
 * the closing balance is exactly what the tenant's invoices still show.
 */
export function showStatement(tenant) {
  const s = store.settings;
  const first = new Date(); first.setMonth(first.getMonth() - 6); first.setDate(1);
  const state = { from: isoDate(first), to: today() };
  const host = el('div');

  const fromInput = el('input', { class: 'input', type: 'date', value: state.from,
                                  onChange: (e) => { state.from = e.target.value; draw(); } });
  const toInput = el('input', { class: 'input', type: 'date', value: state.to,
                                onChange: (e) => { state.to = e.target.value; draw(); } });
  const shareHost = el('span');

  function entries() {
    const out = [];
    for (const inv of store.invoicesOfTenant(tenant.id)) {
      if (['Void', 'Draft'].includes(inv.status)) continue;
      out.push({ date: String(inv.issue_date || inv.due_date || '').slice(0, 10), kind: 'invoice',
                 text: `${inv.id} · ${inv.type || 'Invoice'}${inv.period_start ? ' · ' + date(inv.period_start) + ' – ' + date(inv.period_end) : ''}`,
                 debit: Number(inv.total || inv.amount || 0), credit: 0 });
    }
    for (const p of store.payments.filter(x => x.tenant_id === tenant.id)) {
      out.push({ date: String(p.payment_date || '').slice(0, 10), kind: 'payment',
                 text: `${p.id} · ${p.method || 'Payment'}${p.reference && p.method !== 'Deposit Adjustment' ? ' · ' + p.reference : ''}` +
                       (p.invoice_id ? ' → ' + p.invoice_id : ''),
                 debit: 0, credit: Number(p.amount || 0) });
    }
    // on a day with both, the invoice comes first
    return out.sort((a, b) => a.date.localeCompare(b.date) || (a.kind === 'invoice' ? -1 : 1));
  }

  function draw() {
    host.textContent = '';
    const all = entries();
    const opening = all.filter(e => e.date < state.from).reduce((b, e) => b + e.debit - e.credit, 0);
    const within = all.filter(e => e.date >= state.from && e.date <= state.to);
    let running = opening;
    const rows = within.map(e => {
      running += e.debit - e.credit;
      return el('tr', {}, [
        el('td', { text: date(e.date) }), el('td', { text: e.text }),
        el('td', { class: 'num', text: e.debit ? money(e.debit) : '' }),
        el('td', { class: 'num', text: e.credit ? money(e.credit) : '' }),
        el('td', { class: 'num', text: money(running) })
      ]);
    });
    const closing = running;
    const leases = store.leases.filter(l => l.tenant_id === tenant.id);
    const deposit = leases.map(l => ({ lease: l, ...store.depositLedger(l) })).filter(d => d.received > 0);

    host.append(el('div', { class: 'invoice-doc', id: 'printable' }, [
      el('div', { class: 'invoice-top' }, [
        el('div', {}, [
          el('h2', { text: s.org_name || 'Property Management' }),
          s.gstin ? el('p', { class: 'muted', text: 'GSTIN ' + s.gstin }) : null
        ]),
        el('div', { class: 'invoice-meta' }, [
          el('p', { class: 'doc-kind', text: 'Statement of account' }),
          el('h3', { text: tenant.full_name }),
          el('p', { class: 'muted', text: `${date(state.from)} – ${date(state.to)}` })
        ])
      ]),
      el('div', { class: 'table-scroll' }, [el('table', { class: 'invoice-table statement-table' }, [
        el('thead', {}, [el('tr', {}, ['Date', 'Details', 'Charged', 'Paid', 'Balance']
          .map((h, i) => el('th', { class: i >= 2 ? 'num' : null, text: h })))]),
        el('tbody', {}, [
          el('tr', { class: 'muted' }, [el('td', { text: date(state.from) }), el('td', { text: 'Opening balance' }),
            el('td'), el('td'), el('td', { class: 'num', text: money(opening) })]),
          ...rows,
          el('tr', { class: 'total-row' }, [el('td', { text: date(state.to) }), el('td', { text: 'Closing balance' }),
            el('td'), el('td'), el('td', { class: 'num', text: money(closing) })])
        ])
      ])]),
      deposit.length ? el('div', { class: 'invoice-payments' }, [
        el('h4', { text: 'Security deposit' }),
        el('ul', { class: 'list' }, deposit.map(d => el('li', { class: 'list-row' }, [
          el('span', { text: `${d.lease.id} · received ${money(d.received)}` +
                             (d.applied ? ` · applied ${money(d.applied)}` : '') +
                             (d.refunded ? ` · refunded ${money(d.refunded)}` : '') }),
          el('strong', { text: 'held ' + money(d.held) })
        ])))
      ]) : null,
      el('p', { class: 'invoice-foot muted', text: 'Generated by ' + (s.org_name || 'Property Manager') + ' on ' + date(today()) })
    ]));

    shareHost.textContent = '';
    const text = [
      `Hello ${tenant.full_name},`, '',
      `Statement ${date(state.from)} – ${date(state.to)} from ${s.org_name || 'us'}:`,
      `Opening balance ${money(opening)}`,
      `Charged ${money(within.reduce((t, e) => t + e.debit, 0))}, paid ${money(within.reduce((t, e) => t + e.credit, 0))}`,
      `Closing balance ${money(closing)}`,
      closing > 0 && s.upi_id ? `Pay by UPI to ${s.upi_id}.` : null
    ].filter(l => l !== null).join('\n');
    const wa = tenant.phone ? whatsappLink(tenant.phone, text, s.whatsapp_country_code || '91') : '';
    if (wa) shareHost.append(el('a', { class: 'btn btn-ghost', href: wa, target: '_blank', rel: 'noopener noreferrer' },
                                [icon('whatsapp', 16), ' WhatsApp']));
  }

  draw();
  modal({
    title: 'Statement · ' + tenant.full_name,
    width: 820,
    body: el('div', {}, [
      el('div', { class: 'filter-bar doc-actions' }, [
        el('label', {}, ['From ', fromInput]), el('label', {}, ['To ', toInput]), shareHost
      ]),
      host
    ]),
    actions: [
      { label: 'Close' },
      { label: 'Print / PDF', variant: 'btn-primary', onClick: () => printDocument() }
    ]
  });
}
