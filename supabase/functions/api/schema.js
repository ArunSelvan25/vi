/**
 * The tables, by the names the app uses for them (Leases, InvoiceItems …), and
 * how each column converts between what the browser sends and what Postgres
 * stores.
 *
 * In the app an empty field is '' and a number typed into a form arrives as a
 * string. Postgres wants NULL and real numbers. Every value crossing the
 * boundary goes through `toDb` / `fromDb` below, so the rest of the backend
 * can treat rows the same way everywhere.
 *
 * Column kinds:
 *   text     nullable text; '' is stored as NULL
 *   req      NOT NULL text, kept as typed ('' allowed)
 *   enum     NOT NULL text with a default; '' or missing means the default
 *   date     yyyy-MM-dd
 *   num      nullable numeric
 *   num0     NOT NULL numeric, empty means 0
 *   int      nullable integer
 *   int0     NOT NULL integer, empty means 0
 *   ts       timestamptz, returned as yyyy-MM-ddTHH:mm:ss in the app's zone
 *   ms       timestamptz the code handles as epoch milliseconds
 *   bool     boolean (the strings 'TRUE' / 'FALSE' are accepted too)
 */

const col = (kind, def) => ({ kind, def });
const text = col('text'), req = col('req'), date = col('date'), num = col('num'), num0 = col('num0');
const int = col('int'), int0 = col('int0'), ts = col('ts');
const oneOf = (def) => col('enum', def);

const STAMPS = { created_at: ts, updated_at: ts };

export const TABLES = {
  Properties: { sql: 'properties', prefix: 'PRP', cols: {
    id: req, name: req, type: text, address_line1: text, address_line2: text, city: text, state: text,
    postal_code: text, country: text, owner_name: text, purchase_date: date, purchase_price: num,
    current_value: num, status: oneOf('Active'), notes: text, ...STAMPS } },

  Units: { sql: 'units', prefix: 'UNT', cols: {
    id: req, property_id: text, unit_number: req, floor: text, bedrooms: num, bathrooms: num,
    area_sqft: num, furnishing: text, rent_amount: num, deposit_amount: num, status: oneOf('Vacant'),
    amenities: text, notes: text, ...STAMPS } },

  Tenants: { sql: 'tenants', prefix: 'TNT', cols: {
    id: req, full_name: req, email: text, phone: text, alt_phone: text, id_type: text, id_number: text,
    occupation: text, emergency_name: text, emergency_phone: text, status: oneOf('Active'), notes: text,
    ...STAMPS, gstin: text } },

  Leases: { sql: 'leases', prefix: 'LSE', cols: {
    id: req, property_id: text, unit_id: text, tenant_id: text, start_date: date, end_date: date,
    rent_amount: num0, deposit_amount: num0, deposit_status: oneOf('Pending'), frequency: oneOf('Monthly'),
    billing_day: int, late_fee: num0, grace_days: int0, escalation_pct: num0, status: oneOf('Active'),
    notes: text, ...STAMPS, gst_rate: num0, renewed_from: text, rent_day: int } },

  Invoices: { sql: 'invoices', prefix: 'INV', cols: {
    id: req, lease_id: text, tenant_id: text, unit_id: text, property_id: text, type: req,
    period_start: date, period_end: date, issue_date: date, due_date: date, amount: num0, tax: num0,
    total: num0, amount_paid: num0, balance: num0, status: oneOf('Unpaid'), notes: text, ...STAMPS,
    cgst: num, sgst: num, igst: num, place_of_supply: text, last_reminded: date } },

  InvoiceItems: { sql: 'invoice_items', prefix: 'ITM', cols: {
    id: req, invoice_id: text, description: req, category: oneOf('Other'), quantity: col('num0'),
    unit_amount: num0, amount: num0, notes: text, ...STAMPS, tax_rate: num0, tax_amount: num0 } },

  Payments: { sql: 'payments', prefix: 'PAY', cols: {
    id: req, invoice_id: text, lease_id: text, tenant_id: text, property_id: text, payment_date: date,
    amount: num, method: text, reference: text, received_by: text, notes: text, ...STAMPS } },

  Maintenance: { sql: 'maintenance', prefix: 'MNT', cols: {
    id: req, property_id: text, unit_id: text, tenant_id: text, title: req, description: text,
    category: text, priority: oneOf('Medium'), status: oneOf('Open'), reported_date: date,
    scheduled_date: date, completed_date: date, vendor_name: text, vendor_phone: text, cost: num,
    notes: text, ...STAMPS } },

  Expenses: { sql: 'expenses', prefix: 'EXP', cols: {
    id: req, property_id: text, unit_id: text, date: date, category: text, vendor: text,
    description: text, amount: num0, payment_method: text, reference: text, receipt_url: text, ...STAMPS } },

  Documents: { sql: 'documents', prefix: 'DOC', cols: {
    id: req, entity_type: text, entity_id: text, title: text, category: text, url: text,
    issue_date: date, expiry_date: date, notes: text, ...STAMPS } },

  Users: { sql: 'app_users', prefix: 'USR', cols: {
    id: req, name: req, phone: req, email: text, role: oneOf('viewer'), salt: req, password_hash: req,
    password_changed_at: col('ms'), active: col('bool', true), last_login: ts, ...STAMPS } },

  Settings: { sql: 'settings', key: 'key', cols: { key: req, value: req } },

  ActivityLog: { sql: 'activity_log', prefix: 'LOG', cols: {
    id: req, timestamp: ts, actor: text, action: req, entity: text, entity_id: text, details: text } }
};

