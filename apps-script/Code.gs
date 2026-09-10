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
               'emergency_name','emergency_phone','status','notes','created_at','updated_at'],
  Leases:     ['id','property_id','unit_id','tenant_id','start_date','end_date','rent_amount',
               'deposit_amount','deposit_status','frequency','billing_day','late_fee','grace_days',
               'escalation_pct','status','notes','created_at','updated_at'],
  Invoices:   ['id','lease_id','tenant_id','unit_id','property_id','type','period_start','period_end',
               'issue_date','due_date','amount','tax','total','amount_paid','balance','status','notes',
               'created_at','updated_at'],
  InvoiceItems:['id','invoice_id','description','category','quantity','unit_amount','amount','notes',
               'created_at','updated_at'],
  Payments:   ['id','invoice_id','lease_id','tenant_id','property_id','payment_date','amount','method',
               'reference','received_by','notes','created_at','updated_at'],
  Maintenance:['id','property_id','unit_id','tenant_id','title','description','category','priority',
               'status','reported_date','scheduled_date','completed_date','vendor_name','vendor_phone',
               'cost','notes','created_at','updated_at'],
  Expenses:   ['id','property_id','unit_id','date','category','vendor','description','amount',
               'payment_method','reference','receipt_url','created_at','updated_at'],
  Documents:  ['id','entity_type','entity_id','title','category','url','issue_date','expiry_date','notes',
               'created_at','updated_at'],
  Users:      ['id','name','phone','email','role','salt','password_hash','password_changed_at',
               'active','last_login','created_at','updated_at'],
  Settings:   ['key','value'],
  ActivityLog:['id','timestamp','actor','action','entity','entity_id','details']
};

var ID_PREFIX = {
  Properties:'PRP', Units:'UNT', Tenants:'TNT', Leases:'LSE', Invoices:'INV', Payments:'PAY',
  InvoiceItems:'ITM', Maintenance:'MNT', Expenses:'EXP', Documents:'DOC', Users:'USR', ActivityLog:'LOG'
};

