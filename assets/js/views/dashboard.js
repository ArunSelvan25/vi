import { el, icon, money, date, badge, daysBetween, today } from '../ui.js';
import { store } from '../store.js';
import { navigate } from '../router.js';
import { barChart, donut, rankedBars } from '../components/charts.js';

/** A month-over-month change chip, or null when there's nothing to compare. */
function delta(current, previous) {
  if (!previous) return null;
  const pct = Math.round(((current - previous) / Math.abs(previous)) * 100);
  if (!isFinite(pct) || pct === 0) return el('span', { class: 'delta delta-flat', text: 'no change' });
  const up = pct > 0;
  return el('span', { class: 'delta ' + (up ? 'delta-up' : 'delta-down') },
    [(up ? '↑' : '↓') + ' ' + Math.abs(pct) + '%']);
}

function kpi({ label, value, sub, tone, to, chip }) {
  return el('button', {
    class: 'kpi' + (tone ? ' kpi-' + tone : ''), type: 'button',
    onClick: to ? () => navigate(to) : null
  }, [
    el('span', { class: 'kpi-label', text: label }),
    el('strong', { class: 'kpi-value', text: value }),
    el('span', { class: 'kpi-sub' }, [chip || null, sub ? el('span', { text: sub }) : null])
  ]);
}

function panel(title, body, { action, count } = {}) {
  return el('section', { class: 'panel' }, [
    el('header', { class: 'panel-head' }, [
      el('h3', {}, [title, count !== undefined ? el('span', { class: 'panel-count', text: String(count) }) : null]),
      action || null
    ]),
    el('div', { class: 'panel-body' }, [body])
  ]);
}

