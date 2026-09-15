/**
 * VI Property & Tenancy Manager — Google Apps Script backend
 * ----------------------------------------------------------
 * Deploy this as a Web App ("Execute as: Me", "Who has access: Anyone").
 * The static front-end (GitHub Pages) talks to it over HTTPS with a
 * text/plain POST body so the browser never fires a CORS preflight.
 *
 * Script Properties used:
 *   SHEET_ID     – spreadsheet id (optional if script is container-bound)
 *   AUTH_SECRET  – HMAC secret for session tokens (auto-generated on setup)
 */

// ─────────────────────────────────────────────────────────── configuration ──

var SCHEMA = {
  Properties: ['id','name','type','address_line1','address_line2','city','state','postal_code','country',
               'owner_name','purchase_date','purchase_price','current_value','status','notes',
               'created_at','updated_at'],
  Units:      ['id','property_id','unit_number','floor','bedrooms','bathrooms','area_sqft','furnishing',
               'rent_amount','deposit_amount','status','amenities','notes','created_at','updated_at'],
  Tenants:    ['id','full_name','email','phone','alt_phone','id_type','id_number','occupation',
               'emergency_name','emergency_phone','status','notes','created_at','updated_at','gstin'],
  Leases:     ['id','property_id','unit_id','tenant_id','start_date','end_date','rent_amount',
               'deposit_amount','deposit_status','frequency','billing_day','late_fee','grace_days',
               'escalation_pct','status','notes','created_at','updated_at','gst_rate','renewed_from'],
  Invoices:   ['id','lease_id','tenant_id','unit_id','property_id','type','period_start','period_end',
               'issue_date','due_date','amount','tax','total','amount_paid','balance','status','notes',
               'created_at','updated_at','cgst','sgst','igst','place_of_supply','last_reminded'],
  InvoiceItems:['id','invoice_id','description','category','quantity','unit_amount','amount','notes',
               'created_at','updated_at','tax_rate','tax_amount'],
  Payments:   ['id','invoice_id','lease_id','tenant_id','property_id','payment_date','amount','method',
               'reference','received_by','notes','created_at','updated_at'],
  Maintenance:['id','property_id','unit_id','tenant_id','title','description','category','priority',
               'status','reported_date','scheduled_date','completed_date','vendor_name','vendor_phone',
               'cost','notes','created_at','updated_at'],
  Expenses:   ['id','property_id','unit_id','date','category','vendor','description','amount',
               'payment_method','reference','receipt_url','created_at','updated_at'],
  Documents:  ['id','entity_type','entity_id','title','category','url','issue_date','expiry_date','notes',
               'created_at','updated_at'],
  MeterReadings:['id','property_id','unit_id','lease_id','tenant_id','category','reading_date',
               'previous_reading','current_reading','consumption','rate','amount','invoice_id','notes',
               'created_at','updated_at'],
  Users:      ['id','name','phone','email','role','salt','password_hash','password_changed_at',
               'active','last_login','created_at','updated_at'],
  Settings:   ['key','value'],
  ActivityLog:['id','timestamp','actor','action','entity','entity_id','details']
};

var ID_PREFIX = {
  Properties:'PRP', Units:'UNT', Tenants:'TNT', Leases:'LSE', Invoices:'INV', Payments:'PAY',
  InvoiceItems:'ITM', Maintenance:'MNT', Expenses:'EXP', Documents:'DOC', Users:'USR', ActivityLog:'LOG',
  MeterReadings:'MTR'
};

var DEFAULT_SETTINGS = {
  org_name: 'VI Properties',
  currency: 'INR',
  currency_symbol: '₹',
  locale: 'en-IN',
  date_format: 'dd MMM yyyy',
  invoice_prefix: 'INV',
  default_late_fee: '0',
  default_grace_days: '5',
  reminder_days_before: '3',
  reminder_enabled: 'false',
  lease_expiry_alert_days: '45',
  session_hours: '12',
  reminder_overdue_days: '1,7,14,30',
  gstin: '',
  sac_code: '997212',
  default_gst_rate: '0',
  upi_id: '',
  whatsapp_country_code: '91'
};

var ROLE_RANK = { viewer: 1, manager: 2, admin: 3 };

/** How long a fresh deployment accepts an anonymous first-run bootstrap. */
var BOOTSTRAP_WINDOW_MS = 60 * 60 * 1000;

/** Tables that need more than the default 'manager' to write. */
var TABLE_MIN_ROLE = { Users: 'admin', Settings: 'admin', ActivityLog: 'admin' };

/** Tables that need more than the default 'viewer' to read. */
var TABLE_READ_ROLE = { Users: 'admin', ActivityLog: 'manager' };

/** Columns that must never leave the server, whoever is asking. */
var NEVER_RETURN = { Users: ['salt', 'password_hash'] };

function minRoleFor(table) { return TABLE_MIN_ROLE[table] || 'manager'; }
function readRoleFor(table) { return TABLE_READ_ROLE[table] || 'viewer'; }

/**
 * Rows on their way to a client, with secrets removed.
 *
 * `bootstrap` already scrubbed the Users table, but `list` handed back whole
 * rows — so any signed-in account, including a read-only viewer, could read
 * every salt and password hash and attack them offline. Strip them here, at the
 * boundary, so no future caller can reintroduce the leak.
 */
function readTableForClient(table, user) {
  requireRole(user, readRoleFor(table));
  return readTable(table).map(function (row) { return stripSecrets(table, row); });
}

/**
 * One row with the never-return columns removed. Every path that hands a row
 * back to the browser goes through this — a created or updated user included,
 * which is where createUser and a plain `update` on Users used to leak them.
 */
function stripSecrets(table, row) {
  var hidden = NEVER_RETURN[table];
  if (!hidden || !row) return row;
  var safe = {};
  Object.keys(row).forEach(function (k) {
    if (hidden.indexOf(k) < 0) safe[k] = row[k];
  });
  return safe;
}
var READ_ONLY_ACTIONS = { ping:1, login:1, bootstrap:1, list:1, me:1, stats:1 };

// ─────────────────────────────────────────────────────────────── entry pts ──

/**
 * Health check only.
 *
 * This deliberately exposes no actions. It previously accepted an `action`, a
 * `token` in the query string and a JSONP `callback` that was reflected into a
 * JavaScript response — an injection vector, and a way to leak session tokens
 * into browser history, proxy logs and Referer headers. The front-end has
 * always used POST, so none of that was ever needed.
 */
function doGet() {
  return json(ok({ service: 'vi-property-manager', version: '1.0.0', time: nowIso() }));
}

function doPost(e) {
  var body = {};
  try { body = JSON.parse(e.postData.contents); } catch (err) { body = {}; }
  return json(handle(body.action, body.payload || {}, body.token || ''));
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ────────────────────────────────────────────────────────────────── router ──

function handle(action, payload, token) {
  // The memo below is only ever valid for the request that filled it.
  invalidateAll();
  try {
    if (!action) return fail('No action supplied');

    if (action === 'ping')  return ok({ service: 'vi-property-manager', version: '1.0.0', time: nowIso() });
    if (action === 'setup') return doSetup(payload, token);
    if (action === 'login') return doLogin(payload);

    var user = requireAuth(token);
    ensureSchemaCurrent();

    switch (action) {
      case 'me':               return ok({ user: user, settings: readSettings() });
      case 'bootstrap':        return ok(bootstrap(user, payload.known));
      case 'list':             return ok({ rows: readTableForClient(assertTable(payload.table), user) });
      case 'create':
      case 'update': {
        var written = writeRow(action, payload, user);
        var row = freshRow(payload.table, written.id !== undefined ? written.id : written.key) || written;
        return ok(withSnapshot(payload, user, { row: stripSecrets(payload.table, row) }));
      }
      case 'remove':           return ok(withSnapshot(payload, user, { id: deleteRow(payload.table, payload.id, user) }));
      case 'saveInvoice':      return ok(withSnapshot(payload, user, saveInvoice(payload, user)));
      case 'voidInvoice':      return ok(withSnapshot(payload, user, voidInvoice(payload, user)));
      case 'recordPayment':    return ok(withSnapshot(payload, user, recordPayment(payload, user)));
      case 'voidPayment':      return ok(withSnapshot(payload, user, voidPayment(payload.id, user)));
      case 'generateInvoices': return ok(withSnapshot(payload, user, generateInvoices(payload, user)));
      case 'settleDeposit':    return ok(withSnapshot(payload, user, settleDeposit(payload, user)));
      case 'renewLease':       return ok(withSnapshot(payload, user, renewLease(payload, user)));
      case 'billMeterReadings':return ok(withSnapshot(payload, user, billMeterReadings(payload, user)));
      case 'refreshStatuses':  requireRole(user, 'manager'); return ok(withSnapshot(payload, user, refreshStatuses(user)));
      case 'changePassword':   return ok(changePassword(payload, user));
      case 'createUser':       return ok({ row: createUser(payload, user) });
      case 'resetPassword':    return ok(resetPassword(payload, user));
      case 'setUserActive':    return ok({ row: setUserActive(payload, user) });
      case 'setUserRole':      return ok({ row: setUserRole(payload, user) });
      case 'sendReminders':    return ok(withSnapshot(payload, user, sendReminders(user, { scheduled: false })));
      case 'stats':            return ok(computeStats());
      default: return fail('Unknown action: ' + action);
    }
  } catch (err) {
    return fail(err && err.message ? err.message : String(err));
  }
}

/**
 * Attach the state the browser would otherwise come straight back for.
 *
 * A write that cascades cannot be applied to the client's cache from the
 * response alone — a lease decides whether its unit reads as Occupied, a
 * payment decides an invoice's balance — so the app followed every one of them
 * with a second request for the whole workbook. Answering both in one response
 * removes a round-trip to Apps Script, which on its own costs more than all the
 * reads put together; the snapshot itself is nearly free here because the tabs
 * are already in the per-execution memo.
 *
 * Only sent when asked for, so a browser running an older build still works,
 * and built through bootstrap() so it obeys exactly the same role limits.
 */
function withSnapshot(payload, user, data) {
  if (payload && payload.withSnapshot) data.snapshot = bootstrap(user, payload.known);
  return data;
}

function ok(data)   { return { ok: true,  data: data || {} }; }
function fail(msg)  { return { ok: false, error: msg }; }

// ──────────────────────────────────────────────────────────── spreadsheet ──

/**
 * Per-execution memo of the workbook.
 *
 * A Web App request is one short-lived execution, and every write inside it
 * goes through createRow / updateRow / deleteRow / log / setSetting below —
 * each of which drops the affected tab from the memo — so a cached read can
 * never hand back a stale row.
 *
 * Repetition is where the time actually went. Saving one unit used to re-read
 * Leases three times and Invoices twice inside refreshStatuses alone, re-open
 * the spreadsheet for every one of those reads, and then the browser asked for
 * a full bootstrap that read all twelve tabs again. Each of those is a network
 * call to Sheets costing tens of milliseconds; repeating one in memory is free.
 *
 * Only raw cell values are memoised, never the row objects handed to callers:
 * readTable still builds fresh objects on every call, so one caller mutating
 * what it got back is still invisible to the next.
 */
var CACHE = { book: null, sheets: {}, headers: {}, values: {}, versions: {}, tz: null };

/** Forget a tab's contents. Called after every write to it. */
function invalidate(table) {
  delete CACHE.values[table];
  delete CACHE.versions[table];
}

/** Forget everything, header rows included — for when columns change. */
function invalidateAll() {
  CACHE = { book: null, sheets: {}, headers: {}, values: {}, versions: {}, tz: null };
}

function ss() {
  if (CACHE.book) return CACHE.book;
  var id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (id) return (CACHE.book = SpreadsheetApp.openById(id));
  var active = SpreadsheetApp.getActiveSpreadsheet();
  if (!active) throw new Error('No spreadsheet bound. Set the SHEET_ID script property.');
  return (CACHE.book = active);
}

function assertTable(name) {
  if (!SCHEMA[name]) throw new Error('Unknown table: ' + name);
  return name;
}

function sheetFor(name) {
  if (CACHE.sheets[name]) return CACHE.sheets[name];
  var book = ss();
  var sh = book.getSheetByName(name);
  if (!sh) {
    sh = book.insertSheet(name);
    sh.getRange(1, 1, 1, SCHEMA[name].length).setValues([SCHEMA[name]]);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, SCHEMA[name].length).setFontWeight('bold').setBackground('#eef2ff');
    delete CACHE.headers[name];
    invalidate(name);
  }
  CACHE.sheets[name] = sh;
  return sh;
}

function headersOf(sh, name) {
  var cached = CACHE.headers[name];
  // a copy per call: ensureSchema pushes onto what it gets back
  if (cached) return cached.slice();
  var last = sh.getLastColumn();
  var headers;
  if (last === 0) {
    sh.getRange(1, 1, 1, SCHEMA[name].length).setValues([SCHEMA[name]]);
    headers = SCHEMA[name].slice();
  } else {
    headers = sh.getRange(1, 1, 1, last).getValues()[0].map(function (h) { return String(h).trim(); });
  }
  CACHE.headers[name] = headers;
  return headers.slice();
}

/** A tab's data rows as raw cell values — the one read the memo is built on. */
function valuesOf(name) {
  var cached = CACHE.values[name];
  if (cached) return cached;
  var sh = sheetFor(name);
  var headers = headersOf(sh, name);
  var lastRow = sh.getLastRow();
  var values = lastRow < 2 ? [] : sh.getRange(2, 1, lastRow - 1, headers.length).getValues();
  CACHE.values[name] = values;
  return values;
}

/**
 * The last `n` rows of a tab, without reading the ones in front of them.
 *
 * The audit trail is kept five thousand rows deep but only the newest two
 * hundred are ever shown, so reading all of it to throw 96% away was the
 * single largest read in a page load.
 */
function readTableTail(name, n) {
  if (CACHE.values[name]) return readTable(name).slice(-n);
  var sh = sheetFor(name);
  var headers = headersOf(sh, name);
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  var first = Math.max(2, lastRow - n + 1);
  var values = sh.getRange(first, 1, lastRow - first + 1, headers.length).getValues();
  var out = [];
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    if (row.join('') === '') continue;
    var obj = {};
    for (var c = 0; c < headers.length; c++) obj[headers[c]] = normalise(row[c]);
    obj._row = first + i;
    out.push(obj);
  }
  return out;
}

/**
 * Read a whole tab as an array of plain objects.
 *
 * Each row carries `_v`, a fingerprint of its values. A form sends back the
 * `_v` of the row it was opened on, and updateRow refuses the save if the row
 * has changed since — so two people editing the same record no longer
 * silently overwrite each other.
 */
function readTable(name) {
  var sh = sheetFor(name);
  var headers = headersOf(sh, name);
  var values = valuesOf(name);
  var versions = CACHE.versions[name];
  var fill = !versions;
  if (fill) versions = CACHE.versions[name] = [];
  var out = [];
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    if (row.join('') === '') continue;
    var obj = {};
    var plain = [];
    for (var c = 0; c < headers.length; c++) {
      var v = normalise(row[c]);
      obj[headers[c]] = v;
      if (fill) plain.push(v);
    }
    if (fill) versions[i] = rowVersion(plain);
    obj._row = i + 2;
    obj._v = versions[i];
    out.push(obj);
  }
  return out;
}

/** Fingerprint of one row's normalised values. FNV-1a: fast, and collisions here only cost a reload. */
function rowVersion(plainValues) {
  return fingerprint(JSON.stringify(plainValues));
}

