import { el, icon, badge, money, date, today, daysBetween, initials } from '../ui.js';
import { store, REMOTE } from '../store.js';
import { entities, rentDayLabel } from '../schema.js';
import { hrefFor } from './detail.js';

/**
 * Hover cards: rest the pointer on a link to a record (anything carrying
 * data-hc="<collection>:<id>") and a card with its key facts appears, so a
 * name in a table can be checked without leaving the page.
 *
 * One delegated listener serves the whole app. The card is only offered to a
 * real pointer — on a touch screen a tap simply follows the link.
 */

const SHOW_DELAY = 350;
const HIDE_DELAY = 180;

let card = null;
let anchor = null;
/** The link a card is on its way for, so a slow fetch does not open a card the pointer has left. */
let pending = null;
let showTimer = 0;
let hideTimer = 0;
let installed = false;

const OPEN = ['Unpaid', 'Partial', 'Overdue'];

const row = (label, value) => (value === null || value === undefined || value === '' ? null
  : el('div', { class: 'hc-row' }, [el('span', { text: label }), el('strong', {}, [value instanceof Node ? value : String(value)])]));

const tile = (iconName) => el('div', { class: 'avatar-tile avatar-sm' }, [icon(iconName, 16)]);
const person = (name) => el('div', { class: 'avatar-tile avatar-sm avatar-person' }, [initials(name)]);

/** Per collection: what the card says. Each returns { lead, title, sub, badge, rows }. */
const CARDS = {
  tenants(t) {
    const lease = store.leases.find(l => l.tenant_id === t.id && l.status === 'Active');
    const owed = store.owedBy('tenants', t.id);
    return {
      lead: person(t.full_name), title: t.full_name,
      sub: lease ? store.label('units', lease.unit_id) : 'No active lease',
      badge: t.status,
      rows: [
        row('Phone', t.phone), row('Email', t.email),
        lease ? row('Rent', money(store.currentRent(lease)) + ' / mo') : null,
        row('Outstanding', el('span', { class: owed > 0 ? 'neg' : 'pos', text: money(owed) }))
      ]
    };
  },
  properties(p) {
    const units = store.unitsOfProperty(p.id);
    const occupied = units.filter(u => u.status === 'Occupied').length;
    const roll = store.leases.filter(l => l.property_id === p.id && l.status === 'Active')
      .reduce((s, l) => s + store.currentRent(l), 0);
    return {
      lead: tile('building'), title: p.name,
      sub: [p.type, p.city].filter(Boolean).join(' · '), badge: p.status,
      rows: [
        row('Units', `${occupied} of ${units.length} occupied`),
        row('Rent roll', money(roll) + ' / mo'),
        row('Outstanding', money(store.owedBy('properties', p.id))),
        p.owner_name ? row('Owner', p.owner_name) : null
      ]
    };
  },
  units(u) {
    const lease = store.activeLeaseForUnit(u.id);
    const tenant = lease && store.byId('tenants', lease.tenant_id);
    return {
      lead: tile('grid'), title: u.unit_number,
      sub: store.label('properties', u.property_id), badge: u.status,
      rows: [
        row('Layout', [u.bedrooms ? u.bedrooms + ' BR' : null, u.area_sqft ? u.area_sqft + ' sq ft' : null, u.furnishing]
          .filter(Boolean).join(' · ')),
        row('Tenant', tenant ? tenant.full_name : 'Vacant'),
        row('Rent', money(lease ? store.currentRent(lease) : u.rent_amount) + ' / mo'),
        lease?.end_date ? row('Lease ends', date(lease.end_date)) : null
      ]
    };
  },
  leases(l) {
    const left = l.end_date ? daysBetween(today(), l.end_date) : null;
    return {
      lead: tile('file'), title: 'Lease ' + l.id,
      sub: store.label('tenants', l.tenant_id), badge: l.status,
      rows: [
        row('Unit', store.label('units', l.unit_id)),
        row('Term', `${date(l.start_date)} – ${date(l.end_date)}`),
        row('Rent', money(store.currentRent(l)) + ' / mo' + (l.frequency && l.frequency !== 'Monthly' ? ` · billed ${l.frequency.toLowerCase()}` : '')),
        l.rent_day ? row('Rent day', rentDayLabel(l.rent_day)) : null,
        row('Deposit held', money(store.depositLedger(l).held)),
        l.status === 'Active' && left !== null ? row('Remaining', left >= 0 ? `${left} days` : 'Ended') : null
      ]
    };
  },
  invoices(i) {
    const late = OPEN.includes(i.status) && i.due_date && i.due_date < today();
    return {
      lead: tile('receipt'), title: 'Invoice ' + i.id,
      sub: store.label('tenants', i.tenant_id), badge: i.status,
      rows: [
        row('Type', i.type),
        i.period_start ? row('Period', `${date(i.period_start)} – ${date(i.period_end)}`) : null,
        row('Total', money(i.total || i.amount)),
        row('Balance', el('span', { class: Number(i.balance) > 0 ? 'neg' : '', text: money(i.balance) })),
        row('Due', date(i.due_date) + (late ? ` · ${daysBetween(i.due_date, today())} days late` : ''))
      ]
    };
  },
  payments(p) {
    return {
      lead: tile('card'), title: money(p.amount),
      sub: 'Payment from ' + store.label('tenants', p.tenant_id),
      badge: store.isDepositPayment(p) ? 'Deposit' : null,
      rows: [
        row('Date', date(p.payment_date)),
        row('Method', p.method), row('Reference', p.reference),
        row('Invoice', p.invoice_id || 'On account')
      ]
    };
  },
  maintenance(m) {
    return {
      lead: tile('wrench'), title: m.title,
      sub: store.label('units', m.unit_id) !== '—' ? store.label('units', m.unit_id) : store.label('properties', m.property_id),
      badge: m.status,
      rows: [row('Priority', m.priority), row('Category', m.category), row('Reported', date(m.reported_date)),
             Number(m.cost) ? row('Cost', money(m.cost)) : null, row('Vendor', m.vendor_name)]
    };
  },
  expenses(e) {
    return {
      lead: tile('wallet'), title: money(e.amount),
      sub: e.description || e.category, badge: null,
      rows: [row('Date', date(e.date)), row('Category', e.category), row('Property', store.label('properties', e.property_id)),
             row('Vendor', e.vendor)]
    };
  },
  documents(d) {
    return {
      lead: tile('folder'), title: d.title, sub: d.category, badge: null,
      rows: [row('Linked to', d.entity_type ? `${d.entity_type} ${d.entity_id || ''}`.trim() : null),
             row('Issued', d.issue_date ? date(d.issue_date) : null), row('Expires', d.expiry_date ? date(d.expiry_date) : null)]
    };
  }
};

