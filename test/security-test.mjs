/**
 * Runs `apps-script/Code.gs` against an in-memory spreadsheet and attacks it:
 * setup takeover, brute force, enumeration, forged tokens, role escalation.
 */
import { makeSandbox } from './gas-harness.mjs';

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

// ── bootstrap ───────────────────────────────────────────────────────────────
console.log('\n— first-run bootstrap —');
let box = makeSandbox();
check('setup with no admin details is refused', () => {
  const r = box.handle('setup', {}, '');
  assert(r.ok === false && /adminPhone/.test(r.error), JSON.stringify(r));
});
check('setup seeds the first administrator', () => {
  const r = box.handle('setup',
    { adminPhone: '+91 98800 11111', adminEmail: 'OWNER@Example.com', adminPassword: 'correct-horse-battery' }, '');
  assert(r.ok === true && r.data.adminCreated === true, JSON.stringify(r));
});

// ── finding 1: anonymous setup on a configured workspace ────────────────────
console.log('\n— finding 1 · anonymous setup cannot take over —');
check('a second anonymous setup cannot create another admin', () => {
  const before = box.readTable('Users').length;
  const r = box.handle('setup', { adminPhone: '+91 99999 99999', adminPassword: 'setup-pass-1234' }, '');
  const after = box.readTable('Users').length;
  assert(after === before, `user count went ${before} -> ${after}`);
  assert(r.data && r.data.alreadySeeded === true, JSON.stringify(r));
});
check('anonymous setup performs no writes at all', () => {
  const settings = box.sheetFor('Settings');
  const rowsBefore = JSON.stringify(box.__tabs.get('Settings').rows);
  box.__tabs.get('Settings').rows = box.__tabs.get('Settings').rows
    .filter(r => r[0] !== 'org_name');                      // simulate a deletion
  const trimmed = JSON.stringify(box.__tabs.get('Settings').rows);
  box.handle('setup', {}, '');
  const after = JSON.stringify(box.__tabs.get('Settings').rows);
  assert(after === trimmed, 'anonymous setup rewrote settings');
  assert(rowsBefore !== trimmed, 'test set-up did not actually change anything');
});
check('an admin token may still re-run setup (schema sync)', () => {
  const login = box.handle('login', { phone: '+91 98800 11111', password: 'correct-horse-battery' }, '');
  assert(login.ok, 'admin could not sign in: ' + login.error);
  const r = box.handle('setup', {}, login.data.token);
  assert(r.ok === true, JSON.stringify(r));
  const settings = box.readSettings();
  assert(settings.org_name !== undefined, 'admin setup did not restore defaults');
});
check('SETUP_KEY, when set, is required to bootstrap', () => {
  const fresh = makeSandbox();
  fresh.PropertiesService.getScriptProperties().setProperty('SETUP_KEY', 's3cret-key');
  const denied = fresh.handle('setup', { adminPhone: '9000000001', adminPassword: 'setup-pass-1234' }, '');
  assert(denied.ok === false && /setup key/i.test(denied.error), JSON.stringify(denied));
  assert(fresh.readTable('Users').length === 0, 'admin was created without the key');
  const allowed = fresh.handle('setup',
    { adminPhone: '9000000001', adminPassword: 'setup-pass-1234', setupKey: 's3cret-key' }, '');
  assert(allowed.ok === true && allowed.data.adminCreated, JSON.stringify(allowed));
});

