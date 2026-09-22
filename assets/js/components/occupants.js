import { el, icon, badge, date, modal, toast, today, confirmDialog } from '../ui.js';
import { store } from '../store.js';
import { OCCUPANT_ROLES, RELATIONSHIPS } from '../schema.js';
import { ref, copyable, avatar } from './detail.js';

/**
 * Everyone living on a lease besides its primary tenant.
 *
 * A lease bills one person — the primary tenant — but two friends sharing a
 * room, a couple or a family all live there, and the landlord needs each of
 * their names, phones and ID proofs. Each occupant is a tenant record of
 * their own, linked to the lease with a role (Co-tenant or Occupant), how they
 * relate to the primary tenant, and when they moved in or out.
 */

let seq = 0;
const telHref = (phone) => 'tel:' + String(phone).replace(/[^\d+]/g, '');

/**
 * The editable list of occupants, used inside the lease form and on its own
 * from the lease page.
 *
 * @param occupants    the lease's occupant rows as the server sent them
 * @param primary      () => the primary tenant's id, as currently chosen
 * @param createPerson (done) => opens the new-tenant form, calling done(tenant) once saved
 * @param lease        the lease's dates, to keep move-in / move-out inside its term
 * @returns {{ el, value, seen, validate, syncPrimary }}
 */
