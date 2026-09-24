import { el, icon, badge, money, date, debounce } from '../ui.js';
import { store } from '../store.js';
import { entities } from '../schema.js';
import { hrefFor, DOC_ENTITY } from './detail.js';

/**
 * One search box for the whole app, opened from the top bar, with "/" or with
 * Ctrl/⌘ K. Properties, units, tenants and leases are held whole in the
 * browser, so they match as you type. Invoices, payments, tickets, expenses and
 * documents are asked of the server, a moment after typing stops. Screens are
 * found by name too, and a module's name lists that module.
 */

/** The fewest characters the server is asked about; the browser matches from one. */
const SERVER_MIN = 2;
/** Matches listed per module; "See all" opens the list, searched the same way. */
const PER_GROUP = 5;

const ICONS = { properties: 'building', units: 'grid', tenants: 'users', leases: 'file', invoices: 'receipt',
                payments: 'card', maintenance: 'wrench', expenses: 'wallet', documents: 'folder' };

/** Where each module's list lives, and so where "See all" goes. */
const LIST_OF = { invoices: 'billing', payments: 'billing?tab=payments' };

const seeAllHref = (entity, q) => {
  const base = LIST_OF[entity] || entity;
  return '#/' + base + (q ? (base.includes('?') ? '&' : '?') + 'q=' + encodeURIComponent(q) : '');
};

const lower = (v) => String(v ?? '').toLowerCase();
const digits = (v) => String(v ?? '').replace(/\D/g, '');

/**
 * Whether every word typed appears somewhere in `fields` — so "anita 101"
 * finds Anita Rao's lease on A-101. A number typed with spaces or dashes
 * still finds a phone number stored without them, and the other way round.
 */
function matches(fields, words, phoneDigits) {
  const hay = fields.map(lower).join(' \u0000 ');
  if (words.every(w => hay.includes(w))) return true;
  if (phoneDigits.length >= 4) return fields.some(f => digits(f).includes(phoneDigits));
  return false;
}

/** A row whose title starts with what was typed comes first; then A–Z. */
function rank(items, q) {
  return items
    .map(item => ({ item, first: lower(item.title).startsWith(q) ? 0 : 1 }))
    .sort((a, b) => a.first - b.first || a.item.title.localeCompare(b.item.title))
    .map(x => x.item);
}

const statusBadge = (row) => (row.status ? badge(row.status) : null);
const joinSub = (...parts) => parts.filter(p => p !== null && p !== undefined && p !== '' && p !== '—').join(' · ');

/** How each module's rows read in the results: a title, a line under it, a badge. */
const DESCRIBE = {
  properties: (p) => ({ title: p.name || p.id, sub: joinSub(p.id, p.city, p.type), badge: statusBadge(p) }),
  units: (u) => ({ title: store.label('units', u.id), sub: joinSub(u.id, u.bedrooms ? u.bedrooms + ' BHK' : '',
                   Number(u.rent_amount) ? money(u.rent_amount) : ''), badge: statusBadge(u) }),
  tenants: (t) => {
    const home = store.homeOf(t.id);
    return { title: t.full_name || t.id, sub: joinSub(t.id, t.phone, home ? store.label('units', home.lease.unit_id) : ''),
             badge: statusBadge(t) };
  },
  leases: (l) => ({ title: store.label('leases', l.id), sub: joinSub(store.label('units', l.unit_id),
                    l.start_date ? date(l.start_date) + ' – ' + (l.end_date ? date(l.end_date) : 'open') : ''),
                    badge: statusBadge(l) }),
  invoices: (i) => ({ title: i.id + (i.type ? ' · ' + i.type : ''), sub: joinSub(store.label('tenants', i.tenant_id),
                      i.due_date ? 'due ' + date(i.due_date) : '', money(i.total || i.amount)), badge: statusBadge(i) }),
  payments: (p) => ({ title: p.id + ' · ' + money(p.amount), sub: joinSub(store.label('tenants', p.tenant_id),
                      p.payment_date ? date(p.payment_date) : '', p.method, p.reference), badge: null }),
  maintenance: (m) => ({ title: m.title || m.id, sub: joinSub(m.id, m.unit_id ? store.label('units', m.unit_id)
                         : store.label('properties', m.property_id), m.priority), badge: statusBadge(m) }),
  expenses: (e) => ({ title: e.description || e.category || e.id, sub: joinSub(e.id, e.category, money(e.amount),
                      e.date ? date(e.date) : ''), badge: null }),
  documents: (d) => {
    const owner = DOC_ENTITY[d.entity_type];
    return { title: d.title || d.id, sub: joinSub(d.id, d.category,
             owner && d.entity_id ? store.label(owner, d.entity_id) : ''), badge: null };
  }
};