// ── finding 2: brute force ──────────────────────────────────────────────────
console.log('\n— finding 2 · login throttling —');
check('repeated wrong passwords lock the account out', () => {
  const b = makeSandbox();
  b.handle('setup', { adminPhone: '9000000001', adminPassword: 'correct-horse-battery' }, '');
  let lockedAt = null;
  for (let i = 1; i <= 8; i++) {
    const r = b.handle('login', { phone: '9000000001', password: 'guess' + i }, '');
    if (/Too many/.test(r.error) && lockedAt === null) lockedAt = i;
  }
  assert(lockedAt !== null, 'never locked out after 8 attempts');
  assert(lockedAt <= 6, 'locked out only at attempt ' + lockedAt);
});
check('lockout blocks the CORRECT password too', () => {
  const b = makeSandbox();
  b.handle('setup', { adminPhone: '9000000001', adminPassword: 'correct-horse-battery' }, '');
  for (let i = 0; i < 6; i++) b.handle('login', { phone: '9000000001', password: 'nope' }, '');
  const r = b.handle('login', { phone: '9000000001', password: 'correct-horse-battery' }, '');
  assert(r.ok === false && /Too many/.test(r.error), 'lockout did not hold: ' + JSON.stringify(r));
});
check('a successful sign-in clears the failure counter', () => {
  const b = makeSandbox();
  b.handle('setup', { adminPhone: '9000000001', adminPassword: 'correct-horse-battery' }, '');
  b.handle('login', { phone: '9000000001', password: 'nope' }, '');
  b.handle('login', { phone: '9000000001', password: 'nope' }, '');
  assert(b.handle('login', { phone: '9000000001', password: 'correct-horse-battery' }, '').ok, 'good login blocked');
  for (let i = 0; i < 4; i++) b.handle('login', { phone: '9000000001', password: 'nope' }, '');
  assert(b.handle('login', { phone: '9000000001', password: 'correct-horse-battery' }, '').ok,
         'counter was not reset by the successful sign-in');
});
check('spraying many accounts trips the global limit', () => {
  const b = makeSandbox();
  b.handle('setup', { adminPhone: '9000000001', adminPassword: 'correct-horse-battery' }, '');
  for (let i = 0; i < 31; i++) b.handle('login', { phone: `90000${String(i).padStart(5, '0')}`, password: 'x' }, '');
  const r = b.handle('login', { phone: '9111111111', password: 'x' }, '');
  assert(/Too many/.test(r.error), 'global spray limit never tripped: ' + JSON.stringify(r));
});

// ── finding 3: enumeration ──────────────────────────────────────────────────
console.log('\n— finding 3 · no account enumeration —');
check('unknown, disabled and wrong-password all give one message', () => {
  const b = makeSandbox();
  b.handle('setup', { adminPhone: '9000000001', adminPassword: 'correct-horse-battery' }, '');
  const login = b.handle('login', { phone: '9000000001', password: 'correct-horse-battery' }, '');
  b.handle('create', { table: 'Users', data: {
    name: 'Off', phone: '9000000002', email: '', role: 'viewer', salt: 's',
    password_hash: 'x', active: 'FALSE' } }, login.data.token);

  const unknown  = b.handle('login', { phone: '9555555555', password: 'p' }, '').error;
  const disabled = b.handle('login', { phone: '9000000002', password: 'p' }, '').error;
  const wrong    = b.handle('login', { phone: '9000000001', password: 'bad' }, '').error;
  assert(unknown === disabled && disabled === wrong,
    `messages differ:\n  unknown="${unknown}"\n  disabled="${disabled}"\n  wrong="${wrong}"`);
  assert(!/disabled/i.test(disabled), 'message leaks account state');
});

// ── phone as the login credential ───────────────────────────────────────────
console.log('\n— phone login —');
check('normalisePhone folds the formats people actually type', () => {
  const n = box.normalisePhone;
  const same = ['+91 98800 11111', '+919880011111', '098800 11111', '9880011111',
                '98800-11111', '(98800) 11111', ' 91 98800 11111 '];
  const want = n(same[0]);
  assert(want === '9880011111', 'baseline normalised to ' + want);
  for (const v of same) assert(n(v) === want, `"${v}" -> "${n(v)}" but expected "${want}"`);
  assert(n('') === '' && n(null) === '' && n(undefined) === '', 'blank input');
  assert(n(9880011111) !== '', 'numeric input from the sheet must work');
});

