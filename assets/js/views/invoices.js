import { el, icon, money, date, badge, toast, confirmDialog, today, modal } from '../ui.js';
import { store } from '../store.js';
import { api } from '../api.js';
import { ITEM_CATEGORIES } from '../schema.js';
import { crudView } from './crud.js';
import { openActionForm } from '../components/form.js';

/**
 * Invoice editor with dynamic line items, so one invoice can carry rent,
 * electricity, water and anything else as separate priced rows. The header
 * amount is always the sum of the lines — never typed.
 */
export function openInvoiceForm(invoice = null, { onSaved } = {}) {
  const isEdit = !!invoice;
  const existing = isEdit ? store.itemsOfInvoice(invoice.id) : [];

  const error = el('p', { class: 'form-error', hidden: true });
  const rowsHost = el('div', { class: 'line-rows' });
  const subtotalEl = el('strong', { class: 'num' });
  const totalEl = el('strong', { class: 'num' });

  // ── header fields ───────────────────────────────────────────────────────
  const select = (options, value, attrs = {}) => {
    const sel = el('select', { class: 'input', ...attrs });
    for (const o of options) {
      sel.append(el('option', { value: o.value, selected: String(value) === String(o.value) }, [o.label]));
    }
    return sel;
  };
  const blank = { value: '', label: '— none —' };

  const tenantSel = select([{ value: '', label: 'Select…' }, ...store.options('tenants')],
                           invoice?.tenant_id, { id: 'f_tenant_id' });
  const propertySel = select([blank, ...store.options('properties')], invoice?.property_id);
  const unitSel = select([blank], invoice?.unit_id);
  const leaseSel = select([blank, ...store.options('leases')], invoice?.lease_id);

  const syncUnits = () => {
    const pid = propertySel.value;
    const current = unitSel.value || invoice?.unit_id || '';
    unitSel.textContent = '';
    unitSel.append(el('option', { value: '', text: '— none —' }));
    for (const o of store.options('units', u => !pid || u.property_id === pid)) {
      unitSel.append(el('option', { value: o.value, selected: o.value === current }, [o.label]));
    }
  };
  propertySel.addEventListener('change', syncUnits);
  syncUnits();

  const dueInput = el('input', { class: 'input', type: 'date', value: invoice?.due_date || today() });
  const issueInput = el('input', { class: 'input', type: 'date', value: invoice?.issue_date || today() });
  const fromInput = el('input', { class: 'input', type: 'date', value: invoice?.period_start || '' });
  const toInput = el('input', { class: 'input', type: 'date', value: invoice?.period_end || '' });
  const taxInput = el('input', { class: 'input', type: 'number', step: '0.01', value: invoice?.tax || '' });
  const notesInput = el('textarea', { class: 'input', rows: 2 }, [invoice?.notes || '']);

  const field = (label, control, help) => el('div', { class: 'field' }, [
    el('label', {}, [label]), control, help ? el('small', { class: 'help', text: help }) : null
  ]);

  // ── line items ──────────────────────────────────────────────────────────
  function recalc() {
    let subtotal = 0;
    for (const row of rowsHost.querySelectorAll('.line-row')) {
      const qty = parseFloat(row.querySelector('.line-qty').value) || 0;
      const unit = parseFloat(row.querySelector('.line-unit').value) || 0;
      const amount = Math.round(qty * unit * 100) / 100;
      row.querySelector('.line-amount').textContent = money(amount);
      subtotal += amount;
    }
    const tax = parseFloat(taxInput.value) || 0;
    subtotalEl.textContent = money(subtotal);
    totalEl.textContent = money(subtotal + tax);
  }
  taxInput.addEventListener('input', recalc);

  function addRow(item = {}) {
    const desc = el('input', { class: 'input line-desc', placeholder: 'e.g. EB bill · 142 units',
                               value: item.description || '' });
    const cat = select(ITEM_CATEGORIES.map(c => ({ value: c, label: c })),
                       item.category || 'Rent', { class: 'input line-cat' });
    const qty = el('input', { class: 'input line-qty', type: 'number', step: '0.01',
                              value: item.quantity ?? 1 });
    const unit = el('input', { class: 'input line-unit', type: 'number', step: '0.01',
                               value: item.unit_amount ?? '' });
    const amount = el('span', { class: 'line-amount num' });

    const row = el('div', { class: 'line-row', dataset: { id: item.id || '' } }, [
      desc, cat, qty, unit, amount,
      el('button', {
        class: 'icon-btn danger', type: 'button', title: 'Remove this line',
        onClick: () => {
          if (rowsHost.querySelectorAll('.line-row').length === 1) {
            error.hidden = false;
            error.textContent = 'An invoice needs at least one line.';
            return;
          }
          row.remove();
          recalc();
        }
      }, [icon('trash', 15)])
    ]);
    qty.addEventListener('input', recalc);
    unit.addEventListener('input', recalc);
    rowsHost.append(row);
    recalc();
    return row;
  }

  (existing.length ? existing : [{ category: 'Rent', quantity: 1 }]).forEach(addRow);

  const body = el('div', { class: 'invoice-form' }, [
    error,
    el('div', { class: 'form-grid' }, [
      field('Tenant *', tenantSel),
      field('Property', propertySel),
      field('Unit', unitSel),
      field('Lease', leaseSel),
      field('Issue date', issueInput),
      field('Due date *', dueInput),
      field('Period from', fromInput),
      field('Period to', toInput)
    ]),

    el('div', { class: 'line-editor' }, [
      el('div', { class: 'line-head' }, [
        el('span', { text: 'Description' }), el('span', { text: 'Category' }),
        el('span', { text: 'Qty' }), el('span', { text: 'Unit amount' }),
        el('span', { class: 'num', text: 'Amount' }), el('span')
      ]),
      rowsHost,
      el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onClick: () => addRow() },
         [icon('plus', 15), ' Add line'])
    ]),

    el('div', { class: 'line-totals' }, [
      el('div', { class: 'kv' }, [el('span', { text: 'Subtotal' }), subtotalEl]),
      el('div', { class: 'kv' }, [el('span', { text: 'Tax' }), taxInput]),
      el('div', { class: 'kv kv-strong' }, [el('span', { text: 'Total' }), totalEl])
    ]),

    field('Notes', notesInput)
  ]);

  return modal({
    title: isEdit ? 'Edit invoice · ' + invoice.id : 'New invoice',
    width: 860,
    body,
    actions: [
      { label: 'Cancel' },
      {
        label: isEdit ? 'Save invoice' : 'Create invoice',
        variant: 'btn-primary',
        onClick: async (e, close) => {
          const btn = e.currentTarget;
          error.hidden = true;

          const items = [...rowsHost.querySelectorAll('.line-row')].map(row => ({
            id: row.dataset.id || undefined,
            description: row.querySelector('.line-desc').value.trim(),
            category: row.querySelector('.line-cat').value,
            quantity: row.querySelector('.line-qty').value,
            unit_amount: row.querySelector('.line-unit').value
          }));

          if (!tenantSel.value) { error.hidden = false; error.textContent = 'Choose a tenant.'; return; }
          if (!dueInput.value) { error.hidden = false; error.textContent = 'A due date is required.'; return; }
          const nameless = items.find(i => !i.description);
          if (nameless) {
            error.hidden = false; error.textContent = 'Every line needs a description.'; return;
          }

          btn.disabled = true; btn.textContent = 'Saving…';
          try {
            const res = await store.saveInvoice({
              id: isEdit ? invoice.id : undefined,
              data: {
                tenant_id: tenantSel.value, property_id: propertySel.value,
                unit_id: unitSel.value, lease_id: leaseSel.value,
                issue_date: issueInput.value, due_date: dueInput.value,
                period_start: fromInput.value, period_end: toInput.value,
                tax: taxInput.value === '' ? 0 : Number(taxInput.value),
                notes: notesInput.value
              },
              items
            });
            toast(`Invoice ${isEdit ? 'updated' : 'created'} · ${money(res.invoice.total)}`, 'ok');
            close();
            onSaved?.(res.invoice);
          } catch (err) {
            btn.disabled = false;
            btn.textContent = isEdit ? 'Save invoice' : 'Create invoice';
            error.hidden = false; error.textContent = err.message;
          }
        }
      }
    ]
  });
}

