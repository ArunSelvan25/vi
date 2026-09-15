import { el, icon, money, date, downloadCsv, isoDate, modal, printDocument } from '../ui.js';
import { store } from '../store.js';
import { barChart, rankedBars } from '../components/charts.js';

function panel(title, body, { action, count } = {}) {
  return el('section', { class: 'panel' }, [
    el('header', { class: 'panel-head' }, [
      el('h3', {}, [title, count !== undefined ? el('span', { class: 'panel-count', text: String(count) }) : null]),
      action || null
    ]),
    el('div', { class: 'panel-body' }, [body])
  ]);
}

function sumBy(rows, keyFn, valFn) {
  const map = new Map();
  for (const r of rows) {
    const k = keyFn(r) || 'Uncategorised';
    map.set(k, (map.get(k) || 0) + Number(valFn(r) || 0));
  }
  return [...map.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
}

export function reportsView() {
  const wrap = el('div', { class: 'view' });
  const state = { from: firstOfYear(), to: isoDate(), propertyId: '' };

  function firstOfYear() {
    return isoDate(new Date(new Date().getFullYear(), 0, 1));
  }

  const controls = el('div', { class: 'filter-bar' }, [
    el('label', {}, ['From ', el('input', { type: 'date', class: 'input', value: state.from,
      onChange: e => { state.from = e.target.value; draw(); } })]),
    el('label', {}, ['To ', el('input', { type: 'date', class: 'input', value: state.to,
      onChange: e => { state.to = e.target.value; draw(); } })]),
    (() => {
      const sel = el('select', { class: 'input', onChange: e => { state.propertyId = e.target.value; draw(); } },
        [el('option', { value: '', text: 'All properties' })]);
      for (const p of store.properties) sel.append(el('option', { value: p.id, text: p.name }));
      return sel;
    })()
  ]);

  const body = el('div');
  wrap.append(
    el('div', { class: 'page-hero' }, [
      el('div', { class: 'page-hero-copy' }, [
        el('span', { class: 'eyebrow', text: 'Portfolio metrics' }),
        el('h1', { text: 'Reports' }),
        el('p', { class: 'muted', text: 'Income, expenses and portfolio performance in one operating view.' })
      ]),
      el('div', { class: 'page-meta' }, [
        el('span', { class: 'page-pill page-pill-ok' }, ['Live data']),
        el('span', { class: 'page-pill' }, ['Updated today'])
      ])
    ]),
    el('div', { class: 'view-head' }, [
      el('div', {}, [el('h1', { text: 'Reports' }),
        el('p', { class: 'muted', text: 'Income, expenses and portfolio performance' })])
    ]),
    controls,
    body
  );

  function inRange(d) { return d && d >= state.from && d <= state.to; }
  function matchProp(r) { return !state.propertyId || r.property_id === state.propertyId; }

  function draw() {
    body.textContent = '';

    // A deposit is held for the tenant: receiving one is not income and returning
    // one is not an operating expense. Both are shown separately below.
    const allPayments = store.payments.filter(p => inRange(p.payment_date) && matchProp(p));
    const allExpenses = store.expenses.filter(e => inRange(e.date) && matchProp(e));
    const payments = store.incomePayments(allPayments);
    const expenses = store.operatingExpenses(allExpenses);
    const depositsIn = allPayments.filter(p => store.isDepositPayment(p)).reduce((s, p) => s + Number(p.amount || 0), 0);
    const depositsOut = allExpenses.filter(e => store.isDepositRefund(e)).reduce((s, e) => s + Number(e.amount || 0), 0);
    // a void invoice was never owed and a draft not yet sent, so neither is
    // "billed" — counting them understated the collection rate
    const invoices = store.invoices.filter(i => inRange(i.due_date) && matchProp(i) &&
                                                !['Void', 'Draft'].includes(i.status));

    const income = payments.reduce((s, p) => s + Number(p.amount || 0), 0);
    // Maintenance costs are written to the Expenses tab when a ticket is
    // completed, so they are already in `expenses` and are not added again.
    const opex = expenses.reduce((s, e) => s + Number(e.amount || 0), 0);
    const billed = invoices.reduce((s, i) => s + Number(i.total || i.amount || 0), 0);

    // Collected against billed, both measured on the SAME invoices — the ones
    // due in this period. Dividing all cash received by everything billed mixes
    // two different populations and can read over 100% when arrears are cleared.
    const collectedOnBilled = invoices.reduce((s, i) => s + Number(i.amount_paid || 0), 0);
    const collectionRate = billed ? Math.round((collectedOnBilled / billed) * 1000) / 10 : 0;

    body.append(el('div', { class: 'stat-row' }, [
      el('div', { class: 'stat stat-ok' }, [el('span', { class: 'stat-label', text: 'Income collected' }),
        el('strong', { class: 'stat-value', text: money(income) })]),
      el('div', { class: 'stat stat-warn' }, [el('span', { class: 'stat-label', text: 'Operating expenses' }),
        el('strong', { class: 'stat-value', text: money(opex) })]),
      el('div', { class: 'stat' + (income - opex >= 0 ? ' stat-ok' : ' stat-danger') },
        [el('span', { class: 'stat-label', text: 'Net operating income' }),
         el('strong', { class: 'stat-value', text: money(income - opex) })]),
      el('div', { class: 'stat' }, [el('span', { class: 'stat-label', text: 'Billed in period' }),
        el('strong', { class: 'stat-value', text: money(billed) })]),
      el('div', { class: 'stat', title: 'Paid against invoices due in this period' }, [
        el('span', { class: 'stat-label', text: 'Collection rate' }),
        el('strong', { class: 'stat-value', text: collectionRate + '%' })]),
      el('div', { class: 'stat', title: 'Security deposits are held for tenants, so they are not income' }, [
        el('span', { class: 'stat-label', text: 'Deposits in / returned' }),
        el('strong', { class: 'stat-value', text: `${money(depositsIn, { compact: true })} / ${money(depositsOut, { compact: true })}` })])
    ]));

    body.append(el('div', { class: 'grid-2' }, [
      // the twelve months up to the end of the range, for the chosen property
      panel('Cash flow by month', barChart(store.monthlySeries(12, {
        end: new Date(state.to + 'T00:00:00'), match: matchProp
      }), { height: 240 })),
      // Maintenance costs are expenses too — the headline figure and the P&L
      // column both include them, so leaving them out of this chart made the
      // same screen report two different totals for the same word.
      panel('Expenses by category',
        expenses.length
          ? rankedBars(sumBy(expenses, e => e.category, e => e.amount)
              .map(x => ({ ...x, tone: 'warn' })))
          : el('p', { class: 'muted', text: 'No expenses in this period.' }))
    ]));

    // Per-property P&L — the table an owner actually asks for.
    const props = state.propertyId ? store.properties.filter(p => p.id === state.propertyId) : store.properties;
    const knownProperty = new Set(store.properties.map(p => p.id));
    const pnl = props.map(p => {
      const inc = store.incomePayments()
        .filter(x => x.property_id === p.id && inRange(x.payment_date))
        .reduce((s, x) => s + Number(x.amount || 0), 0);
      const exp = store.operatingExpenses()
        .filter(x => x.property_id === p.id && inRange(x.date))
        .reduce((s, x) => s + Number(x.amount || 0), 0);
      const units = store.unitsOfProperty(p.id);
      const occ = units.length
        ? Math.round((units.filter(u => u.status === 'Occupied').length / units.length) * 100) : 0;
      const due = store.invoices
        .filter(x => x.property_id === p.id && ['Unpaid', 'Partial', 'Overdue'].includes(x.status))
        .reduce((s, x) => s + Number(x.balance || 0), 0);
      // gross yield per year: income over the range, scaled to twelve months,
      // so a nine-month range is not read as a full year's return
      const days = Math.max(1, (new Date(state.to) - new Date(state.from)) / 86400000 + 1);
      const yieldPct = Number(p.current_value) > 0
        ? Math.round((inc * (365 / days) / Number(p.current_value)) * 1000) / 10 : null;
      return { property: p, units: units.length, occ, inc, exp, net: inc - exp, due, yieldPct };
    });

    // Money that belongs to no property — an ad-hoc invoice raised against a
    // tenant alone — still counts in the headline above, so it needs a row here
    // or the table silently fails to add up.
    if (!state.propertyId) {
      const orphan = (rows, dateKey, field) => rows
        .filter(r => !knownProperty.has(r.property_id) && inRange(r[dateKey]))
        .reduce((s, r) => s + Number(r[field] || 0), 0);
      const inc = orphan(store.incomePayments(), 'payment_date', 'amount');
      const exp = orphan(store.operatingExpenses(), 'date', 'amount');
      const due = store.invoices
        .filter(i => !knownProperty.has(i.property_id) &&
                     ['Unpaid', 'Partial', 'Overdue'].includes(i.status))
        .reduce((s, i) => s + Number(i.balance || 0), 0);
      if (inc || exp || due) {
        pnl.push({ property: { id: '', name: 'Not linked to a property' },
                   units: 0, occ: null, inc, exp, net: inc - exp, due, yieldPct: null });
      }
    }

    const pnlTable = el('table', { class: 'data-table' }, [
      el('thead', {}, [el('tr', {}, ['Property', 'Units', 'Occupancy', 'Income', 'Expenses', 'Net', 'Outstanding', 'Yield / yr']
        .map((h, i) => el('th', { class: i >= 3 ? 'num' : null, text: h })))]),
      el('tbody', {}, [
        ...pnl.map(r => el('tr', {}, [
          el('td', { text: r.property.name }),
          el('td', { text: String(r.units) }),
          el('td', { text: r.occ === null ? '—' : r.occ + '%' }),
          el('td', { class: 'num', text: money(r.inc) }),
          el('td', { class: 'num', text: money(r.exp) }),
          el('td', { class: 'num ' + (r.net >= 0 ? 'pos' : 'neg'), text: money(r.net) }),
          el('td', { class: 'num', text: money(r.due) }),
          el('td', { class: 'num', text: r.yieldPct === null ? '—' : r.yieldPct + '%' })
        ])),
        el('tr', { class: 'total-row' }, [
          el('td', { text: 'Total' }),
          el('td', { text: String(pnl.reduce((s, r) => s + r.units, 0)) }),
          el('td', { text: '' }),
          el('td', { class: 'num', text: money(pnl.reduce((s, r) => s + r.inc, 0)) }),
          el('td', { class: 'num', text: money(pnl.reduce((s, r) => s + r.exp, 0)) }),
          el('td', { class: 'num', text: money(pnl.reduce((s, r) => s + r.net, 0)) }),
          el('td', { class: 'num', text: money(pnl.reduce((s, r) => s + r.due, 0)) }),
          el('td', { text: '' })
        ])
      ])
    ]);

    body.append(panel('Profit & loss by property',
      el('div', { class: 'table-scroll' }, [pnlTable]),
      { action: el('button', {
        class: 'btn btn-ghost btn-sm',
        onClick: () => downloadCsv(`pnl-${state.from}-to-${state.to}.csv`, pnl, [
          { label: 'Property', value: r => r.property.name },
          { label: 'Units', value: r => r.units },
          { label: 'Occupancy %', value: r => r.occ },
          { label: 'Income', value: r => r.inc },
          { label: 'Expenses', value: r => r.exp },
          { label: 'Net', value: r => r.net },
          { label: 'Outstanding', value: r => r.due },
          { label: 'Yield %', value: r => r.yieldPct ?? '' }
        ])
      }, [icon('download', 15), ' Export CSV']) }));

    // Arrears ageing — how old is the money we are owed.
    const buckets = { 'Not yet due': 0, '1–30 days': 0, '31–60 days': 0, '61–90 days': 0, '90+ days': 0 };
    const todayStr = isoDate();
    for (const inv of store.invoices.filter(matchProp)) {
      const bal = Number(inv.balance || 0);
      if (bal <= 0 || ['Void', 'Draft'].includes(inv.status)) continue;
      const age = Math.round((new Date(todayStr) - new Date(String(inv.due_date).slice(0, 10))) / 86400000);
      if (isNaN(age) || age < 0) buckets['Not yet due'] += bal;
      else if (age <= 30) buckets['1–30 days'] += bal;
      else if (age <= 60) buckets['31–60 days'] += bal;
      else if (age <= 90) buckets['61–90 days'] += bal;
      else buckets['90+ days'] += bal;
    }
    const ageing = Object.entries(buckets).map(([label, value]) => ({ label, value }));
    const hasArrears = ageing.some(a => a.value > 0);

    const arrears = store.arrears(matchProp);
    body.append(el('div', { class: 'grid-2' }, [
      panel('Arrears ageing', hasArrears
        ? rankedBars(ageing.map((a, i) => ({ ...a, tone: i >= 3 ? 'danger' : i >= 1 ? 'warn' : null })))
        : el('p', { class: 'muted', text: 'Nothing outstanding.' })),
      panel('Top debtors', arrears.length
        ? el('ul', { class: 'list' }, arrears.slice(0, 10).map(a =>
            el('li', { class: 'list-row' }, [
              el('div', {}, [
                el('strong', { text: store.label('tenants', a.tenant_id) }),
                el('br'),
                el('small', { class: 'muted', text: `${a.invoices} invoice(s) · oldest due ${date(a.oldest)}` })
              ]),
              el('strong', { class: 'neg', text: money(a.balance) })
            ])))
        : el('p', { class: 'muted', text: 'No debtors.' }))
    ]));

    body.append(ownerStatementsPanel());
  }

  /** Per-owner results for the range — what a landlord managing for others sends each owner. */
  function ownerStatementsPanel() {
    const owners = [...new Set(store.properties.map(p => p.owner_name || 'Unassigned'))].sort();
    const rowsFor = (owner) => store.properties
      .filter(p => (p.owner_name || 'Unassigned') === owner)
      .map(p => {
        const inc = store.incomePayments().filter(x => x.property_id === p.id && inRange(x.payment_date))
          .reduce((s, x) => s + Number(x.amount || 0), 0);
        const exp = store.operatingExpenses().filter(x => x.property_id === p.id && inRange(x.date))
          .reduce((s, x) => s + Number(x.amount || 0), 0);
        const due = store.invoices.filter(i => i.property_id === p.id && ['Unpaid', 'Partial', 'Overdue'].includes(i.status))
          .reduce((s, i) => s + Number(i.balance || 0), 0);
        const held = store.leases.filter(l => l.property_id === p.id).reduce((s, l) => s + store.depositLedger(l).held, 0);
        return { property: p, inc, exp, net: inc - exp, due, held };
      });
    const total = (rows, k) => rows.reduce((s, r) => s + r[k], 0);

    const list = el('ul', { class: 'list' }, owners.map(owner => {
      const rows = rowsFor(owner);
      return el('li', { class: 'list-row' }, [
        el('div', {}, [
          el('strong', { text: owner }), el('br'),
          el('small', { class: 'muted', text: `${rows.length} propert${rows.length === 1 ? 'y' : 'ies'} · net ${money(total(rows, 'net'))}` })
        ]),
        el('span', { class: 'list-meta' }, [
          el('button', { class: 'btn btn-ghost btn-sm', onClick: () => openOwnerStatement(owner, rows) }, ['Statement']),
          el('button', { class: 'btn btn-ghost btn-sm', onClick: () => downloadCsv(
            `owner-${owner.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${state.from}-to-${state.to}.csv`, rows, [
              { label: 'Property', value: r => r.property.name },
              { label: 'Income', value: r => r.inc }, { label: 'Expenses', value: r => r.exp },
              { label: 'Net', value: r => r.net }, { label: 'Outstanding', value: r => r.due },
              { label: 'Deposits held', value: r => r.held }
            ]) }, [icon('download', 14), ' CSV'])
        ])
      ]);
    }));

    function openOwnerStatement(owner, rows) {
      const s = store.settings;
      const cell = (v, cls) => el('td', { class: cls, text: v });
      const doc = el('div', { class: 'invoice-doc', id: 'printable' }, [
        el('div', { class: 'invoice-top' }, [
          el('div', {}, [el('h2', { text: s.org_name || 'Property Management' }),
                         s.gstin ? el('p', { class: 'muted', text: 'GSTIN ' + s.gstin }) : null]),
          el('div', { class: 'invoice-meta' }, [
            el('p', { class: 'doc-kind', text: 'Owner statement' }),
            el('h3', { text: owner }),
            el('p', { class: 'muted', text: `${date(state.from)} – ${date(state.to)}` })
          ])
        ]),
        el('div', { class: 'table-scroll' }, [el('table', { class: 'invoice-table' }, [
          el('thead', {}, [el('tr', {}, ['Property', 'Rent & charges collected', 'Expenses', 'Net', 'Owed by tenants', 'Deposits held']
            .map((h, i) => el('th', { class: i ? 'num' : null, text: h })))]),
          el('tbody', {}, [
            ...rows.map(r => el('tr', {}, [cell(r.property.name), cell(money(r.inc), 'num'), cell(money(r.exp), 'num'),
              cell(money(r.net), 'num'), cell(money(r.due), 'num'), cell(money(r.held), 'num')])),
            el('tr', { class: 'total-row' }, [cell('Total'), cell(money(total(rows, 'inc')), 'num'),
              cell(money(total(rows, 'exp')), 'num'), cell(money(total(rows, 'net')), 'num'),
              cell(money(total(rows, 'due')), 'num'), cell(money(total(rows, 'held')), 'num')])
          ])
        ])]),
        el('p', { class: 'muted', text: 'Security deposits are held on the tenants\' behalf and are not included in income.' }),
        el('p', { class: 'invoice-foot muted', text: 'Generated by ' + (s.org_name || 'Property Manager') })
      ]);
      modal({ title: 'Owner statement · ' + owner, width: 820, body: doc,
              actions: [{ label: 'Close' }, { label: 'Print / PDF', variant: 'btn-primary', onClick: () => printDocument() }] });
    }

    return panel('Owner statements', owners.length ? list : el('p', { class: 'muted', text: 'No properties.' }),
                 { count: owners.length });
  }

  draw();
  return wrap;
}
