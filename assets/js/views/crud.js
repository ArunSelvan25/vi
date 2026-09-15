import { el, icon, confirmDialog, toast } from '../ui.js';
import { store } from '../store.js';
import { entities, tableFields, fieldByKey } from '../schema.js';
import { dataTable } from '../components/table.js';
import { openEntityForm } from '../components/form.js';

/** "status" → "statuses", "category" → "categories", "type" → "types". */
function pluralise(word) {
  if (/(s|x|z|ch|sh)$/i.test(word)) return word + 'es';
  if (/[^aeiou]y$/i.test(word)) return word.slice(0, -1) + 'ies';
  return word + 's';
}

/**
 * Builds a standard list view for any entity in the schema. Specialised views
 * (invoices, tenants) reuse this and pass extra row actions.
 */
export function crudView(entity, {
  extraActions = [], onRowClick, columns, filterKeys = ['status'], headerActions = [],
  openForm, canDelete
} = {}) {
  // entities with a richer editor (invoices and their line items) supply their own
  const open = openForm || ((row, opts) => openEntityForm(entity, row, opts));
  const def = entities[entity];
  const wrap = el('div', { class: 'view' });

  const filters = filterKeys
    .map(key => {
      const f = fieldByKey(entity, key);
      return f && f.options
        ? { key, label: 'All ' + pluralise(f.label.toLowerCase()), options: f.options }
        : null;
    })
    .filter(Boolean);

  const actions = [
    ...extraActions,
    {
      label: 'Edit', icon: 'edit',
      visible: () => store.can('manager'),
      onClick: (row) => open(row, { onSaved: () => rerender() })
    },
    {
      label: 'Delete', icon: 'trash', danger: true,
      visible: (row) => store.can('admin') && (!canDelete || canDelete(row)),
      onClick: async (row) => {
        const ok = await confirmDialog({
          title: `Delete ${def.singular.toLowerCase()} ${row.id}?`,
          message: 'This removes the row from the Google Sheet permanently. Linked records are not deleted.',
          confirmLabel: 'Delete'
        });
        if (!ok) return;
        try { await store.remove(entity, row.id); toast(`${def.singular} deleted`, 'ok'); rerender(); }
        catch (err) { toast(err.message, 'danger'); }
      }
    }
  ];

  function rerender() {
    wrap.textContent = '';
    wrap.append(
      el('div', { class: 'view-head' }, [
        el('div', {}, [
          el('h1', { text: def.title }),
          el('p', { class: 'muted', text: `${store[entity].length} record${store[entity].length === 1 ? '' : 's'}` })
        ]),
        el('div', { class: 'head-actions' }, [
          ...headerActions,
          store.can('manager')
            ? el('button', {
                class: 'btn btn-primary',
                onClick: () => open(null, { onSaved: () => rerender() })
              }, [icon('plus', 16), ' New ' + def.singular.toLowerCase()])
            : null
        ])
      ]),
      dataTable({
        entity,
        rows: store[entity],
        columns: columns || tableFields(entity),
        filters,
        actions,
        onRowClick,
        emptyMessage: `No ${def.title.toLowerCase()} yet. Create the first one to get started.`
      })
    );
  }

  rerender();
  return wrap;
}
