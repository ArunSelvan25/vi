import { el, icon, money, date, badge, toast, confirmDialog, today, modal,
         whatsappLink, upiLink, printDocument } from '../ui.js';
import { store } from '../store.js';
import { api } from '../api.js';
import { ITEM_CATEGORIES } from '../schema.js';
import { crudView } from './crud.js';
import { openActionForm } from '../components/form.js';
import { refreshView, navigate } from '../router.js';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Invoice editor with dynamic line items, so one invoice can carry rent,
 * electricity, water and anything else as separate priced rows. The header
 * amount is always the sum of the lines — never typed. Each line carries its
 * own GST rate, because rent on a shop and the electricity passed through with
 * it are taxed differently.
 */
export function openInvoiceForm(invoice = null, { onSaved } = {}) {
  const isEdit = !!invoice;
  const isDraft = isEdit && invoice.status === 'Draft';
  const existing = isEdit ? store.itemsOfInvoice(invoice.id) : [];
  const defaultRate = Number(store.settings.default_gst_rate || 0);
  // an invoice from before line rates keeps its flat, typed tax
  const legacyTax = isEdit && Number(invoice.tax) > 0 && !existing.some(i => Number(i.tax_rate) > 0);

  const error = el('p', { class: 'form-error', hidden: true });
  const rowsHost = el('div', { class: 'line-rows' });
  const subtotalEl = el('strong', { class: 'num' });
  const taxEl = el('strong', { class: 'num' });
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
  const flatTaxInput = el('input', { class: 'input', type: 'text', inputmode: 'decimal', step: '0.01', value: legacyTax ? invoice.tax : '' });
  const notesInput = el('textarea', { class: 'input', rows: 2 }, [invoice?.notes || '']);

  const field = (label, control, help) => el('div', { class: 'field' }, [
    el('label', {}, [label]), control, help ? el('small', { class: 'help', text: help }) : null
  ]);

  // ── line items ──────────────────────────────────────────────────────────
  function recalc() {
    let subtotal = 0, gst = 0;
    for (const row of rowsHost.querySelectorAll('.line-row')) {
      const qty = parseFloat(row.querySelector('.line-qty').value) || 0;
      const unit = parseFloat(row.querySelector('.line-unit').value) || 0;
      const rate = parseFloat(row.querySelector('.line-gst').value) || 0;
      const amount = round2(qty * unit);
      row.querySelector('.line-amount').textContent = money(amount);
      subtotal += amount;
      gst += round2(amount * rate / 100);
    }
    const tax = gst > 0 ? gst : (legacyTax ? parseFloat(flatTaxInput.value) || 0 : 0);
    subtotalEl.textContent = money(subtotal);
    taxEl.textContent = money(tax);
    totalEl.textContent = money(subtotal + tax);
  }
  flatTaxInput.addEventListener('input', recalc);

  function addRow(item = {}) {
    const desc = el('input', { class: 'input line-desc', placeholder: 'e.g. EB bill · 142 units',
                               value: item.description || '' });
    const cat = select(ITEM_CATEGORIES.map(c => ({ value: c, label: c })),
                       item.category || 'Rent', { class: 'input line-cat' });
    const qty = el('input', { class: 'input line-qty', type: 'text', inputmode: 'decimal', step: '0.01',
                              value: item.quantity ?? 1 });
    const unit = el('input', { class: 'input line-unit', type: 'text', inputmode: 'decimal', step: '0.01',
                               value: item.unit_amount ?? '' });
    const gst = el('input', { class: 'input line-gst', type: 'text', inputmode: 'decimal', step: '0.01', min: '0', max: '100',
                              title: 'GST %', placeholder: 'GST %',
                              value: item.tax_rate !== undefined && item.tax_rate !== '' ? item.tax_rate : (item.id ? '' : (defaultRate || '')) });
    const amount = el('span', { class: 'line-amount num' });

    const row = el('div', { class: 'line-row', dataset: { id: item.id || '' } }, [
      desc, cat, qty, unit, gst, amount,
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
    for (const input of [qty, unit, gst]) input.addEventListener('input', recalc);
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
        el('span', { text: 'Qty' }), el('span', { text: 'Unit amount' }), el('span', { text: 'GST %' }),
        el('span', { class: 'num', text: 'Amount' }), el('span')
      ]),
      rowsHost,
      el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onClick: () => addRow() },
         [icon('plus', 15), ' Add line'])
    ]),

    el('div', { class: 'line-totals' }, [
      el('div', { class: 'kv' }, [el('span', { text: 'Subtotal' }), subtotalEl]),
      el('div', { class: 'kv' }, [el('span', { text: legacyTax ? 'Tax' : 'GST' }), legacyTax ? flatTaxInput : taxEl]),
      el('div', { class: 'kv kv-strong' }, [el('span', { text: 'Total' }), totalEl])
    ]),

    field('Notes', notesInput)
  ]);

  const save = (asDraft) => async (e, close) => {
    const btn = e.currentTarget;
    error.hidden = true;

    const items = [...rowsHost.querySelectorAll('.line-row')].map(row => ({
      id: row.dataset.id || undefined,
      description: row.querySelector('.line-desc').value.trim(),
      category: row.querySelector('.line-cat').value,
      quantity: row.querySelector('.line-qty').value,
      unit_amount: row.querySelector('.line-unit').value,
      tax_rate: row.querySelector('.line-gst').value === '' ? 0 : Number(row.querySelector('.line-gst').value)
    }));

    if (!tenantSel.value) { error.hidden = false; error.textContent = 'Choose a tenant.'; return; }
    if (!dueInput.value) { error.hidden = false; error.textContent = 'A due date is required.'; return; }
    const nameless = items.find(i => !i.description);
    if (nameless) {
      error.hidden = false; error.textContent = 'Every line needs a description.'; return;
    }
    if (items.some(i => i.tax_rate < 0 || i.tax_rate > 100)) {
      error.hidden = false; error.textContent = 'GST rates must be between 0 and 100%.'; return;
    }

    const label = btn.textContent;
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const data = {
        tenant_id: tenantSel.value, property_id: propertySel.value,
        unit_id: unitSel.value, lease_id: leaseSel.value,
        issue_date: issueInput.value, due_date: dueInput.value,
        period_start: fromInput.value, period_end: toInput.value,
        tax: legacyTax ? Number(flatTaxInput.value || 0) : 0,
        notes: notesInput.value
      };
      // only a new invoice or a draft has a status to choose; the rest follows
      // from its payments and dates
      if (!isEdit || isDraft) data.status = asDraft ? 'Draft' : 'Unpaid';
      const res = await store.saveInvoice({
        id: isEdit ? invoice.id : undefined, data, items,
        expectedVersion: isEdit ? invoice._v : undefined
      });
      toast(`Invoice ${res.invoice.id} ${asDraft ? 'saved as a draft' : isEdit ? 'updated' : 'created'} · ${money(res.invoice.total)}`, 'ok');
      close();
      onSaved?.(res.invoice);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = label;
      error.hidden = false; error.textContent = err.message;
    }
  };

  const actions = [{ label: 'Cancel' }];
  if (!isEdit || isDraft) actions.push({ label: 'Save as draft', variant: 'btn-ghost', onClick: save(true) });
  actions.push({
    label: !isEdit ? 'Create invoice' : isDraft ? 'Issue invoice' : 'Save invoice',
    variant: 'btn-primary', onClick: save(false)
  });

  return modal({
    title: isEdit ? (isDraft ? 'Draft invoice · ' : 'Edit invoice · ') + invoice.id : 'New invoice',
    width: 920,
    body,
    actions
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
      // A payment can settle other invoices too, mark a deposit held and move
      // every dashboard figure, so patching this one invoice locally left the
      // rest stale. Take the server's snapshot in the same round trip instead.
      const res = await store.act('recordPayment', { invoice_id: invoice.id, ...data });
      close();
      toast('Payment recorded', 'ok', 6000, res.payment
        ? { label: 'Receipt', onClick: () => showReceipt(store.byId('payments', res.payment.id) || res.payment) }
        : null);
      onDone?.(res);
    }
  });
}

