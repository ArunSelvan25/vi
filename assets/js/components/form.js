import { el, modal, toast } from '../ui.js';
import { store } from '../store.js';
import { entities, formFields, GSTIN_PATTERN } from '../schema.js';

/** Build one input from a schema field. */
function inputFor(field, value, form) {
  const id = 'f_' + field.key;
  const common = { id, name: field.key, class: 'input', 'data-key': field.key };

  if (field.type === 'textarea') {
    return el('textarea', { ...common, rows: 3 }, [value ?? '']);
  }

  if (field.type === 'select' || field.type === 'ref') {
    const select = el('select', common);
    select.append(el('option', { value: '', text: field.required ? 'Select…' : '— none —' }));

    const opts = field.type === 'ref'
      ? store.options(field.optionsFrom)
      : (field.options || []).map(o => ({ value: o, label: o }));

    for (const o of opts) {
      select.append(el('option', { value: o.value, selected: String(value) === String(o.value) }, [o.label]));
    }
    if (field.type === 'ref') select.dataset.optionsFrom = field.optionsFrom;
    if (field.dependsOn) select.dataset.dependsOn = field.dependsOn;
    return select;
  }

  const typeMap = { money: 'number', number: 'number', date: 'date', email: 'email', tel: 'tel', url: 'url',
                    password: 'password' };
  return el('input', {
    ...common,
    type: typeMap[field.type] || 'text',
    autocomplete: field.autocomplete || null,
    step: field.type === 'money' ? '0.01' : (field.type === 'number' ? '1' : null),
    value: value ?? '',
    required: field.required || null
  });
}

/**
 * Opens a create/edit modal for an entity and returns the saved row.
 * `overrides` pre-fills (and locks) fields — used for "add unit to this property".
 */
export function openEntityForm(entity, row = null, { overrides = {}, onSaved } = {}) {
  const def = entities[entity];
  const isEdit = !!row;
  const fields = formFields(entity);
  // organisation defaults pre-fill a new record, so the settings page means
  // something rather than storing numbers nothing reads
  const orgDefaults = (!isEdit && entity === 'leases') ? {
    grace_days: store.settings.default_grace_days,
    late_fee: store.settings.default_late_fee
  } : {};
  const values = { ...orgDefaults, ...(row || {}), ...overrides };

  const grid = el('div', { class: 'form-grid' });
  const controls = {};

  for (const field of fields) {
    const control = inputFor(field, values[field.key], null);
    controls[field.key] = control;
    const locked = !isEdit && Object.prototype.hasOwnProperty.call(overrides, field.key);
    if (locked) control.setAttribute('disabled', '');

    grid.append(el('div', { class: 'field' + (field.type === 'textarea' ? ' field-wide' : '') }, [
      el('label', { for: 'f_' + field.key }, [
        field.label,
        field.required ? el('span', { class: 'req', text: ' *' }) : null
      ]),
      control,
      field.help ? el('small', { class: 'help', text: field.help }) : null
    ]));
  }

  // Unit dropdowns narrow to the selected property.
  const propertySelect = controls['property_id'];
  const unitSelect = controls['unit_id'];
  if (propertySelect && unitSelect) {
    const syncUnits = () => {
      const pid = propertySelect.value;
      const current = unitSelect.value;
      unitSelect.textContent = '';
      unitSelect.append(el('option', { value: '', text: 'Select…' }));
      for (const o of store.options('units', u => !pid || u.property_id === pid)) {
        unitSelect.append(el('option', { value: o.value, selected: o.value === current }, [o.label]));
      }
    };
    propertySelect.addEventListener('change', syncUnits);
    syncUnits();
    unitSelect.value = values.unit_id || '';
  }

  // Picking a unit fills rent/deposit from the unit record.
  if (unitSelect && controls['rent_amount']) {
    unitSelect.addEventListener('change', () => {
      const unit = store.byId('units', unitSelect.value);
      if (!unit) return;
      if (!controls['rent_amount'].value) controls['rent_amount'].value = unit.rent_amount || '';
      if (controls['deposit_amount'] && !controls['deposit_amount'].value) {
        controls['deposit_amount'].value = unit.deposit_amount || '';
      }
    });
  }

  const error = el('p', { class: 'form-error', hidden: true });
  const formEl = el('form', { class: 'entity-form', onSubmit: (e) => e.preventDefault() }, [error, grid]);

  const dialog = modal({
    title: (isEdit ? 'Edit ' : 'New ') + def.singular + (isEdit ? ' · ' + row.id : ''),
    body: formEl,
    width: 720,
    actions: [
      { label: 'Cancel' },
      {
        label: isEdit ? 'Save changes' : 'Create ' + def.singular.toLowerCase(),
        variant: 'btn-primary',
        onClick: async (e, close) => {
          const btn = e.currentTarget;
          const data = {};
          for (const field of fields) {
            let v = controls[field.key].value;
            if (field.type === 'money' || field.type === 'number') v = v === '' ? '' : Number(v);
            data[field.key] = v;
          }
          Object.assign(data, overrides);

          const missing = fields.filter(f => f.required && (data[f.key] === '' || data[f.key] === undefined));
          if (missing.length) {
            error.hidden = false;
            error.textContent = 'Required: ' + missing.map(f => f.label).join(', ');
            controls[missing[0].key].focus();
            return;
          }
          if (data.start_date && data.end_date && data.end_date < data.start_date) {
            error.hidden = false;
            error.textContent = 'End date cannot be before the start date.';
            return;
          }
          const badGstin = fields.find(f => f.pattern === 'gstin' && data[f.key] &&
            !GSTIN_PATTERN.test(String(data[f.key]).replace(/\s+/g, '').toUpperCase()));
          if (badGstin) {
            error.hidden = false;
            error.textContent = `${badGstin.label}: that is not a valid GSTIN (15 characters, starting with the state code).`;
            controls[badGstin.key].focus();
            return;
          }

          btn.disabled = true;
          btn.textContent = 'Saving…';
          try {
            // the version the form was opened on: a save over someone else's is refused
            const saved = isEdit
              ? await store.update(entity, row.id, data, { expectedVersion: row._v })
              : await store.create(entity, data);
            toast(`${def.singular} ${isEdit ? 'updated' : 'created'}`, 'ok');
            close();
            onSaved?.(saved);
          } catch (err) {
            btn.disabled = false;
            btn.textContent = isEdit ? 'Save changes' : 'Create ' + def.singular.toLowerCase();
            error.hidden = false;
            error.textContent = err.message;
          }
        }
      }
    ]
  });

  return dialog;
}