/** The words a browser-held row is found by. */
const FIELDS = {
  properties: (p) => [p.id, p.name, p.type, p.status, p.city, p.state, p.country, p.address_line1, p.address_line2,
                      p.postal_code, p.owner_name],
  units: (u) => [u.id, u.unit_number, store.label('properties', u.property_id), u.status, u.floor, u.furnishing,
                 u.amenities, u.bedrooms ? u.bedrooms + ' bhk' : '', u.rent_amount],
  tenants: (t) => {
    const home = store.homeOf(t.id);
    return [t.id, t.full_name, t.phone, t.email, t.status, t.occupation, t.gstin, t.emergency_name, t.emergency_phone,
            home ? home.lease.id : '', home ? store.label('units', home.lease.unit_id) : ''];
  },
  leases: (l) => [l.id, l.status, l.frequency, store.label('tenants', l.tenant_id), store.label('units', l.unit_id),
                  store.label('properties', l.property_id), l.rent_amount, l.start_date, l.end_date,
                  l.start_date ? date(l.start_date) : '', l.end_date ? date(l.end_date) : '', l.deposit_status, l.notes,
                  ...store.occupantNames(l)]
};

const LOCAL = ['tenants', 'properties', 'units', 'leases'];
const REMOTE_ORDER = ['invoices', 'payments', 'maintenance', 'expenses', 'documents'];

/**
 * Words that name a module. A search that starts with one (or the first three
 * letters of one) lists that module — "lea" shows the leases — and the words
 * after it search only there: "lease anita", "invoice overdue", "ticket leak".
 */
const MODULE_WORDS = {
  tenants: ['tenants', 'tenant', 'people'],
  properties: ['properties', 'property', 'buildings'],
  units: ['units', 'unit', 'flats'],
  leases: ['leases', 'lease', 'agreements'],
  invoices: ['invoices', 'invoice', 'bills'],
  payments: ['payments', 'payment', 'receipts'],
  maintenance: ['maintenance', 'tickets', 'ticket', 'repairs'],
  expenses: ['expenses', 'expense'],
  documents: ['documents', 'document', 'docs', 'files']
};

function moduleNamed(word) {
  if (word.length < 3) return null;
  for (const [entity, names] of Object.entries(MODULE_WORDS)) if (names.some(n => n.startsWith(word))) return entity;
  return null;
}

/** Every screen, found by its name or what it holds. */
const PAGES = [
  { label: 'Dashboard', path: 'dashboard', icon: 'dashboard', words: ['home', 'overview'] },
  { label: 'Properties', path: 'properties', icon: 'building' },
  { label: 'Units', path: 'units', icon: 'grid' },
  { label: 'Tenants', path: 'tenants', icon: 'users' },
  { label: 'Leases', path: 'leases', icon: 'file' },
  { label: 'Billing', path: 'billing', icon: 'receipt', words: ['invoices', 'rent', 'bills'] },
  { label: 'Payments', path: 'billing?tab=payments', icon: 'card', words: ['receipts', 'collected'] },
  { label: 'Expenses', path: 'expenses', icon: 'wallet' },
  { label: 'Reports', path: 'reports', icon: 'chart', words: ['profit', 'arrears', 'yield', 'gst'] },
  { label: 'Maintenance', path: 'maintenance', icon: 'wrench', words: ['tickets', 'repairs'] },
  { label: 'Documents', path: 'documents', icon: 'folder', words: ['files'] },
  { label: 'Settings', path: 'settings', icon: 'settings', words: ['users', 'upi', 'organisation', 'reminders'] }
];

function pageHits(q) {
  return PAGES.filter(p => [p.label, ...(p.words || [])].some(w => lower(w).startsWith(q)))
    .slice(0, 3)
    .map(p => ({ href: '#/' + p.path, title: 'Go to ' + p.label, icon: p.icon }));
}

/** What was typed: the whole of it, and the module its first word names, with the words after it. */
function parse(raw) {
  const q = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  const words = q.split(' ').filter(Boolean);
  const scope = words.length ? moduleNamed(words[0]) : null;
  return { q, scope, rest: scope ? words.slice(1).join(' ') : q };
}

/** One browser-held module's matches for `text`; every row when `text` is empty. */
function localGroup(entity, text) {
  const words = text.split(' ').filter(Boolean);
  const phoneDigits = /^[\d\s+()-]+$/.test(text) ? digits(text) : '';
  const found = (store[entity] || []).filter(row => !words.length || matches(FIELDS[entity](row), words, phoneDigits));
  const items = rank(found.map(row => ({ href: hrefFor(entity, row.id), ...DESCRIBE[entity](row) })), text);
  return { entity, items: items.slice(0, PER_GROUP), total: items.length, query: text };
}

const remoteGroup = (entity, found, text) => ({
  entity, total: found.total, query: text,
  items: found.rows.map(row => ({ href: hrefFor(entity, row.id), ...DESCRIBE[entity](row) }))
});