function fingerprint(str) {
  var h = 0x811c9dc5;
  for (var i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * Fingerprint of a whole tab — its headers and every row's version. The
 * browser sends back the fingerprints it holds, and bootstrap leaves out any
 * tab that has not changed since.
 */
function tableHash(name) {
  var headers = headersOf(sheetFor(name), name);
  var rows = readTable(name);
  var parts = [headers.join('|')];
  for (var i = 0; i < rows.length; i++) parts.push(rows[i]._row + ':' + rows[i]._v);
  return fingerprint(parts.join(','));
}

/**
 * The spreadsheet's own time zone.
 *
 * A date typed into a cell is midnight in the SPREADSHEET's zone. Formatting it
 * in the script's zone instead moved every date back a day whenever the sheet
 * sat east of the script (a sheet made in Sydney, a script left on Kolkata) —
 * and every save wrote the shifted date back, so it drifted a day per edit.
 */
function sheetTimeZone() {
  if (CACHE.tz) return CACHE.tz;
  var tz = null;
  try { tz = ss().getSpreadsheetTimeZone(); } catch (e) { tz = null; }
  return (CACHE.tz = tz || Session.getScriptTimeZone());
}

/** Dates become ISO yyyy-MM-dd, everything else a primitive. */
function normalise(v) {
  if (v instanceof Date) return Utilities.formatDate(v, sheetTimeZone(), 'yyyy-MM-dd');
  return v;
}

/**
 * Sheet row number for an id, or -1.
 *
 * Deliberately not memoised. This is what a write uses to find the row it is
 * about to overwrite, and it runs inside the write lock so that the answer is
 * still true when the write lands. Answering from a copy taken before the lock
 * would let a row deleted by another request shift everything underneath it,
 * and the update would go to the wrong tenant.
 */
function findRowIndex(name, id) {
  var sh = sheetFor(name);
  var headers = headersOf(sh, name);
  var keyCol = headers.indexOf(name === 'Settings' ? 'key' : 'id') + 1;
  if (keyCol === 0) throw new Error('No id column on ' + name);
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return -1;
  var col = sh.getRange(2, keyCol, lastRow - 1, 1).getValues();
  for (var i = 0; i < col.length; i++) if (String(col[i][0]) === String(id)) return i + 2;
  return -1;
}

/**
 * Reserve `count` sequential ids for a table.
 *
 * Numbering continues from the highest id ever issued, not the highest one
 * still in the sheet. Otherwise deleting the newest invoice handed its number
 * to the next one — two different documents with the same invoice number,
 * which is exactly what GST record-keeping forbids. The high-water mark lives
 * in Script Properties; the id column is still read, so rows added by hand or
 * a sheet restored from a copy can only push the number up.
 *
 * Called inside the write lock, so no other execution can be handed the same
 * id; neither read is served from the memo for the same reason.
 */
function reserveIds(name, count) {
  var prefix = ID_PREFIX[name] || 'ROW';
  // the one id people see on paper, so it is configurable
  if (name === 'Invoices') {
    var configured = String(readSettings().invoice_prefix || '').trim();
    if (configured) prefix = configured;
  }
  var sh = sheetFor(name);
  var headers = headersOf(sh, name);
  var idCol = headers.indexOf('id') + 1;

  var max = 0;
  var lastRow = sh.getLastRow();
  if (idCol > 0 && lastRow >= 2) {
    var col = sh.getRange(2, idCol, lastRow - 1, 1).getValues();
    for (var i = 0; i < col.length; i++) {
      var m = String(col[i][0] || '').match(/(\d+)$/);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
  }
  var props = PropertiesService.getScriptProperties();
  var key = 'SEQ_' + name;
  max = Math.max(max, parseInt(props.getProperty(key) || '0', 10) || 0);
  props.setProperty(key, String(max + count));

  var ids = [];
  for (var n = 1; n <= count; n++) ids.push(prefix + '-' + pad(max + n, 5));
  return ids;
}

function nextId(name) { return reserveIds(name, 1)[0]; }

function pad(n, w) { var s = String(n); while (s.length < w) s = '0' + s; return s; }

/**
 * A value as it must be written to a cell.
 *
 * Sheets runs any text that starts with "=" as a formula, with the owner's
 * access to the whole workbook. A tenant note of `=Users!G2` would then read
 * back through bootstrap as an administrator's password hash, so a manager
 * could lift it. A leading apostrophe stores the text as typed, and Sheets
 * strips it again on read, so nothing downstream sees the difference.
 */
function cellSafe(v) {
  return (typeof v === 'string' && v.charAt(0) === '=') ? "'" + v : v;
}
function nowIso() { return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ss"); }
function today()  { return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'); }

// ───────────────────────────────────────────────────────────────── lock ────

var LOCK_DEPTH = 0;

/**
 * Run `fn` holding the script lock, however deeply calls nest.
 *
 * The script lock is not re-entrant, and every createRow / updateRow used to
 * take and release it on its own. A check-then-write spanning several of those
 * — "is there room on this invoice? then record the payment" — therefore let
 * another request slip in between the check and the write, and two payments at
 * the same moment could both pass it. Wrapping the whole operation here holds
 * the lock throughout; the calls inside join it instead of releasing it early.
 *
 * `fresh` names tabs to re-read once the lock is held, so the check sees what
 * other requests wrote while this one was waiting.
 */
function withLock(fn, fresh) {
  if (LOCK_DEPTH > 0) {
    LOCK_DEPTH++;
    try { return fn(); } finally { LOCK_DEPTH--; }
  }
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  LOCK_DEPTH = 1;
  try {
    (fresh || []).forEach(invalidate);
    return fn();
  } finally {
    LOCK_DEPTH = 0;
    lock.releaseLock();
  }
}

// ───────────────────────────────────────────────────────────────── CRUD ────

function createRow(table, data, user, skipLog) {
  assertTable(table);
  requireRole(user, minRoleFor(table));
  return withLock(function () {
    var sh = sheetFor(table);
    var headers = headersOf(sh, table);
    var row = {};
    headers.forEach(function (h) { row[h] = data[h] !== undefined ? data[h] : ''; });
    if (headers.indexOf('id') >= 0) row.id = data.id || nextId(table);
    if (headers.indexOf('created_at') >= 0) row.created_at = nowIso();
    if (headers.indexOf('updated_at') >= 0) row.updated_at = nowIso();
    sh.appendRow(headers.map(function (h) { return cellSafe(row[h]); }));
    invalidate(table);
    if (!skipLog) log(user, 'create', table, row.id, data.name || data.full_name || '');
    return row;
  });
}

/**
 * Create many rows in one tab with a single write.
 *
 * createRow costs an id-column read and an appendRow per row, each a round
 * trip to Sheets. Raising a year of rent for a portfolio made that hundreds of
 * calls and put the 6-minute execution limit within reach. This takes the lock
 * once, numbers the rows in memory and writes them as one block.
 *
 * Unlike appendRow, a block write does not grow the sheet, so the rows are
 * added first when the block would run past the last one.
 */
function appendRows(table, list, user) {
  assertTable(table);
  requireRole(user, minRoleFor(table));
  if (!list.length) return [];
  return withLock(function () {
    var sh = sheetFor(table);
    var headers = headersOf(sh, table);
    var ids = headers.indexOf('id') >= 0 ? reserveIds(table, list.length) : null;
    var stamp = nowIso();

    var rows = list.map(function (data, i) {
      var row = {};
      headers.forEach(function (h) { row[h] = data[h] !== undefined ? data[h] : ''; });
      if (ids) row.id = ids[i];
      if (headers.indexOf('created_at') >= 0) row.created_at = stamp;
      if (headers.indexOf('updated_at') >= 0) row.updated_at = stamp;
      return row;
    });

    var start = sh.getLastRow() + 1;
    var shortBy = start + rows.length - 1 - sh.getMaxRows();
    if (shortBy > 0) sh.insertRowsAfter(sh.getMaxRows(), shortBy);
    sh.getRange(start, 1, rows.length, headers.length).setValues(rows.map(function (row) {
      return headers.map(function (h) { return cellSafe(row[h]); });
    }));
    invalidate(table);
    return rows;
  });
}

/**
 * @param expectedVersion the `_v` the caller last saw. When given and the row
 *   has changed since, nothing is written and a CONFLICT error is thrown.
 */
function updateRow(table, id, data, user, skipLog, expectedVersion) {
  assertTable(table);
  requireRole(user, minRoleFor(table));
  if (table === 'Users' && (data.role !== undefined || data.active !== undefined)) {
    assertAdminRemains(id, data);
  }
  return withLock(function () {
    var sh = sheetFor(table);
    var headers = headersOf(sh, table);
    var r = findRowIndex(table, id);
    if (r < 0) throw new Error(table + ' ' + id + ' not found');
    var current = sh.getRange(r, 1, 1, headers.length).getValues()[0];
    var row = {};
    var plain = [];
    headers.forEach(function (h, i) { row[h] = normalise(current[i]); plain.push(row[h]); });
    if (expectedVersion && rowVersion(plain) !== String(expectedVersion)) {
      throw new Error('CONFLICT: ' + id + ' was changed by someone else' +
                      (row.updated_at ? ' at ' + String(row.updated_at).replace('T', ' ') : '') +
                      ' after you opened it. Close this form and open it again to see their changes.');
    }
    Object.keys(data).forEach(function (k) { if (headers.indexOf(k) >= 0 && k !== 'id') row[k] = data[k]; });
    if (headers.indexOf('updated_at') >= 0) row.updated_at = nowIso();
    sh.getRange(r, 1, 1, headers.length).setValues([headers.map(function (h) { return cellSafe(row[h]); })]);
    invalidate(table);
    if (!skipLog) log(user, 'update', table, id, JSON.stringify(data).slice(0, 200));
    return row;
  });
}

/** A row as it now stands in the sheet, `_v` included — what a write hands back to the browser. */
function freshRow(table, id) {
  var key = table === 'Settings' ? 'key' : 'id';
  var found = null;
  readTable(table).forEach(function (r) { if (String(r[key]) === String(id)) found = r; });
  return found;
}

/**
 * Refuse any change that would leave the workspace with no way in. Without
 * this an administrator can delete or demote the only admin account and nobody
 * — including them — can ever sign in again.
 */
function assertAdminRemains(userId, changes) {
  var users = readTable('Users');
  var stillAdmin = 0;
  for (var i = 0; i < users.length; i++) {
    var u = users[i];
    var role = u.role, active = String(u.active).toLowerCase() !== 'false';
    if (String(u.id) === String(userId)) {
      if (changes === null) continue;                       // being deleted
      if (changes.role !== undefined) role = changes.role;
      if (changes.active !== undefined) active = String(changes.active).toLowerCase() !== 'false';
    }
    if (role === 'admin' && active) stillAdmin++;
  }
  if (stillAdmin === 0) {
    throw new Error('This is the only active administrator. Promote another user first.');
  }
}

function deleteRow(table, id, user) {
  assertTable(table);
  requireRole(user, 'admin');
  if (table === 'Users') assertAdminRemains(id, null);

  return withLock(function () {
    // An issued invoice is a numbered document: it is voided, never deleted,
    // so the number sequence has no unexplained gaps. A draft was never sent.
    if (table === 'Invoices') {
      var inv = freshRow('Invoices', id);
      if (inv && String(inv.status) !== 'Draft') {
        throw new Error('Invoice ' + id + ' has been issued, so it cannot be deleted. Void it instead — ' +
                        'the number stays on record and nothing is owed on it.');
      }
    }

    // Refuse to leave other rows pointing at something that no longer exists.
    // An invoice's own line items are the one exception: they are part of it.
    assertNoDependents(table, id);
    if (table === 'Invoices') {
      readTable('InvoiceItems').forEach(function (item) {
        if (item.invoice_id === id) deleteRow('InvoiceItems', item.id, SYSTEM_ACTOR);
      });
    }
    if (table === 'Maintenance') {
      readTable('Expenses').forEach(function (e) {
        if (String(e.reference) === String(id) && String(e.category) !== 'Deposit Refund') {
          deleteRow('Expenses', e.id, SYSTEM_ACTOR);
        }
      });
    }

    // remember what the deletion will invalidate, before the row is gone
    var affectedInvoice = null;
    if (table === 'Payments') {
      readTable('Payments').forEach(function (p) {
        if (String(p.id) === String(id)) affectedInvoice = p.invoice_id;
      });
    }

    var sh = sheetFor(table);
    var r = findRowIndex(table, id);
    if (r < 0) throw new Error(table + ' ' + id + ' not found');
    sh.deleteRow(r);
    invalidate(table);
    log(user, 'delete', table, id, '');

    // Deleting money received has to put the invoice back where it was, or the
    // ledger keeps showing it as settled.
    if (affectedInvoice) applyInvoiceTotals(affectedInvoice, user);
    // Removing a lease frees its unit.
    if (table === 'Leases' || table === 'Units') refreshStatuses(user, true);

    return id;
  });
}

// ── business rules ──────────────────────────────────────────────────────────

/**
 * Statuses a new record starts in. Without these a record saved from a form
 * where the user left the dropdown alone lands in the sheet with a blank
 * status, which then reads as "—" everywhere and is skipped by anything that
 * filters on status.
 */
var CREATE_DEFAULTS = {
  Properties:  { status: 'Active' },
  Units:       { status: 'Vacant' },
  Tenants:     { status: 'Active' },
  Invoices:    { status: 'Unpaid' },
  Maintenance: { status: 'Open', priority: 'Medium' },
  Leases:      { frequency: 'Monthly', deposit_status: 'Pending' }
};

/** Rows in other tabs that point at this one. Deleting is blocked while any exist. */
var DEPENDENTS = {
  Properties: [['Units', 'property_id', 'unit'], ['Leases', 'property_id', 'lease'],
               ['Invoices', 'property_id', 'invoice'], ['Expenses', 'property_id', 'expense'],
               ['Maintenance', 'property_id', 'maintenance ticket'], ['Documents', 'entity_id', 'document']],
  Units:      [['Leases', 'unit_id', 'lease'], ['Invoices', 'unit_id', 'invoice'],
               ['Maintenance', 'unit_id', 'maintenance ticket'], ['Expenses', 'unit_id', 'expense'],
               ['MeterReadings', 'unit_id', 'meter reading'], ['Documents', 'entity_id', 'document']],
  Tenants:    [['Leases', 'tenant_id', 'lease'], ['Invoices', 'tenant_id', 'invoice'],
               ['Payments', 'tenant_id', 'payment'], ['Maintenance', 'tenant_id', 'maintenance ticket'],
               ['Documents', 'entity_id', 'document']],
  Leases:     [['Invoices', 'lease_id', 'invoice'], ['Payments', 'lease_id', 'payment'],
               ['Documents', 'entity_id', 'document'], ['Leases', 'renewed_from', 'renewal']],
  Invoices:   [['Payments', 'invoice_id', 'payment']]
};

function assertNoDependents(table, id) {
  var refs = DEPENDENTS[table];
  if (!refs) return;
  var blocking = [];
  var total = 0;
  for (var i = 0; i < refs.length; i++) {
    var tab = refs[i][0], key = refs[i][1], noun = refs[i][2];
    var n = 0;
    readTable(tab).forEach(function (r) { if (String(r[key]) === String(id)) n++; });
    if (n) { blocking.push(n + ' ' + noun + (n === 1 ? '' : 's')); total += n; }
  }
  if (blocking.length) {
    throw new Error('Cannot delete ' + id + ' — ' + blocking.join(' and ') +
                    (total === 1 ? ' still references it. Remove or reassign it first.'
                                 : ' still reference it. Remove or reassign those first.'));
  }
}

/** Where a lease sits today. An explicit termination is never overridden. */
function deriveLeaseStatus(startDate, endDate, currentStatus) {
  if (String(currentStatus) === 'Terminated') return 'Terminated';
  var t = today();
  if (endDate && String(endDate) < t) return 'Expired';
  if (startDate && String(startDate) > t) return 'Upcoming';
  return 'Active';
}

/**
 * A unit cannot be let to two tenants at once. Leases that have ended or been
 * terminated are ignored; anything still live must not overlap the new dates.
 */
function assertUnitIsFree(data, selfId) {
  if (!data.unit_id) return;
  if (['Terminated', 'Expired'].indexOf(String(data.status)) >= 0) return;

  var start = String(data.start_date || '');
  var end = String(data.end_date || '9999-12-31');
  var clash = null;
  readTable('Leases').forEach(function (l) {
    if (clash || String(l.id) === String(selfId)) return;
    if (String(l.unit_id) !== String(data.unit_id)) return;
    if (['Terminated', 'Expired'].indexOf(String(l.status)) >= 0) return;
    var s = String(l.start_date || '');
    var e = String(l.end_date || '9999-12-31');
    if (start <= e && s <= end) clash = l;
  });
  if (clash) {
    throw new Error('That unit is already let on lease ' + clash.id + ' (' +
                    (clash.start_date || '?') + ' to ' + (clash.end_date || 'open ended') +
                    '). Terminate or end that lease first.');
  }
}

/**
 * Fill in the property a record belongs to when the form left it blank but it
 * can be worked out from what was chosen. Without this, an ad-hoc invoice
 * raised against a tenant alone produces a payment with no property, which then
 * counts in the headline income but in none of the per-property rows — so the
 * P&L table never adds up to the total above it.
 */
function inferProperty(data) {
  if (data.property_id) return data.property_id;
  if (data.unit_id) {
    var unit = null;
    readTable('Units').forEach(function (u) { if (u.id === data.unit_id) unit = u; });
    if (unit && unit.property_id) return unit.property_id;
  }
  if (data.lease_id) {
    var lease = null;
    readTable('Leases').forEach(function (l) { if (l.id === data.lease_id) lease = l; });
    if (lease && lease.property_id) return lease.property_id;
  }
  return '';
}

/**
 * create/update with the per-table rules the app promises: sensible starting
 * statuses, invoice totals derived rather than typed, lease dates validated and
 * occupancy kept in step.
 */
function writeRow(op, payload, user) {
  var table = assertTable(payload.table);
  // One lock for the whole save and everything it sets off, so the checks
  // below still hold when the writes land.
  return withLock(function () { return writeRowLocked(op, table, payload, user); });
}

function writeRowLocked(op, table, payload, user) {
  var data = payload.data || {};

  // Ids are issued here, never taken from the browser: a supplied one could
  // duplicate an existing row, and every later update would land on whichever
  // copy findRowIndex meets first.
  if (op === 'create') delete data.id;

  if (op === 'create' && CREATE_DEFAULTS[table]) {
    var defaults = CREATE_DEFAULTS[table];
    Object.keys(defaults).forEach(function (k) {
      if (data[k] === '' || data[k] === null || data[k] === undefined) data[k] = defaults[k];
    });
  }

  if (table === 'Tenants' && data.gstin !== undefined) data.gstin = assertGstin(data.gstin, 'The tenant\'s GSTIN');
  if (table === 'Settings' && String(payload.id || data.key) === 'gstin' && data.value !== undefined) {
    data.value = assertGstin(data.value, 'Your GSTIN');
  }
  if (table === 'Settings' && String(payload.id || data.key) === 'upi_id' && data.value !== undefined) {
    data.value = assertUpiId(data.value);
  }

  if (table === 'Invoices') {
    var amount = parseFloat(data.amount || 0) || 0;
    var tax = parseFloat(data.tax || 0) || 0;
    if (data.total === '' || data.total === null || data.total === undefined) {
      data.total = round2(amount + tax);
    }
    data.property_id = inferProperty(data);
  }

  if (table === 'Maintenance') {
    if (op === 'create' && !data.reported_date) data.reported_date = today();
    // A ticket closed without a completion date dates its cost by when it was
    // reported, which can drop the spend into the wrong reporting period.
    if (['Resolved', 'Closed'].indexOf(String(data.status)) >= 0 && !data.completed_date) {
      data.completed_date = today();
    }
  }

  if (table === 'Invoices' && op === 'update' && String(data.status) === 'Void') {
    assertVoidable(payload.id);
  }

  var before = null;
  if (table === 'Leases') {
    var merged = data;
    if (op === 'update') {
      // validate against the row as it will be, not just the fields that changed
      before = freshRow('Leases', payload.id);
      if (before) {
        merged = {};
        Object.keys(before).forEach(function (k) { merged[k] = before[k]; });
        Object.keys(data).forEach(function (k) { merged[k] = data[k]; });
      }
    }
    if (merged.start_date && merged.end_date && String(merged.end_date) < String(merged.start_date)) {
      throw new Error('A lease cannot end before it starts.');
    }
    data.status = deriveLeaseStatus(merged.start_date, merged.end_date, merged.status);
    merged.status = data.status;
    assertUnitIsFree(merged, op === 'update' ? payload.id : null);
    assertDepositStatusChange(before, merged);
    if (before) assertDepositAmountChange(before, merged);
  }

  var paymentBefore = null;
  if (table === 'Payments') {
    if (op === 'update') paymentBefore = freshRow('Payments', payload.id);
    preparePayment(data, paymentBefore);
  }

  var row = op === 'create'
    ? createRow(table, data, user)
    : updateRow(table, payload.id, data, user, false, payload.expected_version);

  // Recompute paid/balance/status from the Payments tab so the figures can
  // never be inconsistent with the money actually received.
  if (table === 'Invoices' && String(row.status) !== 'Draft') {
    row = applyInvoiceTotals(row.id, user) || row;
  }
  // The same holds for a payment saved from the Payments page rather than from
  // an invoice: the invoice it settles, and the one it was moved off, if any.
  if (table === 'Payments') {
    if (row.invoice_id) applyInvoiceTotals(row.invoice_id, user);
    if (paymentBefore && paymentBefore.invoice_id &&
        String(paymentBefore.invoice_id) !== String(row.invoice_id)) {
      applyInvoiceTotals(paymentBefore.invoice_id, user);
    }
  }
  // Occupancy is derived from leases, so it has to be re-derived as soon as one
  // changes — not left until the next page load.
  if (table === 'Leases' || table === 'Units') refreshStatuses(user, true);

  if (table === 'Leases') {
    // Signing a lease with a deposit makes that deposit due, like the first
    // rent. So does adding one to a lease that had none — unless it is already
    // marked as collected, which is how a lease entered from paper records (or
    // renewed with its deposit carried over) says the money changed hands
    // before this invoice could.
    var collected = String(row.deposit_status) !== 'Pending' && String(row.deposit_status) !== '';
    if (!collected && (op === 'create' || (before && !(num(before.deposit_amount) > 0)))) {
      raiseDepositInvoice(row, user);
    }
    // a changed deposit re-prices its invoice while nothing has been paid past it
    if (before && num(before.deposit_amount) > 0 && round2(num(before.deposit_amount)) !== round2(num(row.deposit_amount))) {
      repriceDepositInvoice(row, user);
    }
  }

  // A finished ticket's cost becomes an ordinary expense, so it is counted in
  // exactly one place.
  if (table === 'Maintenance') recordMaintenanceExpense(row, user);

  // Marking a deposit refunded from the lease form returns whatever is still
  // held. Deductions go through settleDeposit instead.
  if (table === 'Leases' && before && String(row.deposit_status) === 'Refunded' &&
      String(before.deposit_status) !== 'Refunded') {
    recordDepositRefund(row, user);
  }

  return row;
}

function num(v) { return parseFloat(v || 0) || 0; }

/**
 * Raise the invoice for a lease's security deposit.
 *
 * Until now a deposit counted as "held" the moment the lease was saved, whether
 * or not the money ever arrived — so the dashboard could show a liability that
 * was never collected, and the tenant never got a receipt. Billing it like rent
 * means it shows up in outstanding until paid, and only then counts as held.
 *
 * Raised once per lease: re-saving a lease never bills the deposit twice.
 */
function raiseDepositInvoice(lease, user) {
  var amount = round2(parseFloat(lease.deposit_amount || 0) || 0);
  if (amount <= 0) return null;

  var already = false;
  readTable('Invoices').forEach(function (inv) {
    if (String(inv.lease_id) === String(lease.id) && String(inv.type) === 'Deposit') already = true;
  });
  if (already) return null;

  var invoice = createRow('Invoices', {
    lease_id: lease.id, tenant_id: lease.tenant_id, unit_id: lease.unit_id,
    property_id: lease.property_id, type: 'Deposit',
    issue_date: lease.start_date || today(), due_date: lease.start_date || today(),
    amount: amount, tax: 0, total: amount, amount_paid: 0, balance: amount,
    status: 'Unpaid', notes: 'Security deposit for lease ' + lease.id
  }, user, true);

  createRow('InvoiceItems', {
    invoice_id: invoice.id, description: 'Security deposit',
    category: 'Deposit', quantity: 1, unit_amount: amount, amount: amount, notes: ''
  }, user, true);

  log(user, 'deposit-invoiced', 'Invoices', invoice.id, 'lease ' + lease.id + ' · ' + amount);
  // a lease entered after it began has a deposit that is already overdue
  return applyInvoiceTotals(invoice.id, user) || invoice;
}

/**
 * Keep a lease's deposit_status in step with whether its deposit invoice has
 * been paid, so "deposits held" only ever counts money actually received.
 * A deposit already refunded is left alone.
 */
function syncDepositStatus(invoice, user) {
  if (String(invoice.type) !== 'Deposit' || !invoice.lease_id) return;
  var lease = null;
  readTable('Leases').forEach(function (l) { if (l.id === invoice.lease_id) lease = l; });
  if (!lease) return;
  if (DEPOSIT_SETTLED.indexOf(String(lease.deposit_status)) >= 0) return;

  var want = String(invoice.status) === 'Paid' ? 'Held' : 'Pending';
  if (String(lease.deposit_status) !== want) {
    updateRow('Leases', lease.id, { deposit_status: want }, SYSTEM_ACTOR, true);
  }
}

/**
 * Book a completed maintenance ticket's cost as an expense.
 *
 * The cost used to be counted straight from the ticket, in parallel with the
 * Expenses tab — so logging the plumber's bill in both places counted it twice,
 * with nothing to warn you. Costs now live in exactly one place: this writes the
 * expense, and the reports read only expenses.
 *
 * Linked back by `reference`, so re-saving the ticket updates the same row
 * rather than adding another.
 */
var MAINTENANCE_EXPENSE_CATEGORY = {
  Cleaning: 'Cleaning', Security: 'Security', Other: 'Other'
};

function recordMaintenanceExpense(ticket, user) {
  var cost = round2(parseFloat(ticket.cost || 0) || 0);
  var done = ['Resolved', 'Closed'].indexOf(String(ticket.status)) >= 0;

  var existing = null;
  readTable('Expenses').forEach(function (e) {
    if (String(e.reference) === String(ticket.id) && String(e.category) !== 'Deposit Refund') {
      existing = e;
    }
  });

  // not finished, or nothing spent: make sure no stale expense is left behind
  if (!done || cost <= 0) {
    if (existing) deleteRow('Expenses', existing.id, SYSTEM_ACTOR);
    return null;
  }

  var row = {
    property_id: ticket.property_id, unit_id: ticket.unit_id,
    date: ticket.completed_date || today(),
    category: MAINTENANCE_EXPENSE_CATEGORY[String(ticket.category)] || 'Repairs',
    description: ticket.title + (ticket.vendor_name ? ' · ' + ticket.vendor_name : ''),
    vendor: ticket.vendor_name || '', amount: cost, reference: ticket.id
  };
  return existing
    ? updateRow('Expenses', existing.id, row, SYSTEM_ACTOR, true)
    : createRow('Expenses', row, SYSTEM_ACTOR, true);
}

/**
 * Validate a payment saved from the Payments page, and tie it to its invoice.
 *
 * Only recordPayment used to check anything, so a payment entered on the
 * Payments page was stored without touching the invoice: the tenant still
 * showed the full balance, the money was counted as income, and recording it
 * again from the invoice counted it twice. Any amount was accepted, too.
 *
 * A payment with no invoice is money on account and is left as entered.
 */
function preparePayment(data, before) {
  var invoiceId = data.invoice_id !== undefined ? data.invoice_id : (before ? before.invoice_id : '');
  if (!invoiceId) return;

  var invoice = null;
  readTable('Invoices').forEach(function (i) { if (String(i.id) === String(invoiceId)) invoice = i; });
  if (!invoice) throw new Error('Invoice ' + invoiceId + ' not found');

  var amount = round2(parseFloat(data.amount !== undefined ? data.amount : (before ? before.amount : 0)) || 0);
  if (!(amount > 0)) throw new Error('Payment amount must be greater than zero');

  var alreadyOnIt = before && String(before.invoice_id) === String(invoiceId)
    ? round2(parseFloat(before.amount || 0) || 0) : 0;
  var changesMoney = !before || alreadyOnIt !== amount || String(before.invoice_id) !== String(invoiceId);
  if (changesMoney) {
    if (String(invoice.status) === 'Void') throw new Error('That invoice is void.');
    if (String(invoice.status) === 'Draft') throw new Error(invoice.id + ' is still a draft. Issue it before taking payment.');
    var room = round2((parseFloat(invoice.balance || 0) || 0) + alreadyOnIt);
    if (amount > room + 0.009) {
      throw new Error('That is more than the ' + room + ' still owed on ' + invoice.id +
                      '. To spread a larger payment over several invoices, record it from the invoice.');
    }
  }

  // the invoice decides whose money this is, as it does for recordPayment
  data.tenant_id = invoice.tenant_id;
  data.lease_id = invoice.lease_id;
  data.property_id = invoice.property_id || inferProperty(invoice);
}

// ── deposits ────────────────────────────────────────────────────────────────

/** Deposit statuses the app sets itself, once money has moved. */
var DEPOSIT_SETTLED = ['Refunded', 'Partially Refunded', 'Forfeited', 'Transferred'];

/**
 * Where a lease's security deposit stands, from the records rather than from
 * its status field.
 *
 *   received  paid against the lease's Deposit invoice(s) — or, for a lease
 *             whose deposit was collected outside the app (marked Held by
 *             hand, or carried over on renewal), the agreed amount
 *   applied   used to settle the tenant's invoices at move-out
 *   refunded  paid back
 *   held      what is still owed back to the tenant
 *
 * A deposit is money held for the tenant, not income: it never appears in
 * income or expenses. Only the part applied to an invoice becomes income, as
 * a payment on that invoice.
 */
function depositLedger(lease) {
  var paid = 0, hasInvoice = false;
  readTable('Invoices').forEach(function (inv) {
    if (String(inv.lease_id) === String(lease.id) && String(inv.type) === 'Deposit' && String(inv.status) !== 'Void') {
      hasInvoice = true;
      paid += num(inv.amount_paid);
    }
  });
  var status = String(lease.deposit_status || '');
  var received = paid > 0 ? paid : (status && status !== 'Pending' ? num(lease.deposit_amount) : 0);

  var applied = 0, refunded = 0;
  readTable('Payments').forEach(function (p) {
    if (String(p.method) === 'Deposit Adjustment' && String(p.reference) === String(lease.id)) applied += num(p.amount);
  });
  readTable('Expenses').forEach(function (e) {
    if (String(e.category) === 'Deposit Refund' && String(e.reference) === String(lease.id)) refunded += num(e.amount);
  });

  var held = status === 'Transferred' ? 0 : round2(received - applied - refunded);
  return { received: round2(received), applied: round2(applied), refunded: round2(refunded),
           held: Math.max(0, held), hasInvoice: hasInvoice };
}

/** depositLedger for many leases in one pass over the tabs — for the dashboard figures. */
function depositLedgers(leases) {
  var paid = {}, applied = {}, refunded = {};
  readTable('Invoices').forEach(function (inv) {
    if (String(inv.type) === 'Deposit' && String(inv.status) !== 'Void') paid[inv.lease_id] = (paid[inv.lease_id] || 0) + num(inv.amount_paid);
  });
  readTable('Payments').forEach(function (p) {
    if (String(p.method) === 'Deposit Adjustment') applied[p.reference] = (applied[p.reference] || 0) + num(p.amount);
  });
  readTable('Expenses').forEach(function (e) {
    if (String(e.category) === 'Deposit Refund') refunded[e.reference] = (refunded[e.reference] || 0) + num(e.amount);
  });
  var out = {};
  leases.forEach(function (l) {
    var status = String(l.deposit_status || '');
    var received = paid[l.id] > 0 ? paid[l.id] : (status && status !== 'Pending' ? num(l.deposit_amount) : 0);
    var held = status === 'Transferred' ? 0 : round2(received - (applied[l.id] || 0) - (refunded[l.id] || 0));
    out[l.id] = { received: round2(received), held: Math.max(0, held) };
  });
  return out;
}

/**
 * The statuses that record money leaving the deposit are written by
 * settleDeposit and renewLease, which book the money that goes with them. Typed
 * into the lease form they changed a label and moved nothing, so they are
 * refused there. Refunded stays allowed — it returns the whole balance.
 */
function assertDepositStatusChange(before, merged) {
  var was = before ? String(before.deposit_status || '') : '';
  var now = String(merged.deposit_status || '');
  if (now === was) return;
  if (['Partially Refunded', 'Forfeited', 'Transferred'].indexOf(now) >= 0) {
    throw new Error('Use "Settle deposit" on the lease to record deductions and refunds — ' +
                    'it books the money as well as the status.');
  }
  if (now === 'Refunded' && before && depositLedger(before).held <= 0) {
    throw new Error('No deposit is held on ' + before.id + ', so there is nothing to refund. ' +
                    'Record the deposit payment first, or mark it Held if it was collected outside the app.');
  }
}

/** A deposit cannot be cut below what has already been paid against it. */
function assertDepositAmountChange(before, merged) {
  if (round2(num(before.deposit_amount)) === round2(num(merged.deposit_amount))) return;
  var paid = 0;
  readTable('Invoices').forEach(function (inv) {
    if (String(inv.lease_id) === String(before.id) && String(inv.type) === 'Deposit' && String(inv.status) !== 'Void') {
      paid += num(inv.amount_paid);
    }
  });
  if (num(merged.deposit_amount) < paid - 0.009) {
    throw new Error(round2(paid) + ' of the deposit has already been received on ' + before.id +
                    ', so it cannot be reduced below that.');
  }
}

/**
 * Keep the Deposit invoice in step with the lease's deposit. It is re-priced
 * rather than replaced, so its number and any part payment stay; a deposit
 * taken away before anything was paid voids it.
 */
function repriceDepositInvoice(lease, user) {
  var amount = round2(num(lease.deposit_amount));
  readTable('Invoices').forEach(function (inv) {
    if (String(inv.lease_id) !== String(lease.id) || String(inv.type) !== 'Deposit' || String(inv.status) === 'Void') return;
    if (amount <= 0 && num(inv.amount_paid) <= 0) {
      updateRow('Invoices', inv.id, { status: 'Void', notes: 'Deposit removed from lease ' + lease.id }, SYSTEM_ACTOR, true);
      applyInvoiceTotals(inv.id, user);
      return;
    }
    var line = null;
    itemsOfInvoice(inv.id).forEach(function (it) { if (String(it.category) === 'Deposit') line = it; });
    if (line) {
      updateRow('InvoiceItems', line.id, { unit_amount: amount, amount: amount, quantity: 1 }, SYSTEM_ACTOR, true);
    }
    updateRow('Invoices', inv.id, { amount: amount }, SYSTEM_ACTOR, true);
    applyInvoiceTotals(inv.id, user);
    log(user, 'deposit-repriced', 'Invoices', inv.id, 'lease ' + lease.id + ' · ' + amount);
  });
}

/** Marking a deposit Refunded from the lease form pays back whatever is still held. */
function recordDepositRefund(lease, user) {
  var amount = depositLedger(lease).held;
  if (amount <= 0) return null;
  var tenant = freshRow('Tenants', lease.tenant_id);
  return createRow('Expenses', {
    property_id: lease.property_id, unit_id: lease.unit_id, date: today(),
    category: 'Deposit Refund',
    description: 'Security deposit returned' + (tenant ? ' to ' + tenant.full_name : '') +
                 ' · lease ' + lease.id,
    amount: amount, reference: lease.id
  }, user, true);
}

/**
 * Move-out: settle a lease's deposit in one step.
 *
 *   1. optionally apply it to the tenant's unpaid invoices, oldest first;
 *   2. charge any deductions (damage, cleaning, unpaid utilities) on a
 *      "Deposit Deduction" invoice and pay that from the deposit too;
 *   3. refund what is left;
 *   4. optionally end the lease on the move-out date.
 *
 * Money kept from the deposit becomes income through the invoices it pays —
 * never by relabelling the deposit — and the refund is recorded as money
 * returned, not as an operating expense.
 */
function settleDeposit(payload, user) {
  requireRole(user, 'manager');
  return withLock(function () {
    var lease = freshRow('Leases', payload.lease_id);
    if (!lease) throw new Error('Lease ' + payload.lease_id + ' not found');
    var ledger = depositLedger(lease);
    if (ledger.held <= 0.009) throw new Error('No deposit is held on ' + lease.id + ', so there is nothing to settle.');

    var date = String(payload.settlement_date || today()).slice(0, 10);
    var remaining = ledger.held;
    var applied = [];

    var adjust = function (invoice, amount, note) {
      createRow('Payments', {
        invoice_id: invoice.id, lease_id: invoice.lease_id || lease.id, tenant_id: invoice.tenant_id,
        property_id: invoice.property_id || lease.property_id, payment_date: date,
        amount: round2(amount), method: 'Deposit Adjustment', reference: lease.id,
        received_by: user.name || user.phone || '', notes: note
      }, user, true);
      applyInvoiceTotals(invoice.id, user);
      applied.push({ invoice_id: invoice.id, amount: round2(amount) });
      remaining = round2(remaining - amount);
    };

    if (payload.apply_to_arrears) {
      readTable('Invoices')
        .filter(function (i) {
          return String(i.tenant_id) === String(lease.tenant_id) && String(i.type) !== 'Deposit' &&
                 ['Unpaid', 'Partial', 'Overdue'].indexOf(String(i.status)) >= 0 && num(i.balance) > 0;
        })
        .sort(function (a, b) { return String(a.due_date).localeCompare(String(b.due_date)); })
        .forEach(function (inv) {
          if (remaining <= 0.009) return;
          adjust(inv, Math.min(remaining, round2(num(inv.balance))), 'Settled from the security deposit of ' + lease.id);
        });
    }

    var deductionInvoice = null;
    var deductions = (payload.deductions || []).filter(function (d) {
      return String(d.description || '').trim() && num(d.amount) > 0;
    });
    if (deductions.length) {
      deductionInvoice = saveInvoice({
        data: { tenant_id: lease.tenant_id, lease_id: lease.id, unit_id: lease.unit_id,
                property_id: lease.property_id, type: 'Deposit Deduction',
                issue_date: date, due_date: date,
                notes: 'Deductions from the security deposit of ' + lease.id },
        items: deductions.map(function (d) {
          return { description: String(d.description).trim(), category: d.category || 'Other',
                   quantity: 1, unit_amount: round2(num(d.amount)), tax_rate: 0 };
        })
      }, user).invoice;
      if (remaining > 0.009) {
        adjust(deductionInvoice, Math.min(remaining, round2(num(deductionInvoice.balance))),
               'Deducted from the security deposit of ' + lease.id);
      }
      deductionInvoice = freshRow('Invoices', deductionInvoice.id);
    }

    var refund = remaining > 0.009 ? round2(remaining) : 0;
    var refundRow = null;
    if (refund > 0) {
      var tenant = freshRow('Tenants', lease.tenant_id);
      refundRow = createRow('Expenses', {
        property_id: lease.property_id, unit_id: lease.unit_id, date: date, category: 'Deposit Refund',
        vendor: tenant ? tenant.full_name : '', payment_method: payload.refund_method || '',
        description: 'Security deposit returned' + (tenant ? ' to ' + tenant.full_name : '') + ' · lease ' + lease.id +
                     (payload.refund_reference ? ' · ref ' + payload.refund_reference : ''),
        amount: refund, reference: lease.id
      }, user, true);
    }

    var changes = {
      deposit_status: refund >= ledger.held - 0.009 ? 'Refunded' : (refund > 0 ? 'Partially Refunded' : 'Forfeited')
    };
    if (payload.end_lease && ['Active', 'Upcoming'].indexOf(String(lease.status)) >= 0) {
      changes.status = 'Terminated';
      var moveOut = String(payload.move_out_date || date).slice(0, 10);
      if (!lease.end_date || moveOut < String(lease.end_date)) changes.end_date = moveOut;
    }
    updateRow('Leases', lease.id, changes, SYSTEM_ACTOR, true);
    if (changes.status) refreshStatuses(user, true);

    log(user, 'deposit-settled', 'Leases', lease.id,
        'held ' + ledger.held + ' · applied ' + round2(ledger.held - remaining) + ' · refunded ' + refund);
    return {
      lease: freshRow('Leases', lease.id),
      held: ledger.held, applied: applied, refunded: refund,
      deduction_invoice: deductionInvoice, refund: refundRow
    };
  }, ['Leases', 'Invoices', 'Payments', 'Expenses']);
}

/**
 * Renew a lease: the next agreement for the same unit and tenant, starting the
 * day after this one ends, at the rent this one had escalated to by its last
 * period. The deposit can be carried over rather than refunded and collected
 * again — the old lease is marked Transferred and the new one Held, so it is
 * counted once.
 */
function renewLease(payload, user) {
  requireRole(user, 'manager');
  return withLock(function () {
    var old = freshRow('Leases', payload.id);
    if (!old) throw new Error('Lease ' + payload.id + ' not found');
    if (String(old.status) === 'Terminated') throw new Error(old.id + ' was terminated, so it cannot be renewed.');
    if (!old.end_date) throw new Error(old.id + ' has no end date — it is still running, so there is nothing to renew.');

    var start = String(payload.start_date || fmtDate(addDays(parseDate(old.end_date), 1))).slice(0, 10);
    var end = String(payload.end_date || '').slice(0, 10);
    if (!end) throw new Error('Choose when the renewed lease ends.');
    if (start <= String(old.end_date)) {
      throw new Error('The renewal must start after ' + old.id + ' ends on ' + old.end_date + '.');
    }

    var carry = payload.carry_deposit !== false;
    var held = carry ? depositLedger(old).held : 0;
    var rent = payload.rent_amount !== undefined && payload.rent_amount !== ''
      ? round2(num(payload.rent_amount)) : round2(currentMonthlyRent(old, old.end_date));

    var renewed = writeRowLocked('create', 'Leases', { table: 'Leases', data: {
      property_id: old.property_id, unit_id: old.unit_id, tenant_id: old.tenant_id,
      start_date: start, end_date: end, rent_amount: rent,
      deposit_amount: carry ? held : num(payload.deposit_amount),
      deposit_status: carry && held > 0 ? 'Held' : 'Pending',
      frequency: payload.frequency || old.frequency, late_fee: old.late_fee, grace_days: old.grace_days,
      escalation_pct: payload.escalation_pct !== undefined && payload.escalation_pct !== ''
        ? payload.escalation_pct : old.escalation_pct,
      gst_rate: old.gst_rate, renewed_from: old.id,
      notes: 'Renewal of ' + old.id + (carry && held > 0 ? ' · deposit of ' + held + ' carried over' : '')
    } }, user);

    if (carry && held > 0) {
      updateRow('Leases', old.id, { deposit_status: 'Transferred' }, SYSTEM_ACTOR, true);
    }
    log(user, 'lease-renewed', 'Leases', renewed.id, 'from ' + old.id + ' · rent ' + rent);
    return { lease: freshRow('Leases', renewed.id), previous: freshRow('Leases', old.id) };
  }, ['Leases', 'Invoices', 'Payments', 'Expenses']);
}

/** The monthly rent in force on a date, with annual escalation compounded from the lease start. */
function currentMonthlyRent(lease, onDate) {
  var base = num(lease.rent_amount);
  var pct = num(lease.escalation_pct);
  var start = parseDate(lease.start_date), at = parseDate(onDate || today());
  if (!pct || !start || !at || at < start) return round2(base);
  var months = monthsBetween(start, at) - (at.getDate() < start.getDate() ? 1 : 0);
  return round2(base * Math.pow(1 + pct / 100, Math.floor(Math.max(0, months) / 12)));
}

function addDays(d, n) { var r = new Date(d.getTime()); r.setDate(r.getDate() + n); return r; }

// ── invoices: voiding ───────────────────────────────────────────────────────

function assertVoidable(invoiceId) {
  var received = 0;
  readTable('Payments').forEach(function (pay) {
    if (String(pay.invoice_id) === String(invoiceId)) received += num(pay.amount);
  });
  if (received > 0) {
    throw new Error('Cannot void ' + invoiceId + ' — ' + round2(received) +
                    ' has already been received against it. Delete those payments first.');
  }
}

/**
 * Void an issued invoice. It keeps its number and stays on record, and
 * nothing is owed on it. A voided rent invoice still counts as that period
 * billed, so generating rent does not raise it again — correct it with a new
 * invoice if the period should be charged differently.
 */
function voidInvoice(payload, user) {
  requireRole(user, 'manager');
  return withLock(function () {
    var inv = freshRow('Invoices', payload.id);
    if (!inv) throw new Error('Invoice ' + payload.id + ' not found');
    if (String(inv.status) === 'Void') throw new Error(inv.id + ' is already void.');
    assertVoidable(inv.id);
    var reason = String(payload.reason || '').trim();
    if (!reason) throw new Error('Give a reason for voiding ' + inv.id + ' — it is kept on the invoice.');
    updateRow('Invoices', inv.id, {
      status: 'Void',
      notes: (inv.notes ? inv.notes + ' · ' : '') + 'Voided ' + today() + ': ' + reason
    }, user, true, payload.expected_version);
    applyInvoiceTotals(inv.id, user);
    log(user, 'void', 'Invoices', inv.id, reason.slice(0, 180));
    return { invoice: freshRow('Invoices', inv.id) };
  }, ['Invoices', 'Payments']);
}

function log(user, action, entity, entityId, details) {
  try {
    var sh = sheetFor('ActivityLog');
    var values = {
      id: nextLogId(sh), timestamp: nowIso(),
      actor: (user && (user.phone || user.email || user.name)) || 'system',
      action: action, entity: entity, entity_id: entityId || '', details: details || ''
    };
    sh.appendRow(headersOf(sh, 'ActivityLog').map(function (h) {
      return cellSafe(values[h] !== undefined ? values[h] : '');
    }));
    invalidate('ActivityLog');
  } catch (e) { /* logging must never break a write */ }
}

/**
 * The next audit id, from the last row alone.
 *
 * Every write in the app logs, and nextId reads the whole id column to find
 * the highest number — up to five thousand cells here, on every save. The log
 * is append-only and trimmed from the top, so its last row already holds the
 * highest id. Nothing refers to these ids, so a hand-sorted log costs nothing
 * worse than a repeated one.
 */
function nextLogId(sh) {
  var lastRow = sh.getLastRow();
  var n = 0;
  if (lastRow >= 2) {
    var col = headersOf(sh, 'ActivityLog').indexOf('id') + 1 || 1;
    var m = String(sh.getRange(lastRow, col, 1, 1).getValues()[0][0] || '').match(/(\d+)$/);
    if (m) n = parseInt(m[1], 10);
  }
  return ID_PREFIX.ActivityLog + '-' + pad(n + 1, 5);
}

// ────────────────────────────────────────────────────────────────── auth ────

function secret() {
  var props = PropertiesService.getScriptProperties();
  var s = props.getProperty('AUTH_SECRET');
  if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); props.setProperty('AUTH_SECRET', s); }
  return s;
}

/**
 * Reduce a phone number to a comparable form so that "+91 98800 11111",
 * "098800 11111" and "9880011111" all resolve to the same account.
 *
 * Digits only; anything longer than a local number keeps the last 10 digits,
 * which discards a country code or trunk prefix. That assumes 10-digit local
 * numbers (correct for IN/US); adjust LOCAL_PHONE_DIGITS for other regions.
 */
var LOCAL_PHONE_DIGITS = 10;

function normalisePhone(v) {
  var digits = String(v == null ? '' : v).replace(/[^0-9]/g, '');
  if (digits.length > LOCAL_PHONE_DIGITS) digits = digits.slice(-LOCAL_PHONE_DIGITS);
  return digits;
}

/** Compares two strings in time independent of where they first differ. */
function constantTimeEquals(a, b) {
  a = String(a); b = String(b);
  var diff = a.length ^ b.length;
  var n = Math.max(a.length, b.length);
  for (var i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

/**
 * Sign-in throttling, per account.
 *
 * The first few wrong passwords cost nothing; after that each one locks the
 * number out for twice as long as the last (30 s, 1 min, 2 min … capped at
 * 30 min). The counter is kept for six hours and cleared by a good sign-in.
 *
 * There used to be a global limit as well: 30 failures across all accounts
 * locked EVERYONE out for 15 minutes — so anyone who found the URL could keep
 * a whole business signed out with a request every 30 seconds. Password
 * spraying (a few guesses at many accounts) is handled instead by dropping the
 * free attempts to none while failures across all accounts run unusually high:
 * each targeted number then locks after one wrong guess, while a person typing
 * their own correct password is never refused.
 */
var THROTTLE = { freeAttempts: 4, baseDelaySec: 30, maxDelaySec: 1800, windowSec: 21600,
                 sprayThreshold: 100, sprayWindowSec: 900 };

function throttleKey(identifier) { return 'lf:' + Utilities.base64Encode(String(identifier)); }

function throttleState(identifier) {
  try { return JSON.parse(CacheService.getScriptCache().get(throttleKey(identifier)) || 'null') || { n: 0, until: 0 }; }
  catch (e) { return { n: 0, until: 0 }; }
}

function throttleCheck(identifier) {
  var state = throttleState(identifier);
  var wait = state.until - Date.now();
  if (wait > 0) {
    var minutes = Math.ceil(wait / 60000);
    throw new Error('Too many failed sign-in attempts. Try again in ' +
                    (minutes <= 1 ? 'a minute.' : minutes + ' minutes.'));
  }
}

function throttleFail(identifier) {
  var cache = CacheService.getScriptCache();
  var spray = parseInt(cache.get('lf:__global') || '0', 10) + 1;
  cache.put('lf:__global', String(spray), THROTTLE.sprayWindowSec);

  var state = throttleState(identifier);
  state.n++;
  var free = spray > THROTTLE.sprayThreshold ? 0 : THROTTLE.freeAttempts;
  if (state.n > free) {
    var delay = Math.min(THROTTLE.baseDelaySec * Math.pow(2, state.n - free - 1), THROTTLE.maxDelaySec);
    state.until = Date.now() + delay * 1000;
  }
  cache.put(throttleKey(identifier), JSON.stringify(state), THROTTLE.windowSec);
}

function throttleReset(identifier) {
  CacheService.getScriptCache().remove(throttleKey(identifier));
}

/**
 * Password hashing.
 *
 * Apps Script has no bcrypt/scrypt/PBKDF2, so this stretches SHA-256 by hashing
 * repeatedly. One hash per guess makes stolen hashes cheap to crack; this makes
 * each guess ITERATIONS times more expensive.
 *
 * 1,000 is a compromise, not a recommendation: Utilities.computeDigest is slow
 * enough in Apps Script that a modern PBKDF2 count (600k+) would take minutes
 * per sign-in. Raise HASH_ITERATIONS if logins feel instant on your account —
 * old hashes keep working, and each account upgrades on its next sign-in.
 *
 * Stored as "v2$<base64>". A hash with no prefix is the original single-round
 * scheme and is upgraded transparently the next time that password is used.
 */
var HASH_ITERATIONS = 1000;
var HASH_PREFIX = 'v2$';

function hashPassword(password, salt) {
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
                                       salt + '::' + password, Utilities.Charset.UTF_8);
  for (var i = 1; i < HASH_ITERATIONS; i++) {
    digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
                                     Utilities.base64Encode(digest) + salt,
                                     Utilities.Charset.UTF_8);
  }
  return HASH_PREFIX + Utilities.base64Encode(digest);
}

/** The original scheme, kept only so existing accounts can still sign in. */
function hashPasswordLegacy(password, salt) {
  return Utilities.base64Encode(Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, salt + '::' + password, Utilities.Charset.UTF_8));
}

/** True when `password` matches `stored`, under whichever scheme wrote it. */
function passwordMatches(password, salt, stored) {
  stored = String(stored || '');
  if (stored.indexOf(HASH_PREFIX) === 0) {
    return constantTimeEquals(hashPassword(password, salt), stored);
  }
  return constantTimeEquals(hashPasswordLegacy(password, salt), stored);
}

function isLegacyHash(stored) { return String(stored || '').indexOf(HASH_PREFIX) !== 0; }

/**
 * Rules for a new password. Deliberately short: length is what actually
 * matters, and long lists of character classes push people towards
 * "Password1!" and a sticky note.
 */
var MIN_PASSWORD = 10;

function assertPasswordAcceptable(password, phone) {
  var pw = String(password || '');
  if (pw.length < MIN_PASSWORD) {
    throw new Error('Password must be at least ' + MIN_PASSWORD + ' characters.');
  }
  if (/^[0-9]+$/.test(pw)) throw new Error('Password cannot be only numbers.');
  if (/^(.)\1+$/.test(pw)) throw new Error('Password cannot be the same character repeated.');
  var digits = normalisePhone(phone);
  if (digits && pw.replace(/[^0-9]/g, '').indexOf(digits) >= 0) {
    throw new Error('Password cannot contain the phone number.');
  }
  return pw;
}

function signToken(payload) {
  var body = Utilities.base64EncodeWebSafe(JSON.stringify(payload));
  var sig = Utilities.base64EncodeWebSafe(
    Utilities.computeHmacSha256Signature(body, secret()));
  return body + '.' + sig;
}

function verifyToken(token) {
  if (!token || token.indexOf('.') < 0) return null;
  var parts = token.split('.');
  var expect = Utilities.base64EncodeWebSafe(
    Utilities.computeHmacSha256Signature(parts[0], secret()));
  if (expect !== parts[1]) return null;
  var payload;
  try { payload = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString()); }
  catch (e) { return null; }
  if (!payload.exp || payload.exp < Date.now()) return null;
  return payload;
}

/**
 * Verify the token, then re-check the account against the sheet.
 *
 * A signed token alone is not enough: roles and the active flag live in the
 * Users tab and can change mid-session. Trusting the role baked into the token
 * would let a disabled or demoted user keep their old access until it expired
 * — up to `session_hours`. The Users tab is small, so this costs one cheap read.
 */
function requireAuth(token) {
  var payload = verifyToken(token);
  if (!payload) throw new Error('AUTH_REQUIRED');

  var users = readTable('Users');
  var current = null;
  for (var i = 0; i < users.length; i++) {
    if (String(users[i].id) === String(payload.id)) { current = users[i]; break; }
  }
  if (!current) throw new Error('AUTH_REQUIRED');
  if (String(current.active).toLowerCase() === 'false') throw new Error('AUTH_REQUIRED');

  // A token minted before the password last changed belongs to the old
  // password. Otherwise a stolen session survives the very change made to
  // revoke it, until it expires on its own.
  var changedAt = parseFloat(current.password_changed_at || 0) || 0;
  if (changedAt && (!payload.iat || payload.iat < changedAt)) {
    throw new Error('AUTH_REQUIRED');
  }

  return {
    id: current.id, phone: current.phone, email: current.email,
    name: current.name, role: current.role
  };
}

function requireRole(user, min) {
  if ((ROLE_RANK[user.role] || 0) < (ROLE_RANK[min] || 3)) {
    throw new Error('Your role (' + user.role + ') cannot perform this action');
  }
}

function doLogin(payload) {
  // Phone is the login credential; email is optional contact detail only.
  var phone = normalisePhone(payload.phone || payload.identifier || '');
  var password = String(payload.password || '');
  if (!phone || !password) return fail('Phone number and password are required');

  // One generic message for every failure mode. Saying "this account is
  // disabled" would confirm to a stranger that the number is registered.
  var GENERIC = 'Invalid phone number or password';

  try { throttleCheck(phone); } catch (e) { return fail(e.message); }

  var users = readTable('Users');
  var found = null;
  for (var i = 0; i < users.length; i++) {
    if (normalisePhone(users[i].phone) === phone) { found = users[i]; break; }
  }

  var disabled = found && String(found.active).toLowerCase() === 'false';
  // Hash even when the number is unknown, so a missing account is not
  // measurably faster to probe than a wrong password.
  var matches = found
    ? passwordMatches(password, found.salt, found.password_hash)
    : (hashPassword(password, 'no-such-user') && false);

  if (!found || disabled || !matches) {
    throttleFail(phone);
    log({ phone: phone }, 'login-failed', 'Users', found ? found.id : '', disabled ? 'disabled' : '');
    return fail(GENERIC);
  }

  throttleReset(phone);

  // Move an account off the original hashing scheme the first time we can,
  // now that we have the plaintext in hand.
  if (isLegacyHash(found.password_hash)) {
    var upgradeSalt = Utilities.getUuid();
    updateRow('Users', found.id, {
      salt: upgradeSalt, password_hash: hashPassword(password, upgradeSalt)
    }, SYSTEM_ACTOR, true);
    log(SYSTEM_ACTOR, 'password-rehash', 'Users', found.id, 'upgraded to ' + HASH_PREFIX);
  }

  var session = issueSession(found, Date.now());
  updateRow('Users', found.id, { last_login: nowIso() },
            { phone: found.phone, role: 'admin' }, true);
  var data = { token: session.token, user: session.user, settings: readSettings() };
  // Signing in is always followed by a request for the whole workbook; answer
  // both at once and save the browser a round trip to Apps Script. Built
  // through bootstrap(), so it obeys the same role limits as that request.
  if (payload.withSnapshot) data.snapshot = bootstrap(session.user);
  return ok(data);
}

/**
 * A signed session for an account. `iat` must not be earlier than the
 * account's password_changed_at, or requireAuth rejects the token.
 */
function issueSession(account, now) {
  var hours = parseFloat(readSettings().session_hours || '12') || 12;
  var user = { id: account.id, phone: account.phone, email: account.email,
               name: account.name, role: account.role };
  var token = signToken({
    id: user.id, phone: user.phone, email: user.email, name: user.name, role: user.role,
    iat: now, exp: now + hours * 3600 * 1000
  });
  return { token: token, user: user };
}

function changePassword(payload, user) {
  var users = readTable('Users');
  var me = null;
  for (var i = 0; i < users.length; i++) if (users[i].id === user.id) me = users[i];
  if (!me) throw new Error('User not found');
  if (!passwordMatches(payload.current || '', me.salt, me.password_hash)) {
    throw new Error('Current password is incorrect');
  }
  assertPasswordAcceptable(payload.next, me.phone);
  var salt = Utilities.getUuid();
  var now = Date.now();
  updateRow('Users', me.id, {
    salt: salt, password_hash: hashPassword(payload.next, salt),
    password_changed_at: now
  }, SYSTEM_ACTOR, true);
  log(user, 'password-change', 'Users', me.id, '');
  // The change ends every session minted before it — including the one it was
  // made from. Hand that one a replacement, so the person who just changed
  // their password is not signed out for doing so.
  var session = issueSession(me, now);
  return { changed: true, token: session.token, user: session.user };
}

function createUser(payload, user) {
  requireRole(user, 'admin');
  var phone = normalisePhone(payload.phone);
  if (!phone) throw new Error('A phone number is required — it is the sign-in credential');
  assertPasswordAcceptable(payload.password, payload.phone);

  var existing = readTable('Users');
  for (var i = 0; i < existing.length; i++) {
    if (normalisePhone(existing[i].phone) === phone) {
      throw new Error('That phone number already belongs to another user');
    }
  }

  var salt = Utilities.getUuid();
  return stripSecrets('Users', createRow('Users', {
    name: payload.name,
    phone: String(payload.phone).trim(),
    email: payload.email ? String(payload.email).trim().toLowerCase() : '',
    role: payload.role || 'viewer',
    salt: salt, password_hash: hashPassword(payload.password, salt),
    password_changed_at: Date.now(), active: 'TRUE'
  }, user));
}

// ───────────────────────────────────────────────────────────────── setup ────

/**
 * Create any missing tab and append any column the schema has gained. Purely
 * additive: existing rows, values and hand-added columns are never touched.
 */
function ensureSchema() {
  invalidateAll();
  PropertiesService.getScriptProperties().setProperty('SCHEMA_HASH', schemaHash());
  var book = ss();
  Object.keys(SCHEMA).forEach(function (name) {
    var sh = book.getSheetByName(name);
    if (!sh) {
      sh = book.insertSheet(name);
      sh.getRange(1, 1, 1, SCHEMA[name].length).setValues([SCHEMA[name]]);
      sh.setFrozenRows(1);
      sh.getRange(1, 1, 1, SCHEMA[name].length).setFontWeight('bold').setBackground('#eef2ff');
      sh.autoResizeColumns(1, SCHEMA[name].length);
    } else {
      var headers = headersOf(sh, name);
      SCHEMA[name].forEach(function (col) {
        if (headers.indexOf(col) < 0) {
          sh.getRange(1, headers.length + 1).setValue(col)
            .setFontWeight('bold').setBackground('#eef2ff');
          headers.push(col);
          invalidateAll();
        }
      });
    }
  });
}

function schemaHash() { return fingerprint(JSON.stringify(SCHEMA)); }

/**
 * Add the columns a new release needs, the first time it is used.
 *
 * A deployment updated to a version with new columns used to need someone to
 * re-run setup. Until they did, a write simply dropped any field whose column
 * was missing — a GSTIN typed in and saved, and silently gone. The schema's
 * fingerprint is recorded when it is applied, so this costs one property read
 * per request once it has run.
 */
function ensureSchemaCurrent() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('SCHEMA_HASH') === schemaHash()) return;
  withLock(function () {
    if (props.getProperty('SCHEMA_HASH') === schemaHash()) return;
    ensureSchema();
    var settings = readSettings();
    Object.keys(DEFAULT_SETTINGS).forEach(function (k) {
      if (settings[k] === undefined) setSetting(k, DEFAULT_SETTINGS[k]);
    });
  });
}