/** Generic small form modal for one-off actions (payment, user, settings). */
export function openActionForm({ title, fields, submitLabel = 'Save', width = 520, onSubmit }) {
  const controls = {};
  const grid = el('div', { class: 'form-grid' });

  for (const field of fields) {
    const control = inputFor(field, field.value, null);
    controls[field.key] = control;
    grid.append(el('div', { class: 'field' + (field.wide ? ' field-wide' : '') }, [
      el('label', { for: 'f_' + field.key }, [field.label, field.required ? el('span', { class: 'req', text: ' *' }) : null]),
      control,
      field.help ? el('small', { class: 'help', text: field.help }) : null
    ]));
  }

  const error = el('p', { class: 'form-error', hidden: true });
  return modal({
    title,
    width,
    body: el('form', { onSubmit: e => e.preventDefault() }, [error, grid]),
    actions: [
      { label: 'Cancel' },
      {
        label: submitLabel,
        variant: 'btn-primary',
        onClick: async (e, close) => {
          const btn = e.currentTarget;
          const data = {};
          for (const f of fields) {
            let v = controls[f.key].value;
            if (f.type === 'money' || f.type === 'number') v = v === '' ? '' : Number(v);
            data[f.key] = v;
          }
          const missing = fields.filter(f => f.required && (data[f.key] === '' || data[f.key] === undefined));
          if (missing.length) {
            error.hidden = false;
            error.textContent = 'Required: ' + missing.map(f => f.label).join(', ');
            return;
          }
          btn.disabled = true; btn.textContent = 'Working…';
          try {
            await onSubmit(data, close);
          } catch (err) {
            btn.disabled = false; btn.textContent = submitLabel;
            error.hidden = false; error.textContent = err.message;
          }
        }
      }
    ]
  });
}
