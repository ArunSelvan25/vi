import { el, icon, badge, toast, copyText, initials, money, date, today, daysBetween, safeUrl, emptyState } from '../ui.js';
import { store, REMOTE } from '../store.js';
import { entities } from '../schema.js';

/**
 * Building blocks shared by every record page: the header, the details
 * sidebar, tabs, copyable values and links between records. Each record page
 * is assembled from these so they all read the same way.
 */

/** Collections that have a page of their own at #/<collection>/<id>. */
export const DETAIL_ENTITIES = new Set(['properties', 'units', 'tenants', 'leases', 'invoices',
                                        'payments', 'maintenance', 'expenses', 'documents']);

export function hrefFor(entity, id) {
  return '#/' + entity + '/' + encodeURIComponent(id);
}

/** Documents say what they belong to in words; this maps that to a collection. */
export const DOC_ENTITY = { Property: 'properties', Unit: 'units', Tenant: 'tenants', Lease: 'leases' };

// ── values ──────────────────────────────────────────────────────────────────

/**
 * A value with a copy button beside it. Clicking the value itself copies too,
 * unless it is a link (a phone number dials, an email opens the mail app).
 */
export function copyable(value, { label = 'Value', display, href, mono = false, compact = false } = {}) {
  if (value === '' || value === null || value === undefined) return el('span', { class: 'muted', text: '—' });
  const text = String(value);
  const btn = el('button', {
    type: 'button', class: 'copy-btn', title: 'Copy ' + label.toLowerCase(),
    'aria-label': 'Copy ' + label.toLowerCase()
  }, [icon('copy', 13)]);
  const shown = href
    ? el('a', { class: 'copyable-text', href, text: display ?? text, onClick: (e) => e.stopPropagation() })
    : el('span', { class: 'copyable-text', text: display ?? text });
  const wrap = el('span', {
    class: 'copyable' + (mono ? ' mono' : '') + (compact ? ' copyable-compact' : '') + (href ? '' : ' copy-all')
  }, [shown, btn]);

  let timer = null;
  const copy = async (e) => {
    e.stopPropagation();
    e.preventDefault();
    if (!await copyText(text)) { toast('Could not copy to the clipboard', 'danger'); return; }
    wrap.classList.add('copied');
    btn.replaceChildren(icon('check', 13));
    clearTimeout(timer);
    timer = setTimeout(() => { wrap.classList.remove('copied'); btn.replaceChildren(icon('copy', 13)); }, 1400);
    toast(label + ' copied', 'ok', 1600);
  };
  btn.addEventListener('click', copy);
  if (!href) shown.addEventListener('click', copy);
  return wrap;
}

/**
 * A link to another record, with a hover card. Falls back to plain text when
 * the record has no page, or is one of the small tables the browser keeps and
 * is not there (deleted, or not visible to this user). A growing table's row
 * is fetched when it is opened, so it is linked whether or not it has been
 * seen yet.
 */
export function ref(entity, id, { text, short = false, className } = {}) {
  if (!id) return el('span', { class: 'muted', text: '—' });
  const label = text ?? (short ? store.shortLabel(entity, id) : store.label(entity, id));
  if (!DETAIL_ENTITIES.has(entity) || (!REMOTE.has(entity) && !store.byId(entity, id))) return el('span', { text: label });
  return el('a', {
    class: 'ref' + (className ? ' ' + className : ''), href: hrefFor(entity, id),
    dataset: { hc: entity + ':' + id },
    // a link inside a clickable table row opens the link, not the row
    onClick: (e) => e.stopPropagation()
  }, [label]);
}

/**
 * Something drawn once its data arrives from the server: a spinner until then,
 * and the error with a retry if the request fails. A page (the default) says
 * so when it is ready, so the shell can title it; `inline` is for a panel or
 * tab inside a page.
 *
 * @param load   () => Promise of the data
 * @param render (data) => the node to show
 */