/** Void an issued invoice: it keeps its number, and nothing is owed on it. */
export function voidInvoiceFor(invoice, onDone) {
  openActionForm({
    title: `Void invoice · ${invoice.id}`,
    submitLabel: 'Void invoice',
    fields: [
      { key: 'reason', label: 'Reason', type: 'textarea', required: true, wide: true,
        help: 'Kept on the invoice. A voided invoice stays in the records with its number; ' +
              'for rent, that period is not billed again.' }
    ],
    onSubmit: async (data, close) => {
      await store.act('voidInvoice', { id: invoice.id, reason: data.reason, expected_version: invoice._v });
      toast(`${invoice.id} voided`, 'ok');
      close();
      onDone?.();
    }
  });
}

const tenantOf = (row) => store.byId('tenants', row.tenant_id);
const country = () => store.settings.whatsapp_country_code || '91';

/** A "Share on WhatsApp" link, or nothing when the tenant has no phone. */
function whatsappButton(tenant, text) {
  const href = tenant?.phone ? whatsappLink(tenant.phone, text, country()) : '';
  return href
    ? el('a', { class: 'btn btn-ghost', href, target: '_blank', rel: 'noopener noreferrer' },
         [icon('whatsapp', 16), ' WhatsApp'])
    : null;
}

/** The message sent with an invoice: what is owed, by when, and how to pay. */
export function invoiceMessage(invoice) {
  const s = store.settings;
  const tenant = tenantOf(invoice);
  const lines = [
    `Hello ${tenant?.full_name || ''},`.trim(),
    '',
    `${s.org_name || 'Property Management'} · invoice ${invoice.id}`,
    invoice.period_start ? `Period: ${date(invoice.period_start)} – ${date(invoice.period_end)}` : null,
    `Total: ${money(invoice.total || invoice.amount)}`,
    Number(invoice.amount_paid) > 0 ? `Paid: ${money(invoice.amount_paid)}` : null,
    `Balance due: ${money(invoice.balance)} by ${date(invoice.due_date)}`,
    s.upi_id && Number(invoice.balance) > 0 ? `Pay by UPI to ${s.upi_id} (note: ${invoice.id})` : null
  ];
  return lines.filter(l => l !== null).join('\n');
}

