/**
 * The storage layer: readTable / createRow / updateRow / deleteRow, on Postgres.
 *
 * Every request runs inside one transaction that holds a single advisory lock
 * (see `openRequest`), so the business code above this can simply read a
 * table, check something, write — and nothing else can land in between. A
 * request that fails part-way leaves nothing behind: the transaction rolls
 * back.
 *
 * Reads are memoised per request. The memo is kept up to date by the writes
 * below rather than thrown away by them — a rent run that recomputes a hundred
 * invoices would otherwise re-read the whole Invoices table a hundred times.
 */
import { TABLES, toDb, fromDb, keyOf, hasVersion } from './schema.js';

/** Any fixed number: the key of the one lock every request takes. */
const LOCK_KEY = 727274;

/** Tables a delete can change behind the memo's back, through ON DELETE rules. */
const CASCADES = {
  Invoices: ['InvoiceItems'],
  Leases: ['LeaseTenants', 'RentOffline']
};

/**
 * Start a request: the app's time zone for the session (so timestamps read
 * and written as local wall-clock time mean the app's local time), then the
 * lock that serialises writers.
 */
export async function openRequest(tx, tz) {
  await tx`select set_config('timezone', ${tz}, true), pg_advisory_xact_lock(${LOCK_KEY})`;
  return { tx, tz, memo: new Map() };
}

export function assertTable(name) {
  if (!Object.prototype.hasOwnProperty.call(TABLES, name)) throw new Error('Unknown table: ' + name);
  return name;
}

export function mapRow(table, raw) {
  const out = {};
  for (const c of Object.keys(TABLES[table].cols)) out[c] = fromDb(table, c, raw[c]);
  if (raw.row_version !== undefined) out._v = String(raw.row_version);
  return out;
}

async function memoOf(r, table) {
  let m = r.memo.get(table);
  if (m) return m;
  const t = TABLES[table];
  const raw = t.key
    ? await r.tx`select * from ${r.tx(t.sql)} order by ${r.tx(t.key)}`
    : await r.tx`select * from ${r.tx(t.sql)} order by seq`;
  const rows = raw.map(x => mapRow(table, x));
  const byKey = new Map();
  const key = keyOf(table);
  rows.forEach(row => byKey.set(String(row[key]), row));
  m = { rows, byKey };
  r.memo.set(table, m);
  return m;
}

/** A whole table as plain objects, in insertion order. Callers get copies they may mutate. */
export async function readTable(r, table) {
  const m = await memoOf(r, table);
  return m.rows.map(row => ({ ...row }));
}

/** One row by its key, or null. */
export async function findRow(r, table, id) {
  const m = await memoOf(r, table);
  const row = m.byKey.get(String(id));
  return row ? { ...row } : null;
}

/** The newest `n` rows, without reading the ones in front of them. */
export async function readTableTail(r, table, n) {
  const t = TABLES[table];
  const raw = await r.tx`select * from ${r.tx(t.sql)} order by seq desc limit ${n}`;
  return raw.reverse().map(x => mapRow(table, x));
}

export function invalidate(r, table) {
  r.memo.delete(table);
}

function remember(r, table, row) {
  const m = r.memo.get(table);
  if (!m) return;
  const key = String(row[keyOf(table)]);
  const i = m.rows.findIndex(x => String(x[keyOf(table)]) === key);
  if (i >= 0) m.rows[i] = row; else m.rows.push(row);
  m.byKey.set(key, row);
}

function forget(r, table, id) {
  const m = r.memo.get(table);
  if (!m) return;
  const i = m.rows.findIndex(x => String(x[keyOf(table)]) === String(id));
  if (i >= 0) m.rows.splice(i, 1);
  m.byKey.delete(String(id));
  (CASCADES[table] || []).forEach(t => invalidate(r, t));
}

/** Column values ready for an INSERT, with database-managed columns left out. */
function insertValues(table, data) {
  const out = {};
  for (const c of Object.keys(TABLES[table].cols)) {
    if (c === 'created_at' || c === 'updated_at') {
      // only an import carries its own timestamps
      if (data[c]) out[c] = toDb(table, c, data[c]);
      continue;
    }
    const v = toDb(table, c, data[c]);
    if (v !== undefined) out[c] = v;
  }
  return out;
}

/**
 * Reserve `count` sequential numbers and format them as ids. Numbering continues
 * from the highest id ever issued (id_counters) or present in the table,
 * whichever is higher — never from what happens to be left after a delete.
 */