export function awaiting(load, render, { inline = false, label = 'Loading…' } = {}) {
  const host = el('div', { class: inline ? 'awaiting' : 'view awaiting', 'aria-busy': 'true' });
  const spin = () => {
    host.textContent = '';
    host.append(el('div', { class: 'loading' }, [el('div', { class: 'spinner' }), el('span', { text: label })]));
  };
  const run = () => {
    spin();
    Promise.resolve().then(load).then((data) => {
      // gone already: the reader moved on before it arrived
      if (!host.parentNode) return;
      const node = render(data);
      host.replaceWith(node);
      if (!inline) document.dispatchEvent(new CustomEvent('view:ready'));
    }).catch((err) => {
      if (!host.parentNode) return;
      host.removeAttribute('aria-busy');
      host.textContent = '';
      host.append(el('div', { class: 'load-error' }, [
        el('p', { class: 'form-error', text: 'Could not load this: ' + err.message }),
        el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onClick: () => { host.setAttribute('aria-busy', 'true'); run(); } }, ['Try again'])
      ]));
    });
  };
  run();
  return host;
}

/** Initials in a circle for people, an icon tile for things. */
export function avatar({ name, iconName, size = 'lg', tone } = {}) {
  const cls = 'avatar-tile avatar-' + size + (tone ? ' tone-' + tone : '') + (name ? ' avatar-person' : '');
  return el('div', { class: cls, 'aria-hidden': 'true' },
    name ? [initials(name)] : [icon(iconName || 'file', size === 'lg' ? 24 : 18)]);
}

/** One schema field of a row, rendered for reading rather than editing. */
export function fieldValue(entity, field, row) {
  const v = row[field.key];
  if (v === '' || v === null || v === undefined) return null;
  if (field.key === 'id') return copyable(v, { label: entities[entity].singular + ' ID', mono: true });
  switch (field.type) {
    case 'ref': return ref(field.optionsFrom, v);
    case 'money': return money(v);
    case 'date': return date(v);
    case 'email': return copyable(v, { label: 'Email', href: 'mailto:' + v });
    case 'tel': return copyable(v, { label: 'Phone', href: 'tel:' + String(v).replace(/\s+/g, '') });
    case 'url': {
      const href = safeUrl(v);
      return href
        ? el('span', { class: 'inline-actions' }, [
            el('a', { class: 'link', href, target: '_blank', rel: 'noopener noreferrer' }, ['Open ', icon('external', 12)]),
            copyable(href, { label: 'Link', display: 'Copy link', compact: true })
          ])
        : String(v);
    }
    case 'textarea': return el('span', { class: 'prewrap', text: String(v) });
    default:
      if (field.key === 'status' || field.key === 'priority') return badge(v);
      if (['reference', 'id_number', 'gstin', 'entity_id'].includes(field.key)) {
        return copyable(v, { label: field.label, mono: true });
      }
      return String(v);
  }
}

// ── layout ──────────────────────────────────────────────────────────────────

/**
 * A record page: breadcrumbs, a header card, an optional stat strip, and a
 * main column beside a details sidebar.
 *
 * The header keeps the `view-head` class so the sticky topbar title knows when
 * the page's own heading has scrolled out of view.
 */
export function detailPage({ crumbs = [], kind, title, badges = [], subtitle, meta = [], lead,
                             actions = [], stats, main, aside }) {
  return el('div', { class: 'view detail' }, [
    el('nav', { class: 'crumbs', 'aria-label': 'Breadcrumb' }, crumbs.flatMap((c, i) => [
      i ? el('span', { class: 'crumb-sep', 'aria-hidden': 'true', text: '/' }) : null,
      c.href
        ? el('a', { href: c.href, text: c.label })
        : el('span', { 'aria-current': 'page', text: c.label })
    ])),
    el('header', { class: 'view-head detail-head' }, [
      el('div', { class: 'detail-ident' }, [
        lead || null,
        el('div', { class: 'detail-ident-copy' }, [
          kind ? el('span', { class: 'detail-kind', text: kind }) : null,
          el('div', { class: 'detail-title' }, [el('h1', { text: title }), ...badges.filter(Boolean)]),
          subtitle ? el('p', { class: 'detail-sub' }, [].concat(subtitle)) : null,
          meta.filter(Boolean).length
            ? el('div', { class: 'detail-meta' }, meta.filter(Boolean).map(m => el('span', { class: 'detail-meta-item' }, [].concat(m))))
            : null
        ])
      ]),
      actions.filter(Boolean).length ? el('div', { class: 'head-actions' }, actions.filter(Boolean)) : null
    ]),
    stats || null,
    el('div', { class: 'detail-layout' + (aside ? '' : ' no-aside') }, [
      el('div', { class: 'detail-main' }, [].concat(main).filter(Boolean)),
      aside ? el('aside', { class: 'detail-aside' }, [].concat(aside).filter(Boolean)) : null
    ])
  ]);
}

