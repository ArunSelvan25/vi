import { el, icon, toast, confirmDialog, badge } from '../ui.js';
import { store } from '../store.js';
import { api } from '../api.js';
import { config } from '../config.js';
import { openActionForm } from '../components/form.js';

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
    help: 'Pre-filled on a new lease, and charged once an invoice is overdue' },
  { key: 'reminder_days_before', label: 'Remind this many days before due', type: 'number' },
  { key: 'reminder_enabled', label: 'Scheduled reminders', type: 'select', options: ['true', 'false'],
    help: 'Requires a daily trigger on dailyReminderJob in Apps Script' },
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

  wrap.append(el('div', { class: 'view-head' }, [
    el('div', {}, [el('h1', { text: 'Settings' }),
      el('p', { class: 'muted', text: 'Signed in as ' + (user.name || user.phone) + ' · ' + user.role })])
  ]));

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
      control = el('input', { class: 'input', type: f.type === 'number' ? 'number' : 'text', value });
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
              for (const f of SETTING_FIELDS) {
                const v = controls[f.key].value;
                if (String(store.settings[f.key] ?? '') !== String(v)) {
                  await api('update', { table: 'Settings', id: f.key, data: { value: v } })
                    .catch(async () => api('create', { table: 'Settings', data: { key: f.key, value: v } }));
                }
              }
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
          { key: 'current', label: 'Current password', type: 'text', required: true },
          { key: 'next', label: 'New password', type: 'text', required: true, help: 'At least 8 characters' }
        ],
        onSubmit: async (data, close) => {
          await api('changePassword', data);
          toast('Password updated', 'ok');
          close();
        }
      })
    }, ['Change password'])
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
                         help: 'At least 8 characters. Share it securely; they can change it afterwards.' }],
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
                await store.refresh();
                toast('Role updated', 'ok');
                close();
                location.reload();
              }
            })
          }, ['Role']),
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
                location.reload();
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
              help: 'At least 8 characters — share it securely and ask them to change it' }
          ],
          onSubmit: async (data, close) => {
            await api('createUser', data);
            await store.refresh();
            toast('User created', 'ok');
            close();
            location.reload();
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
      el('div', { class: 'kv' }, [
        el('span', { text: 'Records cached' }),
        el('strong', { text: String(['properties', 'units', 'tenants', 'leases', 'invoices', 'payments',
          'maintenance', 'expenses', 'documents'].reduce((s, k) => s + store[k].length, 0)) })
      ])
    ]),
    el('div', { class: 'btn-row' }, [
      el('button', {
        class: 'btn btn-ghost',
        onClick: async (e) => {
          e.target.disabled = true;
          try { const r = await api('refreshStatuses', { withSnapshot: true }); await store.syncFrom(r);
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
            message: 'Clears the saved API URL and session. Your Google Sheet data is untouched.',
            confirmLabel: 'Disconnect'
          });
          if (!ok) return;
          config.apiUrl = null; config.clearSession(); location.reload();
        }
      }, ['Disconnect']),
    ])
  ])));

  // ── audit trail ─────────────────────────────────────────────────────────
  if (store.activity.length && store.can('manager')) {
    wrap.append(panel('Recent activity',
      el('ul', { class: 'list list-compact' }, store.activity.slice(0, 40).map(a =>
        el('li', { class: 'list-row' }, [
          el('span', {}, [
            el('code', { class: 'mono-sm', text: a.action }), ' ',
            el('span', { text: `${a.entity} ${a.entity_id || ''}` })
          ]),
          el('small', { class: 'muted', text: `${a.actor} · ${String(a.timestamp).replace('T', ' ')}` })
        ])))));
  }

  return wrap;
}
