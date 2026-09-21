import { el, icon, money, date, badge, daysBetween, today, modal, whatsappLink,
         printDocument, isoDate } from '../ui.js';
import { store } from '../store.js';
import { navigate, refreshView } from '../router.js';
import { dataTable } from '../components/table.js';
import { openEntityForm } from '../components/form.js';
import { barChart } from '../components/charts.js';
import { tableFields } from '../schema.js';
import { detailPage, stat, statRow, panel, props, facts, notice, tabs, recordList, invoiceRow, paymentRow,
         leaseRow, ticketRow, documentRow, termProgress, timeline, eventsFor, ref, copyable, avatar,
         hrefFor } from '../components/detail.js';
import { recordPaymentFor } from './invoices.js';
import { OPEN, sum, newestFirst, owed, canPay, country, telHref, btn, managerBtn, linkBtn, viewAll, missing,
         deleteBtn, docsFor, invoiceTable, paymentTable, leaseTable, ticketTable, expenseTable, documentTable,
         expenseRow, tenantCard, leaseCard } from './records.js';

const byUnitNumber = (a, b) => String(a.unit_number).localeCompare(String(b.unit_number), undefined, { numeric: true });
const ACTIVE_TICKET = ['Open', 'In Progress', 'On Hold'];

// ── Property detail ─────────────────────────────────────────────────────────

/** One unit in the property's grid: the whole card opens the unit. */
function unitTile(u) {
  const lease = store.activeLeaseForUnit(u.id);
  const tenant = lease ? store.byId('tenants', lease.tenant_id) : null;
  const due = owed(store.invoices.filter(i => i.unit_id === u.id));
  const open = () => navigate('units/' + u.id);
  return el('div', {
    class: 'unit-card clickable', role: 'link', tabindex: '0', 'aria-label': 'Unit ' + u.unit_number,
    onClick: open, onKeydown: (e) => { if (e.key === 'Enter') open(); }
  }, [
    el('div', { class: 'unit-card-head' }, [el('strong', { text: u.unit_number }), badge(u.status)]),
    el('p', { class: 'muted', text: [
      u.bedrooms ? u.bedrooms + ' BR' : null,
      u.area_sqft ? u.area_sqft + ' sq ft' : null,
      u.furnishing
    ].filter(Boolean).join(' · ') || '—' }),
    el('p', {}, [el('strong', { text: money(lease ? store.currentRent(lease) : u.rent_amount) }),
                 el('small', { class: 'muted', text: ' / month' })]),
    tenant
      ? el('div', { class: 'unit-card-tenant' }, [icon('user', 13), ref('tenants', tenant.id)])
      : el('span', { class: 'muted small', text: 'No active tenant' }),
    lease?.end_date || due > 0
      ? el('div', { class: 'unit-card-foot' }, [
          lease?.end_date ? el('small', { class: 'muted', text: 'Ends ' + date(lease.end_date) }) : el('span'),
          due > 0 ? el('small', { class: 'neg', text: money(due) + ' due' }) : null
        ])
      : null
  ]);
}

