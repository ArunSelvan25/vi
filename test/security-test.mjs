/**
 * Attacks the backend (supabase/functions/api/backend.js) on a real Postgres:
 * setup takeover, brute force, enumeration, forged tokens, role escalation,
 * and reaching the tables around the backend.
 */
import { makeSandbox, closeAll } from './pg-harness.mjs';
import { PBKDF2_ITERATIONS } from '../supabase/functions/api/backend.js';

let pass = 0, fail = 0;
const check = async (name, fn) => {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

// ── bootstrap ───────────────────────────────────────────────────────────────
console.log('\n— first-run bootstrap —');
let box = await makeSandbox();
await check('setup with no admin details is refused', async () => {
  const r = await box.handle('setup', {}, '');
  assert(r.ok === false && /adminPhone/.test(r.error), JSON.stringify(r));
});
await check('setup seeds the first administrator', async () => {
  const r = await box.handle('setup',
    { adminPhone: '+91 98800 11111', adminEmail: 'OWNER@Example.com', adminPassword: 'correct-horse-battery' }, '');
  assert(r.ok === true && r.data.adminCreated === true, JSON.stringify(r));
});

// ── finding 1: anonymous setup on a configured workspace ────────────────────
console.log('\n— finding 1 · anonymous setup cannot take over —');
await check('a second anonymous setup cannot create another admin', async () => {
  const before = (await box.readTable('Users')).length;
  const r = await box.handle('setup', { adminPhone: '+91 99999 99999', adminPassword: 'setup-pass-1234' }, '');
  const after = (await box.readTable('Users')).length;
  assert(after === before, `user count went ${before} -> ${after}`);
  assert(r.data && r.data.alreadySeeded === true, JSON.stringify(r));
});
await check('anonymous setup performs no writes at all', async () => {
  const dump = async () => JSON.stringify(await box.query('select key, value from settings order by key'));
  const rowsBefore = await dump();
  await box.query("delete from settings where key = 'org_name'");   // simulate a deletion
  const trimmed = await dump();
  await box.handle('setup', {}, '');
  const after = await dump();
  assert(after === trimmed, 'anonymous setup rewrote settings');
  assert(rowsBefore !== trimmed, 'test set-up did not actually change anything');
});
await check('an admin token may still re-run setup (schema sync)', async () => {
  const login = await box.handle('login', { phone: '+91 98800 11111', password: 'correct-horse-battery' }, '');
  assert(login.ok, 'admin could not sign in: ' + login.error);
  const r = await box.handle('setup', {}, login.data.token);
  assert(r.ok === true, JSON.stringify(r));
  const settings = await box.readSettings();
  assert(settings.org_name !== undefined, 'admin setup did not restore defaults');
});
await check('SETUP_KEY, when set, is required to bootstrap', async () => {
  const fresh = await makeSandbox({ setupKey: 's3cret-key' });
  const denied = await fresh.handle('setup', { adminPhone: '9000000001', adminPassword: 'setup-pass-1234' }, '');
  assert(denied.ok === false && /setup key/i.test(denied.error), JSON.stringify(denied));
  assert((await fresh.readTable('Users')).length === 0, 'admin was created without the key');
  const allowed = await fresh.handle('setup',
    { adminPhone: '9000000001', adminPassword: 'setup-pass-1234', setupKey: 's3cret-key' }, '');
  assert(allowed.ok === true && allowed.data.adminCreated, JSON.stringify(allowed));
});

// ── finding 2: brute force ──────────────────────────────────────────────────
console.log('\n— finding 2 · login throttling —');
await check('repeated wrong passwords lock the account out', async () => {
  const b = await makeSandbox();
  await b.handle('setup', { adminPhone: '9000000001', adminPassword: 'correct-horse-battery' }, '');
  let lockedAt = null;
  for (let i = 1; i <= 8; i++) {
    const r = await b.handle('login', { phone: '9000000001', password: 'guess' + i }, '');
    if (/Too many/.test(r.error) && lockedAt === null) lockedAt = i;
  }
  assert(lockedAt !== null, 'never locked out after 8 attempts');
  assert(lockedAt <= 6, 'locked out only at attempt ' + lockedAt);
});
await check('lockout blocks the CORRECT password too', async () => {
  const b = await makeSandbox();
  await b.handle('setup', { adminPhone: '9000000001', adminPassword: 'correct-horse-battery' }, '');
  for (let i = 0; i < 6; i++) await b.handle('login', { phone: '9000000001', password: 'nope' }, '');
  const r = await b.handle('login', { phone: '9000000001', password: 'correct-horse-battery' }, '');
  assert(r.ok === false && /Too many/.test(r.error), 'lockout did not hold: ' + JSON.stringify(r));
});
await check('a successful sign-in clears the failure counter', async () => {
  const b = await makeSandbox();
  await b.handle('setup', { adminPhone: '9000000001', adminPassword: 'correct-horse-battery' }, '');
  await b.handle('login', { phone: '9000000001', password: 'nope' }, '');
  await b.handle('login', { phone: '9000000001', password: 'nope' }, '');
  assert((await b.handle('login', { phone: '9000000001', password: 'correct-horse-battery' }, '')).ok, 'good login blocked');
  for (let i = 0; i < 4; i++) await b.handle('login', { phone: '9000000001', password: 'nope' }, '');
  assert((await b.handle('login', { phone: '9000000001', password: 'correct-horse-battery' }, '')).ok,
         'counter was not reset by the successful sign-in');
});
await check('failures on other accounts never lock out someone with the right password', async () => {
  // The old global limit let anyone lock the whole business out with 30 bad
  // sign-ins. Nothing anyone else does may stop a correct sign-in.
  const b = await makeSandbox();
  await b.handle('setup', { adminPhone: '9000000001', adminPassword: 'correct-horse-battery' }, '');
  for (let i = 0; i < 150; i++) await b.handle('login', { phone: `90000${String(i).padStart(5, '0')}`, password: 'x' }, '');
  const r = await b.handle('login', { phone: '9000000001', password: 'correct-horse-battery' }, '');
  assert(r.ok, 'a real user was locked out by strangers: ' + JSON.stringify(r));
});
await check('while spraying is under way, each targeted account locks after one wrong guess', async () => {
  const b = await makeSandbox();
  await b.handle('setup', { adminPhone: '9000000001', adminPassword: 'correct-horse-battery' }, '');
  for (let i = 0; i < 101; i++) await b.handle('login', { phone: `90000${String(i).padStart(5, '0')}`, password: 'x' }, '');
  await b.handle('login', { phone: '9111111111', password: 'guess-1' }, '');
  const r = await b.handle('login', { phone: '9111111111', password: 'guess-2' }, '');
  assert(/Too many/.test(r.error), 'second guess during a spray was not throttled: ' + JSON.stringify(r));
});
await check('each further failure locks the account for longer', async () => {
  const b = await makeSandbox();
  await b.handle('setup', { adminPhone: '9000000001', adminPassword: 'correct-horse-battery' }, '');
  const waits = [];
  for (let i = 0; i < 7; i++) {
    await b.handle('login', { phone: '9000000001', password: 'nope' + i }, '');
    const [state] = await b.query(`select (extract(epoch from locked_until) * 1000)::float8 as until
                                   from login_throttle where identifier = '9000000001'`);
    waits.push(state && state.until ? state.until - Date.now() : 0);
    // let the next attempt through
    await b.query(`update login_throttle set locked_until = null where identifier = '9000000001'`);
  }
  const locked = waits.filter(w => w > 0);
  assert(locked.length === 3, 'expected 3 lockouts after 4 free attempts, got ' + JSON.stringify(waits));
  assert(locked[1] > locked[0] * 1.5 && locked[2] > locked[1] * 1.5, 'lockouts did not grow: ' + JSON.stringify(locked));
});

// ── finding 3: enumeration ──────────────────────────────────────────────────
console.log('\n— finding 3 · no account enumeration —');
await check('unknown, disabled and wrong-password all give one message', async () => {
  const b = await makeSandbox();
  await b.handle('setup', { adminPhone: '9000000001', adminPassword: 'correct-horse-battery' }, '');
  const login = await b.handle('login', { phone: '9000000001', password: 'correct-horse-battery' }, '');
  await b.handle('create', { table: 'Users', data: {
    name: 'Off', phone: '9000000002', email: '', role: 'viewer', salt: 's',
    password_hash: 'x', active: 'FALSE' } }, login.data.token);

  const unknown  = (await b.handle('login', { phone: '9555555555', password: 'p' }, '')).error;
  const disabled = (await b.handle('login', { phone: '9000000002', password: 'p' }, '')).error;
  const wrong    = (await b.handle('login', { phone: '9000000001', password: 'bad' }, '')).error;
  assert(unknown === disabled && disabled === wrong,
    `messages differ:\n  unknown="${unknown}"\n  disabled="${disabled}"\n  wrong="${wrong}"`);
  assert(!/disabled/i.test(disabled), 'message leaks account state');
});

// ── phone as the login credential ───────────────────────────────────────────
console.log('\n— phone login —');
await check('normalisePhone folds the formats people actually type', () => {
  const n = box.normalisePhone;
  const same = ['+91 98800 11111', '+919880011111', '098800 11111', '9880011111',
                '98800-11111', '(98800) 11111', ' 91 98800 11111 '];
  const want = n(same[0]);
  assert(want === '9880011111', 'baseline normalised to ' + want);
  for (const v of same) assert(n(v) === want, `"${v}" -> "${n(v)}" but expected "${want}"`);
  assert(n('') === '' && n(null) === '' && n(undefined) === '', 'blank input');
  assert(n(9880011111) !== '', 'a phone number arriving as a number must work');
});

await check('sign-in works whatever format the number is typed in', async () => {
  const b = await makeSandbox();
  await b.handle('setup', { adminPhone: '+91 98800 11111', adminPassword: 'correct-horse-battery' }, '');
  for (const typed of ['+91 98800 11111', '9880011111', '098800 11111', '98800-11111']) {
    const r = await b.handle('login', { phone: typed, password: 'correct-horse-battery' }, '');
    assert(r.ok === true, `could not sign in with "${typed}": ${r.error}`);
  }
});

await check('a different number cannot sign in', async () => {
  const b = await makeSandbox();
  await b.handle('setup', { adminPhone: '9880011111', adminPassword: 'correct-horse-battery' }, '');
  const r = await b.handle('login', { phone: '9880011112', password: 'correct-horse-battery' }, '');
  assert(r.ok === false, 'wrong number was accepted');
});

await check('email is optional for an administrator', async () => {
  const b = await makeSandbox();
  const r = await b.handle('setup', { adminPhone: '9880011111', adminPassword: 'correct-horse-battery' }, '');
  assert(r.ok && r.data.adminCreated, JSON.stringify(r));
  const login = await b.handle('login', { phone: '9880011111', password: 'correct-horse-battery' }, '');
  assert(login.ok, 'cannot sign in without an email on the account: ' + login.error);
  assert(!login.data.user.email, 'email should be blank, got ' + login.data.user.email);
});

await check('a user cannot be created without a phone number', async () => {
  const b = await makeSandbox();
  await b.handle('setup', { adminPhone: '9880011111', adminPassword: 'correct-horse-battery' }, '');
  const admin = (await b.handle('login', { phone: '9880011111', password: 'correct-horse-battery' }, '')).data.token;
  const r = await b.handle('createUser', { name: 'No Phone', email: 'x@e.com', password: 'setup-pass-1234' }, admin);
  assert(r.ok === false && /phone/i.test(r.error), JSON.stringify(r));
});

await check('a duplicate phone number is rejected, in any format', async () => {
  const b = await makeSandbox();
  await b.handle('setup', { adminPhone: '+91 98800 11111', adminPassword: 'correct-horse-battery' }, '');
  const admin = (await b.handle('login', { phone: '9880011111', password: 'correct-horse-battery' }, '')).data.token;
  const r = await b.handle('createUser',
    { name: 'Clash', phone: '098800 11111', role: 'viewer', password: 'setup-pass-1234' }, admin);
  assert(r.ok === false && /already belongs/i.test(r.error), JSON.stringify(r));
});

await check('a user created without an email can still sign in', async () => {
  const b = await makeSandbox();
  await b.handle('setup', { adminPhone: '9880011111', adminPassword: 'correct-horse-battery' }, '');
  const admin = (await b.handle('login', { phone: '9880011111', password: 'correct-horse-battery' }, '')).data.token;
  const made = await b.handle('createUser',
    { name: 'Site Manager', phone: '+91 99400 33333', role: 'manager', password: 'manager-pass-1234' }, admin);
  assert(made.ok, JSON.stringify(made));
  const login = await b.handle('login', { phone: '99400 33333', password: 'manager-pass-1234' }, '');
  assert(login.ok, 'phone-only user cannot sign in: ' + login.error);
  assert(login.data.user.role === 'manager', 'wrong role');
});

await check('throttling keys on the normalised number, not the typed string', async () => {
  const b = await makeSandbox();
  await b.handle('setup', { adminPhone: '9880011111', adminPassword: 'correct-horse-battery' }, '');
  // same account, six different spellings — must still lock out
  const spellings = ['9880011111', '+91 98800 11111', '098800 11111',
                     '98800-11111', '(98800)11111', '91 9880011111'];
  for (const p of spellings) await b.handle('login', { phone: p, password: 'wrong' }, '');
  const r = await b.handle('login', { phone: '9880011111', password: 'correct-horse-battery' }, '');
  assert(/Too many/.test(r.error || ''), 'formatting variations bypassed the lockout');
});

await check('a tenant needs no email address', async () => {
  const b = await makeSandbox();
  await b.handle('setup', { adminPhone: '9880011111', adminPassword: 'correct-horse-battery' }, '');
  const admin = (await b.handle('login', { phone: '9880011111', password: 'correct-horse-battery' }, '')).data.token;
  const r = await b.handle('create',
    { table: 'Tenants', data: { full_name: 'No Email', phone: '9333333333', status: 'Active' } }, admin);
  assert(r.ok === true, JSON.stringify(r));
  assert(r.data.row.email === '', 'email should be blank');
});

await check('reminders skip tenants with no email instead of failing', async () => {
  const b = await makeSandbox();
  await b.handle('setup', { adminPhone: '9880011111', adminPassword: 'correct-horse-battery' }, '');
  const admin = (await b.handle('login', { phone: '9880011111', password: 'correct-horse-battery' }, '')).data.token;
  const withEmail = (await b.handle('create', { table: 'Tenants',
    data: { full_name: 'Has Email', phone: '9111111111', email: 'a@e.com', status: 'Active' } }, admin)).data.row;
  const noEmail = (await b.handle('create', { table: 'Tenants',
    data: { full_name: 'No Email', phone: '9222222222', status: 'Active' } }, admin)).data.row;
  for (const t of [withEmail, noEmail]) {
    await b.handle('create', { table: 'Invoices', data: {
      tenant_id: t.id, type: 'Rent', due_date: '2020-01-01', amount: 1000,
      total: 1000, amount_paid: 0, balance: 1000, status: 'Overdue' } }, admin);
  }
  const r = await b.handle('sendReminders', {}, admin);
  assert(r.ok === true, JSON.stringify(r));
  assert(r.data.sent === 1, 'expected 1 sent, got ' + r.data.sent);
  assert(r.data.skipped === 1, 'expected 1 skipped, got ' + r.data.skipped);
});

// ── finding 4: constant-time comparison ─────────────────────────────────────
console.log('\n— finding 4 · constant-time compare —');
await check('constantTimeEquals is correct', () => {
  const eq = box.constantTimeEquals;
  assert(eq('abc', 'abc') === true, 'equal strings');
  assert(eq('abc', 'abd') === false, 'last char differs');
  assert(eq('abc', 'xbc') === false, 'first char differs');
  assert(eq('abc', 'abcd') === false, 'length differs');
  assert(eq('', '') === true, 'empty');
});

// ── token integrity ─────────────────────────────────────────────────────────
console.log('\n— session tokens —');
await check('a tampered token is rejected', async () => {
  const b = await makeSandbox();
  await b.handle('setup', { adminPhone: '9000000001', adminPassword: 'correct-horse-battery' }, '');
  const token = (await b.handle('login', { phone: '9000000001', password: 'correct-horse-battery' }, '')).data.token;
  assert((await b.handle('bootstrap', {}, token)).ok, 'valid token rejected');

  const [body, sig] = token.split('.');
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
  payload.role = 'admin'; payload.phone = '9999999999';
  const forged = Buffer.from(JSON.stringify(payload)).toString('base64url') + '.' + sig;
  const r = await b.handle('bootstrap', {}, forged);
  assert(r.ok === false && r.error === 'AUTH_REQUIRED', 'forged token accepted: ' + JSON.stringify(r));
});
await check('an expired token is rejected', async () => {
  const b = await makeSandbox();
  await b.handle('setup', { adminPhone: '9000000001', adminPassword: 'correct-horse-battery' }, '');
  const expired = await b.signToken({ id: 'USR-00001', phone: '9000000001', role: 'admin', exp: Date.now() - 1000 });
  assert((await b.handle('bootstrap', {}, expired)).error === 'AUTH_REQUIRED', 'expired token accepted');
});
await check('no token reaches any data action', async () => {
  const b = await makeSandbox();
  await b.handle('setup', { adminPhone: '9000000001', adminPassword: 'correct-horse-battery' }, '');
  for (const action of ['bootstrap', 'list', 'create', 'update', 'remove', 'recordPayment',
                        'saveInvoice', 'createUser', 'sendReminders', 'stats', 'me', 'search']) {
    const r = await b.handle(action, { table: 'Tenants', data: {}, id: 'x' }, '');
    assert(r.ok === false, `"${action}" succeeded without a token`);
  }
});

// ── role enforcement ────────────────────────────────────────────────────────
console.log('\n— password storage —');
await check('hashes are stretched, not a single round', async () => {
  const b = await makeSandbox();
  await b.handle('setup', { adminPhone: '9880011111', adminPassword: 'correct-horse-battery' }, '');
  const stored = (await b.readTable('Users'))[0].password_hash;
  assert(/^v3\$\d+\$/.test(stored), 'hash is not PBKDF2: ' + String(stored).slice(0, 12));
  assert(Number(stored.split('$')[1]) === b.HASH_ITERATIONS, 'stored with the wrong iteration count');
  // the tests run fast hashing; what ships must be the OWASP-recommended strength
  assert(PBKDF2_ITERATIONS >= 600000, 'production PBKDF2 uses only ' + PBKDF2_ITERATIONS + ' iterations');
  // neither older scheme of the same password may match what is stored
  const salt = (await b.readTable('Users'))[0].salt;
  assert(await b.hashPasswordLegacy('correct-horse-battery', salt) !== stored, 'stored as a single round');
  assert(await b.hashPasswordV2('correct-horse-battery', salt) !== stored, 'stored as the older v2 scheme');
});

await check('an account created under the old scheme still signs in, and is upgraded', async () => {
  const b = await makeSandbox();
  await b.handle('setup', { adminPhone: '9880011111', adminPassword: 'correct-horse-battery' }, '');
  const admin = (await b.handle('login', { phone: '9880011111', password: 'correct-horse-battery' }, '')).data.token;
  await b.handle('createUser', { name: 'Old', phone: '9000000007', role: 'manager',
                           password: 'legacy-pass-1234' }, admin);
  // rewrite that account the way the original scheme stored it
  const u = (await b.readTable('Users')).find(x => x.phone === '9000000007');
  const legacySalt = 'legacy-salt';
  await b.handle('update', { table: 'Users', id: u.id, data: {
    salt: legacySalt, password_hash: await b.hashPasswordLegacy('legacy-pass-1234', legacySalt) } }, admin);

  const first = await b.handle('login', { phone: '9000000007', password: 'legacy-pass-1234' }, '');
  assert(first.ok, 'a legacy account could not sign in: ' + first.error);
  const after = (await b.readTable('Users')).find(x => x.phone === '9000000007');
  assert(/^v3\$/.test(after.password_hash), 'the hash was not upgraded on sign-in');
  assert((await b.handle('login', { phone: '9000000007', password: 'legacy-pass-1234' }, '')).ok,
         'sign-in broke after the upgrade');
  assert(!(await b.handle('login', { phone: '9000000007', password: 'wrong-pass-1234' }, '')).ok,
         'a wrong password was accepted after the upgrade');
});

await check('an account with an older (v2) password hash signs in, and is upgraded', async () => {
  // Accounts brought over from the earlier backend carry the v2 hash it
  // wrote. Nobody may have to reset their password because of that.
  const b = await makeSandbox();
  await b.handle('setup', { adminPhone: '9880011111', adminPassword: 'correct-horse-battery' }, '');
  const admin = (await b.handle('login', { phone: '9880011111', password: 'correct-horse-battery' }, '')).data.token;
  await b.handle('createUser', { name: 'Older', phone: '9000000009', role: 'manager',
                                 password: 'older-account-1234' }, admin);
  const u = (await b.readTable('Users')).find(x => x.phone === '9000000009');
  const olderSalt = 'uuid-from-apps-script';
  const v2 = await b.hashPasswordV2('from-the-sheet-1234', olderSalt);
  // the exact v2 hash the earlier backend stored for this password and salt, so verifying cannot drift from it
  assert(v2 === 'v2$ECl2fNv8mgV9ZY7GAVjb06iBiAGSRaDWQm1tCOCKmSo=', 'differs from the stored v2 hash: ' + v2);
  await b.query('update app_users set salt = $1, password_hash = $2 where id = $3', [olderSalt, v2, u.id]);

  const first = await b.handle('login', { phone: '9000000009', password: 'from-the-sheet-1234' }, '');
  assert(first.ok, 'a migrated account could not sign in: ' + first.error);
  const after = (await b.readTable('Users')).find(x => x.phone === '9000000009');
  assert(/^v3\$/.test(after.password_hash), 'the v2 hash was not upgraded on sign-in');
  assert((await b.handle('login', { phone: '9000000009', password: 'from-the-sheet-1234' }, '')).ok,
         'sign-in broke after the upgrade');
  assert(!(await b.handle('login', { phone: '9000000009', password: 'from-the-sheet-9999' }, '')).ok,
         'a wrong password was accepted');
});

await check('weak passwords are refused wherever one is set', async () => {
  const b = await makeSandbox();
  await b.handle('setup', { adminPhone: '9880011111', adminPassword: 'correct-horse-battery' }, '');
  const admin = (await b.handle('login', { phone: '9880011111', password: 'correct-horse-battery' }, '')).data.token;
  const bad = [
    ['too short', 'short1'],
    ['only numbers', '9876543210987'],
    ['one repeated character', 'aaaaaaaaaaaa'],
    ['contains the phone number', 'x9000000008x']
  ];
  for (const [why, pw] of bad) {
    const r = await b.handle('createUser',
      { name: 'X', phone: '9000000008', role: 'viewer', password: pw }, admin);
    assert(r.ok === false, `accepted a password that is ${why}: ${pw}`);
  }
  assert((await b.handle('createUser',
    { name: 'X', phone: '9000000008', role: 'viewer', password: 'a-decent-passphrase' }, admin)).ok,
    'a reasonable password was refused');
});

console.log('\n— sessions end when a password changes —');
await check('changing your own password invalidates your other sessions', async () => {
  const b = await makeSandbox();
  await b.handle('setup', { adminPhone: '9880011111', adminPassword: 'correct-horse-battery' }, '');
  const oldToken = (await b.handle('login', { phone: '9880011111', password: 'correct-horse-battery' }, '')).data.token;
  assert((await b.handle('bootstrap', {}, oldToken)).ok, 'the token did not work to begin with');
  const changed = await b.handle('changePassword',
    { current: 'correct-horse-battery', next: 'a-brand-new-passphrase' }, oldToken);
  assert(changed.ok, 'password change failed: ' + changed.error);
  assert((await b.handle('bootstrap', {}, oldToken)).ok === false,
         'the old session still works after the password changed');
  const fresh = await b.handle('login', { phone: '9880011111', password: 'a-brand-new-passphrase' }, '');
  assert(fresh.ok && (await b.handle('bootstrap', {}, fresh.data.token)).ok, 'the new session does not work');
});

await check('an admin reset ends the sessions of the account they reset', async () => {
  const b = await makeSandbox();
  await b.handle('setup', { adminPhone: '9880011111', adminPassword: 'correct-horse-battery' }, '');
  const admin = (await b.handle('login', { phone: '9880011111', password: 'correct-horse-battery' }, '')).data.token;
  await b.handle('createUser', { name: 'M', phone: '9000000004', role: 'manager',
                           password: 'manager-pass-1234' }, admin);
  const theirs = (await b.handle('login', { phone: '9000000004', password: 'manager-pass-1234' }, '')).data.token;
  const id = (await b.readTable('Users')).find(x => x.phone === '9000000004').id;
  await b.handle('resetPassword', { id, password: 'reset-pass-12345' }, admin);
  assert((await b.handle('bootstrap', {}, theirs)).ok === false, 'the reset account kept its session');
  assert((await b.handle('bootstrap', {}, admin)).ok, 'the admin lost their own session');
});

console.log('\n— the first-run window closes on its own —');
await check('anonymous bootstrap is refused once the window has passed', async () => {
  const b = await makeSandbox();
  // a deployment that has been sitting there since long before now
  await b.setState('FIRST_SEEN', String(Date.now() - (b.BOOTSTRAP_WINDOW_MS + 60000)));
  const late = await b.handle('setup',
    { adminPhone: '9880011111', adminPassword: 'correct-horse-battery' }, '');
  assert(late.ok === false, 'a stale deployment still allowed anonymous bootstrap');
  assert(/recover-admin/i.test(late.error), 'the message does not say what to do: ' + late.error);
  assert((await b.readTable('Users')).length === 0, 'an administrator was created anyway');

  // and the break-glass script still gets you in
  await b.recoverAccess('9880011111', 'correct-horse-battery', 'Owner');
  assert((await b.handle('login', { phone: '9880011111', password: 'correct-horse-battery' }, '')).ok,
         'recovery did not work after the window closed');
});

await check('a fresh deployment can still be set up normally', async () => {
  const b = await makeSandbox();
  const r = await b.handle('setup', { adminPhone: '9880011111', adminPassword: 'correct-horse-battery' }, '');
  assert(r.ok && r.data.adminCreated, 'a fresh deployment refused setup: ' + JSON.stringify(r));
});

console.log('\n— secrets never leave the server —');
await check('no role can read salts or password hashes', async () => {
  const b = await makeSandbox();
  await b.handle('setup', { adminPhone: '9880011111', adminPassword: 'correct-horse-battery' }, '');
  const admin = (await b.handle('login', { phone: '9880011111', password: 'correct-horse-battery' }, '')).data.token;
  await b.handle('createUser', { name: 'V', phone: '9000000003', role: 'viewer', password: 'viewer-pass-1234' }, admin);
  await b.handle('createUser', { name: 'M', phone: '9000000004', role: 'manager', password: 'manager-pass-1234' }, admin);
  const viewer = (await b.handle('login', { phone: '9000000003', password: 'viewer-pass-1234' }, '')).data.token;
  const mgr = (await b.handle('login', { phone: '9000000004', password: 'manager-pass-1234' }, '')).data.token;

  // a viewer or manager must not be able to enumerate accounts at all
  assert((await b.handle('list', { table: 'Users' }, viewer)).ok === false, 'a viewer listed the Users table');
  assert((await b.handle('list', { table: 'Users' }, mgr)).ok === false, 'a manager listed the Users table');

  // and even an administrator never receives the credentials themselves
  const asAdmin = await b.handle('list', { table: 'Users' }, admin);
  assert(asAdmin.ok, 'an admin could not list users');
  const dump = JSON.stringify(asAdmin.data.rows);
  assert(!/password_hash|"salt"/.test(dump), 'credentials returned to an administrator');

  // no other reachable response may carry them either
  for (const [action, payload, tok] of [['bootstrap', {}, admin], ['me', {}, admin],
                                        ['bootstrap', {}, viewer]]) {
    const out = JSON.stringify((await b.handle(action, payload, tok)));
    assert(!/password_hash|"salt"/.test(out), `credentials leaked via ${action}`);
  }
});

await check('the audit trail is not readable by a viewer', async () => {
  const b = await makeSandbox();
  await b.handle('setup', { adminPhone: '9880011111', adminPassword: 'correct-horse-battery' }, '');
  const admin = (await b.handle('login', { phone: '9880011111', password: 'correct-horse-battery' }, '')).data.token;
  await b.handle('createUser', { name: 'V', phone: '9000000003', role: 'viewer', password: 'viewer-pass-1234' }, admin);
  const viewer = (await b.handle('login', { phone: '9000000003', password: 'viewer-pass-1234' }, '')).data.token;
  assert((await b.handle('list', { table: 'ActivityLog' }, viewer)).ok === false,
         'a viewer read the activity log');
  assert((await b.handle('bootstrap', {}, viewer)).data.activity.length === 0,
         'the activity log reached a viewer through bootstrap');
});

console.log('\n— server-side roles —');
await check('a viewer cannot write, an admin can', async () => {
  const b = await makeSandbox();
  await b.handle('setup', { adminPhone: '9000000001', adminPassword: 'correct-horse-battery' }, '');
  const admin = (await b.handle('login', { phone: '9000000001', password: 'correct-horse-battery' }, '')).data.token;
  await b.handle('createUser', { name: 'V', phone: '9000000003', role: 'viewer', password: 'viewer-pass-1234' }, admin);
  const viewer = (await b.handle('login', { phone: '9000000003', password: 'viewer-pass-1234' }, '')).data.token;

  assert((await b.handle('bootstrap', {}, viewer)).ok, 'viewer cannot read');
  const w = await b.handle('create', { table: 'Tenants', data: { full_name: 'X' } }, viewer);
  assert(w.ok === false && /role/i.test(w.error), 'viewer was allowed to write: ' + JSON.stringify(w));
  const d = await b.handle('remove', { table: 'Tenants', id: 'TNT-00001' }, viewer);
  assert(d.ok === false, 'viewer was allowed to delete');
  assert((await b.handle('create', { table: 'Tenants', data: { full_name: 'X' } }, admin)).ok, 'admin blocked');
});
await check('a manager cannot delete or create users', async () => {
  const b = await makeSandbox();
  await b.handle('setup', { adminPhone: '9000000001', adminPassword: 'correct-horse-battery' }, '');
  const admin = (await b.handle('login', { phone: '9000000001', password: 'correct-horse-battery' }, '')).data.token;
  await b.handle('createUser', { name: 'M', phone: '9000000004', role: 'manager', password: 'manager-pass-1234' }, admin);
  const mgr = (await b.handle('login', { phone: '9000000004', password: 'manager-pass-1234' }, '')).data.token;

  assert((await b.handle('create', { table: 'Tenants', data: { full_name: 'Y' } }, mgr)).ok, 'manager cannot write');
  assert((await b.handle('remove', { table: 'Tenants', id: 'TNT-00001' }, mgr)).ok === false,
         'manager was allowed to delete');
  assert((await b.handle('createUser', { name: 'Z', phone: '9000000005', role: 'admin', password: 'pass-word-z-123' }, mgr)).ok === false,
         'manager was allowed to create a user');
});
await check('bootstrap never returns password hashes', async () => {
  const b = await makeSandbox();
  await b.handle('setup', { adminPhone: '9000000001', adminPassword: 'correct-horse-battery' }, '');
  const admin = (await b.handle('login', { phone: '9000000001', password: 'correct-horse-battery' }, '')).data.token;
  const dump = JSON.stringify((await b.handle('bootstrap', {}, admin)).data);
  assert(!/password_hash/.test(dump), 'password_hash leaked to the client');
  assert(!/"salt"/.test(dump), 'salt leaked to the client');
});

// ── sign-in floods cannot stall the app ─────────────────────────────────────
console.log('\n— sign-in floods cannot stall the app —');
await check('password hashing does not hold the request lock', async () => {
  // production-strength hashing, so each sign-in takes real time
  const b = await makeSandbox({ hashIterations: PBKDF2_ITERATIONS, connections: 4 });
  await b.handle('setup', { adminPhone: '9000000001', adminPassword: 'correct-horse-battery' }, '');
  const admin = (await b.handle('login', { phone: '9000000001', password: 'correct-horse-battery' }, '')).data.token;
  const order = [];
  const flood = Array.from({ length: 6 }, (_, i) =>
    b.handle('login', { phone: `95000${String(i).padStart(5, '0')}`, password: 'x' }, '').then(() => order.push('login')));
  await new Promise(res => setTimeout(res, 20));
  const work = b.handle('bootstrap', {}, admin).then(() => order.push('bootstrap'));
  await Promise.all([...flood, work]);
  assert(order.indexOf('bootstrap') < order.length - 1,
         'a signed-in request waited for every anonymous sign-in to finish hashing: ' + order.join(','));
});
await check('a burst of parallel guesses gets no more tries than sequential ones', async () => {
  const b = await makeSandbox({ connections: 4 });
  await b.handle('setup', { adminPhone: '9000000001', adminPassword: 'correct-horse-battery' }, '');
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) =>
    b.handle('login', { phone: '9000000001', password: 'guess-' + i }, '')));
  const checked = results.filter(r => /Invalid phone number or password/.test(r.error)).length;
  assert(checked <= b.THROTTLE.freeAttempts + 1, checked + ' of 12 parallel guesses had their password checked');
});
await check('wrong current passwords on changePassword are throttled', async () => {
  const b = await makeSandbox();
  await b.handle('setup', { adminPhone: '9000000001', adminPassword: 'correct-horse-battery' }, '');
  const admin = (await b.handle('login', { phone: '9000000001', password: 'correct-horse-battery' }, '')).data.token;
  let limited = false;
  for (let i = 0; i < 8 && !limited; i++) {
    const r = await b.handle('changePassword', { current: 'guess-' + i, next: 'a-brand-new-passphrase' }, admin);
    assert(r.ok === false, 'a wrong current password was accepted');
    limited = /Too many/.test(r.error);
  }
  assert(limited, 'eight wrong current passwords were never throttled');
});