/**
 * Break-glass recovery, run from the spreadsheet menu.
 *
 * The Web App cannot help when nobody can sign in — that is the whole point of
 * the setup guard. This runs inside the editor, where Google has already
 * authenticated you as an owner of the script, so it is allowed to do what the
 * public endpoint must not: guarantee a way back in.
 *
 * It syncs the schema, then makes the given phone number an active
 * administrator with the given password — updating the matching account, or
 * adopting an account that has no phone yet (the case after migrating from
 * email sign-in), or creating one. It also clears any sign-in lockout.
 */
function recoverAccess(phone, password, name) {
  invalidateAll();
  ensureSchema();

  var normalised = normalisePhone(phone);
  if (!normalised) throw new Error('A phone number is required');
  assertPasswordAcceptable(password, phone);

  var actor = { role: 'admin', phone: 'sheet-owner', name: 'sheet owner' };
  var users = readTable('Users');
  var target = null;

  for (var i = 0; i < users.length; i++) {
    if (normalisePhone(users[i].phone) === normalised) { target = users[i]; break; }
  }
  // after migrating from email sign-in, the account exists but has no phone
  if (!target) {
    for (var j = 0; j < users.length; j++) {
      if (!normalisePhone(users[j].phone)) { target = users[j]; break; }
    }
  }

  var salt = Utilities.getUuid();
  var creds = {
    phone: String(phone).trim(),
    salt: salt,
    password_hash: hashPassword(password, salt),
    password_changed_at: Date.now(),
    role: 'admin',
    active: 'TRUE'
  };

  var result;
  if (target) {
    result = updateRow('Users', target.id, creds, actor, true);
  } else {
    creds.name = name || 'Administrator';
    creds.email = '';
    result = createRow('Users', creds, actor, true);
  }

  // an earlier flurry of failed attempts must not keep them out
  var cache = CacheService.getScriptCache();
  cache.remove(throttleKey(normalised));
  cache.remove('lf:__global');

  log(actor, 'recover-access', 'Users', result.id, 'via spreadsheet menu');
  return { id: result.id, name: result.name, phone: result.phone, role: result.role };
}