check('sign-in works whatever format the number is typed in', () => {
  const b = makeSandbox();
  b.handle('setup', { adminPhone: '+91 98800 11111', adminPassword: 'correct-horse-battery' }, '');
  for (const typed of ['+91 98800 11111', '9880011111', '098800 11111', '98800-11111']) {
    const r = b.handle('login', { phone: typed, password: 'correct-horse-battery' }, '');
    assert(r.ok === true, `could not sign in with "${typed}": ${r.error}`);
  }
});

check('a different number cannot sign in', () => {
  const b = makeSandbox();
  b.handle('setup', { adminPhone: '9880011111', adminPassword: 'correct-horse-battery' }, '');
  const r = b.handle('login', { phone: '9880011112', password: 'correct-horse-battery' }, '');
  assert(r.ok === false, 'wrong number was accepted');
});

check('email is optional for an administrator', () => {
  const b = makeSandbox();
  const r = b.handle('setup', { adminPhone: '9880011111', adminPassword: 'correct-horse-battery' }, '');
  assert(r.ok && r.data.adminCreated, JSON.stringify(r));
  const login = b.handle('login', { phone: '9880011111', password: 'correct-horse-battery' }, '');
  assert(login.ok, 'cannot sign in without an email on the account: ' + login.error);
  assert(!login.data.user.email, 'email should be blank, got ' + login.data.user.email);
});

check('a user cannot be created without a phone number', () => {
  const b = makeSandbox();
  b.handle('setup', { adminPhone: '9880011111', adminPassword: 'correct-horse-battery' }, '');
  const admin = b.handle('login', { phone: '9880011111', password: 'correct-horse-battery' }, '').data.token;
  const r = b.handle('createUser', { name: 'No Phone', email: 'x@e.com', password: 'setup-pass-1234' }, admin);
  assert(r.ok === false && /phone/i.test(r.error), JSON.stringify(r));
});

check('a duplicate phone number is rejected, in any format', () => {
  const b = makeSandbox();
  b.handle('setup', { adminPhone: '+91 98800 11111', adminPassword: 'correct-horse-battery' }, '');
  const admin = b.handle('login', { phone: '9880011111', password: 'correct-horse-battery' }, '').data.token;
  const r = b.handle('createUser',
    { name: 'Clash', phone: '098800 11111', role: 'viewer', password: 'setup-pass-1234' }, admin);
  assert(r.ok === false && /already belongs/i.test(r.error), JSON.stringify(r));
});

check('a user created without an email can still sign in', () => {
  const b = makeSandbox();
  b.handle('setup', { adminPhone: '9880011111', adminPassword: 'correct-horse-battery' }, '');
  const admin = b.handle('login', { phone: '9880011111', password: 'correct-horse-battery' }, '').data.token;
  const made = b.handle('createUser',
    { name: 'Site Manager', phone: '+91 99400 33333', role: 'manager', password: 'manager-pass-1234' }, admin);
  assert(made.ok, JSON.stringify(made));
  const login = b.handle('login', { phone: '99400 33333', password: 'manager-pass-1234' }, '');
  assert(login.ok, 'phone-only user cannot sign in: ' + login.error);
  assert(login.data.user.role === 'manager', 'wrong role');
});

check('throttling keys on the normalised number, not the typed string', () => {
  const b = makeSandbox();
  b.handle('setup', { adminPhone: '9880011111', adminPassword: 'correct-horse-battery' }, '');
  // same account, six different spellings — must still lock out
  const spellings = ['9880011111', '+91 98800 11111', '098800 11111',
                     '98800-11111', '(98800)11111', '91 9880011111'];
  for (const p of spellings) b.handle('login', { phone: p, password: 'wrong' }, '');
  const r = b.handle('login', { phone: '9880011111', password: 'correct-horse-battery' }, '');
  assert(/Too many/.test(r.error || ''), 'formatting variations bypassed the lockout');
});

check('a tenant needs no email address', () => {
  const b = makeSandbox();
  b.handle('setup', { adminPhone: '9880011111', adminPassword: 'correct-horse-battery' }, '');
  const admin = b.handle('login', { phone: '9880011111', password: 'correct-horse-battery' }, '').data.token;
  const r = b.handle('create',
    { table: 'Tenants', data: { full_name: 'No Email', phone: '9333333333', status: 'Active' } }, admin);
  assert(r.ok === true, JSON.stringify(r));
  assert(r.data.row.email === '', 'email should be blank');
});