export async function reserveIds(r, table, count, prefix) {
  const t = TABLES[table];
  let floor = 0;
  // the audit log is append-only and nothing refers to its ids; skip the scan
  if (table !== 'ActivityLog') {
    const [row] = await r.tx`
      select coalesce(max(nullif(substring(id from '(\\d{1,9})$'), '')::int), 0) as floor
      from ${r.tx(t.sql)}`;
    floor = Number(row.floor) || 0;
  }
  const [{ first }] = await r.tx`select reserve_ids(${table}, ${count}, ${floor}) as first`;
  const ids = [];
  for (let n = 0; n < count; n++) ids.push(prefix + '-' + String(Number(first) + n).padStart(5, '0'));
  return ids;
}

/** Insert one row. `data.id` must already be set for tables that have one. */
export async function insertRow(r, table, data) {
  const t = TABLES[table];
  const [raw] = await r.tx`insert into ${r.tx(t.sql)} ${r.tx(insertValues(table, data))} returning *`;
  const row = mapRow(table, raw);
  remember(r, table, row);
  return { ...row };
}

/** Insert many rows in as few statements as the parameter limit allows. */
export async function insertRows(r, table, list) {
  if (!list.length) return [];
  const t = TABLES[table];
  const values = list.map(d => insertValues(table, d));
  const columns = Object.keys(values[0]);
  const out = [];
  for (let i = 0; i < values.length; i += 500) {
    const chunk = values.slice(i, i + 500);
    const raw = await r.tx`insert into ${r.tx(t.sql)} ${r.tx(chunk, columns)} returning *`;
    raw.sort((a, b) => Number(a.seq) - Number(b.seq))
       .forEach(x => { const row = mapRow(table, x); remember(r, table, row); out.push({ ...row }); });
  }
  return out;
}

/**
 * Change some columns of one row.
 *
 * @param expectedVersion the `_v` the caller last saw. When given and the row
 *   has changed since, nothing is written and a CONFLICT error is thrown.
 */
export async function patchRow(r, table, id, data, expectedVersion) {
  const t = TABLES[table];
  const key = keyOf(table);
  const [current] = await r.tx`select * from ${r.tx(t.sql)} where ${r.tx(key)} = ${String(id)} for update`;
  if (!current) throw new Error(table + ' ' + id + ' not found');
  if (expectedVersion && hasVersion(table) && String(current.row_version) !== String(expectedVersion)) {
    const at = fromDb(table, 'updated_at', current.updated_at);
    throw new Error('CONFLICT: ' + id + ' was changed by someone else' +
                    (at ? ' at ' + String(at).replace('T', ' ') : '') +
                    ' after you opened it. Close this form and open it again to see their changes.');
  }
  const set = {};
  for (const k of Object.keys(data)) {
    if (!Object.prototype.hasOwnProperty.call(t.cols, k)) continue;
    if (k === key || k === 'created_at' || k === 'updated_at') continue;
    const v = toDb(table, k, data[k]);
    if (v !== undefined) set[k] = v;
  }
  let raw = current;
  if (Object.keys(set).length) {
    [raw] = await r.tx`update ${r.tx(t.sql)} set ${r.tx(set)} where ${r.tx(key)} = ${String(id)} returning *`;
  }
  const row = mapRow(table, raw);
  remember(r, table, row);
  return { ...row };
}

/** Delete one row by key. Throws when there is no such row. */
export async function removeRow(r, table, id) {
  const t = TABLES[table];
  const key = keyOf(table);
  const gone = await r.tx`delete from ${r.tx(t.sql)} where ${r.tx(key)} = ${String(id)} returning ${r.tx(key)}`;
  if (!gone.length) throw new Error(table + ' ' + id + ' not found');
  forget(r, table, id);
  return id;
}

/** A value from app_state (what Script Properties held), or null. */
export async function getState(r, key) {
  const [row] = await r.tx`select value from app_state where key = ${key}`;
  return row ? row.value : null;
}

export async function setState(r, key, value) {
  await r.tx`insert into app_state (key, value) values (${key}, ${String(value)})
             on conflict (key) do update set value = excluded.value`;
}

/** Per-table change counters, for bootstrap's "what has moved since" check. */
export async function tableVersions(r) {
  const rows = await r.tx`select table_name, version from table_versions`;
  const out = {};
  rows.forEach(x => { out[x.table_name] = Number(x.version); });
  return out;
}

/** Run `fn` so that a database error inside it cannot abort the whole request. */
export async function guarded(r, fn) {
  try {
    await r.tx.savepoint(async (sp) => fn({ ...r, tx: sp }));
  } catch (e) { /* the savepoint rolled back; the request carries on */ }
}