// ── failed sign-ins cannot wipe the audit trail ─────────────────────────────
console.log('\n— failed sign-ins cannot wipe the audit trail —');
await check('a flood of failed sign-ins does not push real history out of the log', async () => {
  const b = await makeSandbox();
  await b.handle('setup', { adminPhone: '9000000001', adminPassword: 'correct-horse-battery' }, '');
  const admin = (await b.handle('login', { phone: '9000000001', password: 'correct-horse-battery' }, '')).data.token;
  await b.handle('create', { table: 'Tenants', data: { full_name: 'Evidence' } }, admin);
  await b.query(`insert into activity_log (id, timestamp, actor, action, entity)
                 select 'LOG-F' || g, now(), '9' || g, 'login-failed', 'Users' from generate_series(1, 8000) g`);
  await b.refreshStatuses();
  const [{ real, noise }] = await b.query(`select count(*) filter (where action <> 'login-failed')::int as real,
                                                 count(*) filter (where action = 'login-failed')::int as noise
                                          from activity_log`);
  const [{ n }] = await b.query(`select count(*)::int as n from activity_log
                                 where action = 'create' and entity = 'Tenants'`);
  assert(n === 1, 'the record of a real change was pruned away by failed sign-ins');
  assert(real > 0 && noise <= 1000, `log after pruning: ${real} real, ${noise} failed sign-ins`);
});

