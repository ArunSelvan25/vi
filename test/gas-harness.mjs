/**
 * In-memory stand-in for the Google Apps Script runtime: a fake spreadsheet,
 * cache, script properties and crypto, so `apps-script/Code.gs` can be executed
 * and attacked from Node. Shared by the security and production-audit suites.
 */
import fs from 'fs';
import vm from 'vm';
import crypto from 'crypto';

const src = fs.readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');

const pad = n => String(n).padStart(2, '0');

/** Minimal in-memory stand-in for the sheets the script reads and writes. */
function makeSandbox() {
  const tabs = new Map();
  const sheet = (name, headers) => {
    if (!tabs.has(name)) tabs.set(name, { headers: headers ? headers.slice() : [], rows: [] });
    return tabs.get(name);
  };
  const cache = new Map();
  const props = new Map();

  const mkSheet = (name) => ({
    getLastColumn: () => sheet(name).headers.length,
    getLastRow: () => sheet(name).rows.length + 1,
    setFrozenRows: () => {}, autoResizeColumns: () => {},
    appendRow: (vals) => sheet(name).rows.push(vals.slice()),
    deleteRow: (r) => sheet(name).rows.splice(r - 2, 1),
    deleteRows: (r, n) => sheet(name).rows.splice(r - 2, n),
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
          vals.forEach((v, i) => { sheet(name).rows[row - 2 + i] = v.slice(); });
          return this;
        },
        setValue(v) {
          if (row === 1) { sheet(name).headers[col - 1] = v; return this; }
          (sheet(name).rows[row - 2] ||= [])[col - 1] = v;
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
    __tabs: tabs, __cache: cache, __props: props,
    Session: { getScriptTimeZone: () => 'Asia/Kolkata' },
    Utilities: {
      formatDate: (d, tz, fmt) => fmt === 'yyyy-MM-dd'
        ? `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`
        : `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T00:00:00`,
      getUuid: () => 'uuid-' + (++uuid),
      base64Encode: (v) => Buffer.from(String(v)).toString('base64'),
      base64EncodeWebSafe: (v) => Buffer.from(
        typeof v === 'string' ? v : Buffer.from(v)).toString('base64url'),
      base64DecodeWebSafe: (v) => Array.from(Buffer.from(v, 'base64url')),
      newBlob: (bytes) => ({ getDataAsString: () => Buffer.from(bytes).toString('utf8') }),
      computeDigest: (alg, val) => Array.from(
        crypto.createHash('sha256').update(String(val)).digest()),
      computeHmacSha256Signature: (val, key) =>
        Array.from(crypto.createHmac('sha256', String(key)).update(String(val)).digest()),
      DigestAlgorithm: { SHA_256: 'sha256' },
      Charset: { UTF_8: 'utf8' }
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: k => (props.has(k) ? props.get(k) : null),
        setProperty: (k, v) => props.set(k, v)
      })
    },
    CacheService: {
      getScriptCache: () => ({
        get: k => (cache.has(k) ? cache.get(k) : null),
        put: (k, v) => cache.set(k, v),
        remove: k => cache.delete(k)
      })
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    SpreadsheetApp: {
      openById: () => book, getActiveSpreadsheet: () => book,
      getUi: () => ({ alert() {}, prompt: () => ({ getResponseText: () => '' }), createMenu: () => ({ addItem() { return this; }, addToUi() {} }) })
    },
    MailApp: { sendEmail: () => {} },
    ContentService: { createTextOutput: t => ({ setMimeType: () => t }), MimeType: {} },
    console
  };
  const book = {
    getSheetByName: (n) => (tabs.has(n) ? mkSheet(n) : null),
    insertSheet: (n) => { sheet(n, []); return mkSheet(n); }
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox;
}


export { makeSandbox };

/** A sandbox with the schema created and an administrator signed in. */
export function bootedSandbox() {
  const box = makeSandbox();
  const setup = box.handle('setup',
    { adminPhone: '9000000001', adminPassword: 'correct-horse' }, '');
  if (!setup.ok) throw new Error('setup failed: ' + setup.error);
  const login = box.handle('login', { phone: '9000000001', password: 'correct-horse' }, '');
  if (!login.ok) throw new Error('admin login failed: ' + login.error);
  return { box, admin: login.data.token };
}
