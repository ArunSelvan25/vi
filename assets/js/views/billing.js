import { el, icon, money, date, toast, confirmDialog, today, addDays, whatsappLink } from '../ui.js';
import { store } from '../store.js';
import { tableFields, fieldByKey } from '../schema.js';
import { navigate, refreshView } from '../router.js';
import { dataTable } from '../components/table.js';
import { tabs } from '../components/detail.js';
import { openInvoiceForm, recordPaymentFor, showInvoice, voidInvoiceFor, invoiceMessage } from './invoices.js';
import { OPEN, sum, newestFirst, canPay, country, paymentTable } from './records.js';

/**
 * Billing: invoices and the payments received against them, on one screen.
 *
 * A payment always belongs to an invoice — it is recorded from the invoice it
 * pays — so the two are tabs of the same place rather than separate screens.
 * The figures across the top double as filters, and what is shown lives in the
 * address (#/billing?show=overdue, #/billing?tab=payments&show=month), so a
 * save that redraws the screen, a refresh, or a dashboard link lands on the
 * same view.
 */

const FILTERS = {
  outstanding: { tab: 'invoices', label: 'Outstanding', test: (i) => OPEN.includes(i.status) },
  overdue: { tab: 'invoices', label: 'Overdue', test: (i) => OPEN.includes(i.status) && i.due_date && i.due_date < today() },
  week: { tab: 'invoices', label: 'Due in the next 7 days',
          test: (i) => OPEN.includes(i.status) && i.due_date >= today() && i.due_date <= addDays(today(), 7) },
  month: { tab: 'payments', label: 'Collected this month' }
};

const thisMonth = () => today().slice(0, 7);
/** Deposits are held for tenants, not earned — the same rule as the dashboard. */
const collectedThisMonth = () => store.incomePayments()
  .filter(p => String(p.payment_date || '').slice(0, 7) === thisMonth());

/** Invoices with the date their last payment came in, for the "Paid on" column. */
function withLastPaid(invoices) {
  const last = new Map();
  for (const p of store.payments) {
    if (!p.invoice_id) continue;
    const d = String(p.payment_date || '');
    if (d > (last.get(p.invoice_id) || '')) last.set(p.invoice_id, d);
  }
  return invoices.map(i => ({ ...i, last_paid: last.get(i.id) || '' }));
}

/**
 * Unit already names its property ("Sunrise Residency · A-101"), so the
 * Property column goes; the paid amount is total less balance, so "Paid"
 * gives way to when it was paid.
 */
function invoiceColumns() {
  const cols = tableFields('invoices').filter(c => !['property_id', 'amount_paid'].includes(c.key))
    .map(c => (c.key === 'unit_id' ? { ...c, short: false } : c));
  const at = cols.findIndex(c => c.key === 'balance') + 1;
  cols.splice(at, 0, { key: 'last_paid', label: 'Paid on', type: 'date' });
  return cols;
}

function invoiceActions() {
  const again = () => refreshView();
  const invoiceOf = (row) => store.byId('invoices', row.id) || row;
  const tenantOf = (row) => store.byId('tenants', row.tenant_id);
  return [
    { label: 'View / print', icon: 'receipt', onClick: (row) => showInvoice(invoiceOf(row)) },
    { label: 'Record payment', icon: 'card', visible: canPay, onClick: (row) => recordPaymentFor(invoiceOf(row), again) },
    {
      label: 'Share on WhatsApp', icon: 'whatsapp',
      visible: (row) => !!tenantOf(row)?.phone && row.status !== 'Draft',
      onClick: (row) => window.open(whatsappLink(tenantOf(row).phone, invoiceMessage(invoiceOf(row)), country()),
                                    '_blank', 'noopener')
    },
    {
      label: 'Void', icon: 'ban', danger: true,
      visible: (row) => store.can('manager') && !['Void', 'Draft'].includes(row.status) && !(Number(row.amount_paid) > 0),
      onClick: (row) => voidInvoiceFor(invoiceOf(row), again)
    },
    {
      // a draft is still being written, so it is edited from the list; an
      // issued invoice is edited from its own page, keeping this column narrow
      label: 'Edit', icon: 'edit',
      visible: (row) => store.can('manager') && row.status === 'Draft',
      onClick: (row) => openInvoiceForm(invoiceOf(row), { onSaved: again })
    },
    {
      // an issued invoice is voided, never deleted; only a draft can go
      label: 'Delete', icon: 'trash', danger: true,
      visible: (row) => store.can('admin') && row.status === 'Draft',
      onClick: async (row) => {
        const ok = await confirmDialog({
          title: `Delete invoice ${row.id}?`,
          message: 'This removes the draft and its line items permanently.',
          confirmLabel: 'Delete'
        });
        if (!ok) return;
        try { await store.remove('invoices', row.id); toast('Invoice deleted', 'ok'); again(); }
        catch (err) { toast(err.message, 'danger'); }
      }
    }
  ];
}

function bulkActions() {
  if (!store.can('manager')) return [];
  return [
    el('button', {
      class: 'btn btn-ghost',
      onClick: async (e) => {
        const ok = await confirmDialog({
          title: 'Generate rent invoices?',
          message: 'Creates any missing rent invoices for every active lease up to today. Periods already invoiced are skipped, so it is safe to run repeatedly.',
          confirmLabel: 'Generate', danger: false
        });
        if (!ok) return;
        const btn = e.target.closest('button');
        btn.disabled = true;
        try {
          const res = await store.act('generateInvoices', { upto: today() });
          toast(res.created ? `${res.created} invoice(s) generated` : 'Everything already invoiced', 'ok');
          refreshView();
        } catch (err) { toast(err.message, 'danger'); btn.disabled = false; }
      }
    }, [icon('bolt', 16), ' Generate rent']),
    el('button', {
      class: 'btn btn-ghost',
      onClick: async (e) => {
        const btn = e.target.closest('button');
        btn.disabled = true;
        try {
          const res = await store.act('sendReminders', {});
          toast(`${res.sent} reminder(s) emailed, ${res.skipped} skipped`, res.sent ? 'ok' : 'info');
        } catch (err) { toast(err.message, 'danger'); }
        finally { btn.disabled = false; }
      }
    }, [icon('mail', 16), ' Send reminders']),
    el('button', {
      class: 'btn btn-primary',
      onClick: () => openInvoiceForm(null, { onSaved: () => refreshView() })
    }, [icon('plus', 16), ' New invoice'])
  ];
}

