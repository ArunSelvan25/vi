/**
 * In-memory stand-in for the Google Apps Script runtime: a fake spreadsheet,
 * cache, script properties, lock and crypto, so `apps-script/Code.gs` can be
 * executed and attacked from Node. Shared by the security and production
 * suites, and by the dev server, which runs the real backend on top of it.
 *
 * It copies the Sheets behaviours the backend has to cope with, because a
 * forgiving fake is how bugs got past the tests before:
 *
 *  - text shaped like a date is stored as a date, at midnight in the
 *    SPREADSHEET's time zone, and comes back as a Date object;
 *  - text starting "=" becomes a formula; a leading apostrophe marks literal
 *    text and is not part of the value;
 *  - a block write cannot run past the last row of the sheet;
 *  - the script lock is not re-entrant, so taking it twice is an error here.
 */
import fs from 'fs';
import vm from 'vm';
import crypto from 'crypto';

const src = fs.readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');

/** y/m/d/h/m/s of an instant as seen in a time zone. */
function partsIn(date, tz) {
  const out = {};
  new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(date).forEach(p => { if (p.type !== 'literal') out[p.type] = p.value; });
  return out;
}

/** Epoch ms of local midnight on y-m-d in a time zone. */
function midnightIn(y, m, d, tz) {
  const guess = Date.UTC(y, m - 1, d);
  const offset = (instant) => {
    const p = partsIn(new Date(instant), tz);
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - instant;
  };
  let t = guess - offset(guess);
  t = guess - offset(t);          // once more, in case the first guess crossed a DST change
  return t;
}

/**
 * @param {object} [opts]
 * @param {string} [opts.scriptTz]  what Session.getScriptTimeZone() reports
 * @param {string} [opts.sheetTz]   the spreadsheet's own time zone
 */