check('reminders skip tenants with no email instead of failing', () => {
  const b = makeSandbox();
  b.handle('setup', { adminPhone: '9880011111', adminPassword: 'correct-horse-battery' }, '');
  const admin = b.handle('login', { phone: '9880011111', password: 'correct-horse-battery' }, '').data.token;
  const withEmail = b.handle('create', { table: 'Tenants',
    data: { full_name: 'Has Email', phone: '9111111111', email: 'a@e.com', status: 'Active' } }, admin).data.row;
  const noEmail = b.handle('create', { table: 'Tenants',
    data: { full_name: 'No Email', phone: '9222222222', status: 'Active' } }, admin).data.row;
  for (const t of [withEmail, noEmail]) {
    b.handle('create', { table: 'Invoices', data: {
      tenant_id: t.id, type: 'Rent', due_date: '2020-01-01', amount: 1000,
      total: 1000, amount_paid: 0, balance: 1000, status: 'Overdue' } }, admin);
  }
  const r = b.handle('sendReminders', {}, admin);
  assert(r.ok === true, JSON.stringify(r));
  assert(r.data.sent === 1, 'expected 1 sent, got ' + r.data.sent);
  assert(r.data.skipped === 1, 'expected 1 skipped, got ' + r.data.skipped);
});

// ── finding 4: constant-time comparison ─────────────────────────────────────
console.log('\n— finding 4 · constant-time compare —');
check('constantTimeEquals is correct', () => {
  const eq = box.constantTimeEquals;
  assert(eq('abc', 'abc') === true, 'equal strings');
  assert(eq('abc', 'abd') === false, 'last char differs');
  assert(eq('abc', 'xbc') === false, 'first char differs');
  assert(eq('abc', 'abcd') === false, 'length differs');
  assert(eq('', '') === true, 'empty');
});

// ── token integrity ─────────────────────────────────────────────────────────
console.log('\n— session tokens —');
check('a tampered token is rejected', () => {
  const b = makeSandbox();
  b.handle('setup', { adminPhone: '9000000001', adminPassword: 'correct-horse-battery' }, '');
  const token = b.handle('login', { phone: '9000000001', password: 'correct-horse-battery' }, '').data.token;
  assert(b.handle('bootstrap', {}, token).ok, 'valid token rejected');

  const [body, sig] = token.split('.');
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
  payload.role = 'admin'; payload.phone = '9999999999';
  const forged = Buffer.from(JSON.stringify(payload)).toString('base64url') + '.' + sig;
  const r = b.handle('bootstrap', {}, forged);
  assert(r.ok === false && r.error === 'AUTH_REQUIRED', 'forged token accepted: ' + JSON.stringify(r));
});
check('an expired token is rejected', () => {
  const b = makeSandbox();
  b.handle('setup', { adminPhone: '9000000001', adminPassword: 'correct-horse-battery' }, '');
  const expired = b.signToken({ id: 'USR-00001', phone: '9000000001', role: 'admin', exp: Date.now() - 1000 });
  assert(b.handle('bootstrap', {}, expired).error === 'AUTH_REQUIRED', 'expired token accepted');
});
check('no token reaches any data action', () => {
  const b = makeSandbox();
  b.handle('setup', { adminPhone: '9000000001', adminPassword: 'correct-horse-battery' }, '');
  for (const action of ['bootstrap', 'list', 'create', 'update', 'remove', 'recordPayment',
                        'generateInvoices', 'createUser', 'sendReminders', 'stats', 'me']) {
    const r = b.handle(action, { table: 'Tenants', data: {}, id: 'x' }, '');
    assert(r.ok === false, `"${action}" succeeded without a token`);
  }
});

