/**
 * Mobile layout audit.
 *
 * The rule being enforced: a table may scroll sideways inside its own box, but
 * the page never may. A page that scrolls horizontally on a phone hides its
 * primary action off the right-hand edge, which is exactly how the Invoices
 * screen used to behave.
 *
 * It checks every route, both themes, the dialogs, the detail screens and the
 * empty states, because a layout only breaks in the state nobody looked at.
 */
import puppeteer from 'puppeteer-core';
import { spawn } from 'child_process';

const server = spawn('node', [new URL('./mock-server.mjs', import.meta.url).pathname],
  { env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'inherit'] });
process.on('exit', () => server.kill());
const port = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('mock server did not start')), 10000);
  server.stdout.on('data', (c) => {
    const m = String(c).match(/PORT=(\d+)/);
    if (m) { clearTimeout(t); resolve(m[1]); }
  });
});
const BASE = 'http://localhost:' + port;

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage']
});
const page = await browser.newPage();

let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) console.log('  ✓ ' + name);
  else { fail++; console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
};

// ── sign in ─────────────────────────────────────────────────────────────────
await page.goto(BASE + '/index.html', { waitUntil: 'networkidle0' });
await page.evaluate((u) => localStorage.setItem('vipm.apiUrl', u), BASE + '/api');
await page.goto(BASE + '/index.html', { waitUntil: 'networkidle0' });
await page.waitForSelector('input[type=password]', { timeout: 15000 });
await page.evaluate(() => {
  const set = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
  set(document.querySelector('input[type=tel]'), '9000012345');
  set(document.querySelector('input[type=password]'), 'password123');
  document.querySelector('form').requestSubmit();
});
await page.waitForFunction(() => !!document.querySelector('#main .view'), { timeout: 20000 });

/**
 * Elements sticking out past the right edge, ignoring anything inside a box
 * that is allowed to scroll — that is the whole point of `.table-scroll`.
 */
const overflow = () => page.evaluate(() => {
  const vw = document.documentElement.clientWidth;
  const offenders = [];
  const seen = new Set();
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) continue;
    if (r.right - vw <= 1) continue;
    let p = el.parentElement, clipped = false;
    while (p && p !== document.body) {
      const o = getComputedStyle(p).overflowX;
      if (o === 'auto' || o === 'scroll' || o === 'hidden') { clipped = true; break; }
      p = p.parentElement;
    }
    if (clipped) continue;
    const sig = el.tagName + '.' + el.className;
    if (seen.has(sig)) continue;
    seen.add(sig);
    offenders.push(`${el.tagName.toLowerCase()}.${String(el.className).trim().split(/\s+/).join('.')} +${Math.round(r.right - vw)}px`);
  }
  return { doc: document.documentElement.scrollWidth, vw, offenders: offenders.slice(0, 4) };
});

const showRoute = async (r) => {
  await page.evaluate((p) => { location.hash = '#/' + p; }, r);
  await page.waitForFunction(() => !!document.querySelector('#main .view'), { timeout: 8000 }).catch(() => {});
  await new Promise((s) => setTimeout(s, 200));
};

const ROUTES = ['dashboard', 'properties', 'units', 'tenants', 'leases', 'billing',
                'billing?tab=payments', 'billing?show=overdue', 'expenses', 'reports', 'maintenance',
                'documents', 'settings',
                // every record page, with its sidebar, tabs and cards
                'properties/PRP-00001', 'units/UNT-00001', 'tenants/TNT-00001', 'leases/LSE-00001',
                'invoices/INV-00003', 'payments/PAY-00001', 'maintenance/MNT-00002',
                'expenses/EXP-00001', 'documents/DOC-00001', 'tenants/TNT-00001?tab=invoices'];
const WIDTHS = [320, 360, 390, 414, 768];

// ── every screen, every common phone width ──────────────────────────────────
for (const w of WIDTHS) {
  console.log(`\n— ${w}px —`);
  await page.setViewport({ width: w, height: 780, isMobile: w < 700 });
  const bad = [];
  for (const r of ROUTES) {
    await showRoute(r);
    const o = await overflow();
    if (o.doc > o.vw + 1) bad.push(`${r} (${o.doc}px): ${o.offenders.join(', ')}`);
  }
  ok(`no screen scrolls the page sideways`, bad.length === 0, bad.join('\n      '));
}

// ── the states that only show up once you interact ──────────────────────────
await page.setViewport({ width: 360, height: 780, isMobile: true });