let open = null;

/** Open the search, or bring it back to the front if it is already open. */
export function openSearch() {
  if (open) { open.focus(); return; }
  open = searchPanel();
}

function searchPanel() {
  const opener = document.activeElement;
  let seq = 0;
  let remote = { state: 'idle', groups: [] };

  const input = el('input', {
    class: 'global-search-input', type: 'search', placeholder: 'Search tenants, units, invoices, tickets…',
    autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Search everything',
    role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'global-search-results', 'aria-autocomplete': 'list'
  });
  const results = el('div', { class: 'global-search-results', id: 'global-search-results', role: 'listbox',
                              'aria-label': 'Search results' });
  const status = el('div', { class: 'sr-only', 'aria-live': 'polite' });

  const dialog = el('div', { class: 'global-search', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Search' }, [
    el('div', { class: 'global-search-bar' }, [
      icon('search', 18), input,
      el('button', { class: 'icon-btn', type: 'button', title: 'Close (Esc)', 'aria-label': 'Close search',
                     onClick: () => close() }, [icon('close', 18)])
    ]),
    results,
    el('div', { class: 'global-search-foot muted small' }, [
      el('span', {}, [el('kbd', { text: '↑' }), el('kbd', { text: '↓' }), ' to move']),
      el('span', {}, [el('kbd', { text: 'Enter' }), ' to open']),
      el('span', {}, [el('kbd', { text: 'Esc' }), ' to close'])
    ]),
    status
  ]);
  const backdrop = el('div', { class: 'global-search-backdrop', onMousedown: (e) => { if (e.target === backdrop) close(); } },
                      [dialog]);

  const hit = (item, extra = []) => el('a', { class: 'global-search-hit', href: item.href, role: 'option', tabindex: '-1',
                                              onClick: () => close({ restoreFocus: false }) }, [
    item.icon ? icon(item.icon, 16) : null,
    el('span', { class: 'global-search-hit-main' }, [
      el('strong', { text: item.title }),
      item.sub ? el('small', { class: 'muted', text: item.sub }) : null
    ]),
    item.badge, ...extra
  ]);

  function group({ entity, items, total, query }) {
    const def = entities[entity];
    return el('section', { class: 'global-search-group', 'aria-label': def.title }, [
      el('div', { class: 'global-search-head' }, [
        icon(ICONS[entity], 14), el('span', { text: def.title }),
        total ? el('span', { class: 'global-search-count', text: String(total) }) : null
      ]),
      ...items.map(item => hit(item)),
      total > items.length
        ? el('a', { class: 'global-search-hit global-search-all', href: seeAllHref(entity, query), role: 'option',
                    tabindex: '-1', onClick: () => close({ restoreFocus: false }) },
             [`See all ${total} in ${def.title}`, icon('arrow', 14)])
        : null
    ]);
  }

  const pagesGroup = (items) => el('section', { class: 'global-search-group', 'aria-label': 'Pages' }, [
    el('div', { class: 'global-search-head' }, [icon('arrow', 14), el('span', { text: 'Pages' })]),
    ...items.map(item => hit(item))
  ]);

  /** Whether the server has anything to be asked about this search. */
  const serverWanted = (p) => p.q.length >= SERVER_MIN || (p.scope && !LOCAL.includes(p.scope));

  function draw() {
    const p = parse(input.value);
    results.textContent = '';
    if (!p.q) {
      results.append(el('p', { class: 'global-search-empty muted',
        text: 'Search by name, phone, unit, ID, status, reference or description — or start with a module: "lease", "invoice overdue", "ticket leak".' }));
      status.textContent = '';
      return;
    }
    const pages = pageHits(p.q);
    if (pages.length) results.append(pagesGroup(pages));

    const shown = [];
    // the module the search starts with comes first
    if (p.scope && LOCAL.includes(p.scope)) shown.push(localGroup(p.scope, p.rest));
    if (p.scope && !LOCAL.includes(p.scope) && remote.state === 'done' && remote.scoped) shown.push(remote.scoped);
    shown.push(...LOCAL.filter(e => e !== p.scope).map(e => localGroup(e, p.q)));
    if (remote.state === 'done') shown.push(...remote.groups);
    shown.filter(g => g.total).forEach(g => results.append(group(g)));

    const asked = serverWanted(p);
    if (asked && remote.state === 'loading') {
      results.append(el('p', { class: 'global-search-note muted small', text: 'Searching invoices, payments, tickets, expenses and documents…' }));
    } else if (remote.state === 'error') {
      results.append(el('p', { class: 'global-search-note form-error', text: 'Could not search the rest: ' + remote.error }));
    }

    const count = pages.length + shown.reduce((n, g) => n + g.total, 0);
    const settled = !asked || remote.state === 'done' || remote.state === 'error';
    if (settled && !count) {
      results.append(el('p', { class: 'global-search-empty muted', text: `Nothing matches “${input.value.trim()}”.` }));
    } else if (!asked) {
      results.append(el('p', { class: 'global-search-note muted small', text: 'Type one more character to search invoices and the rest too.' }));
    }
    if (settled) status.textContent = count ? `${count} result${count === 1 ? '' : 's'}` : 'No results';
    // keep the first hit ready for Enter
    move(0, true);
  }

  const askServer = debounce(async () => {
    const p = parse(input.value);
    if (!serverWanted(p)) return;
    const mine = ++seq;
    const scopedRemote = p.scope && !LOCAL.includes(p.scope);
    try {
      const [found, page] = await Promise.all([
        p.q.length >= SERVER_MIN ? store.search(p.q) : {},
        scopedRemote ? store.page(p.scope, { q: p.rest, pageSize: PER_GROUP }) : null
      ]);
      if (mine !== seq || !open) return;              // a newer search has taken over
      remote = {
        state: 'done',
        scoped: page && page.total ? remoteGroup(p.scope, page, p.rest) : null,
        groups: REMOTE_ORDER.filter(e => e !== p.scope && found[e] && found[e].total).map(e => remoteGroup(e, found[e], p.q))
      };
    } catch (err) {
      if (mine !== seq || !open) return;
      remote = { state: 'error', error: err.message, groups: [] };
    }
    draw();
  }, 250);

  input.addEventListener('input', () => {
    seq++;                                              // drop any answer still on its way
    remote = { state: serverWanted(parse(input.value)) ? 'loading' : 'idle', groups: [] };
    draw();
    askServer();
  });

  const hits = () => [...results.querySelectorAll('.global-search-hit')];
  let active = -1;
  function move(to, reset = false) {
    const list = hits();
    list.forEach(h => { h.classList.remove('is-active'); h.setAttribute('aria-selected', 'false'); });
    if (!list.length) { active = -1; input.removeAttribute('aria-activedescendant'); return; }
    active = reset ? 0 : (to + list.length) % list.length;
    const hit = list[active];
    hit.classList.add('is-active');
    hit.setAttribute('aria-selected', 'true');
    hit.id = 'global-search-active';
    list.forEach(h => { if (h !== hit && h.id === 'global-search-active') h.removeAttribute('id'); });
    input.setAttribute('aria-activedescendant', hit.id);
    if (!reset) hit.scrollIntoView({ block: 'nearest' });
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); move(active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(active - 1); }
    else if (e.key === 'Enter') {
      const hit = hits()[active];
      if (hit) { e.preventDefault(); location.hash = hit.getAttribute('href'); close({ restoreFocus: false }); }
    } else if (e.key === 'Tab') {
      e.preventDefault();                               // focus stays in the search; the arrows move through it
      input.focus();
    }
  }
  dialog.addEventListener('keydown', onKey);
  // going to another page (Back, a hover card's link) closes it too; a page
  // noting its open tab in the address is not going anywhere
  const pageOf = () => location.hash.split('?')[0];
  const openedOn = pageOf();
  const onRoute = () => { if (pageOf() !== openedOn) close({ restoreFocus: false }); };
  window.addEventListener('hashchange', onRoute);

  function close({ restoreFocus = true } = {}) {
    if (!open) return;
    seq++;
    window.removeEventListener('hashchange', onRoute);
    backdrop.remove();
    document.body.classList.remove('search-open');
    open = null;
    if (restoreFocus && opener && opener.isConnected) opener.focus();
  }

  document.body.append(backdrop);
  document.body.classList.add('search-open');
  draw();
  input.focus();
  return { focus: () => input.focus(), close };
}

/** The top bar's search field. It opens the search panel rather than typing in place. */
export function searchLauncher() {
  const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
  return el('button', { class: 'search-launcher', type: 'button', 'aria-label': 'Search everything',
                        title: 'Search everything (/ or ' + (mac ? '⌘' : 'Ctrl') + ' K)', onClick: () => openSearch() }, [
    icon('search', 16),
    el('span', { class: 'search-launcher-text', text: 'Search…' }),
    el('kbd', { class: 'search-launcher-key', text: mac ? '⌘K' : 'Ctrl K' })
  ]);
}

/** "/" or Ctrl/⌘ K opens the search from anywhere, unless someone is typing. */
export function installSearchShortcut() {
  document.addEventListener('keydown', (e) => {
    if (!store.loaded) return;
    const typing = e.target.closest && e.target.closest('input, textarea, select, [contenteditable="true"]');
    const combo = (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k';
    if (combo || (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey)) {
      if (document.querySelector('.backdrop')) return;  // a form or dialog is open
      e.preventDefault();
      openSearch();
    }
  });
}
