import { el, icon, money, date, badge, emptyState, daysBetween, today } from '../ui.js';
import { store } from '../store.js';
import { navigate } from '../router.js';
import { dataTable } from '../components/table.js';
import { openEntityForm } from '../components/form.js';
import { recordPaymentFor, showInvoice } from './invoices.js';

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

  const collected = store.payments
    .filter(p => p.property_id === id).reduce((s, p) => s + Number(p.amount || 0), 0);
  // a completed ticket's cost is written to Expenses, so it is already counted
  const spent = expenses.reduce((s, e) => s + Number(e.amount || 0), 0);
  const outstanding = invoices
    .filter(i => ['Unpaid', 'Partial', 'Overdue'].includes(i.status))
    .reduce((s, i) => s + Number(i.balance || 0), 0);
  const occupied = units.filter(u => u.status === 'Occupied').length;
  const rentRoll = leases.filter(l => l.status === 'Active')
    .reduce((s, l) => s + Number(l.rent_amount || 0), 0);

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
              onClick: () => openEntityForm('properties', property, { onSaved: () => location.reload() }) },
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
      stat('Net', money(collected - spent), collected - spent >= 0 ? 'ok' : 'danger')
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
              el('p', {}, [el('strong', { text: money(u.rent_amount) }), el('small', { class: 'muted', text: ' / period' })]),
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
                { overrides: { property_id: id }, onSaved: () => location.reload() }) },
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
  const paid = payments.reduce((s, p) => s + Number(p.amount || 0), 0);
  const activeLease = leases.find(l => l.status === 'Active');

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
        store.can('manager')
          ? el('button', { class: 'btn btn-ghost',
              onClick: () => openEntityForm('tenants', tenant, { onSaved: () => location.reload() }) },
              [icon('edit', 16), ' Edit'])
          : null
      ])
    ]),

    el('div', { class: 'stat-row' }, [
      stat('Outstanding', money(outstanding), outstanding > 0 ? 'danger' : 'ok'),
      stat('Paid to date', money(paid), 'ok'),
      stat('Invoices', String(invoices.length)),
      stat('Leases', String(leases.length)),
      activeLease ? stat('Rent', money(activeLease.rent_amount)) : null,
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
                el('span', { class: 'list-meta' }, [el('span', { text: money(l.rent_amount) }), badge(l.status)])
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
                visible: (row) => store.can('manager') && Number(row.balance) > 0,
                onClick: (row) => recordPaymentFor(row, () => location.reload()) }
            ]
          })
        : el('p', { class: 'muted', text: 'No invoices yet.' }))
  ]);
}