/**
 * Build every tab and seed the first administrator.
 *
 * Authorisation, in order of precedence:
 *   1. An admin session token — always allowed (used to sync new columns after
 *      a schema change).
 *   2. No users exist yet AND, if a SETUP_KEY script property is set, the
 *      caller supplies it. This is the one-time bootstrap.
 *
 * Anything else is refused. Without this, an anonymous caller reaching the URL
 * before the owner finished setup could seed themselves as administrator, and
 * one reaching it afterwards could still rewrite headers and default settings.
 */
function doSetup(payload, token, fromEditor) {
  // `fromEditor` is only ever set by the spreadsheet menu, which already runs
  // with the owner's own Google credentials.
  var isAdmin = fromEditor === true;
  if (!isAdmin) {
    try { isAdmin = requireAuth(token).role === 'admin'; } catch (e) { isAdmin = false; }
  }

  if (!isAdmin) {
    var existing = readTable('Users');
    if (existing.length > 0) {
      // Normal path for a new browser connecting to a configured workspace:
      // acknowledge, but do not let an unauthenticated caller write anything.
      return ok({ tables: Object.keys(SCHEMA), adminCreated: false, alreadySeeded: true });
    }
    var props = PropertiesService.getScriptProperties();
    var setupKey = props.getProperty('SETUP_KEY');
    if (setupKey) {
      if (!constantTimeEquals(String(payload.setupKey || ''), setupKey)) {
        return fail('A setup key is required for this deployment.');
      }
    } else {
      // With no setup key configured, anonymous bootstrap is allowed only
      // briefly after the deployment first answers a request. Leaving it open
      // indefinitely means anyone who later finds the URL of an unfinished
      // deployment can claim the administrator account.
      var firstSeen = parseFloat(props.getProperty('FIRST_SEEN') || 0) || 0;
      if (!firstSeen) { firstSeen = Date.now(); props.setProperty('FIRST_SEEN', String(firstSeen)); }
      if (Date.now() - firstSeen > BOOTSTRAP_WINDOW_MS) {
        return fail('The first-run window for this deployment has closed. Create the ' +
                    'administrator from the spreadsheet menu (Property Manager → ' +
                    'Recover admin access), or set a SETUP_KEY script property.');
      }
    }
  }

  ensureSchema();

  // default settings
  var settings = readSettings();
  Object.keys(DEFAULT_SETTINGS).forEach(function (k) {
    if (settings[k] === undefined) setSetting(k, DEFAULT_SETTINGS[k]);
  });

  // seed the first admin (only when there are no users at all)
  var users = readTable('Users');
  var created = null;
  if (users.length === 0) {
    var phone = normalisePhone(payload.adminPhone);
    if (!phone) return fail('Provide adminPhone — it is the sign-in credential');
    var password = assertPasswordAcceptable(payload.adminPassword, payload.adminPhone);
    var salt = Utilities.getUuid();
    var sysUser = { phone: 'system', role: 'admin' };
    created = createRow('Users', {
      name: payload.adminName || 'Administrator',
      phone: String(payload.adminPhone).trim(),
      email: payload.adminEmail ? String(payload.adminEmail).trim().toLowerCase() : '',
      role: 'admin',
      salt: salt, password_hash: hashPassword(password, salt),
      password_changed_at: Date.now(), active: 'TRUE'
    }, sysUser);
  }
  secret();
  return ok({ tables: Object.keys(SCHEMA), adminCreated: !!created, alreadySeeded: users.length > 0 });
}

