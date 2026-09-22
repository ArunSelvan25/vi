import { api } from './api.js';
import { config } from './config.js';
import { entities } from './schema.js';
import { setFormatterSettings, isoDate, isoMonth } from './ui.js';

/** id → row, per collection array. See store.byId. */
const ID_INDEX = new WeakMap();

/**
 * The small tables every screen reads, kept whole in the browser: a portfolio
 * has only so many properties, units, tenants and leases. Each arrives with
 * the figures the server works out for it (what a tenant owes, where a lease's
 * deposit stands), so cards and lists can show them without the invoices.
 */
const COLLECTIONS = ['properties', 'units', 'tenants', 'leases'];

/**
 * The tables that grow without limit. A screen asks the server for the page it
 * shows (store.page) or for a record and what surrounds it (store.detail).
 * Rows that arrive either way are remembered, so a name or a hover card
 * elsewhere can still find them.
 */
export const REMOTE = new Set(['invoices', 'invoiceItems', 'payments', 'maintenance', 'expenses', 'documents']);

/** The server's name for a collection. */
const TABLE_OF = { invoiceItems: 'InvoiceItems', activity: 'ActivityLog' };
export const tableOf = (entity) => (entities[entity] ? entities[entity].table : TABLE_OF[entity] || entity);

/** An export asks for every matching row in one request, up to the server's limit. */
const EXPORT_ROWS = 5000;