// ── only an administrator takes money back ──────────────────────────────────
console.log('\n— only an administrator takes money back —');
await check('a manager cannot zero or move a recorded payment through a plain edit', async () => {
  const b = await makeSandbox();
  await b.handle('setup', { adminPhone: '9000000001', adminPassword: 'correct-horse-battery' }, '');
  const admin = (await b.handle('login', { phone: '9000000001', password: 'correct-horse-battery' }, '')).data.token;
  await b.handle('createUser', { name: 'M', phone: '9000000004', role: 'manager', password: 'manager-pass-1234' }, admin);
  const mgr = (await b.handle('login', { phone: '9000000004', password: 'manager-pass-1234' }, '')).data.token;
  const t = (await b.handle('create', { table: 'Tenants', data: { full_name: 'T' } }, admin)).data.row;
  const newInvoice = async () => (await b.handle('create', { table: 'Invoices', data: {
    tenant_id: t.id, type: 'Utility', due_date: '2030-01-01', amount: 500 } }, admin)).data.row;
  const inv = await newInvoice(), other = await newInvoice();
  const pay = (await b.handle('recordPayment', { invoice_id: inv.id, amount: 500, method: 'Cash' }, admin)).data.payment;

  const lowered = await b.handle('update', { table: 'Payments', id: pay.id, data: { amount: 1 } }, mgr);
  assert(lowered.ok === false && /administrator/.test(lowered.error), 'manager lowered a payment: ' + JSON.stringify(lowered));
  const moved = await b.handle('update', { table: 'Payments', id: pay.id, data: { invoice_id: other.id } }, mgr);
  assert(moved.ok === false, 'manager moved a payment to another invoice');
  const note = await b.handle('update', { table: 'Payments', id: pay.id, data: { amount: 500, notes: 'receipt 42' } }, mgr);
  assert(note.ok, 'manager could not correct the notes on a payment: ' + note.error);
  const fixed = await b.handle('update', { table: 'Payments', id: pay.id, data: { amount: 400 } }, admin);
  assert(fixed.ok, 'admin could not correct a payment: ' + fixed.error);
});

