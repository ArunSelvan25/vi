/**
 * Checks the installable-app plumbing without needing a browser.
 *
 * The expensive mistakes here are quiet ones: a path in the service worker's
 * shell list that does not exist makes cache.addAll reject, which disables
 * offline support entirely — and only shows up once a user is offline. A
 * manifest icon that 404s just means no install prompt, with nothing logged.
 */
import fs from 'fs';
import path from 'path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, path.normalize(p)));

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
};

// ── manifest ────────────────────────────────────────────────────────────────
console.log('\n— web app manifest —');
let manifest = null;
try { manifest = JSON.parse(read('manifest.webmanifest')); ok('is valid JSON', true); }
catch (e) { ok('is valid JSON', false, e.message); }

if (manifest) {
  ok('has a name and a short_name', !!manifest.name && !!manifest.short_name);
  ok('display is standalone', manifest.display === 'standalone');
  // an absolute start_url or scope breaks the app on a GitHub Pages subpath
  ok('start_url is relative', typeof manifest.start_url === 'string' && !manifest.start_url.startsWith('/'),
     'got ' + manifest.start_url);
  ok('scope is relative', typeof manifest.scope === 'string' && !manifest.scope.startsWith('/'),
     'got ' + manifest.scope);
  ok('theme_color matches the brand', manifest.theme_color === '#21420d');

  const icons = manifest.icons || [];
  ok('declares a 192px and a 512px icon',
     icons.some(i => i.sizes === '192x192') && icons.some(i => i.sizes === '512x512'));
  ok('declares a maskable icon (Android crops the others)',
     icons.some(i => String(i.purpose || '').split(/\s+/).includes('maskable')));

  const missing = icons.map(i => i.src).filter(src => !exists(src));
  ok('every manifest icon exists', missing.length === 0, 'missing: ' + missing.join(', '));

  const badShortcut = (manifest.shortcuts || [])
    .flatMap(s => (s.icons || []).map(i => i.src))
    .filter(src => !exists(src));
  ok('every shortcut icon exists', badShortcut.length === 0, 'missing: ' + badShortcut.join(', '));

  for (const src of icons.map(i => i.src)) {
    if (!exists(src)) continue;
    const buf = fs.readFileSync(path.join(ROOT, src));
    const isPng = buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG';
    ok(`${src} is a real PNG`, isPng);
  }
}

// ── service worker ──────────────────────────────────────────────────────────
console.log('\n— service worker —');
const sw = read('sw.js');

ok('has a stampable BUILD line', /^const BUILD = '.*';$/m.test(sw));
ok('the cache name includes the build id', /const CACHE = 'vipm-shell-' \+ BUILD;/.test(sw));
ok('ignores anything that is not a GET', /req\.method !== 'GET'/.test(sw));
ok('ignores other origins, so the API is never cached', /url\.origin !== self\.location\.origin/.test(sw));
ok('clears caches from previous builds', /caches\.delete/.test(sw));
ok('does not call skipWaiting unprompted',
   !/self\.skipWaiting\(\)/.test(sw.replace(/if \(event\.data[\s\S]*?SKIP_WAITING'\) self\.skipWaiting\(\);/, '')),
   'an update must not replace the running version mid-session');

const shell = [...sw.matchAll(/^\s*'(\.\/[^']*)',?$/gm)].map(m => m[1]);
ok('the shell list was found', shell.length > 5, 'found ' + shell.length + ' entries');

const notOnDisk = shell.filter(p => p !== './' && !exists(p.replace(/^\.\//, '')));
ok('every precached path exists on disk', notOnDisk.length === 0,
   'cache.addAll would reject on: ' + notOnDisk.join(', '));

// every module the app actually loads must be in the shell, or the first
// offline launch fails on a missing import
const jsFiles = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = dir + '/' + entry.name;
    if (entry.isDirectory()) walk(rel);
    else if (entry.name.endsWith('.js')) jsFiles.push('./' + rel);
  }
};
walk('assets/js');
const uncached = jsFiles.filter(f => !shell.includes(f));
ok('every app module is precached', uncached.length === 0, 'not in SHELL: ' + uncached.join(', '));
ok('the stylesheet is precached', shell.includes('./assets/css/styles.css'));
ok('the shell can answer a cold launch', shell.includes('./') && shell.includes('./index.html'));

// ── page wiring ─────────────────────────────────────────────────────────────
console.log('\n— index.html —');
const html = read('index.html');
ok('links the manifest', /<link rel="manifest" href="manifest\.webmanifest">/.test(html));
ok('sets a theme colour', /<meta name="theme-color"/.test(html));
ok('has an apple-touch-icon for iOS', /rel="apple-touch-icon"/.test(html));
ok('the apple-touch-icon exists', exists('assets/icons/apple-touch-icon.png'));
ok('declares itself web-app capable', /name="apple-mobile-web-app-capable"/.test(html));
ok('references no absolute paths', !/(?:href|src)="\//.test(html),
   'an absolute path breaks the app under a GitHub Pages project subpath');

console.log('\n— registration —');
const app = read('assets/js/app.js');
ok('app.js registers the worker', /registerServiceWorker\(\)/.test(app));
const pwa = read('assets/js/pwa.js');
ok('registration failure is caught', /catch/.test(pwa));
ok('the worker path resolves from the module, not the page root',
   /new URL\('\.\.\/\.\.\/sw\.js', import\.meta\.url\)/.test(pwa));
ok('an update is offered rather than applied silently', /SKIP_WAITING/.test(pwa));

// ── deploy ──────────────────────────────────────────────────────────────────
console.log('\n— deploy —');
const wf = read('.github/workflows/deploy.yml');
ok('CI stamps the worker build', /scripts\/stamp-build\.mjs/.test(wf),
   'without this, installed devices never see a new release');
const mock = read('test/mock-server.mjs');
ok('the dev server serves .webmanifest', /'\.webmanifest'/.test(mock));
ok('the dev server serves .png', /'\.png'/.test(mock));

console.log('\n' + '─'.repeat(56));
console.log(fail ? `${fail} PWA CHECK(S) FAILED (${pass} passed)` : `ALL ${pass} PWA CHECKS PASSED`);
process.exit(fail ? 1 : 0);