// ── role enforcement ────────────────────────────────────────────────────────
console.log('\n— password storage —');
check('hashes are stretched, not a single round', () => {
  const b = makeSandbox();
  b.handle('setup', { adminPhone: '9880011111', adminPassword: 'correct-horse-battery' }, '');
  const stored = b.readTable('Users')[0].password_hash;
  assert(/^v2\$/.test(stored), 'hash is not the stretched scheme: ' + String(stored).slice(0, 12));
  assert(b.HASH_ITERATIONS >= 1000, 'only ' + b.HASH_ITERATIONS + ' iterations');
  // a single-round hash of the same password must not match what is stored
  const salt = b.readTable('Users')[0].salt;
  assert(b.hashPasswordLegacy('correct-horse-battery', salt) !== stored, 'stored as a single round');
});

check('an account created under the old scheme still signs in, and is upgraded', () => {
  const b = makeSandbox();
  b.handle('setup', { adminPhone: '9880011111', adminPassword: 'correct-horse-battery' }, '');
  const admin = b.handle('login', { phone: '9880011111', password: 'correct-horse-battery' }, '').data.token;
  b.handle('createUser', { name: 'Old', phone: '9000000007', role: 'manager',
                           password: 'legacy-pass-1234' }, admin);
  // rewrite that account the way the original scheme stored it
  const u = b.readTable('Users').find(x => x.phone === '9000000007');
  const legacySalt = 'legacy-salt';
  b.handle('update', { table: 'Users', id: u.id, data: {
    salt: legacySalt, password_hash: b.hashPasswordLegacy('legacy-pass-1234', legacySalt) } }, admin);

  const first = b.handle('login', { phone: '9000000007', password: 'legacy-pass-1234' }, '');
  assert(first.ok, 'a legacy account could not sign in: ' + first.error);
  const after = b.readTable('Users').find(x => x.phone === '9000000007');
  assert(/^v2\$/.test(after.password_hash), 'the hash was not upgraded on sign-in');
  assert(b.handle('login', { phone: '9000000007', password: 'legacy-pass-1234' }, '').ok,
         'sign-in broke after the upgrade');
  assert(!b.handle('login', { phone: '9000000007', password: 'wrong-pass-1234' }, '').ok,
         'a wrong password was accepted after the upgrade');
});

check('weak passwords are refused wherever one is set', () => {
  const b = makeSandbox();
  b.handle('setup', { adminPhone: '9880011111', adminPassword: 'correct-horse-battery' }, '');
  const admin = b.handle('login', { phone: '9880011111', password: 'correct-horse-battery' }, '').data.token;
  const bad = [
    ['too short', 'short1'],
    ['only numbers', '9876543210987'],
    ['one repeated character', 'aaaaaaaaaaaa'],
    ['contains the phone number', 'x9000000008x']
  ];
  for (const [why, pw] of bad) {
    const r = b.handle('createUser',
      { name: 'X', phone: '9000000008', role: 'viewer', password: pw }, admin);
    assert(r.ok === false, `accepted a password that is ${why}: ${pw}`);
  }
  assert(b.handle('createUser',
    { name: 'X', phone: '9000000008', role: 'viewer', password: 'a-decent-passphrase' }, admin).ok,
    'a reasonable password was refused');
});

console.log('\n— sessions end when a password changes —');
check('changing your own password invalidates your other sessions', () => {
  const b = makeSandbox();
  b.handle('setup', { adminPhone: '9880011111', adminPassword: 'correct-horse-battery' }, '');
  const oldToken = b.handle('login', { phone: '9880011111', password: 'correct-horse-battery' }, '').data.token;
  assert(b.handle('bootstrap', {}, oldToken).ok, 'the token did not work to begin with');
  const changed = b.handle('changePassword',
    { current: 'correct-horse-battery', next: 'a-brand-new-passphrase' }, oldToken);
  assert(changed.ok, 'password change failed: ' + changed.error);
  assert(b.handle('bootstrap', {}, oldToken).ok === false,
         'the old session still works after the password changed');
  const fresh = b.handle('login', { phone: '9880011111', password: 'a-brand-new-passphrase' }, '');
  assert(fresh.ok && b.handle('bootstrap', {}, fresh.data.token).ok, 'the new session does not work');
});