console.log('\n— dialogs —');
for (const [route, label] of [['properties', 'property'], ['tenants', 'tenant'],
                              ['units', 'unit'], ['leases', 'lease'],
                              ['expenses', 'expense'], ['billing', 'invoice']]) {
  await showRoute(route);
  const opened = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.head-actions .btn-primary')].pop();
    if (!b) return false;
    b.click();
    return true;
  });
  if (!opened) { ok(`${label} dialog opens`, false, 'no primary action found'); continue; }
  await page.waitForSelector('.modal', { timeout: 5000 }).catch(() => {});
  await new Promise((s) => setTimeout(s, 250));
  const o = await overflow();
  ok(`the new-${label} dialog fits`, o.doc <= o.vw + 1, `${o.doc}px vs ${o.vw}px — ${o.offenders.join(', ')}`);
  const fits = await page.evaluate(() => {
    const m = document.querySelector('.modal');
    if (!m) return null;
    const r = m.getBoundingClientRect();
    return { left: Math.round(r.left), right: Math.round(r.right), vw: document.documentElement.clientWidth };
  });
  ok(`the ${label} dialog sits inside the screen`, fits && fits.left >= -1 && fits.right <= fits.vw + 1,
     JSON.stringify(fits));
  await page.keyboard.press('Escape');
  await new Promise((s) => setTimeout(s, 200));
}

console.log('\n— detail screens —');
for (const [route, name] of [['properties', 'property'], ['tenants', 'tenant']]) {
  await showRoute(route);
  const went = await page.evaluate(() => {
    const row = document.querySelector('.data-table tbody tr.clickable');
    if (!row) return false;
    row.click();
    return true;
  });
  await new Promise((s) => setTimeout(s, 400));
  const o = await overflow();
  ok(`the ${name} detail screen fits`, went && o.doc <= o.vw + 1,
     `${o.doc}px vs ${o.vw}px — ${o.offenders.join(', ')}`);
}

console.log('\n— empty states —');
// the screen the bug report came from: a table with nothing in it
await showRoute('billing');
await page.evaluate(() => {
  const s = document.querySelector('.search-input');
  s.value = 'zzzznothingmatchesthis';
  s.dispatchEvent(new Event('input', { bubbles: true }));
});
await new Promise((s) => setTimeout(s, 400));
const emptyO = await overflow();
ok('an empty table does not widen the page', emptyO.doc <= emptyO.vw + 1,
   `${emptyO.doc}px vs ${emptyO.vw}px — ${emptyO.offenders.join(', ')}`);
const empty = await page.evaluate(() => {
  const e = document.querySelector('.table-empty');
  const scroll = document.querySelector('.table-scroll');
  if (!e) return null;
  const r = e.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  return { visible: r.width > 0, inside: r.left >= -1 && r.right <= vw + 1,
           scrollHidden: !scroll || scroll.hidden, text: (e.textContent || '').trim().slice(0, 40) };
});
ok('the empty message is on screen, not off to one side', empty && empty.visible && empty.inside,
   JSON.stringify(empty));
ok('no column headers are left hanging over an empty table', empty && empty.scrollHidden, JSON.stringify(empty));

console.log('\n— navigation drawer —');
await showRoute('dashboard');
await page.evaluate(() => document.querySelector('.topbar .icon-btn').click());
await new Promise((s) => setTimeout(s, 300));
const drawer = await page.evaluate(() => {
  const s = document.querySelector('.sidebar').getBoundingClientRect();
  return { left: Math.round(s.left), width: Math.round(s.width), vw: document.documentElement.clientWidth,
           open: document.body.classList.contains('nav-open') };
});
ok('the drawer opens fully on screen', drawer.open && drawer.left >= -1 && drawer.width <= drawer.vw,
   JSON.stringify(drawer));
const drawerO = await overflow();
ok('the open drawer does not widen the page', drawerO.doc <= drawerO.vw + 1, JSON.stringify(drawerO));
await page.evaluate(() => document.body.classList.remove('nav-open'));

console.log('\n— dark theme —');
await page.evaluate(() => { localStorage.setItem('vipm.theme', 'dark'); document.documentElement.dataset.theme = 'dark'; });
const darkBad = [];
for (const r of ROUTES) {
  await showRoute(r);
  const o = await overflow();
  if (o.doc > o.vw + 1) darkBad.push(`${r}: ${o.offenders.join(', ')}`);
}
ok('dark theme lays out identically', darkBad.length === 0, darkBad.join('\n      '));
await page.evaluate(() => { localStorage.setItem('vipm.theme', 'light'); document.documentElement.dataset.theme = 'light'; });

