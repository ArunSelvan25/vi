import { el, icon, money, toast, today, date } from '../ui.js';
import { store } from '../store.js';
import { METER_CATEGORIES } from '../schema.js';
import { dataTable } from '../components/table.js';
import { navigate, refreshView } from '../router.js';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Meter readings for a whole property on one screen.
 *
 * Each unit's previous reading comes from the last round, so a month's
 * electricity for a building is one current reading per flat and one click.
 * Occupied units are billed to their tenant; a vacant unit's reading is kept so
 * the next tenant's first bill starts from it.
 */
export function metersView() {
  const wrap = el('div', { class: 'view' });
  const state = {
    propertyId: store.properties.find(p => p.status !== 'Sold' && p.status !== 'Inactive')?.id || '',
    category: METER_CATEGORIES[0]
  };

  const draw = () => {
    wrap.textContent = '';
    wrap.append(
      el('div', { class: 'page-hero' }, [
        el('div', { class: 'page-hero-copy' }, [
          el('span', { class: 'eyebrow', text: 'Utility billing' }),
          el('h1', { text: 'Meter readings' }),
          el('p', { class: 'muted', text: 'Read every meter in a property and bill the tenants in one go.' })
        ]),
        el('div', { class: 'page-meta' }, [
          el('span', { class: 'page-pill page-pill-ok' }, ['Billing ready']),
          el('button', { class: 'btn btn-ghost btn-sm', onClick: () => navigate('invoices') }, ['‹ Invoices'])
        ])
      ]),
      el('div', { class: 'view-head' }, [
        el('div', {}, [
          el('h1', { text: 'Meter readings' }),
          el('p', { class: 'muted', text: 'Track consumption, verify usage, and send billing in one step' })
        ])
      ])
    );

    if (!store.can('manager')) {
      wrap.append(el('p', { class: 'muted', text: 'Only managers and administrators can bill readings.' }));
    } else {
      wrap.append(entryPanel());
    }

    wrap.append(el('section', { class: 'panel' }, [
      el('header', { class: 'panel-head' }, [el('h3', { text: 'Reading history' })]),
      el('div', { class: 'panel-body' }, [
        dataTable({
          entity: 'meterReadings',
          rows: store.meterReadings.slice().sort((a, b) => String(b.reading_date).localeCompare(String(a.reading_date))),
          filters: [{ key: 'category', label: 'All meters', options: METER_CATEGORIES }],
          exportName: 'meter-readings',
          emptyMessage: 'No readings recorded yet.'
        })
      ])
    ]));
  };

  function entryPanel() {
    const error = el('p', { class: 'form-error', hidden: true });
    const propertySel = el('select', { class: 'input', onChange: (e) => { state.propertyId = e.target.value; draw(); } },
      store.options('properties').map(o => el('option', { value: o.value, selected: o.value === state.propertyId, text: o.label })));
    const categorySel = el('select', { class: 'input', onChange: (e) => { state.category = e.target.value; draw(); } },
      METER_CATEGORIES.map(c => el('option', { value: c, selected: c === state.category, text: c })));
    const rate = el('input', { class: 'input meter-rate', type: 'text', inputmode: 'decimal', step: '0.01', min: '0', placeholder: 'e.g. 8.50' });
    const readingDate = el('input', { class: 'input', type: 'date', value: today() });
    const due = (() => { const d = new Date(); d.setDate(d.getDate() + Number(store.settings.default_grace_days || 5)); return d; })();
    const dueDate = el('input', { class: 'input', type: 'date',
      value: `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, '0')}-${String(due.getDate()).padStart(2, '0')}` });
    const totalEl = el('strong', { class: 'num' });

    const units = store.unitsOfProperty(state.propertyId)
      .slice().sort((a, b) => String(a.unit_number).localeCompare(String(b.unit_number), undefined, { numeric: true }));

    const rows = units.map(u => {
      const last = store.lastReading(u.id, state.category);
      const lease = store.activeLeaseForUnit(u.id);
      const tenant = lease ? store.byId('tenants', lease.tenant_id) : null;
      const prev = el('input', { class: 'input meter-prev', type: 'text', inputmode: 'decimal', step: '0.001',
                                 value: last ? last.current_reading : '' });
      const cur = el('input', { class: 'input meter-cur', type: 'text', inputmode: 'decimal', step: '0.001', placeholder: 'Current' });
      const used = el('span', { class: 'num meter-used' });
      const amount = el('span', { class: 'num meter-amount' });
      const tr = el('tr', { dataset: { unit: u.id } }, [
        el('td', {}, [el('strong', { text: u.unit_number }), el('br'),
                      el('small', { class: 'muted', text: tenant ? tenant.full_name : 'Vacant — recorded, not billed' })]),
        el('td', {}, [prev, last ? el('small', { class: 'muted', text: 'read ' + date(last.reading_date) }) : null]),
        el('td', {}, [cur]),
        el('td', { class: 'num' }, [used]),
        el('td', { class: 'num' }, [amount])
      ]);
      for (const input of [prev, cur]) input.addEventListener('input', recalc);
      return { tr, unit: u, prev, cur, used, amount, billable: !!tenant };
    });

    function recalc() {
      let total = 0;
      const r = Number(rate.value || 0);
      for (const row of rows) {
        if (row.cur.value === '') { row.used.textContent = ''; row.amount.textContent = ''; continue; }
        const consumption = Math.round((Number(row.cur.value) - Number(row.prev.value || 0)) * 1000) / 1000;
        row.used.textContent = String(consumption);
        const amt = round2(Math.max(0, consumption) * r);
        row.amount.textContent = row.billable ? money(amt) : '—';
        if (row.billable) total += amt;
        row.tr.classList.toggle('row-error', consumption < 0);
      }
      totalEl.textContent = money(total);
    }
    rate.addEventListener('input', recalc);
    recalc();

    const submit = el('button', {
      class: 'btn btn-primary',
      onClick: async () => {
        error.hidden = true;
        const readings = rows.filter(r => r.cur.value !== '').map(r => ({
          unit_id: r.unit.id, previous_reading: r.prev.value === '' ? 0 : Number(r.prev.value),
          current_reading: Number(r.cur.value)
        }));
        const fail = (msg) => { error.hidden = false; error.textContent = msg; };
        if (!(Number(rate.value) > 0)) return fail('Enter the rate per unit.');
        if (!readings.length) return fail('Enter at least one current reading.');
        const low = rows.find(r => r.cur.value !== '' && Number(r.cur.value) < Number(r.prev.value || 0));
        if (low) return fail(`${low.unit.unit_number}: the current reading is lower than the previous one.`);
        submit.disabled = true; submit.textContent = 'Billing…';
        try {
          const res = await store.act('billMeterReadings', {
            property_id: state.propertyId, category: state.category, rate: Number(rate.value),
            reading_date: readingDate.value, due_date: dueDate.value, readings
          });
          toast(`${res.readings} reading(s) saved · ${res.invoices.length} invoice(s) raised`, 'ok');
          refreshView();
        } catch (err) {
          submit.disabled = false; submit.textContent = 'Save & bill';
          fail(err.message);
        }
      }
    }, [icon('bolt', 16), ' Save & bill']);

    const field = (label, control) => el('div', { class: 'field' }, [el('label', { text: label }), control]);
    return el('section', { class: 'panel' }, [
      el('header', { class: 'panel-head' }, [el('h3', { text: 'New readings' })]),
      el('div', { class: 'panel-body stack' }, [
        error,
        el('div', { class: 'form-grid' }, [
          field('Property', propertySel), field('Meter', categorySel), field('Rate per unit', rate),
          field('Reading date', readingDate), field('Bill due', dueDate)
        ]),
        units.length
          ? el('div', { class: 'table-scroll' }, [el('table', { class: 'data-table meter-table' }, [
              el('thead', {}, [el('tr', {}, ['Unit', 'Previous', 'Current', 'Used', 'Amount']
                .map((h, i) => el('th', { class: i >= 3 ? 'num' : null, text: h })))]),
              el('tbody', {}, rows.map(r => r.tr))
            ])])
          : el('p', { class: 'muted', text: 'This property has no units.' }),
        el('div', { class: 'btn-row meter-foot' }, [
          el('span', { class: 'muted' }, ['To bill: ', totalEl]), submit
        ])
      ])
    ]);
  }

  draw();
  return wrap;
}
