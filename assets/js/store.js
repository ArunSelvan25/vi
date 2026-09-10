import { api } from './api.js';
import { config } from './config.js';
import { entities } from './schema.js';
import { setFormatterSettings, isoDate, isoMonth } from './ui.js';

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
  properties: [], units: [], tenants: [], leases: [],
  invoices: [], invoiceItems: [], payments: [], maintenance: [], expenses: [], documents: [],

  listeners: new Set(),
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
  emit() { this.listeners.forEach(fn => fn(this)); },

  async load() {
    return this.apply(await api('bootstrap'));
  },

  /** Fold a bootstrap payload into the cache and tell the views. */
  apply(data) {
    Object.assign(this, {
      settings: data.settings || {},
      stats: data.stats || {},
      activity: data.activity || [],
      users: data.users || [],
      properties: data.properties || [],
      units: data.units || [],
      tenants: data.tenants || [],
      leases: data.leases || [],
      invoices: data.invoices || [],
      invoiceItems: data.invoiceItems || [],
      payments: data.payments || [],
      maintenance: data.maintenance || [],
      expenses: data.expenses || [],
      documents: data.documents || [],
      loaded: true
    });
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

  // ── CRUD that keeps the cache in step ───────────────────────────────────

  /**
   * Writing one of these changes rows in other tabs too — a lease decides
   * whether its unit reads as Occupied, a payment decides an invoice's balance
   * — so the local cache cannot be patched from the response alone. Re-pull
   * instead, otherwise the screen disagrees with the sheet until a manual
   * refresh.
   */
  CASCADING: new Set(['leases', 'units', 'payments', 'invoices']),

  async create(entity, data) {
    const cascades = this.CASCADING.has(entity);
    const res = await api('create', { table: entities[entity].table, data, withSnapshot: cascades });
    this[entity] = [...this[entity], res.row];
    if (cascades) await this.syncFrom(res); else this.emit();
    return res.row;
  },

  async update(entity, id, data) {
    const cascades = this.CASCADING.has(entity);
    const res = await api('update', { table: entities[entity].table, id, data, withSnapshot: cascades });
    this[entity] = this[entity].map(r => (r.id === id ? { ...r, ...res.row } : r));
    if (cascades) await this.syncFrom(res); else this.emit();
    return res.row;
  },

  async remove(entity, id) {
    const cascades = this.CASCADING.has(entity);
    const res = await api('remove', { table: entities[entity].table, id, withSnapshot: cascades });
    this[entity] = this[entity].filter(r => r.id !== id);
    // the server cascades an invoice's line items; mirror that locally
    if (entity === 'invoices') {
      this.invoiceItems = this.invoiceItems.filter(i => i.invoice_id !== id);
    }
    if (cascades) await this.syncFrom(res); else this.emit();
  },

  // ── lookups & joins ─────────────────────────────────────────────────────

  byId(entity, id) { return this[entity]?.find(r => r.id === id) || null; },

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

  /** Create or update an invoice together with its line items. */
  async saveInvoice({ id, data, items }) {
    const res = await api('saveInvoice', { id, data, items });
    const inv = res.invoice;
    this.invoices = id
      ? this.invoices.map(r => (r.id === id ? { ...r, ...inv } : r))
      : [...this.invoices, inv];
    this.invoiceItems = [
      ...this.invoiceItems.filter(i => i.invoice_id !== inv.id),
      ...(res.items || [])
    ];
    this.emit();
    return res;
  },

  /** Outstanding balance per tenant, biggest first. */
  arrears() {
    const map = new Map();
    for (const inv of this.invoices) {
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

  /** Collected vs. spent for the last n months, oldest first. */
  monthlySeries(months = 6) {
    const out = [];
    const now = new Date();
    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = isoMonth(d);
      const income = this.payments
        .filter(p => String(p.payment_date || '').slice(0, 7) === key)
        .reduce((s, p) => s + Number(p.amount || 0), 0);
      const expense = this.expenses
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
      .sort((a, b) => String(a.end_date).localeCompare(String(b.end_date)));
  },

  expiringDocuments(days = 60) {
    const limit = new Date(); limit.setDate(limit.getDate() + days);
    const limitStr = isoDate(limit);
    return this.documents
      .filter(d => d.expiry_date && d.expiry_date <= limitStr)
      .sort((a, b) => String(a.expiry_date).localeCompare(String(b.expiry_date)));
  },

  can(minRole) {
    const rank = { viewer: 1, manager: 2, admin: 3 };
    return (rank[config.user?.role] || 0) >= (rank[minRole] || 3);
  }
};