/** Tables whose rows carry updated_at / row_version maintained by the database. */
export const hasVersion = (table) => 'updated_at' in TABLES[table].cols;

/** The primary-key column of a table. */
export const keyOf = (table) => TABLES[table].key || 'id';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function numberOf(v, column) {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`${label(column)} must be a number.`);
    return v;
  }
  const s = String(v).replace(/,/g, '').trim();
  const n = Number(s);
  if (s === '' || !Number.isFinite(n)) throw new Error(`${label(column)} must be a number, not "${v}".`);
  return n;
}

const label = (column) => column.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());

const isBlank = (v) => v === '' || v === null || v === undefined;

/**
 * A value as it must be written to Postgres. `undefined` means "leave the
 * column out", so an insert falls back to the database default.
 */
export function toDb(table, column, v) {
  const spec = TABLES[table].cols[column];
  switch (spec.kind) {
    case 'text': return isBlank(v) ? null : String(v);
    case 'req':  return v === null || v === undefined ? '' : String(v);
    case 'enum': return isBlank(v) ? spec.def : String(v);
    case 'date': {
      if (isBlank(v)) return null;
      const s = v instanceof Date ? v.toISOString().slice(0, 10) : String(v).trim().slice(0, 10);
      if (!DATE_RE.test(s) || Number.isNaN(Date.parse(s + 'T00:00:00Z'))) {
        throw new Error(`${label(column)} "${v}" is not a date (expected yyyy-mm-dd).`);
      }
      return s;
    }
    case 'num':  return isBlank(v) ? null : numberOf(v, column);
    case 'num0': return isBlank(v) ? 0 : numberOf(v, column);
    case 'int':  return isBlank(v) ? null : Math.trunc(numberOf(v, column));
    case 'int0': return isBlank(v) ? 0 : Math.trunc(numberOf(v, column));
    // a local wall-clock string (nowIso) is read in the session's time zone
    case 'ts':   return isBlank(v) ? null : String(v);
    case 'ms': {
      if (isBlank(v)) return undefined;
      const n = typeof v === 'number' ? v : Number(v);
      return new Date(Number.isFinite(n) ? n : Date.parse(v)).toISOString();
    }
    case 'bool': return isBlank(v) ? spec.def : !(v === false || String(v).toLowerCase() === 'false');
    default: throw new Error('Unknown column kind ' + spec.kind);
  }
}

/**
 * A value as the SPA expects it: '' for empty, numbers as numbers, dates as
 * yyyy-MM-dd and timestamps as yyyy-MM-ddTHH:mm:ss in the app's time zone.
 * Relies on the connection returning date/timestamptz/numeric as raw text
 * (see PG_TYPES) and on the session time zone being the app's.
 */
export function fromDb(table, column, v) {
  if (v === null || v === undefined) return '';
  const spec = TABLES[table].cols[column];
  switch (spec.kind) {
    case 'num': case 'num0': case 'int': case 'int0': return Number(v);
    case 'ts':   return String(v).slice(0, 19).replace(' ', 'T');
    case 'ms':   return Date.parse(String(v).replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00'));
    case 'bool': return v === true || v === 't' || v === 'true';
    default:     return v;
  }
}

/**
 * Parsers for the Postgres driver. Dates and timestamps stay text — turning
 * them into JS Dates would put them through the server's zone, which is exactly
 * the classic day-shift bug: a date landing on the day before in some zones.
 */
export const PG_TYPES = {
  date:        { to: 1082, from: [1082], serialize: (x) => x, parse: (x) => x },
  timestamptz: { to: 1184, from: [1184], serialize: (x) => x, parse: (x) => x },
  timestamp:   { to: 1114, from: [1114], serialize: (x) => x, parse: (x) => x },
  numeric:     { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => Number(x) },
  bigint:      { to: 20,   from: [20],   serialize: (x) => String(x), parse: (x) => Number(x) }
};
