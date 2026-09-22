import { el, icon, money, date, toast, modal, today, addDays, isoDate } from '../ui.js';
import { store } from '../store.js';
import { crudView } from './crud.js';
import { refreshView, navigate } from '../router.js';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const field = (label, control, help) => el('div', { class: 'field' }, [
  el('label', {}, [label]), control, help ? el('small', { class: 'help', text: help }) : null
]);

/** The tenant's unpaid invoices a deposit could settle, oldest first. */
async function arrearsFor(lease) {
  return store.everything('invoices', {
    scope: { kind: 'tenant', id: lease.tenant_id }, preset: 'arrears', sort: 'due_date', dir: 'asc'
  });
}

/**
 * Move-out: apply the deposit to what the tenant still owes, charge any
 * deductions, and refund the rest — with the arithmetic shown as it is typed,
 * so the refund amount is never a surprise.
 */
export async function openSettleDeposit(lease, { onDone } = {}) {
  const ledger = store.depositLedger(lease);
  const tenant = store.byId('tenants', lease.tenant_id);
  let arrears;
  try { arrears = await arrearsFor(lease); }
  catch (err) { toast(err.message, 'danger'); return; }
  const owed = round2(arrears.reduce((s, i) => s + Number(i.balance), 0));

  const error = el('p', { class: 'form-error', hidden: true });
  const dateInput = el('input', { class: 'input', type: 'date', value: today() });
  const applyBox = el('input', { type: 'checkbox', checked: owed > 0 || null });
  const endBox = el('input', { type: 'checkbox', checked: lease.status === 'Active' || null });
  const moveOut = el('input', { class: 'input', type: 'date', value: today() });
  const method = el('select', { class: 'input' },
    ['Bank Transfer', 'UPI', 'Cash', 'Cheque', 'Other'].map(m => el('option', { value: m, text: m })));
  const reference = el('input', { class: 'input', placeholder: 'e.g. NEFT ref' });
  const rows = el('div', { class: 'deduction-rows' });
  const summary = el('div', { class: 'settle-summary kv-list' });

  const addDeduction = () => {
    const desc = el('input', { class: 'input ded-desc', placeholder: 'e.g. Repainting, broken fan' });
    const amt = el('input', { class: 'input ded-amount', type: 'text', inputmode: 'decimal', step: '0.01', min: '0', placeholder: 'Amount' });
    const row = el('div', { class: 'deduction-row' }, [
      desc, amt,
      el('button', { class: 'icon-btn danger', type: 'button', title: 'Remove',
                     onClick: () => { row.remove(); recalc(); } }, [icon('trash', 15)])
    ]);
    amt.addEventListener('input', recalc);
    rows.append(row);
  };

  function plan() {
    let remaining = ledger.held;
    const toArrears = applyBox.checked ? Math.min(remaining, owed) : 0;
    remaining = round2(remaining - toArrears);
    const deductions = [...rows.querySelectorAll('.deduction-row')].map(r => ({
      description: r.querySelector('.ded-desc').value.trim(),
      amount: Number(r.querySelector('.ded-amount').value || 0)
    })).filter(d => d.amount > 0 || d.description);
    const deducted = round2(deductions.reduce((s, d) => s + (d.amount > 0 ? d.amount : 0), 0));
    const fromDeposit = Math.min(remaining, deducted);
    remaining = round2(remaining - fromDeposit);
    return { toArrears: round2(toArrears), deductions, deducted, fromDeposit, stillOwed: round2(deducted - fromDeposit), refund: remaining };
  }

  function recalc() {
    const p = plan();
    summary.textContent = '';
    const kv = (k, v, cls) => el('div', { class: 'kv' + (cls ? ' ' + cls : '') }, [el('span', { text: k }), el('strong', { text: v })]);
    summary.append(...[
      kv('Deposit held', money(ledger.held)),
      applyBox.checked ? kv('Applied to unpaid invoices', '− ' + money(p.toArrears)) : null,
      p.deducted ? kv('Deductions', '− ' + money(p.fromDeposit)) : null,
      p.stillOwed > 0 ? kv('Deductions beyond the deposit (tenant still owes)', money(p.stillOwed)) : null,
      kv('Refund to tenant', money(p.refund), 'kv-strong')
    ].filter(Boolean));
  }
  applyBox.addEventListener('change', recalc);
  addDeduction();
  recalc();

  const body = el('div', { class: 'stack' }, [
    error,
    el('p', { class: 'muted', text:
      `${tenant?.full_name || 'Tenant'} · ${store.label('units', lease.unit_id)} · received ${money(ledger.received)}` +
      (ledger.applied || ledger.refunded ? `, already settled ${money(ledger.applied + ledger.refunded)}` : '') }),
    el('div', { class: 'form-grid' }, [
      field('Settlement date', dateInput),
      field('Refund paid by', method),
      field('Refund reference', reference)
    ]),
    el('label', { class: 'check' }, [applyBox, ` Apply the deposit to unpaid invoices (${money(owed)} owed on ${arrears.length})`]),
    el('div', { class: 'field field-wide' }, [
      el('label', { text: 'Deductions' }),
      rows,
      el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onClick: addDeduction }, [icon('plus', 15), ' Add deduction']),
      el('small', { class: 'help', text: 'Charged on a "Deposit Deduction" invoice and paid from the deposit, so what is kept counts as income.' })
    ]),
    el('label', { class: 'check' }, [endBox, ' End the lease on the move-out date ']),
    field('Move-out date', moveOut),
    summary
  ]);

  return modal({
    title: 'Settle deposit · ' + lease.id,
    width: 640,
    body,
    actions: [
      { label: 'Cancel' },
      {
        label: 'Settle deposit', variant: 'btn-primary',
        onClick: async (e, close) => {
          const p = plan();
          error.hidden = true;
          const unnamed = p.deductions.find(d => d.amount > 0 && !d.description);
          if (unnamed) { error.hidden = false; error.textContent = 'Every deduction needs a description.'; return; }
          const btn = e.currentTarget;
          btn.disabled = true; btn.textContent = 'Settling…';
          try {
            const res = await store.act('settleDeposit', {
              lease_id: lease.id, settlement_date: dateInput.value,
              apply_to_arrears: applyBox.checked,
              deductions: p.deductions.filter(d => d.amount > 0),
              refund_method: method.value, refund_reference: reference.value.trim(),
              end_lease: endBox.checked, move_out_date: moveOut.value
            });
            toast(`Deposit settled · ${money(res.refunded)} to refund`, 'ok');
            close();
            onDone?.(res);
          } catch (err) {
            btn.disabled = false; btn.textContent = 'Settle deposit';
            error.hidden = false; error.textContent = err.message;
          }
        }
      }
    ]
  });
}