export function stat(label, value, tone, sub) {
  return el('div', { class: 'stat' + (tone ? ' stat-' + tone : '') }, [
    el('span', { class: 'stat-label', text: label }),
    el('strong', { class: 'stat-value', text: value }),
    sub ? el('span', { class: 'stat-sub', text: sub }) : null
  ]);
}

export function statRow(stats) {
  return el('div', { class: 'stat-row' }, stats.filter(Boolean));
}

export function panel(title, body, { count, action, flush = false, className } = {}) {
  return el('section', { class: 'panel' + (className ? ' ' + className : '') }, [
    el('header', { class: 'panel-head' }, [
      el('h3', {}, [title, count !== undefined ? el('span', { class: 'panel-count', text: String(count) }) : null]),
      action || null
    ]),
    el('div', { class: 'panel-body' + (flush ? ' flush' : '') }, [body])
  ]);
}

/**
 * The label-over-value list in the sidebar. Rows with nothing to show are
 * left out, so a sparse record does not read as a column of dashes.
 */
export function props(rows) {
  const items = rows.filter(r => r && r[1] !== null && r[1] !== undefined && r[1] !== '');
  if (!items.length) return el('p', { class: 'muted', text: 'Nothing recorded.' });
  return el('dl', { class: 'props' }, items.map(([label, value]) =>
    el('div', { class: 'prop' }, [
      el('dt', { text: label }),
      el('dd', {}, [value instanceof Node ? value : String(value)])
    ])));
}

/** Every field of a row, in schema order — the sidebar for simpler records. */
export function schemaProps(entity, row, { skip = [] } = {}) {
  return props(entities[entity].fields
    .filter(f => !skip.includes(f.key))
    .map(f => [f.label.replace(/\s*\(.*\)$/, ''), fieldValue(entity, f, row)]));
}

/**
 * Small label/value pairs laid out in a grid inside a panel. Each row is
 * [label, value, tone?, wide?]; a wide one (an email address) takes the full
 * width rather than breaking mid-word.
 */
export function facts(rows) {
  return el('div', { class: 'facts' }, rows.filter(r => r && r[1] !== null && r[1] !== undefined && r[1] !== '')
    .map(([label, value, tone, wide]) => el('div', { class: 'fact' + (tone ? ' fact-' + tone : '') + (wide ? ' fact-wide' : '') }, [
      el('span', { text: label }),
      el('strong', {}, [value instanceof Node ? value : String(value)])
    ])));
}

export function notice(message, tone = 'warn', action) {
  return el('div', { class: 'notice notice-' + tone + ' notice-row' }, [
    icon(tone === 'ok' ? 'check' : 'alert', 16),
    el('span', { class: 'notice-text' }, [].concat(message)),
    action || null
  ]);
}

// ── tabs ────────────────────────────────────────────────────────────────────

/**
 * Tabs whose panels are built the first time they are opened. The open tab is
 * written to the address with replaceState — so a refresh, or coming back
 * after a save, lands on the same tab — without triggering a re-render.
 *
 * @param base the record's own address, e.g. "#/tenants/TNT-00001"
 * @param urlFor instead of base, the full address for a tab — for a page that
 *   keeps more than the tab in its address
 */