// ────────────────────────────────────────────────────────────── settings ────

function readSettings() {
  var rows = readTable('Settings');
  var out = {};
  rows.forEach(function (r) { if (r.key) out[String(r.key)] = r.value; });
  return out;
}

function setSetting(key, value) {
  var sh = sheetFor('Settings');
  var r = findRowIndex('Settings', key);
  if (r < 0) sh.appendRow([key, value]);
  else sh.getRange(r, 2).setValue(value);
  invalidate('Settings');
}

// ───────────────────────────────────────────────────────────── bootstrap ────

/** One round-trip that hands the SPA everything it needs. */
var COLLECTIONS = {
  properties: 'Properties', units: 'Units', tenants: 'Tenants', leases: 'Leases',
  invoices: 'Invoices', invoiceItems: 'InvoiceItems', payments: 'Payments',
  maintenance: 'Maintenance', expenses: 'Expenses', documents: 'Documents',
  meterReadings: 'MeterReadings'
};

/**
 * One round-trip that hands the SPA everything it needs.
 *
 * @param known the tab fingerprints the browser already holds, from an earlier
 *   response. A tab whose fingerprint still matches is left out and named in
 *   `unchanged`, so a save that touched one tab does not send back all twelve.
 *   The server still reads every tab — Sheets cannot be asked what changed —
 *   but the response, and the browser's work parsing and redrawing it, shrink
 *   to what actually moved.
 */