export function billingView(ctx = {}) {
  const show = FILTERS[ctx.query?.show] ? ctx.query.show : '';
  const tab = show ? FILTERS[show].tab : (ctx.query?.tab === 'payments' ? 'payments' : 'invoices');

  const address = (t, s) => '#/billing' + (() => {
    const q = new URLSearchParams();
    if (t === 'payments') q.set('tab', 'payments');
    if (s) q.set('show', s);
    const str = q.toString();
    return str ? '?' + str : '';
  })();

  const invoices = store.invoices;
  const outstanding = invoices.filter(FILTERS.outstanding.test);
  const overdue = invoices.filter(FILTERS.overdue.test);
  const week = invoices.filter(FILTERS.week.test);
  const collected = collectedThisMonth();

  // a figure that is already the filter clears it; any other sets it
  const figure = (key, label, value, sub, tone) => {
    const on = show === key;
    return el('button', {
      type: 'button', class: 'stat stat-button' + (tone ? ' stat-' + tone : '') + (on ? ' is-active' : ''),
      'aria-pressed': String(on), title: on ? 'Show everything' : 'Show only these',
      onClick: () => navigate(on ? address(tab, '') : address(FILTERS[key].tab, key))
    }, [
      el('span', { class: 'stat-label', text: label }),
      el('strong', { class: 'stat-value', text: value }),
      el('span', { class: 'stat-sub', text: sub })
    ]);
  };
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

  const filterChip = show
    ? el('div', { class: 'filter-chip-row' }, [
        el('span', { class: 'filter-chip' }, [
          'Showing: ', el('strong', { text: FILTERS[show].label }),
          el('button', { type: 'button', class: 'filter-chip-clear', 'aria-label': 'Clear filter', title: 'Show everything',
                         onClick: () => navigate(address(tab, '')) }, [icon('close', 13)])
        ])
      ])
    : null;

  const invoiceRows = withLastPaid(show && FILTERS[show].test ? invoices.filter(FILTERS[show].test) : invoices)
    .sort(newestFirst('due_date'));
  const paymentRows = (show === 'month' ? collected : store.payments).slice();

  const t = tabs([
    {
      key: 'invoices', label: 'Invoices', count: invoiceRows.length,
      render: () => el('div', { class: 'tab-stack' }, [
        tab === 'invoices' ? filterChip : null,
        dataTable({
          entity: 'invoices', rows: invoiceRows, columns: invoiceColumns(),
          filters: [
            { key: 'status', label: 'All statuses', options: fieldByKey('invoices', 'status').options },
            { key: 'type', label: 'All types', options: fieldByKey('invoices', 'type').options }
          ],
          actions: invoiceActions(),
          onRowClick: (row) => navigate('invoices/' + encodeURIComponent(row.id)),
          exportName: 'invoices',
          emptyMessage: show ? 'Nothing matches — clear the filter to see every invoice.'
                             : 'No invoices yet. Create one, or generate this month’s rent.'
        })
      ])
    },
    {
      key: 'payments', label: 'Payments received', count: paymentRows.length,
      render: () => el('div', { class: 'tab-stack' }, [
        tab === 'payments' ? filterChip : null,
        el('p', { class: 'muted small', text: 'Payments are recorded from the invoice they pay — use Record payment on an invoice.' }),
        paymentTable(paymentRows, { exportName: 'payments' })
      ])
    }
  ], { active: tab, urlFor: (key) => address(key, key === tab ? show : '') });

  const view = el('div', { class: 'view billing' }, [
    el('div', { class: 'page-hero' }, [
      el('div', { class: 'page-hero-copy' }, [
        el('span', { class: 'eyebrow', text: 'Money' }),
        el('h1', { text: 'Billing' }),
        el('p', { class: 'muted', text: 'Invoices you have raised and the payments received against them.' })
      ]),
      el('div', { class: 'page-meta' }, [
        el('span', { class: 'page-pill' }, [plural(invoices.length, 'invoice')]),
        el('span', { class: 'page-pill' }, [plural(store.payments.length, 'payment')])
      ])
    ]),
    el('div', { class: 'view-head' }, [
      el('div', {}, [
        el('h1', { text: 'Billing' }),
        el('p', { class: 'muted', text: `${money(sum(outstanding, 'balance'))} still to collect` })
      ]),
      el('div', { class: 'head-actions' }, bulkActions())
    ]),
    el('div', { class: 'stat-row stat-row-buttons' }, [
      figure('outstanding', 'Outstanding', money(sum(outstanding, 'balance')), plural(outstanding.length, 'invoice'),
             outstanding.length ? 'warn' : 'ok'),
      figure('overdue', 'Overdue', money(sum(overdue, 'balance')), plural(overdue.length, 'invoice'),
             overdue.length ? 'danger' : null),
      figure('week', 'Due in 7 days', money(sum(week, 'balance')), plural(week.length, 'invoice')),
      figure('month', 'Collected this month', money(sum(collected)), plural(collected.length, 'payment'), 'ok')
    ]),
    t.el
  ]);
  return view;
}