export const store = {
  loaded: false,
  settings: {},
  stats: {},
  /** Billing's figures: outstanding, overdue, due this week, collected this month. */
  billing: {},
  /** The dashboard's lists and trend. */
  dashboard: {},
  users: [],
  /** Server fingerprint of each collection as it was last received. */
  hashes: {},
  properties: [], units: [], tenants: [], leases: [],
  /** Rows of REMOTE collections seen so far, by collection and id. */
  cache: new Map(),

  listeners: new Set(),
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
  emit() { this.listeners.forEach(fn => fn(this)); },

  async load() {
    return this.apply(await api('bootstrap', { known: this.known(), lean: true }));
  },

  /**
   * The fingerprints to send with a request for data, so the server can leave
   * out every tab that has not changed. Nothing is claimed before the first
   * load, or the server could skip a tab this browser has never had.
   */
  known() {
    return this.loaded ? { ...this.hashes } : undefined;
  },

  /** Payload fields that ask for a snapshot with a write. */
  snapshotRequest() {
    return { withSnapshot: true, lean: true, known: this.known() };
  },

  /**
   * Fold a bootstrap payload into the cache and tell the views. A collection
   * the server marked unchanged keeps what is already here.
   */
  apply(data) {
    const unchanged = new Set(this.loaded ? (data.unchanged || []) : []);
    const next = {
      settings: data.settings || {},
      stats: data.stats || {},
      billing: data.billing || {},
      dashboard: data.dashboard || {},
      users: data.users || [],
      hashes: data.hashes || {},
      loaded: true
    };
    for (const key of COLLECTIONS) {
      next[key] = unchanged.has(key) ? this[key] : (data[key] || []);
    }
    Object.assign(this, next);
    if (data.user) config.user = data.user;
    setFormatterSettings(this.settings);
    this.emit();
    return this;
  },

  async refresh() { return this.load(); },

  /**
   * Apply a snapshot the server sent along with a write, falling back to
   * fetching one if it did not — the site and the backend are deployed
   * separately, so a browser on a new build can briefly be talking to an
   * older backend.
   */
  async syncFrom(res) {
    if (res && res.snapshot) this.apply(res.snapshot);
    else await this.load();
  },

  /**
   * A collection patched locally no longer matches the fingerprint the server
   * gave for it, so stop claiming that fingerprint: the next snapshot sends the
   * collection whole.
   */
  forget(entity) { delete this.hashes[entity]; },

  // ── the growing tables, from the server ─────────────────────────────────

  /** Keep rows that arrived with a page or a record, so byId and label find them. */
  remember(entity, rows) {
    if (!rows) return;
    let known = this.cache.get(entity);
    if (!known) { known = new Map(); this.cache.set(entity, known); }
    for (const row of [].concat(rows)) if (row && row.id) known.set(row.id, row);
  },

  /** Take in a response's rows and the rows it points at (`refs`). */
  rememberAll(entity, res) {
    if (!res) return res;
    this.remember(entity, res.rows);
    for (const [other, rows] of Object.entries(res.refs || {})) this.remember(other, rows);
    return res;
  },

  /**
   * One page of a growing table, searched, filtered and sorted by the server.
   * @param params { scope: {kind, id}, preset, filters, q, sort, dir, page, pageSize }
   * @returns { rows, total, page, pageSize }
   */
  async page(entity, params = {}) {
    return this.rememberAll(entity, await api('page', { table: tableOf(entity), ...params }));
  },

  /** Every row matching `params`, up to EXPORT_ROWS — for CSV exports and statements. */
  async everything(entity, params = {}) {
    const res = await this.page(entity, { ...params, page: 1, pageSize: EXPORT_ROWS, export: true });
    return res.rows;
  },

  /**
   * What a record's page shows. For a property, unit, tenant or lease: counts,
   * money figures and the most recent related records. For anything else: the
   * row itself and what sits beside it on its page.
   */
  async detail(entity, id) {
    const res = await api('detail', { table: tableOf(entity), id });
    if (res.row) this.remember(entity, res.row);
    this.remember('invoices', [].concat(res.recentInvoices || [], res.unpaid || [], res.invoice || []));
    this.remember('payments', [].concat(res.recentPayments || [], res.payments || [], res.others || []));
    this.remember('expenses', [].concat(res.recentExpenses || [], res.expense || []));
    this.remember('maintenance', [].concat(res.openTickets || [], res.ticket || []));
    this.remember('invoiceItems', res.items || []);
    for (const [other, rows] of Object.entries(res.refs || {})) this.remember(other, rows);
    return res;
  },

  /** A property, unit, tenant or lease's invoices, payments and tickets in full. */
  async history(entity, id) {
    const res = await api('history', { table: tableOf(entity), id });
    this.remember('invoices', res.invoices || []);
    this.remember('payments', res.payments || []);
    this.remember('maintenance', res.maintenance || []);
    return res;
  },

  /** The Reports screen's figures for a date range and, optionally, one property. */
  async report(params) { return api('report', params); },

  /** A remote row by id: from what has been seen, or else from the server. */
  async fetchRow(entity, id) {
    if (!id) return null;
    const known = this.byId(entity, id);
    if (known) return known;
    const res = await this.page(entity, { ids: [id], pageSize: 1 });
    return res.rows[0] || null;
  },

  /**
   * A write can change any page, so what was remembered is dropped and the
   * screens fetch afresh when they redraw.
   */
  touch() { this.cache.clear(); },

  // ── CRUD that keeps the cache in step ───────────────────────────────────

  /**
   * Writing one of these changes rows in other tables too — a lease decides
   * whether its unit reads as Occupied, a payment decides an invoice's balance
   * — so the local cache cannot be patched from the response alone. Re-pull
   * instead, otherwise the screen disagrees with the database until a manual
   * refresh. A write to a growing table always takes a snapshot: it moves the
   * dashboard, Billing's figures and what tenants owe.
   */
  CASCADING: new Set(['leases', 'units', 'payments', 'invoices', 'maintenance']),

  cascades(entity) { return REMOTE.has(entity) || this.CASCADING.has(entity); },

  async create(entity, data) {
    const cascades = this.cascades(entity);
    const res = await api('create', { table: tableOf(entity), data,
                                      ...(cascades ? this.snapshotRequest() : {}) });
    if (REMOTE.has(entity)) this.touch();
    else { this[entity] = [...this[entity], res.row]; this.forget(entity); }
    if (cascades) await this.syncFrom(res); else this.emit();
    return res.row;
  },

  /**
   * @param opts.expectedVersion the `_v` of the row the form was opened on;
   *   the server refuses the save if someone else has changed it since.
   */
  async update(entity, id, data, { expectedVersion } = {}) {
    const cascades = this.cascades(entity);
    const res = await api('update', { table: tableOf(entity), id, data,
                                      expected_version: expectedVersion,
                                      ...(cascades ? this.snapshotRequest() : {}) });
    if (REMOTE.has(entity)) this.touch();
    else { this[entity] = this[entity].map(r => (r.id === id ? { ...r, ...res.row } : r)); this.forget(entity); }
    if (cascades) await this.syncFrom(res); else this.emit();
    return res.row;
  },

  async remove(entity, id) {
    const cascades = this.cascades(entity);
    const res = await api('remove', { table: tableOf(entity), id,
                                      ...(cascades ? this.snapshotRequest() : {}) });
    if (REMOTE.has(entity)) this.touch();
    else { this[entity] = this[entity].filter(r => r.id !== id); this.forget(entity); }
    if (cascades) await this.syncFrom(res); else this.emit();
  },

  /** Run a server action that writes, and take the snapshot it sends back. */
  async act(action, payload = {}) {
    const res = await api(action, { ...payload, ...this.snapshotRequest() });
    this.touch();
    await this.syncFrom(res);
    return res;
  },

  // ── lookups & joins ─────────────────────────────────────────────────────

  /**
   * One row by id, from an index built the first time a collection is asked.
   *
   * Every foreign-key label in a table, dropdown, search and CSV export comes
   * through here, and a linear scan made each of those proportional to the size
   * of the referenced tab — a keystroke in the invoice search walked the tenant
   * list thousands of times. Collections are replaced, never mutated in place,
   * so keying the index on the array itself means it can never go stale.
   */
  byId(entity, id) {
    if (REMOTE.has(entity)) return (this.cache.get(entity) && this.cache.get(entity).get(id)) || null;
    const rows = this[entity];
    if (!Array.isArray(rows)) return null;
    let index = ID_INDEX.get(rows);
    if (!index) {
      index = new Map();
      for (const r of rows) if (!index.has(r.id)) index.set(r.id, r);
      ID_INDEX.set(rows, index);
    }
    return index.get(id) || null;
  },

  /** Human label for a foreign key, e.g. UNT-00003 → "Sunrise Villas · 2B". */
  label(entity, id) {
    if (!id) return '—';
    const row = this.byId(entity, id);
    if (!row) return String(id);
    switch (entity) {
      case 'units': {
        const prop = this.byId('properties', row.property_id);
        return (prop ? prop.name + ' · ' : '') + row.unit_number;
      }
      case 'leases': {
        const t = this.byId('tenants', row.tenant_id);
        return row.id + (t ? ' · ' + t.full_name : '');
      }
      case 'invoices':
        return row.id + ' · ' + (row.period_start || row.due_date || '');
      default:
        return row[entities[entity].labelKey] || row.id;
    }
  },

  /**
   * Label without the parent's name, for tables that already show a Property
   * column — "A-101" rather than "Sunrise Residency · A-101".
   */
  shortLabel(entity, id) {
    if (!id) return '—';
    const row = this.byId(entity, id);
    if (!row) return String(id);
    if (entity === 'units') return row.unit_number || row.id;
    return this.label(entity, id);
  },

  options(entity, filter) {
    return (this[entity] || [])
      .filter(r => !filter || filter(r))
      .map(r => ({ value: r.id, label: this.label(entity, r.id) }))
      .sort((a, b) => a.label.localeCompare(b.label));
  },

  // ── derived views the dashboard and reports need ────────────────────────

  unitsOfProperty(propertyId) { return this.units.filter(u => u.property_id === propertyId); },

  activeLeaseForUnit(unitId) {
    return this.leases.find(l => l.unit_id === unitId && l.status === 'Active') || null;
  },

  /** What a tenant, unit or property owes now, worked out by the server. */
  owedBy(entity, id) {
    const row = this.byId(entity, id);
    return Number((row && row._owed) || 0);
  },

  /**
   * Create or update an invoice together with its line items.
   * @param expectedVersion the `_v` of the invoice the editor was opened on
   */
  async saveInvoice({ id, data, items, expectedVersion }) {
    const res = await api('saveInvoice', { id, data, items, expected_version: expectedVersion,
                                           ...this.snapshotRequest() });
    this.touch();
    await this.syncFrom(res);
    return res;
  },

  // ── money ─────────────────────────────────────────────────────────────────

  /**
   * A payment that is not income: money received against a security deposit.
   * The server marks each payment it sends (`_deposit`).
   */
  isDepositPayment(p) { return !!p && p._deposit === true; },

  /** Returning a deposit is money going back, not an operating expense. */
  isDepositRefund(e) { return e.category === 'Deposit Refund'; },

  /** Where a lease's security deposit stands — worked out by the server (depositLedgers). */
  depositLedger(lease) {
    const d = (lease && lease._deposit) || {};
    return { received: Number(d.received || 0), applied: Number(d.applied || 0),
             refunded: Number(d.refunded || 0), held: Number(d.held || 0) };
  },

  /** The monthly rent in force on a date, escalation compounded — mirrors currentMonthlyRent in the backend. */
  currentRent(lease, on = isoDate()) {
    const base = Number(lease.rent_amount || 0);
    const pct = Number(lease.escalation_pct || 0);
    if (!pct || !lease.start_date || on < lease.start_date) return round2(base);
    const s = new Date(lease.start_date + 'T00:00:00'), d = new Date(String(on).slice(0, 10) + 'T00:00:00');
    let months = (d.getFullYear() - s.getFullYear()) * 12 + (d.getMonth() - s.getMonth());
    if (d.getDate() < s.getDate()) months--;
    return round2(base * Math.pow(1 + pct / 100, Math.floor(Math.max(0, months) / 12)));
  },

  /**
   * The next rent invoice a lease with a rent day will raise — mirrors
   * rentDayPeriods in the backend, which does the billing; this only
   * previews it. Null for a lease without a rent day, or once its term is
   * fully billed.
   */
  nextRentInvoice(lease) {
    const rentDay = Number(lease.rent_day);
    const monthly = (lease.frequency || 'Monthly') === 'Monthly';
    if (!monthly || !lease.start_date || !(Number.isInteger(rentDay) && ((rentDay >= 1 && rentDay <= 28) || rentDay === 31))) return null;

    const day = (iso) => new Date(String(iso).slice(0, 10) + 'T00:00:00');
    const plus = (d, n) => { const out = new Date(d.getTime()); out.setDate(out.getDate() + n); return out; };
    const rentDayIn = (y, m) => {
      const first = new Date(y, m, 1);
      const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
      return new Date(first.getFullYear(), first.getMonth(), Math.min(rentDay, last));
    };
    const span = (a, b) => Math.round((b - a) / 86400000) + 1;

    // where billing stands: the last day any rent invoice on this lease covers
    const through = String(lease._billed_through || '');

    let cursor = day(lease.start_date);
    if (through && plus(day(through), 1) > cursor) cursor = plus(day(through), 1);
    const end = lease.end_date ? day(lease.end_date) : null;
    if (end && cursor > end) return null;

    let close = rentDayIn(cursor.getFullYear(), cursor.getMonth());
    if (close < cursor) close = rentDayIn(cursor.getFullYear(), cursor.getMonth() + 1);
    const cycleEnd = end && close > end ? end : close;
    const rent = this.currentRent(lease, isoDate(cursor));
    const whole = isoDate(cursor) === isoDate(plus(rentDayIn(close.getFullYear(), close.getMonth() - 1), 1)) &&
                  isoDate(cycleEnd) === isoDate(close);

    const lines = [];
    if (whole) lines.push({ start: isoDate(cursor), end: isoDate(cycleEnd), amount: round2(rent) });
    else {
      for (let from = cursor; from <= cycleEnd;) {
        const monthEnd = new Date(from.getFullYear(), from.getMonth() + 1, 0);
        const to = monthEnd < cycleEnd ? monthEnd : cycleEnd;
        const days = span(from, to);
        lines.push({ start: isoDate(from), end: isoDate(to), days, monthDays: monthEnd.getDate(),
                     amount: round2(rent * days / monthEnd.getDate()) });
        from = plus(to, 1);
      }
    }
    // due on the rent day; raisable from the 1st of that month; the grace
    // days run after the due date, before a late fee
    return {
      start: isoDate(cursor), end: isoDate(cycleEnd), due: isoDate(cycleEnd),
      raiseFrom: isoDate(new Date(cycleEnd.getFullYear(), cycleEnd.getMonth(), 1)),
      lateFeeFrom: isoDate(plus(cycleEnd, (parseInt(lease.grace_days || 0, 10) || 0) + 1)),
      amount: round2(lines.reduce((t, l) => t + l.amount, 0)), partial: !whole, lines
    };
  },

  /** Month keys (yyyy-MM) from the server, with the short month name a chart shows. */
  labelSeries(series) {
    return (series || []).map(m => ({
      ...m, label: new Date(m.key + '-01T00:00:00').toLocaleDateString('en', { month: 'short' })
    }));
  },

  /** Leases ending within `days`, soonest first. */
  expiringLeases(days = 45) {
    const limit = new Date(); limit.setDate(limit.getDate() + days);
    const limitStr = isoDate(limit);
    const todayStr = isoDate();
    return this.leases
      .filter(l => l.status === 'Active' && l.end_date && l.end_date >= todayStr && l.end_date <= limitStr)
      .filter(l => !this.leases.some(n => n.renewed_from === l.id))
      .sort((a, b) => String(a.end_date).localeCompare(String(b.end_date)));
  },

  can(minRole) {
    const rank = { viewer: 1, manager: 2, admin: 3 };
    return (rank[config.user?.role] || 0) >= (rank[minRole] || 3);
  }
};

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
