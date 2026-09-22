import { el, icon, toast, confirmDialog, badge } from '../ui.js';
import { store } from '../store.js';
import { api } from '../api.js';
import { config } from '../config.js';
import { openActionForm } from '../components/form.js';
import { refreshView } from '../router.js';
import { GSTIN_PATTERN } from '../schema.js';

const SETTING_FIELDS = [
  { key: 'org_name', label: 'Organisation name', type: 'text' },
  { key: 'currency_symbol', label: 'Currency symbol', type: 'text' },
  { key: 'currency', label: 'Currency code', type: 'text', help: 'e.g. INR, USD, GBP, AED' },
  { key: 'locale', label: 'Locale', type: 'text', help: 'e.g. en-IN, en-US — controls number grouping' },
  { key: 'date_format', label: 'Date format', type: 'select',
    options: ['dd MMM yyyy', 'dd/MM/yyyy', 'MM/dd/yyyy', 'yyyy-MM-dd', 'd MMMM yyyy'] },
  { key: 'invoice_prefix', label: 'Invoice prefix', type: 'text',
    help: 'Used for new invoice numbers, e.g. INV-00042. Existing numbers are unchanged.' },
  { key: 'default_grace_days', label: 'Default grace days', type: 'number',
    help: 'Pre-filled on a new lease' },
  { key: 'default_late_fee', label: 'Default late fee', type: 'number',
    help: 'Pre-filled on a new lease. The lease\'s own late fee is what gets charged once its rent is overdue.' },
  { key: 'reminder_days_before', label: 'Remind this many days before due', type: 'number' },
  { key: 'reminder_overdue_days', label: 'Remind on these days overdue', type: 'text',
    help: 'Comma separated, e.g. 1, 7, 14, 30. One email per tenant lists everything they owe.' },
  { key: 'reminder_enabled', label: 'Scheduled reminders', type: 'select', options: ['true', 'false'],
    help: 'Email sending is not set up yet, so no reminders go out for now. Share invoices over WhatsApp instead.' },
  { key: 'gstin', label: 'Your GSTIN', type: 'text',
    help: 'When set, invoices carrying GST print as tax invoices with CGST/SGST or IGST' },
  { key: 'sac_code', label: 'SAC code', type: 'text', help: '997212 for renting non-residential property' },
  { key: 'default_gst_rate', label: 'Default GST % on new invoice lines', type: 'number' },
  { key: 'upi_id', label: 'UPI ID for payments', type: 'text',
    help: 'e.g. business@okhdfc — shown on invoices and in reminders, with a Pay via UPI link' },
  { key: 'whatsapp_country_code', label: 'Country code for WhatsApp', type: 'text',
    help: 'Added to phone numbers stored without one. 91 for India.' },
  { key: 'lease_expiry_alert_days', label: 'Lease expiry alert window (days)', type: 'number' },
  { key: 'session_hours', label: 'Session length (hours)', type: 'number' }
];

function panel(title, body, { action, count } = {}) {
  return el('section', { class: 'panel' }, [
    el('header', { class: 'panel-head' }, [
      el('h3', {}, [title, count !== undefined ? el('span', { class: 'panel-count', text: String(count) }) : null]),
      action || null
    ]),
    el('div', { class: 'panel-body' }, [body])
  ]);
}