check('an admin reset ends the sessions of the account they reset', () => {
  const b = makeSandbox();
  b.handle('setup', { adminPhone: '9880011111', adminPassword: 'correct-horse-battery' }, '');
  const admin = b.handle('login', { phone: '9880011111', password: 'correct-horse-battery' }, '').data.token;
  b.handle('createUser', { name: 'M', phone: '9000000004', role: 'manager',
                           password: 'manager-pass-1234' }, admin);
  const theirs = b.handle('login', { phone: '9000000004', password: 'manager-pass-1234' }, '').data.token;
  const id = b.readTable('Users').find(x => x.phone === '9000000004').id;
  b.handle('resetPassword', { id, password: 'reset-pass-12345' }, admin);
  assert(b.handle('bootstrap', {}, theirs).ok === false, 'the reset account kept its session');
  assert(b.handle('bootstrap', {}, admin).ok, 'the admin lost their own session');
});

console.log('\n— the first-run window closes on its own —');
check('anonymous bootstrap is refused once the window has passed', () => {
  const b = makeSandbox();
  // a deployment that has been sitting there since long before now
  b.PropertiesService.getScriptProperties()
    .setProperty('FIRST_SEEN', String(Date.now() - (b.BOOTSTRAP_WINDOW_MS + 60000)));
  const late = b.handle('setup',
    { adminPhone: '9880011111', adminPassword: 'correct-horse-battery' }, '');
  assert(late.ok === false, 'a stale deployment still allowed anonymous bootstrap');
  assert(/spreadsheet menu/i.test(late.error), 'the message does not say what to do: ' + late.error);
  assert(b.readTable('Users').length === 0, 'an administrator was created anyway');

  // and the sheet menu still gets you in
  b.recoverAccess('9880011111', 'correct-horse-battery', 'Owner');
  assert(b.handle('login', { phone: '9880011111', password: 'correct-horse-battery' }, '').ok,
         'recovery did not work after the window closed');
});

check('a fresh deployment can still be set up normally', () => {
  const b = makeSandbox();
  const r = b.handle('setup', { adminPhone: '9880011111', adminPassword: 'correct-horse-battery' }, '');
  assert(r.ok && r.data.adminCreated, 'a fresh deployment refused setup: ' + JSON.stringify(r));
});

console.log('\n— secrets never leave the server —');
check('no role can read salts or password hashes', () => {
  const b = makeSandbox();
  b.handle('setup', { adminPhone: '9880011111', adminPassword: 'correct-horse-battery' }, '');
  const admin = b.handle('login', { phone: '9880011111', password: 'correct-horse-battery' }, '').data.token;
  b.handle('createUser', { name: 'V', phone: '9000000003', role: 'viewer', password: 'viewer-pass-1234' }, admin);
  b.handle('createUser', { name: 'M', phone: '9000000004', role: 'manager', password: 'manager-pass-1234' }, admin);
  const viewer = b.handle('login', { phone: '9000000003', password: 'viewer-pass-1234' }, '').data.token;
  const mgr = b.handle('login', { phone: '9000000004', password: 'manager-pass-1234' }, '').data.token;

  // a viewer or manager must not be able to enumerate accounts at all
  assert(b.handle('list', { table: 'Users' }, viewer).ok === false, 'a viewer listed the Users table');
  assert(b.handle('list', { table: 'Users' }, mgr).ok === false, 'a manager listed the Users table');

  // and even an administrator never receives the credentials themselves
  const asAdmin = b.handle('list', { table: 'Users' }, admin);
  assert(asAdmin.ok, 'an admin could not list users');
  const dump = JSON.stringify(asAdmin.data.rows);
  assert(!/password_hash|"salt"/.test(dump), 'credentials returned to an administrator');

  // no other reachable response may carry them either
  for (const [action, payload, tok] of [['bootstrap', {}, admin], ['me', {}, admin],
                                        ['bootstrap', {}, viewer]]) {
    const out = JSON.stringify(b.handle(action, payload, tok));
    assert(!/password_hash|"salt"/.test(out), `credentials leaked via ${action}`);
  }
});