/** Renew a lease: next dates, the escalated rent, and the deposit carried over. */
export function openRenewLease(lease, { onDone } = {}) {
  const error = el('p', { class: 'form-error', hidden: true });
  const start = lease.end_date ? addDays(lease.end_date, 1) : today();
  // same length as the lease being renewed, by default a year
  const months = lease.start_date && lease.end_date
    ? Math.max(1, Math.round((new Date(lease.end_date) - new Date(lease.start_date)) / (86400000 * 30.44)))
    : 12;
  const endGuess = (() => {
    const d = new Date(start + 'T00:00:00');
    if (isNaN(d)) return '';
    d.setMonth(d.getMonth() + months);
    d.setDate(d.getDate() - 1);
    return isoDate(d);
  })();
  const finalRent = store.currentRent(lease, lease.end_date || today());
  const pct = Number(lease.escalation_pct || 0);
  const held = store.depositLedger(lease).held;

  const startInput = el('input', { class: 'input', type: 'date', value: start });
  const endInput = el('input', { class: 'input', type: 'date', value: endGuess });
  const rentInput = el('input', { class: 'input', type: 'text', inputmode: 'decimal', step: '0.01',
                                  value: round2(pct ? finalRent * (1 + pct / 100) : finalRent) });
  const escInput = el('input', { class: 'input', type: 'text', inputmode: 'decimal', step: '0.01', value: lease.escalation_pct ?? '' });
  const carry = el('input', { type: 'checkbox', checked: held > 0 || null, disabled: held > 0 ? null : true });

  const body = el('div', { class: 'stack' }, [
    error,
    el('p', { class: 'muted', text: `${store.label('leases', lease.id)} · ${store.label('units', lease.unit_id)} · ends ${date(lease.end_date)}` }),
    el('div', { class: 'form-grid' }, [
      field('New start date', startInput),
      field('New end date *', endInput),
      field('Monthly rent', rentInput, `Last rent ${money(finalRent)}` + (pct ? `, with this year's ${pct}% escalation applied` : '')),
      field('Annual escalation %', escInput)
    ]),
    el('label', { class: 'check' }, [carry,
      held > 0 ? ` Carry the deposit of ${money(held)} over to the new lease` : ' No deposit is held to carry over'])
  ]);

  return modal({
    title: 'Renew lease · ' + lease.id,
    width: 600,
    body,
    actions: [
      { label: 'Cancel' },
      {
        label: 'Renew lease', variant: 'btn-primary',
        onClick: async (e, close) => {
          error.hidden = true;
          if (!endInput.value) { error.hidden = false; error.textContent = 'Choose when the renewed lease ends.'; return; }
          const btn = e.currentTarget;
          btn.disabled = true; btn.textContent = 'Renewing…';
          try {
            const res = await store.act('renewLease', {
              id: lease.id, start_date: startInput.value, end_date: endInput.value,
              rent_amount: rentInput.value, escalation_pct: escInput.value, carry_deposit: carry.checked
            });
            toast(`Renewed as ${res.lease.id}`, 'ok');
            close();
            onDone?.(res);
          } catch (err) {
            btn.disabled = false; btn.textContent = 'Renew lease';
            error.hidden = false; error.textContent = err.message;
          }
        }
      }
    ]
  });
}

export function leasesView() {
  return crudView('leases', {
    filterKeys: ['status', 'frequency'],
    onRowClick: (row) => navigate('leases/' + encodeURIComponent(row.id)),
    extraActions: [
      {
        label: 'Renew', icon: 'renew',
        visible: (row) => store.can('manager') && row.end_date && row.status !== 'Terminated' &&
                          !store.leases.some(l => l.renewed_from === row.id),
        onClick: (row) => openRenewLease(row, { onDone: () => refreshView() })
      },
      {
        label: 'Settle deposit', icon: 'wallet2',
        visible: (row) => store.can('manager') && store.depositLedger(row).held > 0,
        onClick: (row) => openSettleDeposit(row, { onDone: () => refreshView() })
      }
    ]
  });
}