function bootstrap(user, known) {
  refreshIfStale(user);
  known = known || {};
  var out = {
    user: user,
    settings: readSettings(),
    hashes: {},
    unchanged: [],
    timezones: { script: Session.getScriptTimeZone(), sheet: sheetTimeZone() },
    users: (user.role === 'admin' ? readTable('Users').map(scrubUser) : []),
    activity: (ROLE_RANK[user.role] >= ROLE_RANK[readRoleFor('ActivityLog')]
      ? readTableTail('ActivityLog', 200).reverse() : []),
    stats: computeStats()
  };
  Object.keys(COLLECTIONS).forEach(function (key) {
    var hash = tableHash(COLLECTIONS[key]);
    out.hashes[key] = hash;
    if (known[key] && known[key] === hash) out.unchanged.push(key);
    else out[key] = readTable(COLLECTIONS[key]);
  });
  return out;
}

/** An administrator sets a new password for someone who has lost theirs. */
function resetPassword(payload, user) {
  requireRole(user, 'admin');
  var users = readTable('Users');
  var target = null;
  for (var i = 0; i < users.length; i++) if (users[i].id === payload.id) target = users[i];
  if (!target) throw new Error('User not found');
  assertPasswordAcceptable(payload.password, target.phone);

  var salt = Utilities.getUuid();
  updateRow('Users', target.id, {
    salt: salt, password_hash: hashPassword(payload.password, salt),
    password_changed_at: Date.now()
  }, user, true);
  log(user, 'password-reset', 'Users', target.id, 'by ' + (user.phone || user.name));
  return { reset: true, id: target.id };
}

/** Disable an account without deleting its history. Takes effect immediately. */
function setUserActive(payload, user) {
  requireRole(user, 'admin');
  var active = payload.active === true || String(payload.active).toLowerCase() === 'true';
  var row = updateRow('Users', payload.id, { active: active ? 'TRUE' : 'FALSE' }, user);
  log(user, active ? 'user-enabled' : 'user-disabled', 'Users', payload.id, '');
  return scrubUser(row);
}

function setUserRole(payload, user) {
  requireRole(user, 'admin');
  if (!ROLE_RANK[payload.role]) throw new Error('Unknown role: ' + payload.role);
  var row = updateRow('Users', payload.id, { role: payload.role }, user);
  log(user, 'user-role-changed', 'Users', payload.id, payload.role);
  return scrubUser(row);
}

function scrubUser(u) {
  return {
    id: u.id, name: u.name, phone: u.phone, email: u.email,
    role: u.role, active: u.active, last_login: u.last_login
  };
}

// ───────────────────────────────────────────────────── billing operations ──

/**
 * Create rent invoices for every active lease whose next billing period is
 * not yet invoiced. Idempotent: re-running never double-bills a period.
 */
function generateInvoices(payload, user) {
  requireRole(user, 'manager');
  return withLock(function () { return generateInvoicesLocked(payload, user); },
                  ['Leases', 'Invoices', 'InvoiceItems']);
}

function generateInvoicesLocked(payload, user) {
  var upto = payload.upto || today();
  var leases = readTable('Leases');
  var invoices = readTable('Invoices');

  // A period counts as billed once any invoice for that lease and start date
  // carries rent — not only one still typed "Rent". Adding an electricity line
  // to a rent invoice used to relabel it "Mixed", and the next run billed that
  // month's rent a second time.
  var rentLine = {};
  readTable('InvoiceItems').forEach(function (it) {
    if (String(it.category) === 'Rent') rentLine[it.invoice_id] = true;
  });
  var billed = {};
  invoices.forEach(function (inv) {
    if (inv.type === 'Rent' || (inv.lease_id && inv.period_start && rentLine[inv.id])) {
      billed[inv.lease_id + '|' + inv.period_start] = true;
    }
  });

  var t = today();
  var headers = [], meta = [];
  for (var i = 0; i < leases.length; i++) {
    var lease = leases[i];
    // The stored status is only as fresh as the last time someone opened the
    // app. On a nightly trigger a lease that began today still reads Upcoming,
    // so go by its dates as well.
    if (String(lease.status) !== 'Active' &&
        deriveLeaseStatus(lease.start_date, lease.end_date, lease.status) !== 'Active') continue;
    var periods = periodsFor(lease, upto);
    for (var p = 0; p < periods.length; p++) {
      var period = periods[p];
      var key = lease.id + '|' + period.start;
      if (billed[key]) continue;
      billed[key] = true;
      var amount = round2(period.amount);
      // GST on rent follows the lease (18% on commercial property, nothing on a home)
      var rate = num(lease.gst_rate);
      var gst = round2(amount * rate / 100);
      var split = rate > 0 ? gstSplit(lease, gst) : { cgst: '', sgst: '', igst: '', place_of_supply: '' };
      headers.push({
        lease_id: lease.id, tenant_id: lease.tenant_id, unit_id: lease.unit_id,
        property_id: lease.property_id, type: 'Rent',
        period_start: period.start, period_end: period.end,
        issue_date: period.start, due_date: period.due,
        amount: amount, tax: gst, total: round2(amount + gst), amount_paid: 0, balance: round2(amount + gst),
        cgst: split.cgst, sgst: split.sgst, igst: split.igst, place_of_supply: split.place_of_supply,
        status: period.due < t ? 'Overdue' : 'Unpaid',
        notes: period.prorated
          ? 'Auto-generated part period — ' + period.days + ' of ' + period.fullDays + ' days'
          : 'Auto-generated ' + lease.frequency + ' rent'
      });
      meta.push({ period: period, amount: amount, rate: rate, gst: gst });
    }
  }

  // two writes in total, however many periods are due
  var created = appendRows('Invoices', headers, user);
  appendRows('InvoiceItems', created.map(function (row, n) {
    var period = meta[n].period;
    return {
      invoice_id: row.id,
      description: 'Rent · ' + period.start + ' to ' + period.end +
                   (period.prorated ? ' (' + period.days + '/' + period.fullDays + ' days)' : ''),
      category: 'Rent', quantity: 1, unit_amount: meta[n].amount, amount: meta[n].amount,
      tax_rate: meta[n].rate || 0, tax_amount: meta[n].gst, notes: ''
    };
  }), user);

  // what was raised already overdue gets its late fee now, not on tomorrow's first load
  if (created.length) applyLateFees(SYSTEM_ACTOR);

  log(user, 'generate-invoices', 'Invoices', '', created.length + ' created up to ' + upto);
  return { created: created.length, invoices: created };
}

/** Whole days from a to b inclusive of both ends. */
function daysInclusive(a, b) {
  return Math.round((b.getTime() - a.getTime()) / 86400000) + 1;
}

/** Every billing period of a lease that has started on or before `upto`. */
function periodsFor(lease, upto) {
  var out = [];
  var start = parseDate(lease.start_date);
  var end = lease.end_date ? parseDate(lease.end_date) : null;
  var limit = parseDate(upto);
  if (!start || !limit) return out;

  var step = { Monthly: 1, Quarterly: 3, 'Half-Yearly': 6, Yearly: 12 }[lease.frequency || 'Monthly'] || 1;
  var grace = parseInt(lease.grace_days || 0, 10) || 0;
  var baseRent = parseFloat(lease.rent_amount || 0) || 0;
  var escalation = parseFloat(lease.escalation_pct || 0) || 0;

  // Each period is measured from the lease start rather than from the previous
  // period, so a lease beginning on the 31st is not permanently pulled back to
  // the 28th once it passes February.
  for (var i = 0; i < 400; i++) {
    var periodStart = addMonths(start, i * step);
    if (periodStart > limit) break;
    if (end && periodStart > end) break;

    var fullEnd = addMonths(start, (i + 1) * step);
    fullEnd.setDate(fullEnd.getDate() - 1);
    var periodEnd = (end && fullEnd > end) ? new Date(end.getTime()) : fullEnd;

    // rent escalates on each anniversary of the lease start
    var years = Math.floor(monthsBetween(start, periodStart) / 12);
    var amount = baseRent * step * Math.pow(1 + escalation / 100, years);

    // A lease that ends part-way through a period is only charged for the days
    // it actually covers. Billing a whole month for ten days of occupancy is
    // the kind of error a tenant notices and disputes.
    var fullDays = daysInclusive(periodStart, fullEnd);
    var actualDays = daysInclusive(periodStart, periodEnd);
    var prorated = actualDays < fullDays;
    if (prorated && fullDays > 0) amount = amount * (actualDays / fullDays);

    var due = new Date(periodStart.getTime());
    due.setDate(due.getDate() + grace);

    out.push({
      start: fmtDate(periodStart), end: fmtDate(periodEnd), due: fmtDate(due),
      amount: round2(amount), prorated: prorated, days: actualDays, fullDays: fullDays
    });
  }
  return out;
}

/**
 * Create or update an invoice together with its line items.
 *
 * An invoice can carry any mix of charges — rent, electricity, water, parking
 * — so the header's `amount` is always the sum of its lines rather than
 * something typed. Sending the full item list replaces what was there, which
 * is what the editor does: rows the user removed simply do not come back.
 */
function saveInvoice(payload, user) {
  requireRole(user, 'manager');
  return withLock(function () { return saveInvoiceLocked(payload, user); }, ['Invoices', 'InvoiceItems', 'Payments']);
}

function saveInvoiceLocked(payload, user) {
  var data = payload.data || {};
  var items = payload.items || [];
  if (!items.length) throw new Error('An invoice needs at least one line item');

  // price each line, then let the lines define the invoice total
  var subtotal = 0, lineTax = 0, hasRates = false;
  var priced = items.map(function (raw) {
    var qty = raw.quantity === '' || raw.quantity === undefined ? 1 : (parseFloat(raw.quantity) || 0);
    var unit = parseFloat(raw.unit_amount || 0) || 0;
    var amount = round2(qty * unit);
    var rate = num(raw.tax_rate);
    if (rate < 0 || rate > 100) throw new Error('GST rate must be between 0 and 100%.');
    var taxAmount = round2(amount * rate / 100);
    if (rate > 0) hasRates = true;
    subtotal += amount;
    lineTax += taxAmount;
    return {
      id: raw.id || '',
      description: String(raw.description || '').trim(),
      category: raw.category || 'Other',
      quantity: qty,
      unit_amount: unit,
      amount: amount,
      tax_rate: rate || 0,
      tax_amount: taxAmount,
      notes: raw.notes || ''
    };
  });

  for (var i = 0; i < priced.length; i++) {
    if (!priced[i].description) throw new Error('Every line item needs a description');
  }

  // GST charged per line is the tax; an invoice with no rates keeps a flat tax
  // typed on the header, as invoices made before line rates existed do
  var tax = hasRates ? round2(lineTax) : num(data.tax);
  data.tax = tax;
  data.amount = round2(subtotal);
  data.total = round2(subtotal + tax);

  var prior = payload.id ? freshRow('Invoices', payload.id) : null;
  if (payload.id && !prior) throw new Error('Invoices ' + payload.id + ' not found');
  if (prior && String(prior.status) === 'Void') {
    throw new Error(prior.id + ' is void, so it cannot be changed. Raise a new invoice instead.');
  }
  // An edit keeps the status it has: the editor sends none, and defaulting it
  // to Unpaid quietly brought a void invoice back into arrears. The one change
  // an edit can make is issuing a draft; Paid, Overdue and the rest are worked
  // out from the payments and dates, never taken from the form.
  if (!prior) data.status = String(data.status) === 'Draft' ? 'Draft' : 'Unpaid';
  else if (String(prior.status) === 'Draft' && data.status && String(data.status) !== 'Draft') data.status = 'Unpaid';
  else delete data.status;

  // a single-category invoice keeps that label; a mixed one says so
  var categories = {};
  priced.forEach(function (it) { categories[it.category] = true; });
  var distinct = Object.keys(categories);
  // ...except that Rent and Deposit are what billing keys on — a rent invoice
  // with an electricity line added is still that month's rent, and a deposit
  // still settles the lease's deposit
  var keepType = prior && ['Rent', 'Deposit', 'Deposit Deduction'].indexOf(String(prior.type)) >= 0;
  if (!data.type) data.type = keepType ? prior.type : (distinct.length === 1 ? distinct[0] : 'Mixed');

  data.property_id = inferProperty(data);

  var invoice = payload.id
    ? updateRow('Invoices', payload.id, data, user, false, payload.expected_version)
    : createRow('Invoices', data, user);

  // replace the line set: update what stayed, add what is new, drop the rest
  var existing = itemsOfInvoice(invoice.id);
  var kept = {};
  var added = [];
  priced.forEach(function (it) {
    var row = { invoice_id: invoice.id, description: it.description, category: it.category,
                quantity: it.quantity, unit_amount: it.unit_amount, amount: it.amount,
                tax_rate: it.tax_rate, tax_amount: it.tax_amount, notes: it.notes };
    if (it.id && existing.some(function (e) { return e.id === it.id; })) {
      updateRow('InvoiceItems', it.id, row, user, true);
      kept[it.id] = true;
    } else {
      added.push(row);
    }
  });
  existing.forEach(function (e) {
    if (!kept[e.id]) deleteRow('InvoiceItems', e.id, SYSTEM_ACTOR);
  });
  appendRows('InvoiceItems', added, user);

  var settled = applyInvoiceTotals(invoice.id, user) || invoice;
  log(user, payload.id ? 'update' : 'create', 'Invoices', invoice.id,
      priced.length + ' line item(s), total ' + data.total);
  return { invoice: freshRow('Invoices', settled.id) || settled, items: itemsOfInvoice(invoice.id) };
}

function itemsOfInvoice(invoiceId) {
  return readTable('InvoiceItems').filter(function (it) { return it.invoice_id === invoiceId; });
}

function recordPayment(payload, user) {
  requireRole(user, 'manager');
  // The balance is checked and the payment written under one lock, so two
  // payments recorded at the same moment cannot both fit into the same balance.
  return withLock(function () { return recordPaymentLocked(payload, user); },
                  ['Invoices', 'Payments', 'InvoiceItems', 'Leases']);
}