export function occupantEditor({ occupants = [], primary = () => '', createPerson, lease = {} } = {}) {
  const list = el('div', { class: 'occ-rows' });
  const empty = el('p', { class: 'occ-empty muted small', text:
    'Only the primary tenant so far. Add anyone else who lives in the unit — a flatmate, spouse or family member.' });
  const note = el('p', { class: 'occ-note small', hidden: true, role: 'status' });
  const relationships = el('datalist', { id: 'occ-rel-' + (++seq) },
    RELATIONSHIPS.map(r => el('option', { value: r })));
  const rows = [];

  const personOptions = (select, value) => {
    select.textContent = '';
    select.append(el('option', { value: '', text: 'Choose a person…' }));
    for (const o of store.options('tenants')) {
      select.append(el('option', { value: o.value, selected: o.value === value }, [o.label]));
    }
    select.value = value || '';
  };

  /** Nobody can be picked twice, and the primary tenant cannot be picked at all. */
  const syncChoices = () => {
    const main = primary();
    for (const r of rows) {
      const taken = new Set(rows.filter(x => x !== r).map(x => x.person.value).filter(Boolean));
      for (const opt of r.person.options) {
        if (!opt.value) continue;
        opt.disabled = opt.value === main || taken.has(opt.value);
        opt.textContent = store.label('tenants', opt.value) +
          (opt.value === main ? ' — primary tenant' : taken.has(opt.value) ? ' — already added' : '');
      }
    }
    empty.hidden = rows.length > 0;
  };

  function addRow(o = {}) {
    const person = el('select', { class: 'input occ-person', 'aria-label': 'Person' });
    personOptions(person, o.tenant_id);
    const role = el('select', { class: 'input occ-role', 'aria-label': 'Role' },
      OCCUPANT_ROLES.map(x => el('option', { value: x.value, title: x.help, selected: (o.role || 'Co-tenant') === x.value }, [x.label])));
    const relationship = el('input', { class: 'input occ-rel', 'aria-label': 'Relationship to the primary tenant',
                                       placeholder: 'Relationship', list: relationships.id, maxlength: 60,
                                       value: o.relationship || '' });
    const moveIn = el('input', { class: 'input', type: 'date', 'aria-label': 'Moved in', value: o.move_in_date || '',
                                 min: lease.start_date || null, max: lease.end_date || null });
    const moveOut = el('input', { class: 'input', type: 'date', 'aria-label': 'Moved out', value: o.move_out_date || '',
                                  min: lease.start_date || null });
    const remove = el('button', { class: 'icon-btn danger', type: 'button', title: 'Remove from this lease',
                                  'aria-label': 'Remove from this lease' }, [icon('trash', 15)]);
    const node = el('div', { class: 'occ-row' + (o.move_out_date && o.move_out_date < today() ? ' is-past' : '') }, [
      el('div', { class: 'occ-main' }, [person, role, relationship, remove]),
      el('div', { class: 'occ-dates' }, [
        el('label', { class: 'occ-date' }, [el('span', { class: 'muted small', text: 'Moved in' }), moveIn]),
        el('label', { class: 'occ-date' }, [el('span', { class: 'muted small', text: 'Moved out' }), moveOut])
      ])
    ]);
    const row = { id: o.id || '', _v: o._v || '', person, role, relationship, moveIn, moveOut, node };
    person.addEventListener('change', syncChoices);
    remove.addEventListener('click', () => {
      rows.splice(rows.indexOf(row), 1);
      node.remove();
      syncChoices();
    });
    rows.push(row);
    list.append(node);
    syncChoices();
    return row;
  }

  occupants.forEach(addRow);

  const addBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onClick: () => addRow().person.focus() },
    [icon('plus', 15), ' Add a person']);
  const newBtn = createPerson ? el('button', {
    class: 'btn btn-ghost btn-sm', type: 'button', title: 'Record someone who is not a tenant yet',
    onClick: () => createPerson((tenant) => {
      if (!tenant) return;
      // every list offers the new person; the row they were created for picks them
      for (const r of rows) personOptions(r.person, r.person.value);
      const blank = rows.find(r => !r.person.value);
      (blank || addRow()).person.value = tenant.id;
      syncChoices();
    })
  }, [icon('user', 15), ' New person']) : null;

  const wrap = el('div', { class: 'occ-editor' }, [
    relationships, note, empty, list,
    el('div', { class: 'occ-actions' }, [addBtn, newBtn])
  ]);

  return {
    el: wrap,
    /** The rows as the server takes them; empty rows are ignored. */
    value: () => rows.filter(r => r.person.value).map(r => ({
      ...(r.id ? { id: r.id, _v: r._v } : {}),
      tenant_id: r.person.value, role: r.role.value, relationship: r.relationship.value.trim(),
      move_in_date: r.moveIn.value, move_out_date: r.moveOut.value
    })),
    /** The occupant ids the editor opened with — only these may be removed by saving it. */
    seen: occupants.map(o => o.id).filter(Boolean),
    /** A reason the list cannot be saved, or null. */
    validate() {
      for (const r of rows) {
        const who = r.person.value ? store.label('tenants', r.person.value) : 'An occupant';
        if (!r.person.value && (r.relationship.value.trim() || r.moveIn.value || r.moveOut.value)) {
          r.person.focus();
          return 'Choose a person for every occupant, or remove the empty row.';
        }
        if (r.moveIn.value && r.moveOut.value && r.moveOut.value < r.moveIn.value) {
          r.moveOut.focus();
          return `${who} cannot move out before they move in.`;
        }
      }
      return null;
    },
    /**
     * The primary tenant changed. Someone listed as an occupant who is now the
     * primary tenant comes off the list, and the form says so.
     */
    syncPrimary() {
      const main = primary();
      const clash = rows.find(r => r.person.value && r.person.value === main);
      note.hidden = true;
      if (clash) {
        rows.splice(rows.indexOf(clash), 1);
        clash.node.remove();
        note.hidden = false;
        note.textContent = `${store.label('tenants', main)} is now the primary tenant, so they were taken off the occupants list.`;
      }
      syncChoices();
    }
  };
}

// ── the household, shown on a lease page ────────────────────────────────────

/** A person on the lease, with the details a landlord reaches for. */
function personRow(tenantId, role, occupant, actions) {
  const t = store.byId('tenants', tenantId);
  const name = t ? t.full_name : tenantId;
  const past = occupant && !store.isLivingThere(occupant);
  const when = occupant
    ? [occupant.move_in_date ? 'moved in ' + date(occupant.move_in_date) : null,
       occupant.move_out_date ? (past ? 'moved out ' : 'moving out ') + date(occupant.move_out_date) : null]
    : [];
  return el('div', { class: 'occ-person-row' + (past ? ' is-past' : '') }, [
    avatar({ name, size: 'md' }),
    el('div', { class: 'occ-person-main' }, [
      el('div', { class: 'occ-person-name' }, [
        ref('tenants', tenantId),
        badge(past ? 'Moved out' : role),
        occupant && occupant.relationship ? el('span', { class: 'muted small', text: occupant.relationship }) : null
      ]),
      el('div', { class: 'occ-person-meta muted small' }, [
        t && t.phone ? copyable(t.phone, { label: 'Phone', href: telHref(t.phone), compact: true }) : null,
        t && t.id_type ? el('span', { text: t.id_type + (t.id_number ? ' on file' : ' — number missing') })
                       : el('span', { class: 'occ-missing', text: 'No ID proof recorded' }),
        ...when.filter(Boolean).map(w => el('span', { text: w }))
      ])
    ]),
    actions && actions.length ? el('div', { class: 'occ-person-actions' }, actions) : null
  ]);
}