function build(entity, id) {
  const record = store.byId(entity, id);
  const make = CARDS[entity];
  if (!record || !make) return null;
  const c = make(record);
  return el('div', { class: 'hc' }, [
    el('div', { class: 'hc-head' }, [
      c.lead,
      el('div', { class: 'hc-title' }, [
        el('strong', { text: c.title }),
        c.sub ? el('small', { class: 'muted', text: c.sub }) : null
      ]),
      c.badge ? badge(c.badge, c.badge === 'Deposit' ? 'info' : undefined) : null
    ]),
    el('div', { class: 'hc-body' }, c.rows.filter(Boolean)),
    el('a', { class: 'hc-foot', href: hrefFor(entity, id) }, [
      el('span', { class: 'mono', text: id }),
      el('span', { class: 'hc-open' }, ['View ' + entities[entity].singular.toLowerCase(), icon('arrow', 13)])
    ])
  ]);
}

function place(target) {
  const r = target.getBoundingClientRect();
  const w = card.offsetWidth, h = card.offsetHeight;
  const vw = document.documentElement.clientWidth, vh = window.innerHeight;
  const gap = 8;
  let top = r.bottom + gap;
  if (top + h > vh - gap && r.top - gap - h > gap) top = r.top - gap - h;
  const left = Math.min(Math.max(gap, r.left), vw - w - gap);
  card.style.top = Math.round(top) + 'px';
  card.style.left = Math.round(Math.max(gap, left)) + 'px';
}

async function show(target) {
  const [entity, ...rest] = String(target.dataset.hc || '').split(':');
  const id = rest.join(':');
  // a growing table's row may not have been fetched on this page yet
  if (REMOTE.has(entity) && !store.byId(entity, id)) {
    try { await store.fetchRow(entity, id); } catch (e) { return; }
    // the pointer may have moved on while it loaded
    if (!target.isConnected || pending !== target) return;
  }
  const content = build(entity, id);
  if (!content) return;
  if (!card) {
    card = el('div', { class: 'hovercard', role: 'tooltip', id: 'hovercard' });
    document.body.append(card);
  }
  card.replaceChildren(content);
  anchor = target;
  target.setAttribute('aria-describedby', 'hovercard');
  card.classList.add('open');
  place(target);
}

export function hideHovercard() {
  clearTimeout(showTimer);
  clearTimeout(hideTimer);
  if (anchor) anchor.removeAttribute('aria-describedby');
  anchor = null;
  if (card) card.classList.remove('open');
}

function scheduleShow(target) {
  clearTimeout(hideTimer);
  if (anchor === target) return;
  clearTimeout(showTimer);
  // moving straight from one link to another swaps the card at once
  const delay = card && card.classList.contains('open') ? 60 : SHOW_DELAY;
  pending = target;
  showTimer = setTimeout(() => { if (target.isConnected) show(target); }, delay);
}

function scheduleHide() {
  pending = null;
  clearTimeout(showTimer);
  clearTimeout(hideTimer);
  hideTimer = setTimeout(hideHovercard, HIDE_DELAY);
}

export function installHovercards() {
  if (installed) return;
  installed = true;

  // Pointer events say what did the pointing. A tap on a touch screen also
  // fires hover events, but a card that pops up under a finger just gets in
  // the way — so only a mouse or a pen opens one.
  const hovering = (e) => e.pointerType === 'mouse' || e.pointerType === 'pen';
  document.addEventListener('pointerover', (e) => {
    if (!hovering(e)) return;
    const target = e.target.closest?.('[data-hc]');
    if (target) { scheduleShow(target); return; }
    if (card && card.contains(e.target)) clearTimeout(hideTimer);
  });
  document.addEventListener('pointerout', (e) => {
    if (!hovering(e)) return;
    const to = e.relatedTarget;
    const from = e.target.closest?.('[data-hc]');
    if (from && !(to && from.contains(to)) && !(to && card && card.contains(to))) scheduleHide();
    else if (card && card.contains(e.target) && !(to && (card.contains(to) || to.closest?.('[data-hc]') === anchor))) scheduleHide();
  });
  // keyboard users get the same card when they tab onto a link
  document.addEventListener('focusin', (e) => {
    const target = e.target.closest?.('[data-hc]');
    if (target && target.matches(':focus-visible')) scheduleShow(target);
  });
  document.addEventListener('focusout', (e) => {
    if (e.target.closest?.('[data-hc]')) scheduleHide();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideHovercard(); });
  document.addEventListener('click', (e) => { if (!card || !card.contains(e.target)) hideHovercard(); });
  window.addEventListener('scroll', hideHovercard, { capture: true, passive: true });
  window.addEventListener('hashchange', hideHovercard);
  window.addEventListener('resize', hideHovercard);
}