function recordPaymentLocked(payload, user) {
  var invoiceId = payload.invoice_id;
  var amount = parseFloat(payload.amount || 0);
  if (!(amount > 0)) throw new Error('Payment amount must be greater than zero');

  var invoices = readTable('Invoices');
  var invoice = null;
  for (var i = 0; i < invoices.length; i++) if (invoices[i].id === invoiceId) invoice = invoices[i];
  if (!invoice) throw new Error('Invoice ' + invoiceId + ' not found');
  if (String(invoice.status) === 'Void') throw new Error('That invoice is void.');
  if (String(invoice.status) === 'Draft') throw new Error(invoice.id + ' is still a draft. Issue it before taking payment.');

  var owed = round2(parseFloat(invoice.balance || 0) || 0);
  if (owed <= 0) throw new Error('Invoice ' + invoice.id + ' is already settled.');

  // Someone paying several months at once should not have to be told to split
  // the payment up. Anything beyond this invoice is applied to the same
  // tenant's other outstanding invoices, oldest due date first, so no balance
  // ever goes negative and nothing is silently absorbed.
  var overflow = round2(amount - owed);
  var applyHere = Math.min(round2(amount), owed);
  var spillTargets = [];
  if (overflow > 0.009) {
    var remaining = overflow;
    invoices
      .filter(function (i) {
        return i.id !== invoice.id && i.tenant_id === invoice.tenant_id &&
               ['Unpaid', 'Partial', 'Overdue'].indexOf(String(i.status)) >= 0 &&
               (parseFloat(i.balance || 0) || 0) > 0;
      })
      .sort(function (a, b) { return String(a.due_date).localeCompare(String(b.due_date)); })
      .forEach(function (other) {
        if (remaining <= 0.009) return;
        var take = Math.min(remaining, round2(parseFloat(other.balance || 0) || 0));
        spillTargets.push({ invoice: other, amount: round2(take) });
        remaining = round2(remaining - take);
      });
    if (remaining > 0.009) {
      throw new Error('That is ' + remaining + ' more than ' +
        (spillTargets.length ? 'every outstanding invoice for this tenant comes to.'
                             : 'the ' + owed + ' owed on ' + invoice.id + '.') +
        ' Reduce the amount or raise the invoice first.');
    }
  }

  var payment = createRow('Payments', {
    invoice_id: invoice.id, lease_id: invoice.lease_id, tenant_id: invoice.tenant_id,
    property_id: invoice.property_id || inferProperty(invoice),
    payment_date: payload.payment_date || today(),
    amount: round2(applyHere), method: payload.method || 'Cash', reference: payload.reference || '',
    received_by: user.name || user.phone || user.email, notes: payload.notes || ''
  }, user, true);

  var updated = applyInvoiceTotals(invoice.id, user);

  var alsoSettled = [];
  spillTargets.forEach(function (target) {
    createRow('Payments', {
      invoice_id: target.invoice.id, lease_id: target.invoice.lease_id,
      tenant_id: target.invoice.tenant_id,
      property_id: target.invoice.property_id || inferProperty(target.invoice),
      payment_date: payload.payment_date || today(), amount: target.amount,
      method: payload.method || 'Cash', reference: payload.reference || '',
      received_by: user.name || user.phone || user.email,
      notes: 'Applied from a payment made against ' + invoice.id
    }, user, true);
    alsoSettled.push(applyInvoiceTotals(target.invoice.id, user));
  });

  log(user, 'payment', 'Invoices', invoice.id,
      round2(amount) + ' via ' + (payload.method || 'Cash') +
      (alsoSettled.length ? ' (spread over ' + (alsoSettled.length + 1) + ' invoices)' : ''));
  return { payment: freshRow('Payments', payment.id) || payment, invoice: updated, alsoSettled: alsoSettled };
}

function voidPayment(paymentId, user) {
  requireRole(user, 'admin');
  return withLock(function () {
    var target = freshRow('Payments', paymentId);
    if (!target) throw new Error('Payment not found');
    // deleteRow already puts the invoice back; recomputing it again here only
    // repeated the reads and the write
    deleteRow('Payments', paymentId, user);
    return { voided: paymentId, invoice: target.invoice_id ? freshRow('Invoices', target.invoice_id) : null };
  }, ['Payments', 'Invoices']);
}

/** Recompute amount_paid / balance / status — and the GST split — for one invoice. */
function applyInvoiceTotals(invoiceId, user) {
  var invoices = readTable('Invoices');
  var invoice = null;
  for (var i = 0; i < invoices.length; i++) if (invoices[i].id === invoiceId) invoice = invoices[i];
  if (!invoice) return null;

  var paid = 0;
  readTable('Payments').forEach(function (p) {
    if (p.invoice_id === invoiceId) paid += parseFloat(p.amount || 0) || 0;
  });

  // line items, when present, are the source of truth for what is owed
  var lines = itemsOfInvoice(invoiceId);
  var amount = parseFloat(invoice.amount || 0) || 0;
  var lineTax = 0, hasRates = false;
  if (lines.length) {
    amount = 0;
    lines.forEach(function (it) {
      amount += num(it.amount);
      if (num(it.tax_rate) > 0) hasRates = true;
      lineTax += num(it.tax_amount);
    });
    amount = round2(amount);
  }
  var tax = hasRates ? round2(lineTax) : num(invoice.tax);
  var total = lines.length ? round2(amount + tax)
                           : (parseFloat(invoice.total || invoice.amount || 0) || 0);
  var isVoid = String(invoice.status) === 'Void';
  // nothing is owed on a void invoice, so it must not read as a balance
  var balance = isVoid ? 0 : round2(total - paid);
  var status;
  if (isVoid) status = 'Void';
  // a draft stays a draft until it is issued, whatever its dates say
  else if (String(invoice.status) === 'Draft') status = 'Draft';
  else if (paid <= 0) status = (invoice.due_date && invoice.due_date < today()) ? 'Overdue' : 'Unpaid';
  else if (balance > 0.009) status = (invoice.due_date && invoice.due_date < today()) ? 'Overdue' : 'Partial';
  else status = 'Paid';

  var changes = { amount: amount, tax: tax, total: total, amount_paid: round2(paid), balance: balance, status: status };
  var split = hasRates ? gstSplit(invoice, tax) : { cgst: '', sgst: '', igst: '', place_of_supply: '' };
  Object.keys(split).forEach(function (k) { changes[k] = split[k]; });

  var saved = updateRow('Invoices', invoiceId, changes, SYSTEM_ACTOR, true);
  syncDepositStatus(saved, user);
  return saved;
}

// ── GST ─────────────────────────────────────────────────────────────────────

/** GST state codes, by name and by the usual two-letter abbreviation. */
var GST_STATES = {
  '01': ['Jammu and Kashmir', 'JK'], '02': ['Himachal Pradesh', 'HP'], '03': ['Punjab', 'PB'],
  '04': ['Chandigarh', 'CH'], '05': ['Uttarakhand', 'UK', 'UT'], '06': ['Haryana', 'HR'],
  '07': ['Delhi', 'DL'], '08': ['Rajasthan', 'RJ'], '09': ['Uttar Pradesh', 'UP'], '10': ['Bihar', 'BR'],
  '11': ['Sikkim', 'SK'], '12': ['Arunachal Pradesh', 'AR'], '13': ['Nagaland', 'NL'], '14': ['Manipur', 'MN'],
  '15': ['Mizoram', 'MZ'], '16': ['Tripura', 'TR'], '17': ['Meghalaya', 'ML'], '18': ['Assam', 'AS'],
  '19': ['West Bengal', 'WB'], '20': ['Jharkhand', 'JH'], '21': ['Odisha', 'OD', 'OR', 'Orissa'],
  '22': ['Chhattisgarh', 'CG', 'CT'], '23': ['Madhya Pradesh', 'MP'], '24': ['Gujarat', 'GJ'],
  '26': ['Dadra and Nagar Haveli and Daman and Diu', 'DN', 'DD'], '27': ['Maharashtra', 'MH'],
  '29': ['Karnataka', 'KA'], '30': ['Goa', 'GA'], '31': ['Lakshadweep', 'LD'], '32': ['Kerala', 'KL'],
  '33': ['Tamil Nadu', 'TN'], '34': ['Puducherry', 'PY', 'Pondicherry'], '35': ['Andaman and Nicobar Islands', 'AN'],
  '36': ['Telangana', 'TS', 'TG'], '37': ['Andhra Pradesh', 'AP'], '38': ['Ladakh', 'LA']
};

/** A state's two-digit GST code from its name, abbreviation or code; '' when unknown. */
function gstStateCode(value) {
  var v = String(value || '').trim();
  if (!v) return '';
  if (/^\d{1,2}$/.test(v)) { v = pad(parseInt(v, 10), 2); return GST_STATES[v] ? v : ''; }
  var key = v.toLowerCase().replace(/&/g, 'and').replace(/[^a-z]/g, '');
  for (var code in GST_STATES) {
    for (var i = 0; i < GST_STATES[code].length; i++) {
      if (GST_STATES[code][i].toLowerCase().replace(/[^a-z]/g, '') === key) return code;
    }
  }
  return '';
}

var GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/** A GSTIN in canonical form, or '' — refusing anything that is not one. */
function assertGstin(value, label) {
  var v = String(value || '').replace(/\s+/g, '').toUpperCase();
  if (!v) return '';
  if (!GSTIN_PATTERN.test(v) || !GST_STATES[v.slice(0, 2)]) {
    throw new Error(label + ' "' + value + '" is not a valid GSTIN — 15 characters, starting with the state code.');
  }
  return v;
}

function assertUpiId(value) {
  var v = String(value || '').trim();
  if (!v) return '';
  if (!/^[A-Za-z0-9.\-_]{2,256}@[A-Za-z][A-Za-z0-9]{1,63}$/.test(v)) {
    throw new Error('"' + value + '" is not a UPI ID. It looks like name@bank.');
  }
  return v;
}

/**
 * Split an invoice's GST into CGST + SGST (supplier and place of supply in the
 * same state) or IGST (different states).
 *
 * For renting immovable property the place of supply is where the property is
 * (IGST Act s.12(3)), so the property's state decides, then the tenant's GSTIN.
 * When either side is unknown it is treated as intra-state — the usual case for
 * a landlord registered where they own property — and place_of_supply is left
 * blank so the gap is visible on the invoice.
 */
function gstSplit(invoice, gst) {
  gst = round2(gst);
  var settings = readSettings();
  var supplier = /^[0-9]{2}/.test(String(settings.gstin || '')) ? String(settings.gstin).slice(0, 2) : '';
  var place = '';
  var property = invoice.property_id ? freshRow('Properties', invoice.property_id) : null;
  if (property) place = gstStateCode(property.state);
  if (!place && invoice.tenant_id) {
    var tenant = freshRow('Tenants', invoice.tenant_id);
    if (tenant && GSTIN_PATTERN.test(String(tenant.gstin || ''))) place = String(tenant.gstin).slice(0, 2);
  }
  var placeLabel = place ? place + '-' + GST_STATES[place][0] : '';
  if (supplier && place && supplier !== place) {
    return { cgst: 0, sgst: 0, igst: gst, place_of_supply: placeLabel };
  }
  var half = round2(gst / 2);
  return { cgst: half, sgst: round2(gst - half), igst: 0, place_of_supply: placeLabel };
}

var SYSTEM_ACTOR = { role: 'admin', phone: 'system', name: 'system' };

/**
 * Housekeeping: flips overdue invoices, expires leases, syncs unit occupancy.
 *
 * The writes are made as SYSTEM, not as the caller. It runs after writes that
 * change occupancy, once a day on a read (refreshIfStale) including for
 * read-only viewers, and from dailyMaintenanceJob — the app maintaining its own
 * derived state rather than the user editing anything.
 */
function refreshStatuses(user, quiet) {
  return withLock(function () {
    var result = refreshStatusesLocked(user, quiet);
    PropertiesService.getScriptProperties().setProperty('LAST_REFRESH', today());
    return result;
  }, ['Invoices', 'Leases', 'Units', 'Tenants', 'InvoiceItems']);
}

/**
 * Housekeeping, at most once a day on a read.
 *
 * Statuses used to be recomputed — and written — on every page load, by every
 * user. They only change with the date, so the first load of the day does it,
 * and every other load is read-only. A daily trigger on dailyMaintenanceJob
 * gets it done before anyone opens the app; writes still refresh at once.
 */
function refreshIfStale(user) {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('LAST_REFRESH') === today()) return;
  withLock(function () {
    if (props.getProperty('LAST_REFRESH') === today()) return;
    refreshStatuses(user, true);
  });
}

/** Attach a daily time-driven trigger to this, early in the morning. */
function dailyMaintenanceJob() {
  invalidateAll();
  refreshStatuses(SYSTEM_ACTOR, false);
}

function refreshStatusesLocked(user, quiet) {
  var t = today();
  var changes = 0;
  var sys = SYSTEM_ACTOR;

  readTable('Invoices').forEach(function (inv) {
    if (['Paid', 'Void', 'Draft'].indexOf(String(inv.status)) >= 0) return;
    if (inv.due_date && String(inv.due_date) < t && String(inv.status) !== 'Overdue') {
      updateRow('Invoices', inv.id, { status: 'Overdue' }, sys, true); changes++;
    }
  });

  var occupied = {};
  readTable('Leases').forEach(function (lease) {
    var status = String(lease.status);
    if (status === 'Terminated') return;
    if (lease.end_date && String(lease.end_date) < t && status !== 'Expired') {
      updateRow('Leases', lease.id, { status: 'Expired' }, sys, true); changes++;
      return;
    }
    if (lease.start_date && String(lease.start_date) > t && status !== 'Upcoming') {
      updateRow('Leases', lease.id, { status: 'Upcoming' }, sys, true); changes++;
    }
    if (String(lease.start_date) <= t && (!lease.end_date || String(lease.end_date) >= t)) {
      if (status !== 'Active') { updateRow('Leases', lease.id, { status: 'Active' }, sys, true); changes++; }
      occupied[lease.unit_id] = true;
    }
  });

  readTable('Units').forEach(function (unit) {
    if (String(unit.status) === 'Under Maintenance') return;
    var want = occupied[unit.id] ? 'Occupied' : 'Vacant';
    if (String(unit.status) !== want) { updateRow('Units', unit.id, { status: want }, sys, true); changes++; }
  });

  // A tenant is Active while they hold a live lease and Past once every lease
  // has ended, so the dashboard stops counting people who moved out. Someone
  // with no lease at all is left alone — they are a Prospect until signed.
  var live = {}, everLeased = {};
  readTable('Leases').forEach(function (l) {
    if (!l.tenant_id) return;
    everLeased[l.tenant_id] = true;
    if (['Active', 'Upcoming'].indexOf(String(l.status)) >= 0) live[l.tenant_id] = true;
  });
  readTable('Tenants').forEach(function (tenant) {
    if (!everLeased[tenant.id]) return;
    var want = live[tenant.id] ? 'Active' : 'Past';
    if (String(tenant.status) !== want) {
      updateRow('Tenants', tenant.id, { status: want }, sys, true); changes++;
    }
  });

  changes += applyLateFees(sys);
  pruneActivityLog();

  if (!quiet) log(user || sys, 'refresh-statuses', 'System', '', changes + ' rows updated');
  return { changes: changes };
}

/**
 * Charge the lease's late fee on an invoice that has gone overdue.
 *
 * Added as an ordinary line item so it appears on the printed invoice and in
 * the totals like any other charge, and applied at most once per invoice — the
 * fee is for being late, not for each day of lateness.
 */
function applyLateFees(actor) {
  var leases = {};
  readTable('Leases').forEach(function (l) { leases[l.id] = l; });

  var charged = {};
  readTable('InvoiceItems').forEach(function (it) {
    if (String(it.category) === 'Late Fee') charged[it.invoice_id] = true;
  });

  var applied = 0;
  readTable('Invoices').forEach(function (inv) {
    if (String(inv.status) !== 'Overdue') return;
    if (charged[inv.id]) return;
    // a late fee is for late rent; a security deposit is refundable money held,
    // not a charge the tenant can be fined for paying a day after move-in
    if (String(inv.type) === 'Deposit') return;
    var lease = leases[inv.lease_id];
    if (!lease) return;
    var fee = round2(parseFloat(lease.late_fee || 0) || 0);
    if (fee <= 0) return;

    // a late fee on rent is taxed like the rent it is charged on
    var rate = num(lease.gst_rate);
    createRow('InvoiceItems', {
      invoice_id: inv.id, description: 'Late fee · payment overdue since ' + inv.due_date,
      category: 'Late Fee', quantity: 1, unit_amount: fee, amount: fee,
      tax_rate: rate || 0, tax_amount: round2(fee * rate / 100), notes: ''
    }, actor, true);
    applyInvoiceTotals(inv.id, actor);
    log(actor, 'late-fee', 'Invoices', inv.id, String(fee));
    applied++;
  });
  return applied;
}

/**
 * Keep the audit trail to a workable size. It is append-only and every write
 * adds a row, so left alone it eventually dominates the workbook and slows
 * every read of it. The most recent entries are the ones anyone looks at.
 */
var ACTIVITY_LOG_KEEP = 5000;

function pruneActivityLog() {
  var sh = sheetFor('ActivityLog');
  var lastRow = sh.getLastRow();
  var excess = lastRow - 1 - ACTIVITY_LOG_KEEP;
  if (excess < 500) return 0;            // trim in batches, not one row at a time
  sh.deleteRows(2, excess);
  invalidate('ActivityLog');
  return excess;
}

// ───────────────────────────────────────────────────────────────── stats ────