/** Record a payment against an invoice and refresh the affected rows. */
export function recordPaymentFor(invoice, onDone) {
  const balance = Number(invoice.balance ?? invoice.total ?? invoice.amount ?? 0);
  openActionForm({
    title: `Record payment · ${invoice.id}`,
    submitLabel: 'Save payment',
    fields: [
      { key: 'amount', label: 'Amount received', type: 'money', required: true, value: balance > 0 ? balance : '',
        help: `Outstanding balance: ${money(balance)}` },
      { key: 'payment_date', label: 'Payment date', type: 'date', required: true, value: today() },
      { key: 'method', label: 'Method', type: 'select', value: 'Bank Transfer',
        options: ['Cash', 'Bank Transfer', 'UPI', 'Card', 'Cheque', 'Other'] },
      { key: 'reference', label: 'Reference / txn no.', type: 'text' },
      { key: 'notes', label: 'Notes', type: 'textarea', wide: true }
    ],
    onSubmit: async (data, close) => {
      const res = await api('recordPayment', { invoice_id: invoice.id, ...data });
      store.payments = [...store.payments, res.payment];
      if (res.invoice) store.invoices = store.invoices.map(i => (i.id === invoice.id ? { ...i, ...res.invoice } : i));
      toast('Payment recorded', 'ok');
      close();
      onDone?.(res);
    }
  });
}