export function propertyDetail(id, ctx = {}) {
  const property = store.byId('properties', id);
  if (!property) return missing('properties');

  const units = store.unitsOfProperty(id).slice().sort(byUnitNumber);
  const unitIds = units.map(u => u.id);
  const leases = store.leases.filter(l => l.property_id === id);
  const leaseIds = leases.map(l => l.id);
  const invoices = store.invoices.filter(i => i.property_id === id);
  const payments = store.payments.filter(p => p.property_id === id).sort(newestFirst('payment_date'));
  const expenses = store.expenses.filter(e => e.property_id === id).sort(newestFirst('date'));
  const tickets = store.maintenance.filter(m => m.property_id === id);
  const openTickets = tickets.filter(t => ACTIVE_TICKET.includes(t.status));
  const docs = [...docsFor('Property', id), ...docsFor('Unit', unitIds), ...docsFor('Lease', leaseIds)];

  // deposits are held for tenants, so neither receiving nor returning one is income or spend
  const collected = sum(store.incomePayments(payments));
  // a completed ticket's cost is written to Expenses, so it is already counted
  const spent = sum(store.operatingExpenses(expenses));
  const depositsHeld = leases.reduce((s, l) => s + store.depositLedger(l).held, 0);
  const outstanding = owed(invoices);
  const occupied = units.filter(u => u.status === 'Occupied').length;
  const vacant = units.filter(u => u.status === 'Vacant').length;
  const occPct = units.length ? Math.round(occupied / units.length * 100) : 0;
  const rentRoll = leases.filter(l => l.status === 'Active').reduce((s, l) => s + store.currentRent(l), 0);
  const address = [property.address_line1, property.address_line2, property.city, property.state,
                   property.postal_code, property.country].filter(Boolean).join(', ');
  const appreciation = Number(property.purchase_price) > 0 && Number(property.current_value) > 0
    ? Math.round((property.current_value - property.purchase_price) / property.purchase_price * 1000) / 10 : null;

  const addUnit = () => openEntityForm('units', null, { overrides: { property_id: id }, onSaved: () => refreshView() });

  let t = null;
  const overview = () => el('div', { class: 'tab-stack' }, [
    panel('Units', units.length
      ? el('div', { class: 'unit-grid' }, units.map(unitTile))
      : el('p', { class: 'muted', text: 'No units yet. Add the first one to start leasing.' }), {
      count: units.length,
      action: store.can('manager')
        ? el('button', { class: 'btn btn-ghost btn-sm', onClick: addUnit }, [icon('plus', 15), ' Add unit'])
        : null
    }),
    el('div', { class: 'grid-2' }, [
      panel('Collected vs spent', barChart(store.monthlySeries(6, { match: r => r.property_id === id }), { height: 200 })),
      panel('Open maintenance', recordList(openTickets, ticketRow, { limit: 6, empty: 'Nothing open.' }), {
        flush: true, count: openTickets.length,
        action: tickets.length ? viewAll(() => t.select('maintenance')) : null
      })
    ]),
    el('div', { class: 'grid-2' }, [
      panel('Recent payments', recordList(payments, paymentRow, { limit: 5, empty: 'No payments yet.' }), {
        flush: true, count: payments.length,
        action: payments.length > 5 ? viewAll(() => t.select('payments')) : null
      }),
      panel('Recent expenses', recordList(expenses, expenseRow, { limit: 5, empty: 'No expenses recorded.' }), {
        flush: true, count: expenses.length,
        action: expenses.length > 5 ? viewAll(() => t.select('expenses')) : null
      })
    ])
  ]);

  t = tabs([
    { key: 'overview', label: 'Overview', render: overview },
    { key: 'units', label: 'Units', count: units.length, render: () => dataTable({
        entity: 'units', rows: units, columns: tableFields('units').filter(c => c.key !== 'property_id'),
        onRowClick: (r) => navigate('units/' + r.id), emptyMessage: 'No units yet.' }) },
    { key: 'leases', label: 'Leases', count: leases.length, render: () => leaseTable(leases, { hide: ['property_id'] }) },
    { key: 'invoices', label: 'Invoices', count: invoices.length,
      render: () => invoiceTable(invoices, { hide: ['property_id'], exportName: 'property-' + id + '-invoices' }) },
    { key: 'payments', label: 'Payments', count: payments.length,
      render: () => paymentTable(payments, { hide: ['property_id'], exportName: 'property-' + id + '-payments' }) },
    { key: 'expenses', label: 'Expenses', count: expenses.length, render: () => expenseTable(expenses, { hide: ['property_id'] }) },
    { key: 'maintenance', label: 'Maintenance', count: tickets.length, render: () => ticketTable(tickets, { hide: ['property_id'] }) },
    { key: 'documents', label: 'Documents', count: docs.length, render: () => documentTable(docs) }
  ], { active: ctx.query?.tab, base: hrefFor('properties', id) });

  return detailPage({
    crumbs: [{ label: 'Properties', href: '#/properties' }, { label: property.name }],
    lead: avatar({ iconName: 'building' }),
    kind: property.type || 'Property',
    title: property.name,
    badges: [badge(property.status)],
    subtitle: address || null,
    meta: [
      copyable(id, { label: 'Property ID', mono: true }),
      [icon('grid', 14), `${units.length} unit${units.length === 1 ? '' : 's'}`],
      property.owner_name ? [icon('user', 14), property.owner_name] : null
    ],
    actions: [
      managerBtn('Add unit', 'plus', addUnit),
      managerBtn('Edit', 'edit', () => openEntityForm('properties', property, { onSaved: () => refreshView() })),
      deleteBtn('properties', property)
    ],
    stats: statRow([
      stat('Occupancy', `${occupied}/${units.length}`, null, `${occPct}% occupied`),
      stat('Rent roll', money(rentRoll), null, 'per month'),
      stat('Collected', money(collected), 'ok', 'all time'),
      stat('Outstanding', money(outstanding), outstanding > 0 ? 'danger' : null),
      stat('Spent', money(spent), 'warn', 'all time'),
      stat('Net', money(collected - spent), collected - spent >= 0 ? 'ok' : 'danger'),
      depositsHeld ? stat('Deposits held', money(depositsHeld)) : null
    ]),
    main: t.el,
    aside: [
      panel('Occupancy', el('div', { class: 'stack' }, [
        el('div', { class: 'term-track', role: 'progressbar', 'aria-valuenow': String(occPct), 'aria-valuemin': '0',
                    'aria-valuemax': '100', 'aria-label': 'Units occupied' },
           [el('div', { class: 'term-fill', style: `width:${occPct}%` })]),
        facts([['Occupied', String(occupied), 'ok'], ['Vacant', String(vacant)],
               units.length - occupied - vacant ? ['Other', String(units.length - occupied - vacant)] : null])
      ])),
      panel('Property details', props([
        ['Property ID', copyable(id, { label: 'Property ID', mono: true })],
        ['Type', property.type],
        ['Address', address ? copyable(address, { label: 'Address' }) : null],
        ['Owner', property.owner_name],
        ['Purchased', property.purchase_date ? date(property.purchase_date) : null],
        ['Purchase price', Number(property.purchase_price) ? money(property.purchase_price) : null],
        ['Current value', Number(property.current_value) ? money(property.current_value) : null],
        ['Appreciation', appreciation !== null
          ? el('span', { class: appreciation >= 0 ? 'pos' : 'neg', text: (appreciation >= 0 ? '+' : '') + appreciation + '%' }) : null],
        ['Notes', property.notes ? el('span', { class: 'prewrap', text: property.notes }) : null]
      ]))
    ]
  });
}