function computeStats() {
  // A property that has been sold or taken out of service is no longer part of
  // the portfolio: counting its units, rent and deposits overstates every
  // headline figure on the dashboard.
  var live = {};
  var liveProperties = 0;
  readTable('Properties').forEach(function (p) {
    var status = String(p.status || 'Active');
    if (status !== 'Sold' && status !== 'Inactive') { live[p.id] = true; liveProperties++; }
  });
  var inPortfolio = function (r) { return !r.property_id || live[r.property_id]; };

  var units = readTable('Units').filter(inPortfolio);
  var leases = readTable('Leases').filter(inPortfolio);
  var invoices = readTable('Invoices');
  var payments = readTable('Payments');
  var expenses = readTable('Expenses');
  var maintenance = readTable('Maintenance').filter(inPortfolio);

  var month = today().slice(0, 7);
  // A deposit is money held for the tenant, not income, and returning it is not
  // an operating expense — so neither moves "collected" or "spent".
  var depositInvoice = {};
  invoices.forEach(function (i) { if (String(i.type) === 'Deposit') depositInvoice[i.id] = true; });
  var ledgers = depositLedgers(leases);
  var sum = function (arr, field, test) {
    var t = 0;
    arr.forEach(function (r) { if (!test || test(r)) t += parseFloat(r[field] || 0) || 0; });
    return round2(t);
  };

  var occupied = 0;
  units.forEach(function (u) { if (String(u.status) === 'Occupied') occupied++; });

  return {
    properties: liveProperties,
    units: units.length,
    occupied_units: occupied,
    vacant_units: units.length - occupied,
    occupancy_rate: units.length ? Math.round((occupied / units.length) * 1000) / 10 : 0,
    active_leases: leases.filter(function (l) { return String(l.status) === 'Active'; }).length,
    tenants: readTable('Tenants').filter(function (t) { return String(t.status) === 'Active'; }).length,
    // the rent actually in force, escalation included
    monthly_rent_roll: round2(leases.reduce(function (t, l) {
      return String(l.status) === 'Active' ? t + currentMonthlyRent(l, today()) : t;
    }, 0)),
    outstanding: sum(invoices, 'balance', function (i) {
      return ['Unpaid', 'Partial', 'Overdue'].indexOf(String(i.status)) >= 0;
    }),
    overdue: sum(invoices, 'balance', function (i) { return String(i.status) === 'Overdue'; }),
    overdue_count: invoices.filter(function (i) { return String(i.status) === 'Overdue'; }).length,
    collected_this_month: sum(payments, 'amount', function (p) {
      return String(p.payment_date || '').slice(0, 7) === month && !depositInvoice[p.invoice_id] &&
             String(p.method) !== 'Deposit Adjustment';
    }),
    expenses_this_month: sum(expenses, 'amount', function (e) {
      return String(e.date || '').slice(0, 7) === month && String(e.category) !== 'Deposit Refund';
    }),
    open_tickets: maintenance.filter(function (m) {
      return ['Open', 'In Progress', 'On Hold'].indexOf(String(m.status)) >= 0;
    }).length,
    // what is still owed back to tenants, from the deposit ledger — a
    // terminated lease whose deposit has not been returned still owes it
    deposits_held: round2(leases.reduce(function (t, l) { return t + (ledgers[l.id] ? ledgers[l.id].held : 0); }, 0))
  };
}

// ───────────────────────────────────────────────────────────── reminders ────

/** Attach a daily time-driven trigger to this function to email rent reminders. */
function dailyReminderJob() {
  invalidateAll();
  var settings = readSettings();
  if (String(settings.reminder_enabled).toLowerCase() !== 'true') return;
  sendReminders({ email: 'scheduler', role: 'admin', name: 'Scheduler' }, { scheduled: true });
}

/**
 * The days an unpaid invoice is due a reminder on, from the settings: N days
 * before it falls due, on the day itself, and on each listed day overdue.
 */
function reminderSchedule(settings) {
  var before = parseInt(settings.reminder_days_before || '3', 10);
  var overdue = String(settings.reminder_overdue_days || '1,7,14,30').split(/[,\s]+/)
    .map(function (d) { return parseInt(d, 10); })
    .filter(function (d) { return d > 0; });
  return { before: isNaN(before) ? 3 : Math.max(0, before), overdue: overdue };
}

/** Whole days from `a` to `b` (yyyy-MM-dd), negative when b is earlier. */
function daysFrom(a, b) {
  var da = parseDate(a), db = parseDate(b);
  if (!da || !db) return NaN;
  return Math.round((db.getTime() - da.getTime()) / 86400000);
}

/**
 * Email tenants about what they owe.
 *
 * The daily job used to email every overdue tenant every single day, and send
 * the "due soon" note on each of the N days before. It now keeps to a
 * schedule — N days before, on the due date, then on chosen days overdue
 * (1, 7, 14 and 30 by default) — and one tenant gets one email listing all of
 * their invoices, not one per invoice. Nobody is reminded about the same
 * invoice twice in a day, however often the button is pressed.
 *
 * @param opts.scheduled true for the daily job (keeps to the schedule); the
 *   button sends for everything due within the reminder window.
 */
function sendReminders(user, opts) {
  requireRole(user, 'manager');
  var scheduled = !!(opts && opts.scheduled);
  var settings = readSettings();
  var schedule = reminderSchedule(settings);
  var t = today();
  var tenants = {};
  readTable('Tenants').forEach(function (tn) { tenants[tn.id] = tn; });

  var byTenant = {}, order = [];
  readTable('Invoices').forEach(function (inv) {
    if (['Unpaid', 'Partial', 'Overdue'].indexOf(String(inv.status)) < 0) return;
    if (num(inv.balance) <= 0) return;
    if (String(inv.last_reminded) === t) return;
    var until = daysFrom(t, inv.due_date);
    if (isNaN(until)) return;
    var due = scheduled
      ? (until === schedule.before || until === 0 || schedule.overdue.indexOf(-until) >= 0)
      : until <= schedule.before;
    if (!due) return;
    if (!byTenant[inv.tenant_id]) { byTenant[inv.tenant_id] = []; order.push(inv.tenant_id); }
    byTenant[inv.tenant_id].push(inv);
  });

  var sent = 0, skipped = 0, reminded = [];
  var money = function (v) { return (settings.currency_symbol || '') + round2(v).toLocaleString('en-IN'); };
  order.forEach(function (tenantId) {
    var tenant = tenants[tenantId];
    var list = byTenant[tenantId].sort(function (a, b) { return String(a.due_date).localeCompare(String(b.due_date)); });
    // Email is optional on a tenant record; those tenants simply get no email
    // reminder. Chase them from the arrears list instead.
    if (!tenant || !String(tenant.email || '').trim()) { skipped++; return; }

    var overdue = list.some(function (inv) { return String(inv.due_date) < t; });
    var total = list.reduce(function (s, inv) { return s + num(inv.balance); }, 0);
    var lines = list.map(function (inv) {
      return '  ' + inv.id + ' · ' + (inv.type || 'Invoice') +
             (inv.period_start ? ' · ' + inv.period_start + ' to ' + inv.period_end : '') +
             ' · due ' + inv.due_date + ' · ' + money(inv.balance) +
             (String(inv.due_date) < t ? ' (overdue)' : '');
    });
    var subject = (overdue ? 'Payment overdue — ' : 'Payment due — ') + money(total) +
                  ' · ' + (settings.org_name || 'Property Management');
    var body =
      'Hello ' + tenant.full_name + ',\n\n' +
      (overdue ? 'Our records show an overdue balance on your account.\n\n'
               : 'This is a friendly reminder that a payment is due shortly.\n\n') +
      lines.join('\n') + '\n\n' +
      'Total due: ' + money(total) + '\n' +
      (settings.upi_id ? 'Pay by UPI to: ' + settings.upi_id + '\n' : '') +
      '\nPlease disregard this note if payment is already on its way.\n\n' +
      '— ' + (settings.org_name || 'Property Management');
    try {
      MailApp.sendEmail(tenant.email, subject, body);
      sent++;
      reminded = reminded.concat(list);
    } catch (e) { skipped++; }
  });

  reminded.forEach(function (inv) {
    updateRow('Invoices', inv.id, { last_reminded: t }, SYSTEM_ACTOR, true);
  });
  log(user, 'send-reminders', 'Invoices', '', sent + ' sent, ' + skipped + ' skipped' + (scheduled ? ' (scheduled)' : ''));
  return { sent: sent, skipped: skipped, invoices: reminded.length };
}

// ───────────────────────────────────────────────────────── meter readings ──

var METER_CATEGORIES = ['Electricity', 'Water', 'Gas'];

/**
 * Bill a round of meter readings for a property in one go.
 *
 * Each reading is stored, so the next round starts from it. A unit with a live
 * lease on the reading date gets an invoice for its consumption × the rate; a
 * vacant unit's reading is still recorded, and billed to nobody. Everything is
 * written as three block writes, however many units there are.
 */
function billMeterReadings(payload, user) {
  requireRole(user, 'manager');
  return withLock(function () {
    var property = freshRow('Properties', payload.property_id);
    if (!property) throw new Error('Choose the property these readings are for.');
    var category = String(payload.category || '');
    if (METER_CATEGORIES.indexOf(category) < 0) throw new Error('Meter type must be one of ' + METER_CATEGORIES.join(', ') + '.');
    var rate = round2(num(payload.rate));
    if (!(rate > 0)) throw new Error('Enter the rate per unit.');
    var date = String(payload.reading_date || today()).slice(0, 10);
    var due = String(payload.due_date || date).slice(0, 10);
    var t = today();

    var units = {};
    readTable('Units').forEach(function (u) { if (String(u.property_id) === String(property.id)) units[u.id] = u; });
    var leases = readTable('Leases');

    var readings = [], headers = [], meta = [], skipped = [];
    (payload.readings || []).forEach(function (r) {
      if (r.current_reading === '' || r.current_reading === undefined || r.current_reading === null) return;
      var unit = units[r.unit_id];
      if (!unit) throw new Error('Unit ' + r.unit_id + ' is not part of ' + property.name + '.');
      var previous = num(r.previous_reading), current = num(r.current_reading);
      if (current < previous) {
        throw new Error(unit.unit_number + ': the reading ' + current + ' is lower than the previous ' + previous + '.');
      }
      var consumption = Math.round((current - previous) * 1000) / 1000;
      var amount = round2(consumption * rate);
      var lease = null;
      leases.forEach(function (l) {
        if (String(l.unit_id) !== String(unit.id) || String(l.status) === 'Terminated') return;
        if (String(l.start_date) <= date && (!l.end_date || String(l.end_date) >= date)) lease = l;
      });

      var reading = {
        property_id: property.id, unit_id: unit.id, lease_id: lease ? lease.id : '',
        tenant_id: lease ? lease.tenant_id : '', category: category, reading_date: date,
        previous_reading: previous, current_reading: current, consumption: consumption,
        rate: rate, amount: amount, invoice_id: '', notes: ''
      };
      readings.push(reading);

      if (!lease) { skipped.push({ unit_id: unit.id, reason: 'no tenant on ' + date }); return; }
      if (amount <= 0) { skipped.push({ unit_id: unit.id, reason: 'no consumption' }); return; }
      headers.push({
        lease_id: lease.id, tenant_id: lease.tenant_id, unit_id: unit.id, property_id: property.id,
        type: category, period_start: payload.period_start || '', period_end: payload.period_end || date,
        issue_date: date, due_date: due, amount: amount, tax: 0, total: amount,
        amount_paid: 0, balance: amount, status: due < t ? 'Overdue' : 'Unpaid',
        notes: category + ' meter · ' + previous + ' → ' + current
      });
      meta.push({ reading: reading, unit: unit, consumption: consumption, previous: previous, current: current });
    });
    if (!readings.length) throw new Error('Enter at least one current reading.');

    var invoices = appendRows('Invoices', headers, user);
    appendRows('InvoiceItems', invoices.map(function (inv, n) {
      var m = meta[n];
      m.reading.invoice_id = inv.id;
      return {
        invoice_id: inv.id, category: category, quantity: m.consumption, unit_amount: rate,
        amount: inv.amount, tax_rate: 0, tax_amount: 0, notes: '',
        description: category + ' · ' + m.unit.unit_number + ' · ' + m.previous + ' → ' + m.current +
                     ' = ' + m.consumption + ' units'
      };
    }), user);
    appendRows('MeterReadings', readings, user);

    log(user, 'meter-readings', 'MeterReadings', property.id,
        category + ' · ' + readings.length + ' read, ' + invoices.length + ' billed');
    return { readings: readings.length, invoices: invoices, skipped: skipped };
  }, ['Units', 'Leases', 'Invoices', 'MeterReadings']);
}

// ───────────────────────────────────────────────────────────── date utils ──

function parseDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  var s = String(v).slice(0, 10);
  var m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) { var d = new Date(s); return isNaN(d.getTime()) ? null : d; }
  return new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
}

function fmtDate(d) { return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd'); }

function addMonths(d, n) {
  var day = d.getDate();
  var r = new Date(d.getFullYear(), d.getMonth() + n, 1);
  var lastDay = new Date(r.getFullYear(), r.getMonth() + 1, 0).getDate();
  r.setDate(Math.min(day, lastDay));
  return r;
}

function monthsBetween(a, b) {
  return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
}

function round2(n) { return Math.round((parseFloat(n) || 0) * 100) / 100; }

// ──────────────────────────────────────────────────── editor conveniences ──

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Property Manager')
    .addItem('Initialise tables', 'menuSetup')
    .addItem('Recover admin access', 'menuRecoverAccess')
    .addItem('Generate invoices (today)', 'menuGenerate')
    .addItem('Refresh statuses', 'menuRefresh')
    .addItem('Send rent reminders', 'menuReminders')
    .addSeparator()
    .addItem('Install daily automation', 'menuInstallTriggers')
    .addToUi();
}

function menuSetup() {
  invalidateAll();
  var ui = SpreadsheetApp.getUi();
  var phone = ui.prompt('Admin phone number (this is the sign-in credential)').getResponseText();
  var pass = ui.prompt('Admin password (min ' + MIN_PASSWORD + ' characters)').getResponseText();
  var res = doSetup({ adminPhone: phone, adminPassword: pass, adminName: 'Administrator' }, '', true);
  ui.alert(JSON.stringify(res));
}

function menuRecoverAccess() {
  invalidateAll();
  var ui = SpreadsheetApp.getUi();
  var phone = ui.prompt('Phone number to sign in with').getResponseText();
  var pass = ui.prompt('New password (min ' + MIN_PASSWORD + ' characters)').getResponseText();
  try {
    var r = recoverAccess(phone, pass, 'Administrator');
    ui.alert('Done.\n\n' + r.name + ' (' + r.phone + ') is now an active administrator.' +
             '\n\nSign in with that number and the password you just set.');
  } catch (e) {
    ui.alert('Could not recover access: ' + e.message);
  }
}

function menuGenerate() {
  invalidateAll();
  var res = generateInvoices({}, { email: 'menu', role: 'admin', name: 'Sheet menu' });
  tellOwner(res.created + ' invoice(s) created.');
}

function menuRefresh() {
  invalidateAll();
  var res = refreshStatuses({ email: 'menu', role: 'admin', name: 'Sheet menu' });
  tellOwner(res.changes + ' row(s) updated.');
}

/**
 * Create the daily triggers the app relies on, once: housekeeping early in the
 * morning, then reminders (they only send when switched on in Settings).
 * Existing triggers for the same functions are left alone, so running it twice
 * does not double anything.
 */
function menuInstallTriggers() {
  var wanted = { dailyMaintenanceJob: 5, dailyReminderJob: 9 };
  var have = {};
  ScriptApp.getProjectTriggers().forEach(function (tr) { have[tr.getHandlerFunction()] = true; });
  var made = [];
  Object.keys(wanted).forEach(function (fn) {
    if (have[fn]) return;
    ScriptApp.newTrigger(fn).timeBased().everyDays(1).atHour(wanted[fn]).create();
    made.push(fn);
  });
  tellOwner(made.length ? 'Installed: ' + made.join(', ') + '.' : 'The daily triggers were already installed.');
}

function menuReminders() {
  invalidateAll();
  var res = sendReminders({ email: 'menu', role: 'admin', name: 'Sheet menu' }, { scheduled: false });
  tellOwner(res.sent + ' reminder(s) sent, ' + res.skipped + ' skipped.');
}

/**
 * Show a result in the spreadsheet when someone is looking at it.
 *
 * The setup guide has these menu functions put on time-driven triggers, where
 * there is no UI: getUi() throws there, so the run was reported as failed —
 * and emailed to the owner as a failure — every night, after doing its work.
 */
function tellOwner(message) {
  try { SpreadsheetApp.getUi().alert(message); }
  catch (e) { console.log(message); }
}