/** Printable invoice / receipt in a modal — uses the browser's own print. */
export function showInvoice(invoice) {
  const tenant = store.byId('tenants', invoice.tenant_id);
  const unit = store.byId('units', invoice.unit_id);
  const property = store.byId('properties', invoice.property_id);
  const payments = store.paymentsOfInvoice(invoice.id);
  const s = store.settings;

  const line = (k, v) => el('div', { class: 'kv' }, [el('span', { text: k }), el('strong', { text: v })]);

  const doc = el('div', { class: 'invoice-doc', id: 'printable' }, [
    el('div', { class: 'invoice-top' }, [
      el('div', {}, [
        el('h2', { text: s.org_name || 'Property Management' }),
        el('p', { class: 'muted', text: property ? [property.address_line1, property.city].filter(Boolean).join(', ') : '' })
      ]),
      el('div', { class: 'invoice-meta' }, [
        el('h3', { text: invoice.id }),
        badge(invoice.status),
        el('p', { class: 'muted', text: 'Issued ' + date(invoice.issue_date || invoice.period_start) })
      ])
    ]),
    el('div', { class: 'invoice-parties' }, [
      el('div', {}, [
        el('h4', { text: 'Billed to' }),
        el('p', { text: tenant?.full_name || '—' }),
        tenant?.email ? el('p', { class: 'muted', text: tenant.email }) : null,
        tenant?.phone ? el('p', { class: 'muted', text: tenant.phone }) : null
      ]),
      el('div', {}, [
        el('h4', { text: 'For' }),
        el('p', { text: unit ? store.label('units', unit.id) : '—' }),
        el('p', { class: 'muted', text: invoice.period_start ? `${date(invoice.period_start)} – ${date(invoice.period_end)}` : '' }),
        el('p', { class: 'muted', text: 'Due ' + date(invoice.due_date) })
      ])
    ]),
    (() => {
      const lines = store.itemsOfInvoice(invoice.id);
      const rows = lines.length
        ? lines.map(it => el('tr', {}, [
            el('td', {}, [
              el('strong', { text: it.description }),
              el('br'),
              el('small', { class: 'muted', text:
                Number(it.quantity) === 1
                  ? it.category
                  : `${it.category} · ${it.quantity} × ${money(it.unit_amount)}` })
            ]),
            el('td', { class: 'num', text: money(it.amount) })
          ]))
        : [el('tr', {}, [
            el('td', { text: `${invoice.type || 'Rent'}${invoice.notes ? ' — ' + invoice.notes : ''}` }),
            el('td', { class: 'num', text: money(invoice.amount) })
          ])];
      if (Number(invoice.tax)) {
        rows.push(el('tr', {}, [
          el('td', { text: 'Tax' }), el('td', { class: 'num', text: money(invoice.tax) })
        ]));
      }
      return el('table', { class: 'invoice-table' }, [
        el('thead', {}, [el('tr', {}, [
          el('th', { text: 'Description' }), el('th', { class: 'num', text: 'Amount' })
        ])]),
        el('tbody', {}, rows)
      ]);
    })(),
    el('div', { class: 'invoice-totals' }, [
      line('Total', money(invoice.total || invoice.amount)),
      line('Paid', money(invoice.amount_paid)),
      el('div', { class: 'kv kv-strong' }, [
        el('span', { text: 'Balance due' }),
        el('strong', { text: money(invoice.balance) })
      ])
    ]),
    payments.length
      ? el('div', { class: 'invoice-payments' }, [
          el('h4', { text: 'Payments received' }),
          el('ul', { class: 'list' }, payments.map(p =>
            el('li', { class: 'list-row' }, [
              el('span', { text: `${date(p.payment_date)} · ${p.method || ''} ${p.reference || ''}`.trim() }),
              el('strong', { text: money(p.amount) })
            ])))
        ])
      : null,
    el('p', { class: 'invoice-foot muted', text: 'Generated by ' + (s.org_name || 'Property Manager') })
  ]);

  modal({
    title: 'Invoice ' + invoice.id,
    width: 720,
    body: doc,
    actions: [
      { label: 'Close' },
      { label: 'Print / PDF', variant: 'btn-ghost',
        onClick: () => { document.body.classList.add('printing'); window.print();
                         setTimeout(() => document.body.classList.remove('printing'), 500); } },
      Number(invoice.balance) > 0 && store.can('manager')
        ? { label: 'Record payment', variant: 'btn-primary',
            onClick: (e, close) => { close(); recordPaymentFor(invoice, () => location.reload()); } }
        : null
    ].filter(Boolean)
  });
}