// ── Unit detail ─────────────────────────────────────────────────────────────

export function unitDetail(id, ctx = {}) {
  const unit = store.byId('units', id);
  if (!unit) return missing('units');

  const leases = store.leases.filter(l => l.unit_id === id).sort(newestFirst('start_date'));
  const leaseIds = new Set(leases.map(l => l.id));
  const lease = store.activeLeaseForUnit(id);
  const upcoming = leases.find(l => l.status === 'Upcoming');
  const tenant = lease ? store.byId('tenants', lease.tenant_id) : null;
  const invoices = store.invoices.filter(i => i.unit_id === id);
  const invIds = new Set(invoices.map(i => i.id));
  const payments = store.payments.filter(p => invIds.has(p.invoice_id) || (p.lease_id && leaseIds.has(p.lease_id)))
    .sort(newestFirst('payment_date'));
  const tickets = store.maintenance.filter(m => m.unit_id === id);
  const openTickets = tickets.filter(m => ACTIVE_TICKET.includes(m.status));
  const docs = [...docsFor('Unit', id), ...docsFor('Lease', [...leaseIds])];
  const outstanding = owed(invoices);
  const collected = sum(store.incomePayments(payments));
  const left = lease?.end_date ? daysBetween(today(), lease.end_date) : null;
  const lastEnded = !lease ? leases.find(l => ['Expired', 'Terminated'].includes(l.status) && l.end_date) : null;
  const again = () => refreshView();
  const newLease = !lease && !upcoming && store.can('manager')
    ? () => openEntityForm('leases', null, {
        overrides: { property_id: unit.property_id, unit_id: id },
        onSaved: (row) => (row?.id ? navigate('leases/' + row.id) : again())
      })
    : null;

  let t = null;
  const overview = () => el('div', { class: 'tab-stack' }, [
    !lease ? notice([
      upcoming ? ['Vacant until ', ref('leases', upcoming.id, { text: upcoming.id }), ` starts on ${date(upcoming.start_date)}.`]
        : lastEnded ? `Vacant since ${date(lastEnded.end_date)}.` : 'This unit is vacant.'
    ].flat(), 'info', newLease ? btn('New lease', 'plus', newLease) : null) : null,
    el('div', { class: 'grid-2' }, [
      panel('Current tenant', tenant ? tenantCard(tenant) : el('p', { class: 'muted', text: 'No one is living here right now.' })),
      panel('Current lease', lease ? leaseCard(lease) : el('p', { class: 'muted', text: 'No active lease.' }))
    ]),
    el('div', { class: 'grid-2' }, [
      panel('Recent invoices', recordList(invoices.slice().sort(newestFirst('due_date')), invoiceRow,
        { limit: 5, empty: 'No invoices for this unit yet.' }),
        { flush: true, count: invoices.length, action: invoices.length > 5 ? viewAll(() => t.select('invoices')) : null }),
      panel('Recent payments', recordList(payments, paymentRow, { limit: 5, empty: 'No payments yet.' }),
        { flush: true, count: payments.length, action: payments.length > 5 ? viewAll(() => t.select('payments')) : null })
    ]),
    panel('Open maintenance', recordList(openTickets, ticketRow, { limit: 5, empty: 'Nothing open.' }),
      { flush: true, count: openTickets.length, action: tickets.length ? viewAll(() => t.select('maintenance')) : null })
  ]);

  t = tabs([
    { key: 'overview', label: 'Overview', render: overview },
    { key: 'invoices', label: 'Invoices', count: invoices.length,
      render: () => invoiceTable(invoices, { hide: ['property_id', 'unit_id'], exportName: 'unit-' + id + '-invoices' }) },
    { key: 'payments', label: 'Payments', count: payments.length,
      render: () => paymentTable(payments, { hide: ['property_id'], exportName: 'unit-' + id + '-payments' }) },
    { key: 'leases', label: 'Lease history', count: leases.length,
      render: () => leaseTable(leases, { hide: ['property_id', 'unit_id'] }) },
    { key: 'maintenance', label: 'Maintenance', count: tickets.length,
      render: () => ticketTable(tickets, { hide: ['property_id', 'unit_id'] }) },
    { key: 'documents', label: 'Documents', count: docs.length, render: () => documentTable(docs) },
    { key: 'activity', label: 'Activity',
      render: () => panel('Activity', timeline(eventsFor({ leases, invoices, payments, tickets }))) }
  ], { active: ctx.query?.tab, base: hrefFor('units', id) });

  const property = store.byId('properties', unit.property_id);
  return detailPage({
    crumbs: [
      { label: 'Properties', href: '#/properties' },
      property ? { label: property.name, href: hrefFor('properties', property.id) } : { label: 'Units', href: '#/units' },
      { label: unit.unit_number }
    ],
    lead: avatar({ iconName: 'grid' }),
    kind: 'Unit',
    title: unit.unit_number,
    badges: [badge(unit.status)],
    subtitle: [ref('properties', unit.property_id), unit.floor ? ` · Floor ${unit.floor}` : ''],
    meta: [
      copyable(id, { label: 'Unit ID', mono: true }),
      [unit.bedrooms ? unit.bedrooms + ' BR' : null, unit.bathrooms ? unit.bathrooms + ' bath' : null,
       unit.area_sqft ? unit.area_sqft + ' sq ft' : null, unit.furnishing].filter(Boolean).join(' · ') || null
    ],
    actions: [
      newLease ? btn('New lease', 'plus', newLease, 'btn-primary') : null,
      managerBtn('Edit', 'edit', () => openEntityForm('units', unit, { onSaved: again })),
      deleteBtn('units', unit)
    ],
    stats: statRow([
      stat('Market rent', money(unit.rent_amount), null, 'per month'),
      lease ? stat('Current rent', money(store.currentRent(lease)), null, tenant?.full_name) : stat('Current rent', '—', null, 'vacant'),
      stat('Outstanding', money(outstanding), outstanding > 0 ? 'danger' : 'ok'),
      stat('Collected', money(collected), 'ok', 'all time'),
      lease ? stat('Deposit held', money(store.depositLedger(lease).held)) : null,
      left !== null ? stat('Lease ends', date(lease.end_date), left <= 45 ? 'warn' : null, `in ${left} days`) : null
    ]),
    main: t.el,
    aside: panel('Unit details', props([
      ['Unit ID', copyable(id, { label: 'Unit ID', mono: true })],
      ['Property', ref('properties', unit.property_id)],
      ['Floor', unit.floor],
      ['Bedrooms', unit.bedrooms],
      ['Bathrooms', unit.bathrooms],
      ['Area', unit.area_sqft ? unit.area_sqft + ' sq ft' : null],
      ['Furnishing', unit.furnishing],
      ['Market rent', money(unit.rent_amount)],
      ['Deposit', Number(unit.deposit_amount) ? money(unit.deposit_amount) : null],
      ['Amenities', unit.amenities
        ? el('span', { class: 'tag-row' }, String(unit.amenities).split(',').map(a => a.trim()).filter(Boolean)
            .map(a => el('span', { class: 'tag', text: a })))
        : null],
      ['Notes', unit.notes ? el('span', { class: 'prewrap', text: unit.notes }) : null]
    ]))
  });
}