function makeSandbox({ scriptTz = 'Asia/Kolkata', sheetTz = 'Asia/Kolkata' } = {}) {
  const tabs = new Map();
  // a new Google Sheet has 1000 rows; appendRow grows it, a block write does not
  const sheet = (name, headers) => {
    if (!tabs.has(name)) tabs.set(name, { headers: headers ? headers.slice() : [], rows: [], maxRows: 1000 });
    return tabs.get(name);
  };
  const cache = new Map();
  const props = new Map();
  /** Every value that Sheets would have run as a formula, for the tests to inspect. */
  const formulas = [];
  const lock = { held: false, acquisitions: 0 };
  const zones = { script: scriptTz, sheet: sheetTz };

  // Filled in once the context exists: dates must be the script's own Date, or
  // `instanceof Date` inside Code.gs is false for them.
  let ContextDate = Date;

  const store = (v) => {
    if (typeof v !== 'string') return v;
    if (v.startsWith("'")) return v.slice(1);
    if (v.startsWith('=')) { formulas.push(v); return v; }
    const m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return new ContextDate(midnightIn(+m[1], +m[2], +m[3], zones.sheet));
    return v;
  };

  const mkSheet = (name) => ({
    getLastColumn: () => sheet(name).headers.length,
    getLastRow: () => sheet(name).rows.length + 1,
    getMaxRows: () => sheet(name).maxRows,
    insertRowsAfter: (after, n) => { sheet(name).maxRows += n; },
    setFrozenRows: () => {}, autoResizeColumns: () => {},
    appendRow: (vals) => {
      const s = sheet(name);
      s.rows.push(vals.map(store));
      s.maxRows = Math.max(s.maxRows, s.rows.length + 1);
    },
    deleteRow: (r) => { sheet(name).rows.splice(r - 2, 1); sheet(name).maxRows--; },
    deleteRows: (r, n) => { sheet(name).rows.splice(r - 2, n); sheet(name).maxRows -= n; },
    // Apps Script Range setters return the Range so calls can be chained
    // (`.setValue(x).setFontWeight('bold')`). The mock must do the same or the
    // "add a missing column" path throws instead of running.
    getRange: (row, col, nRows = 1, nCols = 1) => {
      const range = {
        getValues: () => {
          if (row === 1) return [sheet(name).headers.slice(col - 1, col - 1 + nCols)];
          const out = [];
          for (let i = 0; i < nRows; i++) {
            const r = sheet(name).rows[row - 2 + i] || [];
            out.push(Array.from({ length: nCols }, (_, c) => r[col - 1 + c] ?? ''));
          }
          return out;
        },
        setValues(vals) {
          if (row === 1) { sheet(name).headers = vals[0].slice(); return this; }
          if (row + vals.length - 1 > sheet(name).maxRows) {
            throw new Error('The coordinates of the range are outside the dimensions of the sheet.');
          }
          vals.forEach((v, i) => {
            const target = (sheet(name).rows[row - 2 + i] ||= []);
            v.forEach((cell, c) => { target[col - 1 + c] = store(cell); });
          });
          return this;
        },
        setValue(v) {
          if (row === 1) { sheet(name).headers[col - 1] = v; return this; }
          (sheet(name).rows[row - 2] ||= [])[col - 1] = store(v);
          return this;
        },
        setFontWeight() { return this; },
        setBackground() { return this; },
        setNumberFormat() { return this; }
      };
      return range;
    }
  });

  let uuid = 0;
  const sandbox = {
    __tabs: tabs, __cache: cache, __props: props, __formulas: formulas, __lock: lock, __zones: zones,
    Session: { getScriptTimeZone: () => zones.script },
    Utilities: {
      formatDate: (d, tz, fmt) => {
        const p = partsIn(d, tz);
        const day = `${p.year}-${p.month}-${p.day}`;
        return fmt === 'yyyy-MM-dd' ? day : `${day}T${p.hour}:${p.minute}:${p.second}`;
      },
      getUuid: () => 'uuid-' + (++uuid),
      sleep: () => {},
      base64Encode: (v) => Buffer.from(typeof v === 'string' ? v : Buffer.from(v)).toString('base64'),
      base64EncodeWebSafe: (v) => Buffer.from(
        typeof v === 'string' ? v : Buffer.from(v)).toString('base64url'),
      base64DecodeWebSafe: (v) => Array.from(Buffer.from(v, 'base64url')),
      newBlob: (bytes) => ({ getDataAsString: () => Buffer.from(bytes).toString('utf8') }),
      computeDigest: (alg, val) => Array.from(
        crypto.createHash('sha256').update(String(val)).digest()),
      computeHmacSha256Signature: (val, key) =>
        Array.from(crypto.createHmac('sha256', String(key)).update(String(val)).digest()),
      DigestAlgorithm: { SHA_256: 'sha256', MD5: 'md5' },
      Charset: { UTF_8: 'utf8' }
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: k => (props.has(k) ? props.get(k) : null),
        getProperties: () => Object.fromEntries(props),
        setProperty: (k, v) => props.set(k, String(v)),
        deleteProperty: k => props.delete(k)
      })
    },
    CacheService: {
      getScriptCache: () => ({
        get: k => (cache.has(k) ? cache.get(k) : null),
        put: (k, v) => cache.set(k, v),
        remove: k => cache.delete(k)
      })
    },
    LockService: {
      getScriptLock: () => ({
        waitLock() {
          if (lock.held) throw new Error('The script lock is already held by this execution (nested lock).');
          lock.held = true; lock.acquisitions++;
        },
        releaseLock() { lock.held = false; },
        hasLock() { return lock.held; }
      })
    },
    SpreadsheetApp: {
      openById: () => book, getActiveSpreadsheet: () => book,
      getUi: () => ({ alert() {}, prompt: () => ({ getResponseText: () => '' }), createMenu: () => ({ addItem() { return this; }, addSeparator() { return this; }, addToUi() {} }) })
    },
    ScriptApp: {
      getProjectTriggers: () => [],
      newTrigger: () => ({ timeBased() { return this; }, everyDays() { return this; },
                           atHour() { return this; }, create() { return {}; } })
    },
    MailApp: { sendEmail: () => {} },
    ContentService: { createTextOutput: t => ({ setMimeType: () => t }), MimeType: {} },
    console
  };
  const book = {
    getSheetByName: (n) => (tabs.has(n) ? mkSheet(n) : null),
    insertSheet: (n) => { sheet(n, []); return mkSheet(n); },
    getSpreadsheetTimeZone: () => zones.sheet
  };
  vm.createContext(sandbox);
  ContextDate = vm.runInContext('Date', sandbox);
  vm.runInContext(src, sandbox);
  return sandbox;
}


export { makeSandbox };

/** A sandbox with the schema created and an administrator signed in. */
export function bootedSandbox(opts) {
  const box = makeSandbox(opts);
  const setup = box.handle('setup',
    { adminPhone: '9000000001', adminPassword: 'correct-horse' }, '');
  if (!setup.ok) throw new Error('setup failed: ' + setup.error);
  const login = box.handle('login', { phone: '9000000001', password: 'correct-horse' }, '');
  if (!login.ok) throw new Error('admin login failed: ' + login.error);
  return { box, admin: login.data.token };
}