export function dashboardView() {
  const s = store.stats;
  const wrap = el('div', { class: 'view' });

  // ── KPI row ─────────────────────────────────────────────────────────────
  const last2 = store.monthlySeries(2);
  const prevCollected = last2.length > 1 ? last2[0].income : 0;
  const trend = delta(s.collected_this_month, prevCollected);

  wrap.append(el('div', { class: 'kpi-row' }, [
    kpi({ label: 'Monthly rent roll', value: money(s.monthly_rent_roll, { compact: true }),
          sub: `${s.active_leases} active lease${s.active_leases === 1 ? '' : 's'}`, to: 'leases' }),
    kpi({ label: 'Collected this month', value: money(s.collected_this_month, { compact: true }),
          chip: trend,
          sub: trend ? 'vs last month' : `${money(s.expenses_this_month, { compact: true })} spent`,
          tone: 'ok', to: 'payments' }),
    kpi({ label: 'Outstanding', value: money(s.outstanding, { compact: true }),
          sub: s.overdue > 0 ? `${money(s.overdue, { compact: true })} overdue` : 'none overdue',
          tone: s.overdue > 0 ? 'danger' : null, to: 'invoices' }),
    kpi({ label: 'Occupancy', value: s.occupancy_rate + '%',
          sub: `${s.occupied_units} of ${s.units} units`, to: 'units' }),
    kpi({ label: 'Open tickets', value: String(s.open_tickets),
          sub: s.open_tickets ? 'needs attention' : 'all clear',
          tone: s.open_tickets > 0 ? 'warn' : null, to: 'maintenance' }),
    kpi({ label: 'Deposits held', value: money(s.deposits_held, { compact: true }),
          sub: 'refundable', to: 'leases' })
  ]));

  // ── charts ──────────────────────────────────────────────────────────────
  const series = store.monthlySeries(6);
  wrap.append(el('div', { class: 'grid-2' }, [
    panel('Cash flow · last 6 months', barChart(series)),
    panel('Occupancy', donut([
      { label: 'Occupied', value: s.occupied_units, color: 'var(--ok)' },
      { label: 'Vacant', value: s.vacant_units, color: 'var(--muted-2)' }
    ], { centerLabel: s.occupancy_rate + '%', centerSub: 'occupied' }))
  ]));

  // ── attention lists ─────────────────────────────────────────────────────
  const arrears = store.arrears().slice(0, 6);
  const arrearsBody = arrears.length
    ? rankedBars(arrears.map(a => ({
        label: store.label('tenants', a.tenant_id),
        value: a.balance,
        tone: daysBetween(a.oldest, today()) > 30 ? 'danger' : 'warn'
      })))
    : el('p', { class: 'muted', text: 'No outstanding balances. Nicely done.' });

  const expiring = store.expiringLeases(Number(store.settings.lease_expiry_alert_days || 45));
  const expiringBody = expiring.length
    ? el('ul', { class: 'list' }, expiring.slice(0, 8).map(l => {
        const days = daysBetween(today(), l.end_date);
        return el('li', { class: 'list-row clickable', onClick: () => navigate('leases/' + l.id) }, [
          el('div', {}, [
            el('strong', { text: store.label('tenants', l.tenant_id) }),
            el('small', { class: 'muted', text: ' · ' + store.label('units', l.unit_id) })
          ]),
          el('span', { class: 'list-meta' }, [
            badge(days <= 0 ? 'today' : `in ${days} day${days === 1 ? '' : 's'}`,
                  days <= 14 ? 'danger' : days <= 30 ? 'warn' : 'info'),
            el('span', { text: date(l.end_date) })
          ])
        ]);
      }))
    : el('p', { class: 'muted', text: 'No leases expiring soon.' });

  const openTickets = store.maintenance
    .filter(m => ['Open', 'In Progress', 'On Hold'].includes(m.status))
    .sort((a, b) => ({ Urgent: 0, High: 1, Medium: 2, Low: 3 }[a.priority] ?? 4)
                  - ({ Urgent: 0, High: 1, Medium: 2, Low: 3 }[b.priority] ?? 4));
  const ticketBody = openTickets.length
    ? el('ul', { class: 'list' }, openTickets.slice(0, 8).map(m =>
        el('li', { class: 'list-row clickable', onClick: () => navigate('maintenance') }, [
          el('div', {}, [
            el('strong', { text: m.title }),
            el('small', { class: 'muted', text: ' · ' + store.label('properties', m.property_id) })
          ]),
          el('span', { class: 'list-meta' }, [badge(m.priority), badge(m.status)])
        ])))
    : el('p', { class: 'muted', text: 'No open maintenance tickets.' });

  const docs = store.expiringDocuments(60);
  const docBody = docs.length
    ? el('ul', { class: 'list' }, docs.slice(0, 6).map(d => {
        const expired = d.expiry_date < today();
        return el('li', { class: 'list-row' }, [
          el('div', {}, [
            el('strong', { text: d.title }),
            el('small', { class: 'muted', text: ' · ' + (d.category || 'Document') })
          ]),
          el('span', { class: 'list-meta' }, [
            badge(expired ? 'Expired' : 'Expiring soon', expired ? 'danger' : 'warn'),
            el('span', { text: date(d.expiry_date) })
          ])
        ]);
      }))
    : el('p', { class: 'muted', text: 'Nothing expiring in the next 60 days.' });

  wrap.append(el('div', { class: 'grid-2' }, [
    panel('Rent arrears', arrearsBody, {
      count: arrears.length || undefined,
      action: el('button', { class: 'btn btn-ghost btn-sm', onClick: () => navigate('invoices') },
                 ['View invoices'])
    }),
    panel('Leases expiring', expiringBody, { count: expiring.length || undefined })
  ]));

  wrap.append(el('div', { class: 'grid-2' }, [
    panel('Maintenance queue', ticketBody, {
      count: openTickets.length || undefined,
      action: el('button', { class: 'btn btn-ghost btn-sm', onClick: () => navigate('maintenance') },
                 ['All tickets'])
    }),
    panel('Documents expiring', docBody, { count: docs.length || undefined })
  ]));

  // ── vacant units, so nothing sits empty unnoticed ───────────────────────
  const vacant = store.units.filter(u => u.status === 'Vacant');
  if (vacant.length) {
    wrap.append(panel('Vacant units',
      el('div', { class: 'chip-row' }, vacant.slice(0, 24).map(u =>
        el('button', { class: 'chip', onClick: () => navigate('units') }, [
          store.label('units', u.id),
          el('small', { text: money(u.rent_amount, { compact: true }) })
        ]))),
      { count: vacant.length }));
  }

  return wrap;
}