// ── signing out ends the session on the server ──────────────────────────────
console.log('\n— signing out ends the session on the server —');
const signIn = async (b, phone, password) =>
  (await b.handle('login', { phone, password }, '')).data.token;
const works = async (b, token) => (await b.handle('bootstrap', {}, token)).ok;

await check('a signed-out token stops working; the same account on another device does not', async () => {
  const b = await makeSandbox();
  await b.handle('setup', { adminPhone: '9000000001', adminPassword: 'correct-horse-battery' }, '');
  const laptop = await signIn(b, '9000000001', 'correct-horse-battery');
  const phone = await signIn(b, '9000000001', 'correct-horse-battery');
  const out = await b.handle('logout', {}, laptop);
  assert(out.ok, 'logout failed: ' + out.error);
  assert(!(await works(b, laptop)), 'the token still works after signing out');
  assert(await works(b, phone), 'signing out one device signed out the other');
  const [row] = await b.query('select token_hash from revoked_sessions');
  assert(row && row.token_hash !== laptop && !String(row.token_hash).includes('.'), 'the token itself was stored');
});
await check('logout with a bad or missing token answers ok and stores nothing', async () => {
  const b = await makeSandbox();
  await b.handle('setup', { adminPhone: '9000000001', adminPassword: 'correct-horse-battery' }, '');
  for (const t of ['', 'garbage', 'a.b']) assert((await b.handle('logout', {}, t)).ok, 'logout refused ' + JSON.stringify(t));
  const [{ n }] = await b.query('select count(*)::int as n from revoked_sessions');
  assert(n === 0, n + ' rows stored for invalid tokens');
});
await check('expired revocations are purged', async () => {
  const b = await makeSandbox();
  await b.handle('setup', { adminPhone: '9000000001', adminPassword: 'correct-horse-battery' }, '');
  await b.query(`insert into revoked_sessions values ('old', now() - interval '1 hour')`);
  await b.handle('logout', {}, await signIn(b, '9000000001', 'correct-horse-battery'));
  const rows = await b.query(`select token_hash from revoked_sessions where token_hash = 'old'`);
  assert(rows.length === 0, 'an expired revocation was kept');
});
await check('"sign out other devices" ends every other session and keeps this one', async () => {
  const b = await makeSandbox();
  await b.handle('setup', { adminPhone: '9000000001', adminPassword: 'correct-horse-battery' }, '');
  const here = await signIn(b, '9000000001', 'correct-horse-battery');
  const elsewhere = await signIn(b, '9000000001', 'correct-horse-battery');
  const r = await b.handle('endSessions', {}, here);
  assert(r.ok && r.data.token, 'endSessions failed: ' + JSON.stringify(r));
  assert(!(await works(b, elsewhere)), 'the other device is still signed in');
  assert(!(await works(b, here)), 'the old token of this device survived');
  assert(await works(b, r.data.token), 'the replacement token does not work');
  assert(await works(b, await signIn(b, '9000000001', 'correct-horse-battery')), 'cannot sign in again afterwards');
});
await check('an admin can sign a user out everywhere; a manager cannot', async () => {
  const b = await makeSandbox();
  await b.handle('setup', { adminPhone: '9000000001', adminPassword: 'correct-horse-battery' }, '');
  const admin = await signIn(b, '9000000001', 'correct-horse-battery');
  await b.handle('createUser', { name: 'M', phone: '9000000004', role: 'manager', password: 'manager-pass-1234' }, admin);
  await b.handle('createUser', { name: 'V', phone: '9000000005', role: 'viewer', password: 'viewer-pass-1234' }, admin);
  const mgr = await signIn(b, '9000000004', 'manager-pass-1234');
  const viewer = await signIn(b, '9000000005', 'viewer-pass-1234');
  const ids = Object.fromEntries((await b.readTable('Users')).map(u => [u.phone, u.id]));

  const denied = await b.handle('endSessions', { id: ids['9000000005'] }, mgr);
  assert(denied.ok === false, 'a manager signed another user out');
  assert(await works(b, viewer), 'the refused request still ended the session');
  assert((await b.handle('endSessions', { id: ids['9000000005'] }, admin)).ok, 'admin could not sign the user out');
  assert(!(await works(b, viewer)), 'the user is still signed in');
  assert(await works(b, admin), 'the admin lost their own session');
});