/**
 * The lease page's Occupants panel body: the primary tenant, everyone living
 * with them, and — dimmed — anyone who has moved out.
 *
 * @param onChanged called after a change is saved, to redraw the page
 */
export function householdList(lease, { onChanged } = {}) {
  const live = ['Active', 'Upcoming'].includes(lease.status);
  const canEdit = store.can('manager');
  const all = store.occupantsOf(lease);
  const current = all.filter(o => store.isLivingThere(o));
  const past = all.filter(o => !store.isLivingThere(o));

  const makePrimary = (o) => el('button', {
    class: 'btn btn-ghost btn-sm', type: 'button', title: 'Bill the rent to this person from now on',
    onClick: async () => {
      const ok = await confirmDialog({
        title: `Make ${store.label('tenants', o.tenant_id)} the primary tenant?`,
        message: `Rent from now on is billed to ${store.label('tenants', o.tenant_id)}. ` +
                 `${store.label('tenants', lease.tenant_id)} stays on the lease as a co-tenant. ` +
                 'Invoices already raised stay with whoever they were billed to.',
        confirmLabel: 'Make primary', danger: false
      });
      if (!ok) return;
      try {
        await store.setPrimaryTenant(lease, o.tenant_id);
        toast(`${store.label('tenants', o.tenant_id)} is now the primary tenant`, 'ok');
        onChanged?.();
      } catch (err) { toast(err.message, 'danger'); }
    }
  }, ['Make primary']);

  return el('div', { class: 'occ-household' }, [
    personRow(lease.tenant_id, 'Primary', null),
    ...current.map(o => personRow(o.tenant_id, o.role, o, canEdit && live ? [makePrimary(o)] : [])),
    current.length ? null : el('p', { class: 'muted small occ-alone', text: 'Nobody else is recorded as living here.' }),
    past.length ? el('p', { class: 'occ-subhead muted small', text: 'Moved out' }) : null,
    ...past.map(o => personRow(o.tenant_id, o.role, o, []))
  ]);
}

/** The lease page's "Manage occupants" dialog: the editor on its own, saved in one request. */
export function openOccupants(lease, { onDone, createPerson } = {}) {
  const error = el('p', { class: 'form-error', hidden: true });
  const editor = occupantEditor({
    occupants: store.occupantsOf(lease), primary: () => lease.tenant_id, createPerson, lease
  });
  return modal({
    title: 'Occupants · ' + lease.id,
    width: 760,
    body: el('div', { class: 'stack' }, [
      error,
      el('p', { class: 'muted', text:
        `${store.label('tenants', lease.tenant_id)} is the primary tenant — the person rent is billed to. ` +
        'List everyone else who lives in the unit.' }),
      editor.el
    ]),
    actions: [
      { label: 'Cancel' },
      {
        label: 'Save occupants', variant: 'btn-primary',
        onClick: async (e, close) => {
          error.hidden = true;
          const problem = editor.validate();
          if (problem) { error.hidden = false; error.textContent = problem; return; }
          const btn = e.currentTarget;
          btn.disabled = true; btn.textContent = 'Saving…';
          try {
            await store.saveOccupants(lease.id, editor.value(), editor.seen);
            toast('Occupants saved', 'ok');
            close();
            onDone?.();
          } catch (err) {
            btn.disabled = false; btn.textContent = 'Save occupants';
            error.hidden = false; error.textContent = err.message;
          }
        }
      }
    ]
  });
}
