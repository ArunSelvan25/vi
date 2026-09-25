import { el, icon, money, date, toast, modal, today } from '../ui.js';
import { store } from '../store.js';
import { openEntityForm } from '../components/form.js';
import { refreshView, navigate } from '../router.js';
import { openInvoiceForm, recordPaymentFor } from './invoices.js';

/**
 * "Add" from wherever you are: a document on a lease's Documents tab, a
 * ticket on a unit's Maintenance tab, an invoice from a tenant's page. Each
 * opens the usual form with the record you came from already filled in — and
 * locked where it can only be that record — so nothing has to be chosen twice.
 * Managers and administrators only; a viewer sees no add buttons.
 */

const again = () => refreshView();

/** A small add button for a panel header, or null for someone who cannot add. */
export function addButton(label, onClick, iconName = 'plus') {
  if (!store.can('manager')) return null;
  return el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onClick }, [icon(iconName, 14), ' ' + label]);
}

/** The `add` option of a related-records table, or null for someone who cannot add. */
export function tableAdd(label, onClick) {
  return store.can('manager') ? { label, onClick } : null;
}

/** Several actions in one panel header. */
export function panelActions(...nodes) {
  const shown = nodes.filter(Boolean);
  if (!shown.length) return null;
  return shown.length === 1 ? shown[0] : el('span', { class: 'panel-actions' }, shown);
}

/** Who and what an invoice raised from this page is for. */
export function invoiceDefaults(kind, row) {
  const lease = kind === 'lease' ? row
    : kind === 'unit' ? store.activeLeaseForUnit(row.id)
    : kind === 'tenant' ? store.leases.find(l => l.tenant_id === row.id && l.status === 'Active')
    : null;
  return {
    property_id: row.property_id || (kind === 'property' ? row.id : lease?.property_id) || '',
    unit_id: kind === 'unit' ? row.id : lease?.unit_id || '',
    tenant_id: kind === 'tenant' ? row.id : lease?.tenant_id || '',
    lease_id: lease?.id || ''
  };
}

export const addInvoice = (defaults) => openInvoiceForm(null, { defaults, onSaved: again });

export const addLease = (overrides) => openEntityForm('leases', null, {
  overrides, onSaved: (row) => (row?.id ? navigate('leases/' + encodeURIComponent(row.id)) : again())
});

export const addUnit = (propertyId) => openEntityForm('units', null, { overrides: { property_id: propertyId }, onSaved: again });

/** @param lock fields that can only be this record's; @param suggest fields filled in but changeable */
export const addTicket = (lock, suggest = {}) => openEntityForm('maintenance', null, {
  overrides: lock, defaults: { status: 'Open', priority: 'Medium', reported_date: today(), ...suggest }, onSaved: again
});

export const addExpense = (lock) => openEntityForm('expenses', null,
  { overrides: lock, defaults: { date: today() }, onSaved: again });

/** A document linked to this property, unit, tenant or lease. */
export const addDocument = (entityType, id) => openEntityForm('documents', null,
  { overrides: { entity_type: entityType, entity_id: id }, onSaved: again });

/**
 * Record a payment from a property, unit, tenant or lease page. A payment is
 * always taken against an invoice, so this asks which of the unpaid ones it
 * pays — straight to the form when there is only one.
 *
 * @param scope { kind: 'property'|'unit'|'tenant'|'lease', id }
 */
export async function addPayment(scope) {
  let rows;
  try {
    rows = (await store.page('invoices', { scope, preset: 'unpaid', sort: 'due_date', dir: 'asc', pageSize: 50 })).rows;
  } catch (err) { toast(err.message, 'danger'); return; }
  if (!rows.length) {
    toast(`Nothing is owed on this ${scope.kind} — raise an invoice first, then record the payment against it.`, 'info', 6000);
    return;
  }
  if (rows.length === 1) { recordPaymentFor(rows[0], again); return; }

  let chosen = rows[0];
  const list = el('div', { class: 'pick-list', role: 'radiogroup', 'aria-label': 'Invoice' }, rows.map((inv, i) => {
    const radio = el('input', { type: 'radio', name: 'pay-invoice', checked: i === 0 || null,
                                onChange: () => { chosen = inv; } });
    const late = inv.due_date && inv.due_date < today();
    return el('label', { class: 'pick-row' }, [
      radio,
      el('span', { class: 'pick-main' }, [
        el('strong', { text: `${inv.id} · ${inv.type || 'Invoice'}` }),
        el('small', { class: 'muted', text: [
          store.label('tenants', inv.tenant_id),
          inv.period_start ? `${date(inv.period_start)} – ${date(inv.period_end)}` : '',
          (late ? 'was due ' : 'due ') + date(inv.due_date)
        ].filter(Boolean).join(' · ') })
      ]),
      el('strong', { class: 'num' + (late ? ' neg' : ''), text: money(inv.balance) })
    ]);
  }));
  modal({
    title: 'Record payment · choose the invoice',
    width: 560,
    body: el('div', { class: 'stack' }, [
      el('p', { class: 'muted', text: 'Oldest first. Anything paid beyond this invoice is applied to the tenant\'s other unpaid invoices.' }),
      list
    ]),
    actions: [
      { label: 'Cancel' },
      { label: 'Continue', variant: 'btn-primary', onClick: (e, close) => { close(); recordPaymentFor(chosen, again); } }
    ]
  });
}