// ── tenant ID numbers are masked below manager ──────────────────────────────
console.log('\n— tenant ID numbers are masked below manager —');
await check('a viewer gets ID numbers masked, a manager in full', async () => {
  const b = await makeSandbox();
  await b.handle('setup', { adminPhone: '9000000001', adminPassword: 'correct-horse-battery' }, '');
  const admin = await signIn(b, '9000000001', 'correct-horse-battery');
  await b.handle('create', { table: 'Tenants', data: { full_name: 'A', id_type: 'Aadhaar', id_number: '1234 5678 9012' } }, admin);
  await b.handle('create', { table: 'Tenants', data: { full_name: 'B', id_type: 'Other', id_number: 'AB12' } }, admin);
  await b.handle('createUser', { name: 'M', phone: '9000000004', role: 'manager', password: 'manager-pass-1234' }, admin);
  await b.handle('createUser', { name: 'V', phone: '9000000005', role: 'viewer', password: 'viewer-pass-1234' }, admin);
  const mgr = await signIn(b, '9000000004', 'manager-pass-1234');
  const viewer = await signIn(b, '9000000005', 'viewer-pass-1234');

  const ids = (rows) => rows.map(t => t.id_number).sort().join(',');
  const vBoot = (await b.handle('bootstrap', {}, viewer)).data.tenants;
  const vList = (await b.handle('list', { table: 'Tenants' }, viewer)).data.rows;
  const vLogin = (await b.handle('login', { phone: '9000000005', password: 'viewer-pass-1234', withSnapshot: true }, '')).data.snapshot.tenants;
  for (const [where, rows] of [['bootstrap', vBoot], ['list', vList], ['login snapshot', vLogin]]) {
    assert(ids(rows) === 'XXXX,XXXXXXXX9012', `viewer ${where} returned ${ids(rows)}`);
  }
  assert(ids((await b.handle('bootstrap', {}, mgr)).data.tenants) === '1234 5678 9012,AB12', 'manager did not get full numbers');
  assert(ids((await b.handle('list', { table: 'Tenants' }, mgr)).data.rows) === '1234 5678 9012,AB12', 'manager list was masked');
});
await check('a viewer promoted to manager is not left holding the masked copy', async () => {
  const b = await makeSandbox();
  await b.handle('setup', { adminPhone: '9000000001', adminPassword: 'correct-horse-battery' }, '');
  const admin = await signIn(b, '9000000001', 'correct-horse-battery');
  await b.handle('create', { table: 'Tenants', data: { full_name: 'A', id_number: '123456789012' } }, admin);
  await b.handle('createUser', { name: 'V', phone: '9000000005', role: 'viewer', password: 'viewer-pass-1234' }, admin);
  const viewer = await signIn(b, '9000000005', 'viewer-pass-1234');
  const first = (await b.handle('bootstrap', {}, viewer)).data;
  const id = (await b.readTable('Users')).find(u => u.phone === '9000000005').id;
  await b.handle('setUserRole', { id, role: 'manager' }, admin);
  const again = (await b.handle('bootstrap', { known: first.hashes }, viewer)).data;
  assert(!again.unchanged.includes('tenants'), 'the server said the masked tenants were still current');
  assert(again.tenants[0].id_number === '123456789012', 'still masked after promotion: ' + again.tenants[0].id_number);
});

await closeAll();
console.log('\n' + '─'.repeat(56));
console.log(fail ? `${fail} FAILED, ${pass} passed` : `ALL ${pass} SECURITY CHECKS PASSED`);
process.exit(fail ? 1 : 0);