check('the audit trail is not readable by a viewer', () => {
  const b = makeSandbox();
  b.handle('setup', { adminPhone: '9880011111', adminPassword: 'correct-horse-battery' }, '');
  const admin = b.handle('login', { phone: '9880011111', password: 'correct-horse-battery' }, '').data.token;
  b.handle('createUser', { name: 'V', phone: '9000000003', role: 'viewer', password: 'viewer-pass-1234' }, admin);
  const viewer = b.handle('login', { phone: '9000000003', password: 'viewer-pass-1234' }, '').data.token;
  assert(b.handle('list', { table: 'ActivityLog' }, viewer).ok === false,
         'a viewer read the activity log');
  assert(b.handle('bootstrap', {}, viewer).data.activity.length === 0,
         'the activity log reached a viewer through bootstrap');
});

console.log('\n— server-side roles —');
check('a viewer cannot write, an admin can', () => {
  const b = makeSandbox();
  b.handle('setup', { adminPhone: '9000000001', adminPassword: 'correct-horse-battery' }, '');
  const admin = b.handle('login', { phone: '9000000001', password: 'correct-horse-battery' }, '').data.token;
  b.handle('createUser', { name: 'V', phone: '9000000003', role: 'viewer', password: 'viewer-pass-1234' }, admin);
  const viewer = b.handle('login', { phone: '9000000003', password: 'viewer-pass-1234' }, '').data.token;

  assert(b.handle('bootstrap', {}, viewer).ok, 'viewer cannot read');
  const w = b.handle('create', { table: 'Tenants', data: { full_name: 'X' } }, viewer);
  assert(w.ok === false && /role/i.test(w.error), 'viewer was allowed to write: ' + JSON.stringify(w));
  const d = b.handle('remove', { table: 'Tenants', id: 'TNT-00001' }, viewer);
  assert(d.ok === false, 'viewer was allowed to delete');
  assert(b.handle('create', { table: 'Tenants', data: { full_name: 'X' } }, admin).ok, 'admin blocked');
});
check('a manager cannot delete or create users', () => {
  const b = makeSandbox();
  b.handle('setup', { adminPhone: '9000000001', adminPassword: 'correct-horse-battery' }, '');
  const admin = b.handle('login', { phone: '9000000001', password: 'correct-horse-battery' }, '').data.token;
  b.handle('createUser', { name: 'M', phone: '9000000004', role: 'manager', password: 'manager-pass-1234' }, admin);
  const mgr = b.handle('login', { phone: '9000000004', password: 'manager-pass-1234' }, '').data.token;

  assert(b.handle('create', { table: 'Tenants', data: { full_name: 'Y' } }, mgr).ok, 'manager cannot write');
  assert(b.handle('remove', { table: 'Tenants', id: 'TNT-00001' }, mgr).ok === false,
         'manager was allowed to delete');
  assert(b.handle('createUser', { name: 'Z', phone: '9000000005', role: 'admin', password: 'pass-word-z-123' }, mgr).ok === false,
         'manager was allowed to create a user');
});
check('bootstrap never returns password hashes', () => {
  const b = makeSandbox();
  b.handle('setup', { adminPhone: '9000000001', adminPassword: 'correct-horse-battery' }, '');
  const admin = b.handle('login', { phone: '9000000001', password: 'correct-horse-battery' }, '').data.token;
  const dump = JSON.stringify(b.handle('bootstrap', {}, admin).data);
  assert(!/password_hash/.test(dump), 'password_hash leaked to the client');
  assert(!/"salt"/.test(dump), 'salt leaked to the client');
});

console.log('\n' + '─'.repeat(56));
console.log(fail ? `${fail} FAILED, ${pass} passed` : `ALL ${pass} SECURITY CHECKS PASSED`);
process.exit(fail ? 1 : 0);