export function settingsView() {
  const wrap = el('div', { class: 'view' });
  const user = config.user || {};

  wrap.append(
    el('div', { class: 'page-hero' }, [
      el('div', { class: 'page-hero-copy' }, [
        el('span', { class: 'eyebrow', text: 'Control center' }),
        el('h1', { text: 'Settings' }),
        el('p', { class: 'muted', text: 'Signed in as ' + (user.name || user.phone) + ' · ' + user.role })
      ]),
      el('div', { class: 'page-meta' }, [
        el('span', { class: 'page-pill page-pill-ok' }, ['Workspace ready']),
        el('span', { class: 'page-pill' }, [user.role || 'User'])
      ])
    ]),
    el('div', { class: 'view-head' }, [
      el('div', {}, [
        el('h1', { text: 'Settings' }),
        el('p', { class: 'muted', text: 'Keep your organisation, billing, and team configuration aligned.' })
      ])
    ])
  );

  // ── organisation settings ───────────────────────────────────────────────
  const controls = {};
  const grid = el('div', { class: 'form-grid' });
  for (const f of SETTING_FIELDS) {
    const value = store.settings[f.key] ?? '';
    let control;
    if (f.type === 'select') {
      control = el('select', { class: 'input' }, f.options.map(o =>
        el('option', { value: o, selected: String(value) === o, text: o })));
    } else {
      control = el('input', { class: 'input', type: 'text', inputmode: f.type === 'number' ? 'decimal' : null, value });
    }
    if (!store.can('admin')) control.setAttribute('disabled', '');
    controls[f.key] = control;
    grid.append(el('div', { class: 'field' }, [
      el('label', { text: f.label }), control,
      f.help ? el('small', { class: 'help', text: f.help }) : null
    ]));
  }

  wrap.append(panel('Organisation', el('div', {}, [
    grid,
    store.can('admin')
      ? el('button', {
          class: 'btn btn-primary',
          onClick: async (e) => {
            e.target.disabled = true;
            try {
              // Saved side by side rather than one round trip after another,
              // and a key is only created when the server says it is missing — a
              // create after any failure (a dropped connection, say) appended a
              // second row for a key that was already there.
              const gstin = controls.gstin.value.replace(/\s+/g, '').toUpperCase();
              if (gstin && !GSTIN_PATTERN.test(gstin)) {
                throw new Error('Your GSTIN is not valid — 15 characters, starting with the state code.');
              }
              controls.gstin.value = gstin;
              const changed = SETTING_FIELDS.filter(f =>
                String(store.settings[f.key] ?? '') !== String(controls[f.key].value));
              await Promise.all(changed.map(f => {
                const v = controls[f.key].value;
                return api('update', { table: 'Settings', id: f.key, data: { value: v } })
                  .catch(err => {
                    if (!/not found/i.test(err.message)) throw err;
                    return api('create', { table: 'Settings', data: { key: f.key, value: v } });
                  });
              }));
              await store.refresh();
              toast('Settings saved', 'ok');
            } catch (err) { toast(err.message, 'danger'); }
            finally { e.target.disabled = false; }
          }
        }, ['Save settings'])
      : el('p', { class: 'muted', text: 'Only administrators can change these.' })
  ])));

  // ── account ─────────────────────────────────────────────────────────────
  wrap.append(panel('Your account', el('div', { class: 'kv-list' }, [
    el('div', { class: 'kv' }, [el('span', { text: 'Name' }), el('strong', { text: user.name || '—' })]),
    el('div', { class: 'kv' }, [
      el('span', { text: 'Phone' }),
      el('strong', { text: user.phone || '—' })
    ]),
    el('div', { class: 'kv' }, [
      el('span', { text: 'Email' }),
      el('strong', { text: user.email || '—' })
    ]),
    el('div', { class: 'kv' }, [
      el('span', { text: 'Role' }),
      el('span', { class: 'badge badge-info', text: user.role || 'unknown' })
    ]),
    el('button', {
      class: 'btn btn-ghost',
      onClick: () => openActionForm({
        title: 'Change password',
        submitLabel: 'Update password',
        fields: [
          { key: 'current', label: 'Current password', type: 'password', required: true,
            autocomplete: 'current-password' },
          { key: 'next', label: 'New password', type: 'password', required: true,
            autocomplete: 'new-password', help: 'At least 10 characters, not only numbers' }
        ],
        onSubmit: async (data, close) => {
          const res = await api('changePassword', data);
          // the change ends every earlier session, this one included; the
          // server sends a replacement so saving does not sign you out
          if (res && res.token) {
            config.token = res.token;
            if (res.user) config.user = res.user;
          }
          toast('Password updated', 'ok');
          close();
        }
      })
    }, ['Change password']),
    el('button', {
      class: 'btn btn-ghost',
      onClick: async () => {
        const ok = await confirmDialog({
          title: 'Sign out other devices?',
          message: 'Every other phone or computer signed in as you is signed out now. This device stays signed in.',
          confirmLabel: 'Sign them out'
        });
        if (!ok) return;
        try {
          const res = await api('endSessions', {});
          // this device's own session ended with the rest; keep the replacement
          if (res && res.token) {
            config.token = res.token;
            if (res.user) config.user = res.user;
          }
          toast('Other devices signed out', 'ok');
        } catch (err) { toast(err.message, 'danger'); }
      }
    }, ['Sign out other devices'])
  ])));

  // ── users (admin only) ──────────────────────────────────────────────────
  if (store.can('admin')) {
    const userRows = store.users;
    const me = config.user || {};

    const userRow = (u) => {
      const disabled = String(u.active).toLowerCase() === 'false';
      const isMe = u.id === me.id;
      return el('li', { class: 'list-row' }, [
        el('div', {}, [
          el('strong', { text: u.name || u.phone }),
          isMe ? el('small', { class: 'muted', text: ' · you' }) : null,
          el('br'),
          el('small', { class: 'muted', text:
            [u.phone, u.email].filter(Boolean).join(' · ') +
            ' · last seen ' + (u.last_login || 'never') })
        ]),
        el('span', { class: 'list-meta' }, [
          disabled ? badge('Disabled', 'muted') : badge(u.role, 'info'),
          el('button', {
            class: 'btn btn-ghost btn-sm', title: 'Set a new password for this user',
            onClick: () => openActionForm({
              title: 'Reset password · ' + (u.name || u.phone),
              submitLabel: 'Set password',
              fields: [{ key: 'password', label: 'New password', type: 'text', required: true,
                         help: 'At least 10 characters. Share it securely; they can change it afterwards.' }],
              onSubmit: async (data, close) => {
                await api('resetPassword', { id: u.id, password: data.password });
                toast('Password reset', 'ok');
                close();
              }
            })
          }, ['Reset password']),
          el('button', {
            class: 'btn btn-ghost btn-sm',
            onClick: () => openActionForm({
              title: 'Change role · ' + (u.name || u.phone),
              submitLabel: 'Save role',
              fields: [{ key: 'role', label: 'Role', type: 'select', value: u.role,
                         options: ['admin', 'manager', 'viewer'],
                         help: 'Takes effect immediately, even on an open session.' }],
              onSubmit: async (data, close) => {
                await api('setUserRole', { id: u.id, role: data.role });
                close();
                // your own role decides the whole shell, so rebuild it; anyone
                // else's only changes this list
                if (isMe) { location.reload(); return; }
                await store.refresh();
                toast('Role updated', 'ok');
                refreshView();
              }
            })
          }, ['Role']),
          isMe ? null : el('button', {
            class: 'btn btn-ghost btn-sm', title: 'End every session this user has open',
            onClick: async () => {
              const ok = await confirmDialog({
                title: 'Sign out ' + (u.name || u.phone) + '?',
                message: 'They are signed out on every device now, and can sign in again with their password.',
                confirmLabel: 'Sign out'
              });
              if (!ok) return;
              try {
                await api('endSessions', { id: u.id });
                toast((u.name || u.phone) + ' signed out everywhere', 'ok');
              } catch (err) { toast(err.message, 'danger'); }
            }
          }, ['Sign out']),
          isMe ? null : el('button', {
            class: 'btn btn-ghost btn-sm' + (disabled ? '' : ' danger-text'),
            onClick: async () => {
              const ok = await confirmDialog({
                title: (disabled ? 'Enable ' : 'Disable ') + (u.name || u.phone) + '?',
                message: disabled
                  ? 'They will be able to sign in again straight away.'
                  : 'They are signed out immediately and cannot sign in. Their records are kept.',
                confirmLabel: disabled ? 'Enable' : 'Disable',
                danger: !disabled
              });
              if (!ok) return;
              try {
                await api('setUserActive', { id: u.id, active: !disabled });
                await store.refresh();
                toast(disabled ? 'User enabled' : 'User disabled', 'ok');
                refreshView();
              } catch (err) { toast(err.message, 'danger'); }
            }
          }, [disabled ? 'Enable' : 'Disable'])
        ])
      ]);
    };

    wrap.append(panel('Team members',
      userRows.length
        ? el('ul', { class: 'list' }, userRows.map(userRow))
        : el('p', { class: 'muted', text: 'No users.' }),
      { count: userRows.length, action: el('button', {
        class: 'btn btn-ghost btn-sm',
        onClick: () => openActionForm({
          title: 'Invite a team member',
          submitLabel: 'Create user',
          fields: [
            { key: 'name', label: 'Name', type: 'text', required: true },
            { key: 'phone', label: 'Phone number', type: 'tel', required: true,
              help: 'This is how they sign in — it must be unique' },
            { key: 'email', label: 'Email (optional)', type: 'email' },
            { key: 'role', label: 'Role', type: 'select', value: 'manager',
              options: ['admin', 'manager', 'viewer'],
              help: 'viewer: read only · manager: day-to-day edits · admin: everything incl. delete' },
            { key: 'password', label: 'Temporary password', type: 'text', required: true,
              help: 'At least 10 characters — share it securely and ask them to change it' }
          ],
          onSubmit: async (data, close) => {
            await api('createUser', data);
            await store.refresh();
            toast('User created', 'ok');
            close();
            refreshView();
          }
        })
      }, [icon('plus', 15), ' Add user']) }));
  }

  // ── connection + maintenance ────────────────────────────────────────────
  wrap.append(panel('Connection', el('div', {}, [
    el('div', { class: 'kv-list' }, [
      el('div', { class: 'kv' }, [
        el('span', { text: 'API endpoint' }),
        el('code', { class: 'mono-sm', text: config.apiUrl.slice(0, 60) + '…' })
      ]),
      // invoices, payments and the rest load a page at a time and are not kept
      el('div', { class: 'kv' }, [
        el('span', { text: 'Kept on this device' }),
        el('strong', { text: String(['properties', 'units', 'tenants', 'leases']
          .reduce((s, k) => s + store[k].length, 0)) + ' properties, units, tenants and leases' })
      ])
    ]),
    el('div', { class: 'btn-row' }, [
      el('button', {
        class: 'btn btn-ghost',
        onClick: async (e) => {
          e.target.disabled = true;
          try { const r = await store.act('refreshStatuses', {});
                toast(`${r.changes} row(s) synced`, 'ok'); }
          catch (err) { toast(err.message, 'danger'); }
          finally { e.target.disabled = false; }
        }
      }, [icon('refresh', 15), ' Re-sync statuses']),
      el('button', {
        class: 'btn btn-danger',
        onClick: async () => {
          const ok = await confirmDialog({
            title: 'Disconnect this browser?',
            message: 'Clears the saved API URL and session on this browser. Your data is untouched.',
            confirmLabel: 'Disconnect'
          });
          if (!ok) return;
          config.apiUrl = null; config.clearSession(); location.reload();
        }
      }, ['Disconnect']),
    ])
  ])));

  // ── audit trail ─────────────────────────────────────────────────────────
  // newest first, a page at a time from the server
  if (store.can('manager')) wrap.append(activityPanel());

  return wrap;
}

