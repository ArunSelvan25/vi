/**
 * Drives a real Chrome over the installable-app behaviour: that Chrome accepts
 * the manifest, that the worker takes control, that the app opens with the
 * network cut, and — the one that matters most — that not one API call ever
 * reaches the cache. Tenant records and session tokens must not be left on the
 * device by the thing that makes it feel like an app.
 *
 * test/pwa-test.mjs covers the same wiring statically and needs no browser;
 * this is the proof that it behaves.
 */
import puppeteer from 'puppeteer-core';
import fs from 'fs';
import { spawn } from 'child_process';

const server = spawn('node', [new URL('./mock-server.mjs', import.meta.url).pathname],
  { env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'inherit'] });
process.on('exit', () => server.kill());
const port = await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('no server')), 10000);
  server.stdout.on('data', c => { const m = String(c).match(/PORT=(\d+)/); if (m) { clearTimeout(t); res(m[1]); } });
});
const BASE = 'http://localhost:' + port;

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage']
});
const page = await browser.newPage();
const consoleErrors = [];
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', e => consoleErrors.push('PAGEERROR: ' + e.message));

let fail = 0;
const ok = (n, c, d='') => { console.log((c?'  ✓ ':'  ✗ ')+n+(c?'':' — '+d)); if(!c) fail++; };

console.log('\n— installability —');
await page.goto(BASE + '/index.html', { waitUntil: 'networkidle0' });

const cdp = await page.target().createCDPSession();
const { data, errors: mErrors } = await cdp.send('Page.getAppManifest');
ok('Chrome parses the manifest with no errors',
   !!data && (mErrors || []).filter(e => !e.critical === false || e.critical).length === 0,
   JSON.stringify(mErrors));
const parsed = data ? JSON.parse(data) : {};
ok('name and display come through', parsed.name === 'VI Property Manager' && parsed.display === 'standalone');

// sign in so the app makes real API calls before we inspect the cache
await page.evaluate(url => localStorage.setItem('vipm.apiUrl', url), BASE + '/api');
await page.reload({ waitUntil: 'networkidle0' });

const swState = await page.evaluate(async () => {
  const reg = await navigator.serviceWorker.ready;
  return { active: !!reg.active, state: reg.active && reg.active.state, scope: reg.scope };
});
ok('a service worker is active', swState.active && swState.state === 'activated', JSON.stringify(swState));
ok('its scope is the site root', swState.scope === BASE + '/', swState.scope);

await page.reload({ waitUntil: 'networkidle0' });
const controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
ok('the page is controlled after a reload', controlled);

console.log('\n— what is in the cache —');
const cacheInfo = await page.evaluate(async () => {
  const names = await caches.keys();
  const out = {};
  for (const n of names) out[n] = (await (await caches.open(n)).keys()).map(r => r.url);
  return out;
});
const names = Object.keys(cacheInfo);
ok('exactly one shell cache exists', names.length === 1, JSON.stringify(names));
const urls = cacheInfo[names[0]] || [];
ok('the cache is named for the build', /^vipm-shell-/.test(names[0]), names[0]);
ok('the whole shell is cached', urls.length >= 26, urls.length + ' entries');
ok('index.html is cached', urls.some(u => u.endsWith('/index.html')));
ok('every app module is cached', urls.filter(u => u.includes('/assets/js/')).length === 18,
   urls.filter(u => u.includes('/assets/js/')).length + ' modules');

console.log('\n— the API must never be cached —');
// force some traffic through the API first
await page.evaluate(async (api) => {
  const call = (action, payload, token) => fetch(api, { method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action, payload, token }) }).then(r => r.json());
  const login = await call('login', { phone: '9000012345', password: 'password123' });
  await call('bootstrap', {}, login.data.token);
  await call('create', { table: 'Units', data: { unit_number: 'SW-1' }, withSnapshot: true }, login.data.token);
}, BASE + '/api');

const after = await page.evaluate(async () => {
  const names = await caches.keys();
  const all = [];
  for (const n of names) all.push(...(await (await caches.open(n)).keys()).map(r => r.url));
  return all;
});
// the endpoint itself, not assets/js/api.js which is part of the shell
const isApiCall = (u) => { try { return new URL(u).pathname === '/api'; } catch { return false; } };
ok('no API request was cached', !after.some(isApiCall), after.filter(isApiCall).join(', '));
const dump = JSON.stringify(after);
ok('no token or session data in cache keys', !/token|password/i.test(dump));

console.log('\n— opening with no network —');
await page.setOfflineMode(true);
const resp = await page.reload({ waitUntil: 'domcontentloaded' });
ok('the page still loads offline', !!resp && resp.status() < 400, resp ? String(resp.status()) : 'no response');
const offlineShell = await page.evaluate(() => ({
  title: document.title,
  hasApp: !!document.querySelector('#app'),
  styled: getComputedStyle(document.body).backgroundColor,
  scripts: !!window.__appBooted || !!document.querySelector('#app *')
}));
ok('the app shell renders offline', offlineShell.hasApp && offlineShell.title === 'Property Manager',
   JSON.stringify(offlineShell));
ok('the stylesheet came from cache too', offlineShell.styled !== 'rgba(0, 0, 0, 0)', offlineShell.styled);
ok('the app booted its JS offline', offlineShell.scripts);
await page.setOfflineMode(false);

console.log('\n— taking an update —');
// Rewrite the worker the way a deploy does, then prove an installed client
// notices, is asked rather than interrupted, and ends up on the new build.
const SW = new URL('../sw.js', import.meta.url);
const original = fs.readFileSync(SW, 'utf8');
try {
  const before = (await page.evaluate(async () => (await caches.keys())[0]));
  fs.writeFileSync(SW, original.replace(/^const BUILD = '.*';$/m, "const BUILD = 'test-build-2';"));

  await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); await r.update(); });

  const toastText = await page.waitForFunction(
    () => { const t = document.querySelector('.toast'); return t ? t.textContent : false; },
    { timeout: 15000 }
  ).then(h => h.jsonValue()).catch(() => null);
  ok('the user is told a new version is ready', /new version is ready/i.test(toastText || ''), String(toastText));
  ok('the update is offered, not forced', /update now/i.test(toastText || ''), String(toastText));

  const stillOld = await page.evaluate(async () => (await caches.keys()).sort());
  ok('the running build is untouched until they accept', stillOld.includes(before), stillOld.join(', '));

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }),
    page.evaluate(() => document.querySelector('.toast-action').click())
  ]);

  const names = await page.evaluate(async () => (await caches.keys()));
  ok('the new build is now serving', names.includes('vipm-shell-test-build-2'), names.join(', '));
  ok('the previous cache was cleaned up', names.length === 1, names.join(', '));
} finally {
  fs.writeFileSync(SW, original);
}

console.log('\n— console —');
// an offline reload legitimately logs the failed API call
const noisy = consoleErrors.filter(e => !/Failed to load resource|net::ERR_INTERNET_DISCONNECTED|Could not reach the API/i.test(e));
ok('no unexpected console errors', noisy.length === 0, noisy.join(' | '));

await browser.close(); server.kill();
console.log('\n' + '─'.repeat(56));
console.log(fail ? `${fail} BROWSER PWA CHECK(S) FAILED` : 'ALL BROWSER PWA CHECKS PASSED');
process.exit(fail ? 1 : 0);