/** Printable invoice / receipt in a modal — uses the browser's own print. */
export function showInvoice(invoice) {
  const tenant = tenantOf(invoice);
  const unit = store.byId('units', invoice.unit_id);
  const property = store.byId('properties', invoice.property_id);
  const payments = store.paymentsOfInvoice(invoice.id);
  const lines = store.itemsOfInvoice(invoice.id);
  const s = store.settings;
  const gstLines = lines.some(it => Number(it.tax_rate) > 0);
  // a registered supplier charging GST issues a "Tax invoice", by that name
  const taxInvoice = !!s.gstin && Number(invoice.tax) > 0;

  const line = (k, v) => el('div', { class: 'kv' }, [el('span', { text: k }), el('strong', { text: v })]);

  const rows = lines.length
    ? lines.map(it => el('tr', {}, [
        el('td', {}, [
          el('strong', { text: it.description }),
          el('br'),
          el('small', { class: 'muted', text:
            (Number(it.quantity) === 1
              ? it.category
              : `${it.category} · ${it.quantity} × ${money(it.unit_amount)}`) +
            (gstLines ? ` · GST ${Number(it.tax_rate) || 0}%` : '') })
        ]),
        el('td', { class: 'num', text: money(it.amount) })
      ]))
    : [el('tr', {}, [
        el('td', { text: `${invoice.type || 'Rent'}${invoice.notes ? ' — ' + invoice.notes : ''}` }),
        el('td', { class: 'num', text: money(invoice.amount) })
      ])];
  if (Number(invoice.tax)) {
    if (Number(invoice.igst) > 0) {
      rows.push(el('tr', {}, [el('td', { text: 'IGST' }), el('td', { class: 'num', text: money(invoice.igst) })]));
    } else if (Number(invoice.cgst) > 0 || Number(invoice.sgst) > 0) {
      rows.push(el('tr', {}, [el('td', { text: 'CGST' }), el('td', { class: 'num', text: money(invoice.cgst) })]));
      rows.push(el('tr', {}, [el('td', { text: 'SGST / UTGST' }), el('td', { class: 'num', text: money(invoice.sgst) })]));
    } else {
      rows.push(el('tr', {}, [el('td', { text: 'Tax' }), el('td', { class: 'num', text: money(invoice.tax) })]));
    }
  }

  const pay = Number(invoice.balance) > 0 && invoice.status !== 'Void' && invoice.status !== 'Draft'
    ? upiLink({ vpa: s.upi_id, name: s.org_name, amount: invoice.balance, note: invoice.id }) : '';

  const doc = el('div', { class: 'invoice-doc', id: 'printable' }, [
    el('div', { class: 'invoice-top' }, [
      el('div', {}, [
        el('h2', { text: s.org_name || 'Property Management' }),
        el('p', { class: 'muted', text: property ? [property.address_line1, property.city, property.state].filter(Boolean).join(', ') : '' }),
        s.gstin ? el('p', { class: 'muted', text: 'GSTIN ' + s.gstin }) : null
      ]),
      el('div', { class: 'invoice-meta' }, [
        el('p', { class: 'doc-kind', text: invoice.status === 'Draft' ? 'Draft — not issued'
                                           : taxInvoice ? 'Tax invoice' : 'Invoice' }),
        el('h3', { text: invoice.id }),
        badge(invoice.status),
        el('p', { class: 'muted', text: 'Issued ' + date(invoice.issue_date || invoice.period_start) })
      ])
    ]),
    el('div', { class: 'invoice-parties' }, [
      el('div', {}, [
        el('h4', { text: 'Billed to' }),
        el('p', { text: tenant?.full_name || '—' }),
        tenant?.gstin ? el('p', { class: 'muted', text: 'GSTIN ' + tenant.gstin }) : null,
        tenant?.email ? el('p', { class: 'muted', text: tenant.email }) : null,
        tenant?.phone ? el('p', { class: 'muted', text: tenant.phone }) : null
      ]),
      el('div', {}, [
        el('h4', { text: 'For' }),
        el('p', { text: unit ? store.label('units', unit.id) : '—' }),
        el('p', { class: 'muted', text: invoice.period_start ? `${date(invoice.period_start)} – ${date(invoice.period_end)}` : '' }),
        el('p', { class: 'muted', text: 'Due ' + date(invoice.due_date) }),
        taxInvoice && invoice.place_of_supply ? el('p', { class: 'muted', text: 'Place of supply ' + invoice.place_of_supply }) : null,
        taxInvoice && s.sac_code ? el('p', { class: 'muted', text: 'SAC ' + s.sac_code }) : null
      ])
    ]),
    el('table', { class: 'invoice-table' }, [
      el('thead', {}, [el('tr', {}, [
        el('th', { text: 'Description' }), el('th', { class: 'num', text: 'Amount' })
      ])]),
      el('tbody', {}, rows)
    ]),
    el('div', { class: 'invoice-totals' }, [
      line('Total', money(invoice.total || invoice.amount)),
      line('Paid', money(invoice.amount_paid)),
      el('div', { class: 'kv kv-strong' }, [
        el('span', { text: 'Balance due' }),
        el('strong', { text: money(invoice.balance) })
      ])
    ]),
    s.upi_id && pay ? el('p', { class: 'invoice-pay' }, [
      'Pay by UPI to ', el('strong', { text: s.upi_id }), ` — use ${invoice.id} as the note.`
    ]) : null,
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

  const shareBar = el('div', { class: 'btn-row doc-actions' }, [
    whatsappButton(tenant, invoiceMessage(invoice)),
    pay ? el('a', { class: 'btn btn-ghost', href: pay, title: 'Opens a UPI app on a phone' },
             [icon('card', 16), ' Pay via UPI']) : null
  ].filter(Boolean));

  modal({
    title: 'Invoice ' + invoice.id,
    width: 720,
    body: el('div', {}, [shareBar.childElementCount ? shareBar : null, doc]),
    actions: [
      { label: 'Close' },
      { label: 'Print / PDF', variant: 'btn-ghost', onClick: () => printDocument() },
      Number(invoice.balance) > 0 && store.can('manager') && !['Void', 'Draft'].includes(invoice.status)
        ? { label: 'Record payment', variant: 'btn-primary',
            onClick: (e, close) => { close(); recordPaymentFor(invoice, () => refreshView()); } }
        : null
    ].filter(Boolean)
  });
}

/** A printable receipt for one payment, with what is still owed after it. */
export function showReceipt(payment) {
  const s = store.settings;
  const tenant = tenantOf(payment);
  const invoice = store.byId('invoices', payment.invoice_id);
  const property = store.byId('properties', payment.property_id);
  const deposit = invoice?.type === 'Deposit';
  const owedNow = store.arrears(i => i.tenant_id === payment.tenant_id)[0]?.balance || 0;

  const kv = (k, v) => v ? el('div', { class: 'kv' }, [el('span', { text: k }), el('strong', { text: v })]) : null;
  const doc = el('div', { class: 'invoice-doc', id: 'printable' }, [
    el('div', { class: 'invoice-top' }, [
      el('div', {}, [
        el('h2', { text: s.org_name || 'Property Management' }),
        el('p', { class: 'muted', text: property ? [property.address_line1, property.city].filter(Boolean).join(', ') : '' }),
        s.gstin ? el('p', { class: 'muted', text: 'GSTIN ' + s.gstin }) : null
      ]),
      el('div', { class: 'invoice-meta' }, [
        el('p', { class: 'doc-kind', text: deposit ? 'Deposit receipt' : 'Payment receipt' }),
        el('h3', { text: payment.id }),
        el('p', { class: 'muted', text: date(payment.payment_date) })
      ])
    ]),
    el('div', { class: 'kv-list receipt-body' }, [
      kv('Received from', tenant?.full_name || '—'),
      kv('Amount', money(payment.amount)),
      kv('Method', [payment.method, payment.reference].filter(Boolean).join(' · ')),
      kv('Against', invoice ? `${invoice.id}${invoice.period_start ? ' · ' + date(invoice.period_start) + ' – ' + date(invoice.period_end) : ''}` : 'Account'),
      kv('Received by', payment.received_by),
      invoice ? kv('Invoice balance now', money(invoice.balance)) : null,
      kv('Total still owed', money(owedNow))
    ]),
    deposit ? el('p', { class: 'muted', text: 'A security deposit is refundable under the terms of the lease.' }) : null,
    el('p', { class: 'invoice-foot muted', text: 'Thank you. Generated by ' + (s.org_name || 'Property Manager') })
  ]);

  const text = [
    `Hello ${tenant?.full_name || ''},`.trim(), '',
    `${s.org_name || 'We'} received ${money(payment.amount)} on ${date(payment.payment_date)}` +
      (invoice ? ` against ${invoice.id}` : '') + '. Thank you.',
    `Receipt ${payment.id}` + (payment.reference ? ` · ref ${payment.reference}` : ''),
    owedNow > 0 ? `Balance still due: ${money(owedNow)}` : 'Nothing further is due.'
  ].join('\n');
  const share = whatsappButton(tenant, text);

  modal({
    title: 'Receipt ' + payment.id,
    width: 600,
    body: el('div', {}, [share ? el('div', { class: 'btn-row doc-actions' }, [share]) : null, doc]),
    actions: [
      { label: 'Close' },
      { label: 'Print / PDF', variant: 'btn-primary', onClick: () => printDocument() }
    ]
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
          const res = await store.act('generateInvoices', { upto: today() });
          toast(res.created ? `${res.created} invoice(s) generated` : 'Everything already invoiced', 'ok');
          rerenderHost();
        } catch (err) { toast(err.message, 'danger'); }
        finally { e.target.disabled = false; }
      }
    }, [icon('bolt', 16), ' Generate rent']),
    el('button', { class: 'btn btn-ghost', onClick: () => navigate('meters') },
       [icon('gauge', 16), ' Meter readings']),
    el('button', {
      class: 'btn btn-ghost',
      onClick: async (e) => {
        e.target.disabled = true;
        try {
          const res = await store.act('sendReminders', {});
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
    // an issued invoice is voided, never deleted; only a draft can go
    canDelete: (row) => row.status === 'Draft',
    extraActions: [
      { label: 'View / print', icon: 'receipt', onClick: (row) => showInvoice(row) },
      {
        label: 'Record payment', icon: 'card',
        visible: (row) => store.can('manager') && Number(row.balance) > 0 && !['Void', 'Draft'].includes(row.status),
        onClick: (row) => recordPaymentFor(row, () => rerenderHost())
      },
      {
        label: 'Share on WhatsApp', icon: 'whatsapp',
        visible: (row) => !!tenantOf(row)?.phone && row.status !== 'Draft',
        onClick: (row) => window.open(whatsappLink(tenantOf(row).phone, invoiceMessage(row), country()),
                                      '_blank', 'noopener')
      },
      {
        label: 'Void', icon: 'ban', danger: true,
        visible: (row) => store.can('manager') && !['Void', 'Draft'].includes(row.status) && !(Number(row.amount_paid) > 0),
        onClick: (row) => voidInvoiceFor(row, () => rerenderHost())
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