export function tabs(defs, { active, base, urlFor } = {}) {
  const list = defs.filter(Boolean);
  const bar = el('div', { class: 'tabs', role: 'tablist' });
  const host = el('div', { class: 'tab-panels' });
  const built = new Map();
  const buttons = new Map();

  function select(key, { focus = false, write = true } = {}) {
    const def = list.find(d => d.key === key) || list[0];
    for (const [k, b] of buttons) {
      const on = k === def.key;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
      if (on && bar.isConnected) b.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    for (const [k, p] of built) p.hidden = k !== def.key;
    if (!built.has(def.key)) {
      const p = el('div', { class: 'tab-panel', role: 'tabpanel', id: 'tab-' + def.key }, [def.render()]);
      built.set(def.key, p);
      host.append(p);
    }
    const url = urlFor ? urlFor(def.key)
      : base ? base + (def.key === list[0].key ? '' : '?tab=' + def.key) : null;
    if (write && url && location.hash !== url) history.replaceState(history.state, '', url);
  }

  list.forEach((d, i) => {
    const b = el('button', {
      type: 'button', class: 'tab', role: 'tab', 'aria-controls': 'tab-' + d.key,
      onClick: () => select(d.key),
      onKeydown: (e) => {
        const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        if (!step) return;
        e.preventDefault();
        select(list[(i + step + list.length) % list.length].key, { focus: true });
      }
    }, [d.label, d.count !== undefined ? el('span', { class: 'tab-count', text: String(d.count) }) : null]);
    buttons.set(d.key, b);
    bar.append(b);
  });

  // fade whichever edge has more tabs beyond it, so a cut-off tab reads as
  // "scroll for more" rather than as a rendering fault
  const edges = () => {
    bar.classList.toggle('fade-start', bar.scrollLeft > 1);
    bar.classList.toggle('fade-end', bar.scrollLeft + bar.clientWidth < bar.scrollWidth - 1);
  };
  bar.addEventListener('scroll', edges, { passive: true });
  if ('ResizeObserver' in window) new ResizeObserver(edges).observe(bar);

  select(active, { write: false });
  const node = el('div', { class: 'detail-tabs' }, [bar, host]);
  return { el: node, select: (key) => { select(key); bar.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } };
}

// ── pieces used on several pages ────────────────────────────────────────────

const TONE_OF_STATUS = { Paid: 'ok', Partial: 'warn', Unpaid: 'warn', Overdue: 'danger', Void: 'muted', Draft: 'muted' };

/** A compact, linked list of records — the "recent" lists on an overview. */
export function recordList(rows, render, { empty = 'Nothing yet.', limit } = {}) {
  const shown = limit ? rows.slice(0, limit) : rows;
  if (!shown.length) return el('p', { class: 'muted pad', text: empty });
  return el('div', { class: 'rec-list' }, shown.map(render));
}

export function invoiceRow(inv) {
  const period = inv.period_start ? date(inv.period_start) + ' – ' + date(inv.period_end) : 'Due ' + date(inv.due_date);
  return el('a', { class: 'rec-row', href: hrefFor('invoices', inv.id) }, [
    el('span', { class: 'rec-icon tone-' + (TONE_OF_STATUS[inv.status] || 'muted') }, [icon('receipt', 15)]),
    el('span', { class: 'rec-main' }, [
      el('strong', {}, [el('span', { class: 'mono', text: inv.id }), ' · ' + (inv.type || 'Invoice')]),
      el('small', { class: 'muted', text: period })
    ]),
    el('span', { class: 'rec-side' }, [
      el('strong', { class: 'num', text: money(inv.total || inv.amount) }),
      Number(inv.balance) > 0 && !['Void', 'Draft'].includes(inv.status)
        ? el('small', { class: 'muted', text: money(inv.balance) + ' due' })
        : null
    ]),
    badge(inv.status)
  ]);
}

export function paymentRow(p) {
  const deposit = store.isDepositPayment(p);  // marked by the server
  return el('a', { class: 'rec-row', href: hrefFor('payments', p.id) }, [
    el('span', { class: 'rec-icon tone-ok' }, [icon('card', 15)]),
    el('span', { class: 'rec-main' }, [
      el('strong', {}, [money(p.amount)]),
      el('small', { class: 'muted', text: [p.method, p.reference].filter(Boolean).join(' · ') || 'Payment' })
    ]),
    el('span', { class: 'rec-side' }, [
      el('span', { class: 'mono small', text: p.invoice_id || 'On account' }),
      el('small', { class: 'muted', text: date(p.payment_date) })
    ]),
    deposit ? badge('Deposit', 'info') : null
  ]);
}

export function leaseRow(l) {
  return el('a', { class: 'rec-row', href: hrefFor('leases', l.id) }, [
    el('span', { class: 'rec-icon tone-' + ({ Active: 'ok', Upcoming: 'info' }[l.status] || 'muted') }, [icon('file', 15)]),
    el('span', { class: 'rec-main' }, [
      el('strong', {}, [el('span', { class: 'mono', text: l.id }), ' · ' + store.label('tenants', l.tenant_id)]),
      el('small', { class: 'muted', text: store.label('units', l.unit_id) + ' · ' + date(l.start_date) + ' – ' + date(l.end_date) })
    ]),
    el('span', { class: 'rec-side' }, [
      el('strong', { class: 'num', text: money(store.currentRent(l, l.status === 'Active' ? today() : (l.end_date || today()))) }),
      el('small', { class: 'muted', text: '/ month' })
    ]),
    badge(l.status)
  ]);
}

export function ticketRow(m) {
  return el('a', { class: 'rec-row', href: hrefFor('maintenance', m.id) }, [
    el('span', { class: 'rec-icon tone-' + (['Resolved', 'Closed'].includes(m.status) ? 'muted' : 'warn') }, [icon('wrench', 15)]),
    el('span', { class: 'rec-main' }, [
      el('strong', { text: m.title }),
      el('small', { class: 'muted', text: [m.category, 'reported ' + date(m.reported_date)].filter(Boolean).join(' · ') })
    ]),
    el('span', { class: 'rec-side' }, [badge(m.priority)]),
    badge(m.status)
  ]);
}

export function documentRow(d) {
  const expired = d.expiry_date && d.expiry_date < today();
  const soon = d.expiry_date && !expired && daysBetween(today(), d.expiry_date) <= 60;
  return el('a', { class: 'rec-row', href: hrefFor('documents', d.id) }, [
    el('span', { class: 'rec-icon' }, [icon('folder', 15)]),
    el('span', { class: 'rec-main' }, [
      el('strong', { text: d.title }),
      el('small', { class: 'muted', text: [d.category, d.expiry_date ? 'expires ' + date(d.expiry_date) : null].filter(Boolean).join(' · ') })
    ]),
    expired ? badge('Expired', 'danger') : soon ? badge('Expiring soon', 'warn') : null
  ]);
}

/** Where a lease is in its term, as a bar with the dates at either end. */
export function termProgress(lease) {
  const start = lease.start_date, end = lease.end_date;
  if (!start) return el('p', { class: 'muted', text: 'No start date recorded.' });
  if (!end) {
    return el('div', { class: 'term' }, [
      el('div', { class: 'term-dates' }, [el('span', { text: date(start) }), el('span', { text: 'Open-ended' })]),
      el('div', { class: 'term-track' }, [el('div', { class: 'term-fill', style: 'width:100%' })]),
      el('p', { class: 'term-note', text: `Running for ${daysBetween(start, today())} days` })
    ]);
  }
  const total = Math.max(1, daysBetween(start, end));
  const done = Math.min(total, Math.max(0, daysBetween(start, today())));
  const left = daysBetween(today(), end);
  const pct = Math.round(done / total * 100);
  const ended = lease.status === 'Terminated' || lease.status === 'Expired' || left < 0;
  const tone = ended ? 'muted' : left <= 30 ? 'danger' : left <= 60 ? 'warn' : '';
  const note = lease.status === 'Upcoming' ? `Starts in ${daysBetween(today(), start)} days`
    : lease.status === 'Terminated' ? 'Terminated'
    : left < 0 ? `Ended ${-left} days ago`
    : left === 0 ? 'Ends today'
    : `${left} day${left === 1 ? '' : 's'} left · ${pct}% of the term served`;
  return el('div', { class: 'term' }, [
    el('div', { class: 'term-dates' }, [el('span', { text: date(start) }), el('span', { text: date(end) })]),
    el('div', { class: 'term-track', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100',
                'aria-valuenow': String(pct), 'aria-label': 'Lease term elapsed' },
       [el('div', { class: 'term-fill' + (tone ? ' tone-' + tone : ''), style: `width:${pct}%` })]),
    el('p', { class: 'term-note', text: note })
  ]);
}

/**
 * A card that stands for another record — "Current tenant", "Unit" — and
 * opens it. The body can hold its own links, so the card is not one big
 * anchor; the title is the link.
 */
export function entityCard({ entity, id, lead, title, sub, rows = [], footer }) {
  return el('div', { class: 'entity-card' }, [
    el('div', { class: 'entity-card-head' }, [
      lead || null,
      el('div', { class: 'entity-card-title' }, [
        entity && id ? el('a', { class: 'ref ref-strong', href: hrefFor(entity, id), dataset: { hc: entity + ':' + id } }, [title])
                     : el('strong', { text: title }),
        sub ? el('small', { class: 'muted' }, [].concat(sub)) : null
      ]),
      entity && id
        ? el('a', { class: 'icon-btn', href: hrefFor(entity, id), title: 'Open', 'aria-label': 'Open ' + title }, [icon('arrow', 16)])
        : null
    ]),
    rows.length ? facts(rows) : null,
    footer || null
  ]);
}

/**
 * What happened, newest first. Each event: { date, icon, tone, title, meta }.
 * Anything dated in the future is left out — this is history, not a plan.
 */
export function timeline(events, { limit = 30, empty = 'No activity yet.' } = {}) {
  const t = today();
  const rows = events
    .filter(e => e.date && String(e.date).slice(0, 10) <= t)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || (b.order || 0) - (a.order || 0))
    .slice(0, limit);
  if (!rows.length) return emptyState(empty, null, 'clock');
  return el('ol', { class: 'timeline' }, rows.map(e =>
    el('li', { class: 'tl-item' }, [
      el('span', { class: 'tl-dot tone-' + (e.tone || 'muted') }, [icon(e.icon || 'clock', 14)]),
      el('div', { class: 'tl-body' }, [
        el('div', { class: 'tl-title' }, [].concat(e.title)),
        e.meta ? el('div', { class: 'tl-meta' }, [].concat(e.meta)) : null
      ]),
      el('time', { class: 'tl-date', datetime: String(e.date).slice(0, 10), text: date(e.date) })
    ])));
}