console.log('\n— touch targets —');
await showRoute('billing');
const small = await page.evaluate(() => {
  const out = [];
  for (const el of document.querySelectorAll('button, a, select, input[type=search]')) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    if (r.height < 32) out.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} ${Math.round(r.height)}px`);
  }
  return [...new Set(out)];
});
ok('every control is at least 32px tall on a phone', small.length === 0, small.join(', '));

console.log('\n— the primary action stays reachable —');
for (const w of [320, 360, 390]) {
  await page.setViewport({ width: w, height: 780, isMobile: true });
  await showRoute('billing');
  const btn = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.head-actions .btn')].pop();
    const r = b.getBoundingClientRect();
    return { right: Math.round(r.right), vw: document.documentElement.clientWidth, text: b.textContent.trim() };
  });
  ok(`"${btn.text}" is fully visible at ${w}px`, btn.right <= btn.vw + 1, JSON.stringify(btn));
}

console.log('\n— status bar and home indicator —');
// Installed on iOS the app is drawn under the status bar, so the chrome has to
// reserve room for it. Chrome on a desktop reports no insets, so we stand in
// for an iPhone by setting the variables the stylesheet reads.
const IOS = { top: 47, bottom: 34 };
await page.setViewport({ width: 390, height: 844, isMobile: true });
await showRoute('dashboard');
await page.evaluate(({ top, bottom }) => {
  const r = document.documentElement.style;
  r.setProperty('--safe-top', top + 'px');
  r.setProperty('--safe-bottom', bottom + 'px');
}, IOS);
await new Promise((s) => setTimeout(s, 250));

const bar = await page.evaluate(() => {
  const t = document.querySelector('.topbar');
  const btn = t.querySelector('.icon-btn');
  return { barTop: Math.round(t.getBoundingClientRect().top),
           barHeight: Math.round(t.getBoundingClientRect().height),
           btnTop: Math.round(btn.getBoundingClientRect().top),
           btnBottom: Math.round(btn.getBoundingClientRect().bottom) };
});
ok('the bar still starts at the very top of the screen', bar.barTop === 0, JSON.stringify(bar));
ok('the bar grows by the height of the status bar', bar.barHeight === 56 + IOS.top, JSON.stringify(bar));
ok('the menu button clears the status bar', bar.btnTop >= IOS.top, JSON.stringify(bar));

// the drawer's own header has to line up with it
await page.evaluate(() => document.querySelector('.topbar .icon-btn').click());
await new Promise((s) => setTimeout(s, 300));
const brand = await page.evaluate(() => {
  const b = document.querySelector('.sidebar .brand');
  const r = b.getBoundingClientRect();
  const label = b.querySelector('span');
  return { top: Math.round(r.top), height: Math.round(r.height),
           labelTop: label ? Math.round(label.getBoundingClientRect().top) : null };
});
ok('the drawer header clears the status bar too', brand.labelTop >= IOS.top, JSON.stringify(brand));
await page.evaluate(() => document.body.classList.remove('nav-open'));

// a dialog is its own full-screen surface and cannot inherit the inset
await showRoute('tenants');
await page.evaluate(() => [...document.querySelectorAll('.head-actions .btn-primary')].pop().click());
await page.waitForSelector('.modal', { timeout: 5000 }).catch(() => {});
await new Promise((s) => setTimeout(s, 300));
const modalTop = await page.evaluate(() => {
  const m = document.querySelector('.modal');
  return m ? Math.round(m.getBoundingClientRect().top) : null;
});
ok('a dialog opens below the status bar', modalTop !== null && modalTop >= IOS.top,
   'modal top = ' + modalTop);
await page.keyboard.press('Escape');

// nothing above should have cost us the rule everything else is built on
await new Promise((s) => setTimeout(s, 250));
const insetOverflow = await overflow();
ok('insets do not make the page scroll sideways', insetOverflow.doc <= insetOverflow.vw + 1,
   JSON.stringify(insetOverflow));

// and with no insets — a browser tab, or Android — the layout is untouched
await page.evaluate(() => {
  document.documentElement.style.removeProperty('--safe-top');
  document.documentElement.style.removeProperty('--safe-bottom');
});
await showRoute('dashboard');
const plain = await page.evaluate(() => Math.round(document.querySelector('.topbar').getBoundingClientRect().height));
ok('without insets the bar is its normal height', plain === 56, 'height = ' + plain);

await browser.close(); server.kill();
console.log('\n' + '─'.repeat(60));
console.log(fail ? `${fail} RESPONSIVE CHECK(S) FAILED` : 'ALL RESPONSIVE CHECKS PASSED');
process.exit(fail ? 1 : 0);
