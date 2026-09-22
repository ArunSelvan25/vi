/**
 * The edges of the Supabase deployment: the HTTP surface the Edge Function
 * serves (supabase/functions/api/http.js), and the database seen from the
 * outside — Supabase publishes every table over its REST API to anyone holding
 * the public anon key, so the migration must leave that door shut.
 */
import { makeSandbox, bootedSandbox, closeAll } from './pg-harness.mjs';
import { makeHttpHandler } from '../supabase/functions/api/http.js';

let pass = 0, fail = 0;
const check = async (name, fn) => {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

const BASE = 'https://ref.supabase.co/functions/v1/api';
const CRON = 'cron-secret-for-tests';

/** POST the way the SPA does: text/plain, so the browser sends no preflight. */
const post = (serve, body, { path = '', headers = {} } = {}) => serve(new Request(BASE + path, {
  method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body)
}));

console.log('\n— the HTTP surface —');
const { box, admin } = await bootedSandbox();
const serve = makeHttpHandler(box.backend, { cronSecret: CRON });

await check('the SPA can sign in and load everything over POST', async () => {
  const login = await (await post(serve, { action: 'login', payload: { phone: '9000000001', password: 'correct-horse' } })).json();
  assert(login.ok && login.data.token, JSON.stringify(login));
  const res = await post(serve, { action: 'bootstrap', payload: {}, token: login.data.token });
  assert(res.status === 200, 'status ' + res.status);
  assert(res.headers.get('access-control-allow-origin') === '*', 'no CORS header on the response');
  const body = await res.json();
  assert(body.ok && Array.isArray(body.data.properties), JSON.stringify(body).slice(0, 200));
});

await check('errors come back as {ok:false} with status 200, as the SPA expects', async () => {
  const res = await post(serve, { action: 'bootstrap', payload: {}, token: 'forged.token' });
  const body = await res.json();
  assert(res.status === 200 && body.ok === false && body.error === 'AUTH_REQUIRED', res.status + ' ' + JSON.stringify(body));
});

await check('a preflight is answered, so the SPA may also send JSON', async () => {
  const res = await serve(new Request(BASE, { method: 'OPTIONS', headers: {
    Origin: 'https://example.github.io', 'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'content-type' } }));
  assert(res.status === 204, 'status ' + res.status);
  assert(/POST/.test(res.headers.get('access-control-allow-methods') || ''), 'POST not allowed');
  assert(/content-type/.test(res.headers.get('access-control-allow-headers') || ''), 'content-type not allowed');
});

await check('GET is a health check only — no action, token or JSONP callback', async () => {
  const res = await serve(new Request(BASE + '?action=bootstrap&token=' + admin + '&callback=alert'));
  const text = await res.text();
  assert(res.status === 200, 'status ' + res.status);
  assert(!/alert/.test(text), 'the callback was reflected');
  const body = JSON.parse(text);
  assert(body.ok && body.data.service && !body.data.properties, 'GET did more than report health: ' + text.slice(0, 200));
});

await check('malformed and oversized bodies are refused without reaching the database', async () => {
  const mark = box.queries.length;
  const junk = await (await post(serve, '{not json')).json();
  assert(junk.ok === false, 'junk was accepted');
  const big = await post(serve, JSON.stringify({ action: 'ping', payload: { x: 'a'.repeat(3 * 1024 * 1024) } }));
  assert(big.status === 413, 'a 3 MB body got status ' + big.status);
  assert(box.queries.length === mark, 'the database was queried for a request that should never reach it');
});

await check('other methods are refused', async () => {
  const res = await serve(new Request(BASE, { method: 'DELETE' }));
  assert(res.status === 405, 'status ' + res.status);
});

console.log('\n— the scheduled jobs endpoint —');
await check('the cron endpoint refuses a caller without the secret', async () => {
  const none = await post(serve, { job: 'dailyMaintenanceJob' }, { path: '/cron' });
  const wrong = await post(serve, { job: 'dailyMaintenanceJob' }, { path: '/cron', headers: { 'x-cron-secret': 'guess' } });
  assert(none.status === 403 && wrong.status === 403, `statuses ${none.status}, ${wrong.status}`);
});

await check('with the secret it runs the job, and only a known job', async () => {
  const ok = await post(serve, { job: 'dailyMaintenanceJob' }, { path: '/cron', headers: { 'x-cron-secret': CRON } });
  const body = await ok.json();
  assert(ok.status === 200 && body.ok && typeof body.data.changes === 'number', JSON.stringify(body));
  const other = await post(serve, { job: 'recoverAccess' }, { path: '/cron', headers: { 'x-cron-secret': CRON } });
  assert(other.status === 400, 'an arbitrary backend method was reachable: ' + other.status);
});

await check('with no CRON_SECRET configured the endpoint is closed', async () => {
  const closed = makeHttpHandler(box.backend, { cronSecret: '' });
  const res = await post(closed, { job: 'dailyMaintenanceJob' }, { path: '/cron', headers: { 'x-cron-secret': '' } });
  assert(res.status === 403, 'status ' + res.status);
});

console.log('\n— the tables cannot be reached around the backend —');
const TABLES = ['app_users', 'properties', 'units', 'tenants', 'leases', 'lease_tenants', 'invoices', 'invoice_items', 'payments',
                'maintenance', 'expenses', 'documents', 'settings', 'activity_log',
                'id_counters', 'table_versions', 'app_state', 'login_throttle'];

for (const role of ['anon', 'authenticated']) {
  await check(`the ${role} role (the public REST API) can read and write no table`, async () => {
    const opened = [];
    for (const t of TABLES) {
      for (const stmt of [`select * from ${t} limit 1`, `delete from ${t}`]) {
        try {
          await box.sql.begin(async (tx) => {
            await tx.unsafe(`set local role ${role}`);
            await tx.unsafe(stmt);
          });
          opened.push(stmt);
        } catch (e) {
          if (!/permission denied/.test(e.message)) opened.push(stmt + ' (' + e.message + ')');
        }
      }
    }
    assert(!opened.length, 'reachable: ' + opened.join('; '));
  });
}

await check('every table has row-level security switched on', async () => {
  const rows = await box.query(`select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
                                where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`);
  assert(!rows.length, 'no RLS on: ' + rows.map(r => r.relname).join(', '));
});

await check('the id counter cannot be advanced through the API', async () => {
  let reached = false;
  try {
    await box.sql.begin(async (tx) => {
      await tx.unsafe('set local role anon');
      await tx.unsafe(`select reserve_ids('Invoices', 1000, 0)`);
    });
    reached = true;
  } catch (e) { /* permission denied */ }
  assert(!reached, 'anon could burn invoice numbers');
});

await check('a fresh deployment answers setup over HTTP', async () => {
  const fresh = await makeSandbox();
  const s = makeHttpHandler(fresh.backend, {});
  const r = await (await post(s, { action: 'setup', payload: { adminPhone: '9880011111', adminPassword: 'correct-horse-battery' } })).json();
  assert(r.ok && r.data.adminCreated, JSON.stringify(r));
});

await closeAll();
console.log('\n' + '─'.repeat(56));
console.log(fail ? `${fail} FAILED, ${pass} passed` : `ALL ${pass} HTTP AND ACCESS CHECKS PASSED`);
process.exit(fail ? 1 : 0);