// ── Tenant detail ───────────────────────────────────────────────────────────

export function tenantDetail(id, ctx = {}) {
  const tenant = store.byId('tenants', id);
  if (!tenant) return missing('tenants');

  const leases = store.leases.filter(l => l.tenant_id === id).sort(newestFirst('start_date'));
  const invoices = store.invoicesOfTenant(id);
  const payments = store.payments.filter(p => p.tenant_id === id).sort(newestFirst('payment_date'));
  const tickets = store.maintenance.filter(m => m.tenant_id === id);
  const docs = [...docsFor('Tenant', id), ...docsFor('Lease', leases.map(l => l.id))];
  const unpaid = invoices.filter(i => OPEN.includes(i.status) && Number(i.balance) > 0)
    .sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)));
  const outstanding = owed(invoices);
  const overdue = unpaid.filter(i => i.due_date && i.due_date < today());
  const paid = sum(store.incomePayments(payments));
  const activeLease = leases.find(l => l.status === 'Active');
  const depositHeld = leases.reduce((s, l) => s + store.depositLedger(l).held, 0);
  const since = leases.length ? leases[leases.length - 1].start_date : tenant.created_at;
  const left = activeLease?.end_date ? daysBetween(today(), activeLease.end_date) : null;
  const again = () => refreshView();

  const balanceText = [
    `Hello ${tenant.full_name},`, '',
    outstanding > 0
      ? `Your balance with ${store.settings.org_name || 'us'} is ${money(outstanding)}.`
      : `You have nothing outstanding with ${store.settings.org_name || 'us'}. Thank you.`,
    outstanding > 0 && store.settings.upi_id ? `Pay by UPI to ${store.settings.upi_id}.` : null
  ].filter(l => l !== null).join('\n');
  const wa = tenant.phone ? whatsappLink(tenant.phone, balanceText, country()) : '';

  let t = null;
  const overview = () => el('div', { class: 'tab-stack' }, [
    overdue.length
      ? notice(`${money(sum(overdue, 'balance'))} overdue across ${overdue.length} invoice${overdue.length === 1 ? '' : 's'}` +
               ` — the oldest was due ${date(overdue[0].due_date)}.`, 'danger')
      : null,
    unpaid.length ? panel('Unpaid invoices', el('div', { class: 'rec-list' }, unpaid.map(inv =>
      el('div', { class: 'rec-with-action' }, [
        invoiceRow(inv),
        canPay(inv) ? el('button', { class: 'btn btn-ghost btn-sm', onClick: () => recordPaymentFor(inv, again) },
                         [icon('card', 14), ' Record payment']) : null
      ]))), { flush: true, count: unpaid.length }) : null,
    el('div', { class: 'grid-2' }, [
      panel('Current lease', activeLease ? leaseCard(activeLease) : el('div', { class: 'stack' }, [
        el('p', { class: 'muted', text: 'No active lease.' }),
        store.can('manager') ? el('div', {}, [btn('New lease', 'plus', () => openEntityForm('leases', null,
          { overrides: { tenant_id: id }, onSaved: again }))]) : null
      ])),
      panel('Home', activeLease ? el('div', { class: 'stack' }, [
        facts([
          ['Unit', ref('units', activeLease.unit_id, { short: true })],
          ['Property', ref('properties', activeLease.property_id)],
          ['Deposit held', money(store.depositLedger(activeLease).held)],
          ['Tenant since', since ? date(since) : null]
        ])
      ]) : el('p', { class: 'muted', text: 'Not renting a unit right now.' }))
    ]),
    el('div', { class: 'grid-2' }, [
      panel('Recent invoices', recordList(invoices.slice().sort(newestFirst('due_date')), invoiceRow,
        { limit: 5, empty: 'No invoices yet.' }),
        { flush: true, count: invoices.length, action: invoices.length > 5 ? viewAll(() => t.select('invoices')) : null }),
      panel('Recent payments', recordList(payments, paymentRow, { limit: 5, empty: 'No payments yet.' }),
        { flush: true, count: payments.length, action: payments.length > 5 ? viewAll(() => t.select('payments')) : null })
    ])
  ]);

  t = tabs([
    { key: 'overview', label: 'Overview', render: overview },
    { key: 'invoices', label: 'Invoices', count: invoices.length,
      render: () => invoiceTable(invoices, { hide: ['tenant_id'], exportName: 'tenant-' + id + '-invoices' }) },
    { key: 'payments', label: 'Payments', count: payments.length,
      render: () => paymentTable(payments, { hide: ['tenant_id'], exportName: 'tenant-' + id + '-payments' }) },
    { key: 'leases', label: 'Leases', count: leases.length, render: () => leaseTable(leases, { hide: ['tenant_id'] }) },
    { key: 'maintenance', label: 'Maintenance', count: tickets.length, render: () => ticketTable(tickets) },
    { key: 'documents', label: 'Documents', count: docs.length, render: () => documentTable(docs) },
    { key: 'activity', label: 'Activity',
      render: () => panel('Activity', timeline(eventsFor({ leases, invoices, payments, tickets }))) }
  ], { active: ctx.query?.tab, base: hrefFor('tenants', id) });

  return detailPage({
    crumbs: [{ label: 'Tenants', href: '#/tenants' }, { label: tenant.full_name }],
    lead: avatar({ name: tenant.full_name }),
    kind: 'Tenant',
    title: tenant.full_name,
    badges: [badge(tenant.status), overdue.length ? badge('Overdue', 'danger') : null],
    subtitle: activeLease
      ? [ref('units', activeLease.unit_id), ' · lease ', ref('leases', activeLease.id, { text: activeLease.id })]
      : 'No active lease',
    meta: [
      copyable(id, { label: 'Tenant ID', mono: true }),
      tenant.phone ? [icon('phone', 14), copyable(tenant.phone, { label: 'Phone', href: telHref(tenant.phone) })] : null,
      tenant.email ? [icon('mail', 14), copyable(tenant.email, { label: 'Email', href: 'mailto:' + tenant.email })] : null
    ],
    actions: [
      btn('Statement', 'file', () => showStatement(tenant)),
      wa ? linkBtn('WhatsApp', 'whatsapp', wa) : null,
      managerBtn('Edit', 'edit', () => openEntityForm('tenants', tenant, { onSaved: again })),
      deleteBtn('tenants', tenant)
    ],
    stats: statRow([
      stat('Outstanding', money(outstanding), outstanding > 0 ? 'danger' : 'ok',
           unpaid.length ? `${unpaid.length} unpaid invoice${unpaid.length === 1 ? '' : 's'}` : 'all settled'),
      stat('Paid to date', money(paid), 'ok', `${payments.length} payment${payments.length === 1 ? '' : 's'}`),
      activeLease ? stat('Rent', money(store.currentRent(activeLease)), null, 'per month') : null,
      depositHeld ? stat('Deposit held', money(depositHeld)) : null,
      left !== null ? stat('Lease ends', date(activeLease.end_date), left < 45 ? 'warn' : null, `in ${left} days`) : null,
      stat('Invoices', String(invoices.length), null, `${leases.length} lease${leases.length === 1 ? '' : 's'}`)
    ]),
    main: t.el,
    aside: [
      panel('Contact', props([
        ['Tenant ID', copyable(id, { label: 'Tenant ID', mono: true })],
        ['Phone', tenant.phone ? copyable(tenant.phone, { label: 'Phone', href: telHref(tenant.phone) }) : null],
        ['Alternate phone', tenant.alt_phone ? copyable(tenant.alt_phone, { label: 'Phone', href: telHref(tenant.alt_phone) }) : null],
        ['Email', tenant.email ? copyable(tenant.email, { label: 'Email', href: 'mailto:' + tenant.email }) : null],
        ['Occupation', tenant.occupation],
        ['Tenant since', since ? date(since) : null]
      ])),
      panel('Identity', props([
        [tenant.id_type || 'ID number', tenant.id_number ? copyable(tenant.id_number, { label: (tenant.id_type || 'ID') + ' number', mono: true }) : null],
        ['GSTIN', tenant.gstin ? copyable(tenant.gstin, { label: 'GSTIN', mono: true }) : null]
      ])),
      tenant.emergency_name || tenant.emergency_phone ? panel('Emergency contact', props([
        ['Name', tenant.emergency_name],
        ['Phone', tenant.emergency_phone ? copyable(tenant.emergency_phone, { label: 'Phone', href: telHref(tenant.emergency_phone) }) : null]
      ])) : null,
      tenant.notes ? panel('Notes', el('p', { class: 'prewrap', text: tenant.notes })) : null
    ]
  });
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