var DEFAULT_SETTINGS = {
  org_name: 'VI Lifestyle Properties',
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
  session_hours: '12'
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
  var hidden = NEVER_RETURN[table];
  var rows = readTable(table);
  if (!hidden) return rows;
  return rows.map(function (row) {
    var safe = {};
    Object.keys(row).forEach(function (k) {
      if (hidden.indexOf(k) < 0) safe[k] = row[k];
    });
    return safe;
  });
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

    switch (action) {
      case 'me':               return ok({ user: user, settings: readSettings() });
      case 'bootstrap':        return ok(bootstrap(user));
      case 'list':             return ok({ rows: readTableForClient(assertTable(payload.table), user) });
      case 'create':           return ok(withSnapshot(payload, user, { row: writeRow('create', payload, user) }));
      case 'update':           return ok(withSnapshot(payload, user, { row: writeRow('update', payload, user) }));
      case 'remove':           return ok(withSnapshot(payload, user, { id: deleteRow(payload.table, payload.id, user) }));
      case 'saveInvoice':      return ok(withSnapshot(payload, user, saveInvoice(payload, user)));
      case 'recordPayment':    return ok(withSnapshot(payload, user, recordPayment(payload, user)));
      case 'voidPayment':      return ok(withSnapshot(payload, user, voidPayment(payload.id, user)));
      case 'generateInvoices': return ok(withSnapshot(payload, user, generateInvoices(payload, user)));
      case 'refreshStatuses':  requireRole(user, 'manager'); return ok(withSnapshot(payload, user, refreshStatuses(user)));
      case 'changePassword':   return ok(changePassword(payload, user));
      case 'createUser':       return ok({ row: createUser(payload, user) });
      case 'resetPassword':    return ok(resetPassword(payload, user));
      case 'setUserActive':    return ok({ row: setUserActive(payload, user) });
      case 'setUserRole':      return ok({ row: setUserRole(payload, user) });
      case 'sendReminders':    return ok(sendReminders(user));
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
  if (payload && payload.withSnapshot) data.snapshot = bootstrap(user);
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
var CACHE = { book: null, sheets: {}, headers: {}, values: {} };

/** Forget a tab's contents. Called after every write to it. */
function invalidate(table) {
  delete CACHE.values[table];
}

/** Forget everything, header rows included — for when columns change. */
function invalidateAll() {
  CACHE = { book: null, sheets: {}, headers: {}, values: {} };
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

/** Read a whole tab as an array of plain objects. */
function readTable(name) {
  var sh = sheetFor(name);
  var headers = headersOf(sh, name);
  var values = valuesOf(name);
  var out = [];
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    if (row.join('') === '') continue;
    var obj = {};
    for (var c = 0; c < headers.length; c++) obj[headers[c]] = normalise(row[c]);
    obj._row = i + 2;
    out.push(obj);
  }
  return out;
}

/** Dates become ISO yyyy-MM-dd, everything else a primitive. */
function normalise(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
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
 * Next sequential id for a table.
 *
 * Reads only the id column, not the whole tab. Bulk operations call this once
 * per row created — generating a year of rent raises an invoice and a line item
 * each month — so reading every cell here made the work quadratic and put the
 * 6-minute execution limit within reach.
 *
 * Like findRowIndex, never served from the memo: it is called inside the write
 * lock so that no other execution can be handed the same id, and a copy taken
 * before the lock would defeat that.
 */
function nextId(name) {
  var prefix = ID_PREFIX[name] || 'ROW';
  // the one id people see on paper, so it is configurable
  if (name === 'Invoices') {
    var configured = String(readSettings().invoice_prefix || '').trim();
    if (configured) prefix = configured;
  }
  var sh = sheetFor(name);
  var headers = headersOf(sh, name);
  var idCol = headers.indexOf('id') + 1;
  if (idCol === 0) return prefix + '-' + pad(1, 5);

  var lastRow = sh.getLastRow();
  var max = 0;
  if (lastRow >= 2) {
    var col = sh.getRange(2, idCol, lastRow - 1, 1).getValues();
    for (var i = 0; i < col.length; i++) {
      var m = String(col[i][0] || '').match(/(\d+)$/);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
  }
  return prefix + '-' + pad(max + 1, 5);
}

function pad(n, w) { var s = String(n); while (s.length < w) s = '0' + s; return s; }
function nowIso() { return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ss"); }
function today()  { return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'); }

// ───────────────────────────────────────────────────────────────── CRUD ────

function createRow(table, data, user, skipLog) {
  assertTable(table);
  requireRole(user, minRoleFor(table));
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = sheetFor(table);
    var headers = headersOf(sh, table);
    var row = {};
    headers.forEach(function (h) { row[h] = data[h] !== undefined ? data[h] : ''; });
    if (headers.indexOf('id') >= 0) row.id = data.id || nextId(table);
    if (headers.indexOf('created_at') >= 0) row.created_at = nowIso();
    if (headers.indexOf('updated_at') >= 0) row.updated_at = nowIso();
    sh.appendRow(headers.map(function (h) { return row[h]; }));
    invalidate(table);
    if (!skipLog) log(user, 'create', table, row.id, data.name || data.full_name || '');
    return row;
  } finally { lock.releaseLock(); }
}

function updateRow(table, id, data, user, skipLog) {
  assertTable(table);
  requireRole(user, minRoleFor(table));
  if (table === 'Users' && (data.role !== undefined || data.active !== undefined)) {
    assertAdminRemains(id, data);
  }
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = sheetFor(table);
    var headers = headersOf(sh, table);
    var r = findRowIndex(table, id);
    if (r < 0) throw new Error(table + ' ' + id + ' not found');
    var current = sh.getRange(r, 1, 1, headers.length).getValues()[0];
    var row = {};
    headers.forEach(function (h, i) { row[h] = normalise(current[i]); });
    Object.keys(data).forEach(function (k) { if (headers.indexOf(k) >= 0 && k !== 'id') row[k] = data[k]; });
    if (headers.indexOf('updated_at') >= 0) row.updated_at = nowIso();
    sh.getRange(r, 1, 1, headers.length).setValues([headers.map(function (h) { return row[h]; })]);
    invalidate(table);
    if (!skipLog) log(user, 'update', table, id, JSON.stringify(data).slice(0, 200));
    return row;
  } finally { lock.releaseLock(); }
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

  // Refuse to leave other rows pointing at something that no longer exists.
  // An invoice's own line items are the one exception: they are part of it.
  assertNoDependents(table, id);
  if (table === 'Invoices') {
    readTable('InvoiceItems').forEach(function (item) {
      if (item.invoice_id === id) deleteRow('InvoiceItems', item.id, user);
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

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = sheetFor(table);
    var r = findRowIndex(table, id);
    if (r < 0) throw new Error(table + ' ' + id + ' not found');
    sh.deleteRow(r);
    invalidate(table);
    log(user, 'delete', table, id, '');
  } finally { lock.releaseLock(); }

  // Deleting money received has to put the invoice back where it was, or the
  // ledger keeps showing it as settled.
  if (affectedInvoice) applyInvoiceTotals(affectedInvoice, user);
  // Removing a lease frees its unit.
  if (table === 'Leases' || table === 'Units') refreshStatuses(user, true);

  return id;
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
               ['Maintenance', 'property_id', 'maintenance ticket']],
  Units:      [['Leases', 'unit_id', 'lease'], ['Invoices', 'unit_id', 'invoice'],
               ['Maintenance', 'unit_id', 'maintenance ticket'], ['Expenses', 'unit_id', 'expense']],
  Tenants:    [['Leases', 'tenant_id', 'lease'], ['Invoices', 'tenant_id', 'invoice'],
               ['Payments', 'tenant_id', 'payment']],
  Leases:     [['Invoices', 'lease_id', 'invoice'], ['Payments', 'lease_id', 'payment']],
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
  var data = payload.data || {};

  if (op === 'create' && CREATE_DEFAULTS[table]) {
    var defaults = CREATE_DEFAULTS[table];
    Object.keys(defaults).forEach(function (k) {
      if (data[k] === '' || data[k] === null || data[k] === undefined) data[k] = defaults[k];
    });
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
    var received = 0;
    readTable('Payments').forEach(function (pay) {
      if (String(pay.invoice_id) === String(payload.id)) received += parseFloat(pay.amount || 0) || 0;
    });
    if (received > 0) {
      throw new Error('Cannot void ' + payload.id + ' — ' + round2(received) +
                      ' has already been received against it. Delete those payments first.');
    }
  }

  if (table === 'Leases') {
    var merged = data;
    if (op === 'update') {
      // validate against the row as it will be, not just the fields that changed
      var before = null;
      readTable('Leases').forEach(function (l) { if (l.id === payload.id) before = l; });
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
  }

  var row = op === 'create'
    ? createRow(table, data, user)
    : updateRow(table, payload.id, data, user);

  // Recompute paid/balance/status from the Payments tab so the figures can
  // never be inconsistent with the money actually received.
  if (table === 'Invoices' && String(row.status) !== 'Draft') {
    row = applyInvoiceTotals(row.id, user) || row;
  }
  // Occupancy is derived from leases, so it has to be re-derived as soon as one
  // changes — not left until the next page load.
  if (table === 'Leases' || table === 'Units') refreshStatuses(user, true);

  // Signing a lease with a deposit makes that deposit due, like the first rent.
  if (table === 'Leases' && op === 'create') raiseDepositInvoice(row, user);

  // A finished ticket's cost becomes an ordinary expense, so it is counted in
  // exactly one place.
  if (table === 'Maintenance') recordMaintenanceExpense(row, user);

  // Marking a deposit refunded removes a liability; without a matching expense
  // the money leaves the business with nothing in the P&L to show for it.
  if (table === 'Leases' && op === 'update' && String(data.deposit_status) === 'Refunded') {
    recordDepositRefund(row, user);
  }

  return row;
}

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
  return invoice;
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
  if (['Refunded', 'Partially Refunded'].indexOf(String(lease.deposit_status)) >= 0) return;

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

function recordDepositRefund(lease, user) {
  var amount = round2(parseFloat(lease.deposit_amount || 0) || 0);
  if (amount <= 0) return null;

  // never write it twice, however often the lease is saved
  var already = false;
  readTable('Expenses').forEach(function (e) {
    if (e.category === 'Deposit Refund' && String(e.reference) === String(lease.id)) already = true;
  });
  if (already) return null;

  var tenant = null;
  readTable('Tenants').forEach(function (t) { if (t.id === lease.tenant_id) tenant = t; });
  return createRow('Expenses', {
    property_id: lease.property_id, unit_id: lease.unit_id, date: today(),
    category: 'Deposit Refund',
    description: 'Security deposit returned' + (tenant ? ' to ' + tenant.full_name : '') +
                 ' · lease ' + lease.id,
    amount: amount, reference: lease.id
  }, user, true);
}

function log(user, action, entity, entityId, details) {
  try {
    var sh = sheetFor('ActivityLog');
    sh.appendRow([nextId('ActivityLog'), nowIso(),
                  (user && (user.phone || user.email || user.name)) || 'system',
                  action, entity, entityId || '', details || '']);
    invalidate('ActivityLog');
  } catch (e) { /* logging must never break a write */ }
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

// ── login throttling ────────────────────────────────────────────────────────
// Apps Script gives no per-caller rate limiting, so failed attempts are counted
// in the script cache: per-account to stop a targeted guess, and globally to
// stop password spraying across many accounts.
var THROTTLE = { perAccount: 5, global: 30, windowSec: 900 };

function throttleKey(identifier) { return 'lf:' + Utilities.base64Encode(String(identifier)); }

function throttleCheck(identifier) {
  var cache = CacheService.getScriptCache();
  var mine = parseInt(cache.get(throttleKey(identifier)) || '0', 10);
  var all = parseInt(cache.get('lf:__global') || '0', 10);
  if (mine >= THROTTLE.perAccount || all >= THROTTLE.global) {
    throw new Error('Too many failed sign-in attempts. Try again in 15 minutes.');
  }
}

function throttleFail(identifier) {
  var cache = CacheService.getScriptCache();
  var k = throttleKey(identifier);
  cache.put(k, String(parseInt(cache.get(k) || '0', 10) + 1), THROTTLE.windowSec);
  cache.put('lf:__global', String(parseInt(cache.get('lf:__global') || '0', 10) + 1), THROTTLE.windowSec);
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

  var hours = parseFloat(readSettings().session_hours || '12') || 12;
  var token = signToken({
    id: found.id, phone: found.phone, email: found.email,
    name: found.name, role: found.role,
    iat: Date.now(),
    exp: Date.now() + hours * 3600 * 1000
  });
  updateRow('Users', found.id, { last_login: nowIso() },
            { phone: found.phone, role: 'admin' }, true);
  return ok({
    token: token,
    user: { id: found.id, phone: found.phone, email: found.email,
            name: found.name, role: found.role },
    settings: readSettings()
  });
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
  updateRow('Users', me.id, {
    salt: salt, password_hash: hashPassword(payload.next, salt),
    password_changed_at: Date.now()
  }, SYSTEM_ACTOR, true);
  log(user, 'password-change', 'Users', me.id, '');
  return { changed: true };
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
  return createRow('Users', {
    name: payload.name,
    phone: String(payload.phone).trim(),
    email: payload.email ? String(payload.email).trim().toLowerCase() : '',
    role: payload.role || 'viewer',
    salt: salt, password_hash: hashPassword(payload.password, salt),
    password_changed_at: Date.now(), active: 'TRUE'
  }, user);
}

// ───────────────────────────────────────────────────────────────── setup ────

/**
 * Create any missing tab and append any column the schema has gained. Purely
 * additive: existing rows, values and hand-added columns are never touched.
 */
function ensureSchema() {
  invalidateAll();
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
function bootstrap(user) {
  refreshStatuses(user, true);
  return {
    user: user,
    settings: readSettings(),
    properties: readTable('Properties'),
    units: readTable('Units'),
    tenants: readTable('Tenants'),
    leases: readTable('Leases'),
    invoices: readTable('Invoices'),
    invoiceItems: readTable('InvoiceItems'),
    payments: readTable('Payments'),
    maintenance: readTable('Maintenance'),
    expenses: readTable('Expenses'),
    documents: readTable('Documents'),
    users: (user.role === 'admin' ? readTable('Users').map(scrubUser) : []),
    activity: (ROLE_RANK[user.role] >= ROLE_RANK[readRoleFor('ActivityLog')]
      ? readTableTail('ActivityLog', 200).reverse() : []),
    stats: computeStats()
  };
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
  var upto = payload.upto || today();
  var leases = readTable('Leases');
  var invoices = readTable('Invoices');
  var settings = readSettings();

  var billed = {};
  invoices.forEach(function (inv) {
    if (inv.type === 'Rent') billed[inv.lease_id + '|' + inv.period_start] = true;
  });

  var created = [];
  for (var i = 0; i < leases.length; i++) {
    var lease = leases[i];
    if (String(lease.status) !== 'Active') continue;
    var periods = periodsFor(lease, upto);
    for (var p = 0; p < periods.length; p++) {
      var period = periods[p];
      if (billed[lease.id + '|' + period.start]) continue;
      var amount = round2(period.amount);
      var row = createRow('Invoices', {
        lease_id: lease.id, tenant_id: lease.tenant_id, unit_id: lease.unit_id,
        property_id: lease.property_id, type: 'Rent',
        period_start: period.start, period_end: period.end,
        issue_date: period.start, due_date: period.due,
        amount: amount, tax: 0, total: amount, amount_paid: 0, balance: amount,
        status: period.due < today() ? 'Overdue' : 'Unpaid',
        notes: period.prorated
          ? 'Auto-generated part period — ' + period.days + ' of ' + period.fullDays + ' days'
          : 'Auto-generated ' + lease.frequency + ' rent'
      }, user, true);
      createRow('InvoiceItems', {
        invoice_id: row.id,
        description: 'Rent · ' + period.start + ' to ' + period.end +
                     (period.prorated ? ' (' + period.days + '/' + period.fullDays + ' days)' : ''),
        category: 'Rent', quantity: 1, unit_amount: amount, amount: amount, notes: ''
      }, user, true);
      created.push(row);
    }
  }
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

  var data = payload.data || {};
  var items = payload.items || [];
  if (!items.length) throw new Error('An invoice needs at least one line item');

  // price each line, then let the lines define the invoice total
  var subtotal = 0;
  var priced = items.map(function (raw) {
    var qty = raw.quantity === '' || raw.quantity === undefined ? 1 : (parseFloat(raw.quantity) || 0);
    var unit = parseFloat(raw.unit_amount || 0) || 0;
    var amount = round2(qty * unit);
    subtotal += amount;
    return {
      id: raw.id || '',
      description: String(raw.description || '').trim(),
      category: raw.category || 'Other',
      quantity: qty,
      unit_amount: unit,
      amount: amount,
      notes: raw.notes || ''
    };
  });

  for (var i = 0; i < priced.length; i++) {
    if (!priced[i].description) throw new Error('Every line item needs a description');
  }

  var tax = parseFloat(data.tax || 0) || 0;
  data.amount = round2(subtotal);
  data.total = round2(subtotal + tax);
  if (!data.status) data.status = 'Unpaid';
  // a single-category invoice keeps that label; a mixed one says so
  var categories = {};
  priced.forEach(function (it) { categories[it.category] = true; });
  var distinct = Object.keys(categories);
  if (!data.type) data.type = distinct.length === 1 ? distinct[0] : 'Mixed';

  data.property_id = inferProperty(data);

  var invoice = payload.id
    ? updateRow('Invoices', payload.id, data, user)
    : createRow('Invoices', data, user);

  // replace the line set: update what stayed, add what is new, drop the rest
  var existing = readTable('InvoiceItems').filter(function (it) {
    return it.invoice_id === invoice.id;
  });
  var kept = {};
  priced.forEach(function (it) {
    var row = { invoice_id: invoice.id, description: it.description, category: it.category,
                quantity: it.quantity, unit_amount: it.unit_amount, amount: it.amount, notes: it.notes };
    if (it.id && existing.some(function (e) { return e.id === it.id; })) {
      updateRow('InvoiceItems', it.id, row, user, true);
      kept[it.id] = true;
    } else {
      var made = createRow('InvoiceItems', row, user, true);
      kept[made.id] = true;
    }
  });
  existing.forEach(function (e) {
    if (!kept[e.id]) deleteRow('InvoiceItems', e.id, SYSTEM_ACTOR);
  });

  var settled = applyInvoiceTotals(invoice.id, user) || invoice;
  log(user, payload.id ? 'update' : 'create', 'Invoices', invoice.id,
      priced.length + ' line item(s), total ' + data.total);
  return { invoice: settled, items: itemsOfInvoice(invoice.id) };
}

function itemsOfInvoice(invoiceId) {
  return readTable('InvoiceItems').filter(function (it) { return it.invoice_id === invoiceId; });
}

function recordPayment(payload, user) {
  requireRole(user, 'manager');
  var invoiceId = payload.invoice_id;
  var amount = parseFloat(payload.amount || 0);
  if (!(amount > 0)) throw new Error('Payment amount must be greater than zero');

  var invoices = readTable('Invoices');
  var invoice = null;
  for (var i = 0; i < invoices.length; i++) if (invoices[i].id === invoiceId) invoice = invoices[i];
  if (!invoice) throw new Error('Invoice ' + invoiceId + ' not found');
  if (String(invoice.status) === 'Void') throw new Error('That invoice is void.');

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
  return { payment: payment, invoice: updated, alsoSettled: alsoSettled };
}

function voidPayment(paymentId, user) {
  requireRole(user, 'admin');
  var payments = readTable('Payments');
  var target = null;
  for (var i = 0; i < payments.length; i++) if (payments[i].id === paymentId) target = payments[i];
  if (!target) throw new Error('Payment not found');
  deleteRow('Payments', paymentId, user);
  var invoice = target.invoice_id ? applyInvoiceTotals(target.invoice_id, user) : null;
  return { voided: paymentId, invoice: invoice };
}

/** Recompute amount_paid / balance / status for one invoice. */
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
  if (lines.length) {
    amount = 0;
    lines.forEach(function (it) { amount += parseFloat(it.amount || 0) || 0; });
    amount = round2(amount);
  }
  var tax = parseFloat(invoice.tax || 0) || 0;
  var total = lines.length ? round2(amount + tax)
                           : (parseFloat(invoice.total || invoice.amount || 0) || 0);
  var balance = round2(total - paid);
  var status;
  if (String(invoice.status) === 'Void') status = 'Void';
  else if (paid <= 0) status = (invoice.due_date && invoice.due_date < today()) ? 'Overdue' : 'Unpaid';
  else if (balance > 0.009) status = (invoice.due_date && invoice.due_date < today()) ? 'Overdue' : 'Partial';
  else status = 'Paid';

  var saved = updateRow('Invoices', invoiceId,
    { amount: amount, total: total, amount_paid: round2(paid), balance: balance, status: status },
    SYSTEM_ACTOR, true);
  syncDepositStatus(saved, user);
  return saved;
}

/**
 * Housekeeping pass: flips overdue invoices, expires leases, and keeps unit
 * occupancy in sync with the lease table. Cheap enough to run on every load.
 */
var SYSTEM_ACTOR = { role: 'admin', phone: 'system', name: 'system' };

/**
 * Housekeeping: flips overdue invoices, expires leases, syncs unit occupancy.
 *
 * The writes are made as SYSTEM, not as the caller. This runs on every load,
 * including for read-only viewers, and it is the app maintaining its own
 * derived state rather than the user editing anything.
 */
function refreshStatuses(user, quiet) {
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
    var lease = leases[inv.lease_id];
    if (!lease) return;
    var fee = round2(parseFloat(lease.late_fee || 0) || 0);
    if (fee <= 0) return;

    createRow('InvoiceItems', {
      invoice_id: inv.id, description: 'Late fee · payment overdue since ' + inv.due_date,
      category: 'Late Fee', quantity: 1, unit_amount: fee, amount: fee, notes: ''
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
    monthly_rent_roll: sum(leases, 'rent_amount', function (l) { return String(l.status) === 'Active'; }),
    outstanding: sum(invoices, 'balance', function (i) {
      return ['Unpaid', 'Partial', 'Overdue'].indexOf(String(i.status)) >= 0;
    }),
    overdue: sum(invoices, 'balance', function (i) { return String(i.status) === 'Overdue'; }),
    overdue_count: invoices.filter(function (i) { return String(i.status) === 'Overdue'; }).length,
    collected_this_month: sum(payments, 'amount', function (p) {
      return String(p.payment_date || '').slice(0, 7) === month;
    }),
    expenses_this_month: sum(expenses, 'amount', function (e) {
      return String(e.date || '').slice(0, 7) === month;
    }),
    open_tickets: maintenance.filter(function (m) {
      return ['Open', 'In Progress', 'On Hold'].indexOf(String(m.status)) >= 0;
    }).length,
    deposits_held: sum(leases, 'deposit_amount', function (l) {
      return String(l.deposit_status) === 'Held' && String(l.status) !== 'Terminated';
    })
  };
}

// ───────────────────────────────────────────────────────────── reminders ────

/** Attach a daily time-driven trigger to this function to email rent reminders. */
function dailyReminderJob() {
  invalidateAll();
  var settings = readSettings();
  if (String(settings.reminder_enabled).toLowerCase() !== 'true') return;
  sendReminders({ email: 'scheduler', role: 'admin', name: 'Scheduler' });
}

function sendReminders(user) {
  requireRole(user, 'manager');
  var settings = readSettings();
  var days = parseInt(settings.reminder_days_before || '3', 10);
  var tenants = {};
  readTable('Tenants').forEach(function (t) { tenants[t.id] = t; });

  var horizon = new Date();
  horizon.setDate(horizon.getDate() + days);
  var horizonStr = fmtDate(horizon);
  var sent = 0, skipped = 0;

  readTable('Invoices').forEach(function (inv) {
    if (['Unpaid', 'Partial', 'Overdue'].indexOf(String(inv.status)) < 0) return;
    if (String(inv.due_date) > horizonStr) return;
    var tenant = tenants[inv.tenant_id];
    // Email is optional on a tenant record; those tenants simply get no email
    // reminder. Chase them from the arrears list instead.
    if (!tenant || !String(tenant.email || '').trim()) { skipped++; return; }
    var overdue = String(inv.due_date) < today();
    var subject = (overdue ? 'Overdue rent — ' : 'Rent due — ') + inv.id;
    var body =
      'Hello ' + tenant.full_name + ',\n\n' +
      (overdue ? 'Our records show an overdue balance on your account.\n\n'
               : 'This is a friendly reminder that your rent is due shortly.\n\n') +
      'Invoice:  ' + inv.id + '\n' +
      'Period:   ' + inv.period_start + ' to ' + inv.period_end + '\n' +
      'Due date: ' + inv.due_date + '\n' +
      'Balance:  ' + (settings.currency_symbol || '') + inv.balance + '\n\n' +
      'Please disregard this note if payment is already on its way.\n\n' +
      '— ' + (settings.org_name || 'Property Management');
    try { MailApp.sendEmail(tenant.email, subject, body); sent++; } catch (e) { skipped++; }
  });

  log(user, 'send-reminders', 'Invoices', '', sent + ' sent, ' + skipped + ' skipped');
  return { sent: sent, skipped: skipped };
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
    .addToUi();
}

function menuSetup() {
  invalidateAll();
  var ui = SpreadsheetApp.getUi();
  var phone = ui.prompt('Admin phone number (this is the sign-in credential)').getResponseText();
  var pass = ui.prompt('Admin password (min 8 chars)').getResponseText();
  var res = doSetup({ adminPhone: phone, adminPassword: pass, adminName: 'Administrator' }, '', true);
  ui.alert(JSON.stringify(res));
}

function menuRecoverAccess() {
  invalidateAll();
  var ui = SpreadsheetApp.getUi();
  var phone = ui.prompt('Phone number to sign in with').getResponseText();
  var pass = ui.prompt('New password (min 8 characters)').getResponseText();
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
  SpreadsheetApp.getUi().alert(res.created + ' invoice(s) created.');
}

function menuRefresh() {
  invalidateAll();
  var res = refreshStatuses({ email: 'menu', role: 'admin', name: 'Sheet menu' });
  SpreadsheetApp.getUi().alert(res.changes + ' row(s) updated.');
}

function menuReminders() {
  invalidateAll();
  var res = sendReminders({ email: 'menu', role: 'admin', name: 'Sheet menu' });
  SpreadsheetApp.getUi().alert(res.sent + ' reminder(s) sent, ' + res.skipped + ' skipped.');
}