const ACTIVITY_PAGE = 40;

/** The audit trail, newest first, with the next page on request. */
function activityPanel() {
  const list = el('ul', { class: 'list list-compact' });
  const more = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', hidden: true }, ['Show more']);
  const count = el('span', { class: 'panel-count' });
  const status = el('p', { class: 'muted small' });
  let page = 0;

  const entry = (a) => el('li', { class: 'list-row' }, [
    el('span', {}, [
      el('code', { class: 'mono-sm', text: a.action }), ' ',
      el('span', { text: `${a.entity || ''} ${a.entity_id || ''}` })
    ]),
    el('small', { class: 'muted', text: `${a.actor} · ${String(a.timestamp).replace('T', ' ')}` })
  ]);

  async function next() {
    more.disabled = true;
    status.textContent = 'Loading…';
    try {
      const res = await store.page('activity', { page: page + 1, pageSize: ACTIVITY_PAGE });
      page = res.page;
      res.rows.forEach(a => list.append(entry(a)));
      count.textContent = String(res.total);
      status.textContent = res.total ? '' : 'Nothing recorded yet.';
      more.hidden = page * ACTIVITY_PAGE >= res.total;
    } catch (err) {
      status.textContent = 'Could not load the activity: ' + err.message;
    } finally {
      more.disabled = false;
    }
  }
  more.addEventListener('click', next);
  next();

  return el('section', { class: 'panel' }, [
    el('header', { class: 'panel-head' }, [el('h3', {}, ['Recent activity', count])]),
    el('div', { class: 'panel-body' }, [list, status, more])
  ]);
}