/** The events a set of records adds to a timeline. */
export function eventsFor({ leases = [], invoices = [], payments = [], tickets = [] }) {
  const out = [];
  for (const l of leases) {
    out.push({ date: l.start_date, icon: 'file', tone: 'info', order: 0,
               title: ['Lease ', ref('leases', l.id, { text: l.id }), ' started'],
               meta: [ref('tenants', l.tenant_id), ' · ', ref('units', l.unit_id)] });
    if (l.end_date && (l.status === 'Expired' || l.status === 'Terminated')) {
      out.push({ date: l.end_date, icon: 'file', tone: 'muted', order: 3,
                 title: ['Lease ', ref('leases', l.id, { text: l.id }), l.status === 'Terminated' ? ' terminated' : ' ended'] });
    }
  }
  for (const i of invoices) {
    if (i.status === 'Draft') continue;
    out.push({ date: i.issue_date || i.due_date, icon: 'receipt', tone: i.status === 'Void' ? 'muted' : 'info', order: 1,
               title: ['Invoice ', ref('invoices', i.id, { text: i.id }), ' issued · ', el('strong', { text: money(i.total || i.amount) })],
               meta: [i.type || 'Invoice', i.status === 'Void' ? ' · voided' : ' · due ' + date(i.due_date)] });
  }
  for (const p of payments) {
    out.push({ date: p.payment_date, icon: 'card', tone: 'ok', order: 2,
               title: ['Payment ', ref('payments', p.id, { text: money(p.amount) }), ' received'],
               meta: [[p.method, p.reference].filter(Boolean).join(' · '),
                      p.invoice_id ? [' → ', ref('invoices', p.invoice_id, { text: p.invoice_id })] : null].flat().filter(Boolean) });
  }
  for (const m of tickets) {
    out.push({ date: m.reported_date, icon: 'wrench', tone: 'warn', order: 1,
               title: ['Ticket ', ref('maintenance', m.id, { text: m.title }), ' reported'],
               meta: [m.priority ? m.priority + ' priority' : 'Maintenance'] });
    if (m.completed_date) {
      out.push({ date: m.completed_date, icon: 'check', tone: 'ok', order: 2,
                 title: ['Ticket ', ref('maintenance', m.id, { text: m.title }), ' completed'],
                 meta: Number(m.cost) ? ['Cost ' + money(m.cost)] : null });
    }
  }
  return out;
}
