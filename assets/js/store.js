import { api } from './api.js';
import { config } from './config.js';
import { entities } from './schema.js';
import { setFormatterSettings, isoDate, isoMonth } from './ui.js';

/** id → row, per collection array. See store.byId. */
const ID_INDEX = new WeakMap();

/** The collections a bootstrap carries, each fingerprinted by the server. */
const COLLECTIONS = ['properties', 'units', 'tenants', 'leases', 'invoices', 'invoiceItems',
                     'payments', 'maintenance', 'expenses', 'documents', 'meterReadings'];

/**
 * Client-side cache of the whole workbook. Bootstrap pulls every tab in one
 * round-trip (Sheets is slow per-call, fast in bulk), then mutations patch the
 * cache locally so the UI stays instant.
 */
export const store = {
  loaded: false,
  settings: {},
  stats: {},
  activity: [],
  users: [],
  timezones: null,
  /** Server fingerprint of each collection as it was last received. */
  hashes: {},
  properties: [], units: [], tenants: [], leases: [],
  invoices: [], invoiceItems: [], payments: [], maintenance: [], expenses: [], documents: [],
  meterReadings: [],

  listeners: new Set(),
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
  emit() { this.listeners.forEach(fn => fn(this)); },

  async load() {
    return this.apply(await api('bootstrap', { known: this.known() }));
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
    return { withSnapshot: true, known: this.known() };
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
      activity: data.activity || [],
      users: data.users || [],
      timezones: data.timezones || null,
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
   * fetching one if it did not — the front end and the Apps Script deployment
   * are updated separately, so a browser on the new build can be talking to an
   * older backend that does not know about `withSnapshot` yet.
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

  // ── CRUD that keeps the cache in step ───────────────────────────────────

  /**
   * Writing one of these changes rows in other tabs too — a lease decides
   * whether its unit reads as Occupied, a payment decides an invoice's balance
   * — so the local cache cannot be patched from the response alone. Re-pull
   * instead, otherwise the screen disagrees with the sheet until a manual
   * refresh.
   */
  CASCADING: new Set(['leases', 'units', 'payments', 'invoices', 'maintenance']),

  async create(entity, data) {
    const cascades = this.CASCADING.has(entity);
    const res = await api('create', { table: entities[entity].table, data,
                                      ...(cascades ? this.snapshotRequest() : {}) });
    this[entity] = [...this[entity], res.row];
    this.forget(entity);
    if (cascades) await this.syncFrom(res); else this.emit();
    return res.row;
  },

  /**
   * @param opts.expectedVersion the `_v` of the row the form was opened on;
   *   the server refuses the save if someone else has changed it since.
   */
  async update(entity, id, data, { expectedVersion } = {}) {
    const cascades = this.CASCADING.has(entity);
    const res = await api('update', { table: entities[entity].table, id, data,
                                      expected_version: expectedVersion,
                                      ...(cascades ? this.snapshotRequest() : {}) });
    this[entity] = this[entity].map(r => (r.id === id ? { ...r, ...res.row } : r));
    this.forget(entity);
    if (cascades) await this.syncFrom(res); else this.emit();
    return res.row;
  },

  async remove(entity, id) {
    const cascades = this.CASCADING.has(entity);
    const res = await api('remove', { table: entities[entity].table, id,
                                      ...(cascades ? this.snapshotRequest() : {}) });
    this[entity] = this[entity].filter(r => r.id !== id);
    this.forget(entity);
    // the server cascades an invoice's line items; mirror that locally
    if (entity === 'invoices') {
      this.invoiceItems = this.invoiceItems.filter(i => i.invoice_id !== id);
      this.forget('invoiceItems');
    }
    if (cascades) await this.syncFrom(res); else this.emit();
  },

  /** Run a server action that writes, and take the snapshot it sends back. */
  async act(action, payload = {}) {
    const res = await api(action, { ...payload, ...this.snapshotRequest() });
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

  invoicesOfTenant(tenantId) { return this.invoices.filter(i => i.tenant_id === tenantId); },

  paymentsOfInvoice(invoiceId) { return this.payments.filter(p => p.invoice_id === invoiceId); },

  /** The charges that make up an invoice — rent, electricity, water, … */
  itemsOfInvoice(invoiceId) { return this.invoiceItems.filter(i => i.invoice_id === invoiceId); },

  /**
   * Create or update an invoice together with its line items.
   * @param expectedVersion the `_v` of the invoice the editor was opened on
   */
  async saveInvoice({ id, data, items, expectedVersion }) {
    const res = await api('saveInvoice', { id, data, items, expected_version: expectedVersion,
                                           ...this.snapshotRequest() });
    await this.syncFrom(res);
    return res;
  },

  // ── money: what counts as income ────────────────────────────────────────

  /**
   * A payment that is not income: money received against a security deposit.
   * Deposits are held for the tenant; they reach income only when applied to an
   * invoice at move-out, which is a separate payment on that invoice.
   */
  isDepositPayment(p) {
    const inv = this.byId('invoices', p.invoice_id);
    return !!inv && inv.type === 'Deposit';
  },

  /** Returning a deposit is money going back, not an operating expense. */
  isDepositRefund(e) { return e.category === 'Deposit Refund'; },

  incomePayments(rows = this.payments) { return rows.filter(p => !this.isDepositPayment(p)); },

  operatingExpenses(rows = this.expenses) { return rows.filter(e => !this.isDepositRefund(e)); },

  /** Where a lease's security deposit stands — mirrors depositLedger in Code.gs. */
  depositLedger(lease) {
    const deposits = this.invoices.filter(i => i.lease_id === lease.id && i.type === 'Deposit' && i.status !== 'Void');
    const paid = deposits.reduce((s, i) => s + Number(i.amount_paid || 0), 0);
    const status = String(lease.deposit_status || '');
    const received = paid > 0 ? paid : (status && status !== 'Pending' ? Number(lease.deposit_amount || 0) : 0);
    const applied = this.payments
      .filter(p => p.method === 'Deposit Adjustment' && p.reference === lease.id)
      .reduce((s, p) => s + Number(p.amount || 0), 0);
    const refunded = this.expenses
      .filter(e => e.category === 'Deposit Refund' && e.reference === lease.id)
      .reduce((s, e) => s + Number(e.amount || 0), 0);
    const held = status === 'Transferred' ? 0 : Math.max(0, round2(received - applied - refunded));
    return { received: round2(received), applied: round2(applied), refunded: round2(refunded), held };
  },

  /** The monthly rent in force on a date, escalation compounded — mirrors currentMonthlyRent in Code.gs. */
  currentRent(lease, on = isoDate()) {
    const base = Number(lease.rent_amount || 0);
    const pct = Number(lease.escalation_pct || 0);
    if (!pct || !lease.start_date || on < lease.start_date) return round2(base);
    const s = new Date(lease.start_date + 'T00:00:00'), d = new Date(String(on).slice(0, 10) + 'T00:00:00');
    let months = (d.getFullYear() - s.getFullYear()) * 12 + (d.getMonth() - s.getMonth());
    if (d.getDate() < s.getDate()) months--;
    return round2(base * Math.pow(1 + pct / 100, Math.floor(Math.max(0, months) / 12)));
  },

  /** Outstanding balance per tenant, biggest first. */
  arrears(filter) {
    const map = new Map();
    for (const inv of this.invoices) {
      if (filter && !filter(inv)) continue;
      const bal = Number(inv.balance || 0);
      if (bal <= 0 || ['Void', 'Draft'].includes(inv.status)) continue;
      const cur = map.get(inv.tenant_id) || { tenant_id: inv.tenant_id, balance: 0, invoices: 0, oldest: null };
      cur.balance += bal;
      cur.invoices += 1;
      if (!cur.oldest || inv.due_date < cur.oldest) cur.oldest = inv.due_date;
      map.set(inv.tenant_id, cur);
    }
    return [...map.values()].sort((a, b) => b.balance - a.balance);
  },

  /**
   * Collected vs. spent per month, oldest first — deposits in and out left out.
   *
   * @param months how many months, ending with the month of `end`
   * @param opts.end   last month to include (default: this month)
   * @param opts.match row filter, e.g. one property
   */
  monthlySeries(months = 6, { end = new Date(), match } = {}) {
    const out = [];
    const payments = this.incomePayments().filter(p => !match || match(p));
    const expenses = this.operatingExpenses().filter(e => !match || match(e));
    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(end.getFullYear(), end.getMonth() - i, 1);
      const key = isoMonth(d);
      const income = payments
        .filter(p => String(p.payment_date || '').slice(0, 7) === key)
        .reduce((s, p) => s + Number(p.amount || 0), 0);
      const expense = expenses
        .filter(e => String(e.date || '').slice(0, 7) === key)
        .reduce((s, e) => s + Number(e.amount || 0), 0);
      out.push({
        key,
        label: d.toLocaleDateString('en', { month: 'short' }),
        income, expense, net: income - expense
      });
    }
    return out;
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

  expiringDocuments(days = 60) {
    const limit = new Date(); limit.setDate(limit.getDate() + days);
    const limitStr = isoDate(limit);
    return this.documents
      .filter(d => d.expiry_date && d.expiry_date <= limitStr)
      .sort((a, b) => String(a.expiry_date).localeCompare(String(b.expiry_date)));
  },

  /** The most recent reading of a unit's meter, for the next round to start from. */
  lastReading(unitId, category) {
    return this.meterReadings
      .filter(r => r.unit_id === unitId && r.category === category)
      .sort((a, b) => String(b.reading_date).localeCompare(String(a.reading_date)) ||
                      String(b.id).localeCompare(String(a.id)))[0] || null;
  },

  can(minRole) {
    const rank = { viewer: 1, manager: 2, admin: 3 };
    return (rank[config.user?.role] || 0) >= (rank[minRole] || 3);
  }
};

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