export function invoicesView() {
  const bulkActions = store.can('manager') ? [
    el('button', {
      class: 'btn btn-ghost',
      onClick: async (e) => {
        const ok = await confirmDialog({
          title: 'Generate rent invoices?',
          message: 'Creates any missing rent invoices for every active lease up to today. Periods already invoiced are skipped, so it is safe to run repeatedly.',
          confirmLabel: 'Generate', danger: false
        });
        if (!ok) return;
        e.target.disabled = true;
        try {
          const res = await api('generateInvoices', { upto: today(), withSnapshot: true });
          toast(res.created ? `${res.created} invoice(s) generated` : 'Everything already invoiced', 'ok');
          await store.syncFrom(res);
          rerenderHost();
        } catch (err) { toast(err.message, 'danger'); }
        finally { e.target.disabled = false; }
      }
    }, [icon('bolt', 16), ' Generate rent']),
    el('button', {
      class: 'btn btn-ghost',
      onClick: async (e) => {
        e.target.disabled = true;
        try {
          const res = await api('sendReminders', {});
          toast(`${res.sent} reminder(s) emailed, ${res.skipped} skipped`, res.sent ? 'ok' : 'info');
        } catch (err) { toast(err.message, 'danger'); }
        finally { e.target.disabled = false; }
      }
    }, [icon('mail', 16), ' Send reminders'])
  ] : [];

  const view = crudView('invoices', {
    headerActions: bulkActions,
    openForm: (row, opts) => openInvoiceForm(row, opts),
    filterKeys: ['status', 'type'],
    onRowClick: (row) => showInvoice(row),
    extraActions: [
      { label: 'View / print', icon: 'receipt', onClick: (row) => showInvoice(row) },
      {
        label: 'Record payment', icon: 'card',
        visible: (row) => store.can('manager') && Number(row.balance) > 0 && row.status !== 'Void',
        onClick: (row) => recordPaymentFor(row, () => rerenderHost())
      }
    ]
  });

  function rerenderHost() {
    const parent = view.parentElement;
    if (!parent) return;
    parent.replaceChild(invoicesView(), view);
  }

  return view;
}
