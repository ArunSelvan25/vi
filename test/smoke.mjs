import puppeteer from 'puppeteer-core';
import { spawn } from 'child_process';

// Start a fresh mock server on an OS-assigned port, so no state leaks between
// runs and a stale server can never collide with us.
const server = spawn('node', [new URL('./mock-server.mjs', import.meta.url).pathname],
                     { env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'inherit'] });
process.on('exit', () => server.kill());

const port = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('mock server did not start')), 10000);
  server.stdout.on('data', chunk => {
    const m = String(chunk).match(/PORT=(\d+)/);
    if (m) { clearTimeout(timer); resolve(m[1]); }
  });
});

const BASE = 'http://localhost:' + port;
const errors = [];
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome-stable';
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage']
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 950 });
page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
page.on('requestfailed', r => errors.push('REQFAIL: ' + r.url() + ' ' + r.failure()?.errorText));

/** Navigate and wait for the new view to actually be rendered. */
const go = async (path, expectHeading) => {
  await page.evaluate(p => { location.hash = '#/' + p; }, path);
  await page.waitForFunction(h => {
    const el = document.querySelector('#main .view h1, #main .view .view-head h1');
    return el && new RegExp(h, 'i').test(el.textContent);
  }, { timeout: 5000 }, expectHeading);
  await new Promise(r => setTimeout(r, 150));
};

const step = async (name, fn) => {
  try { await fn(); console.log('  ✓ ' + name); }
  catch (e) { console.log('  ✗ ' + name + ' — ' + e.message); errors.push('STEP ' + name + ': ' + e.message); }
};

console.log('\n— setup & login —');
await page.goto(BASE + '/index.html', { waitUntil: 'networkidle0' });

await step('first run shows setup wizard', async () => {
  await page.waitForSelector('.auth-card', { timeout: 5000 });
  const t = await page.$eval('.auth-card h2', e => e.textContent);
  if (!/Connect your database/.test(t)) throw new Error('got: ' + t);
});

await step('the wizard creates the first administrator on a fresh sheet', async () => {
  // The wizard only accepts a real API URL, so answer for one here — with
  // exactly what the backend says to an empty database. The mock API always
  // claims to be set up already, which is how this path broke unseen.
  const FAKE = 'https://abcdefghijklmnop.supabase.co/functions/v1/api';
  const seen = [];
  await page.setRequestInterception(true);
  const answer = (req) => {
    if (!req.url().startsWith(FAKE)) return req.continue();
    if (req.method() === 'OPTIONS') throw new Error('the API call needed a CORS preflight');
    const { action, payload } = JSON.parse(req.postData() || '{}');
    seen.push(action);
    const reply = action === 'ping' ? { ok: true, data: { service: 'vi-property-manager' } }
      : action === 'setup' && !payload.adminPhone
        ? { ok: false, error: 'Provide adminPhone — it is the sign-in credential' }
        : action === 'setup' ? { ok: true, data: { adminCreated: true, alreadySeeded: false } }
        : { ok: false, error: 'AUTH_REQUIRED' };
    req.respond({ status: 200, contentType: 'application/json',
                  headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(reply) });
  };
  page.on('request', answer);
  try {
    await page.type('.auth-card input[type=url]', FAKE);
    await page.evaluate(() => [...document.querySelectorAll('.auth-card button')]
      .find(b => /^Connect$/.test(b.textContent.trim())).click());
    await page.waitForFunction(() => {
      const btn = [...document.querySelectorAll('.auth-card button')].find(b => /Create admin/.test(b.textContent));
      return btn && !btn.hidden;
    }, { timeout: 5000 }).catch(async () => {
      const shown = await page.$eval('.auth-card .form-error', e => e.hidden ? '(none)' : e.textContent);
      throw new Error('the admin form never appeared; error shown: ' + shown);
    });
    await page.type('.auth-card input[type=tel]', '9880011111');
    await page.type('.auth-card input[type=password]', 'first-admin-pass');
    await page.evaluate(() => [...document.querySelectorAll('.auth-card button')]
      .find(b => /Create admin/.test(b.textContent)).click());
    await page.waitForFunction(() => /Sign in/.test(document.querySelector('.auth-card h2')?.textContent || ''),
                               { timeout: 5000 });
    if (seen.filter(a => a === 'setup').length !== 2) throw new Error('setup calls: ' + seen.join(','));
  } finally {
    page.off('request', answer);
    await page.setRequestInterception(false);
  }
});

// Seed the API URL the way the wizard would, then reload into the login screen.
await page.evaluate(url => localStorage.setItem('vipm.apiUrl', url), BASE + '/api');
await page.reload({ waitUntil: 'networkidle0' });

await step('login screen renders', async () => {
  await page.waitForSelector('.auth-card form', { timeout: 5000 });
  const label = await page.$eval('.auth-card label', e => e.textContent.trim());
  if (!/phone/i.test(label)) throw new Error('login asks for "' + label + '", expected phone');
  if (!await page.$('input[type=tel]')) throw new Error('no telephone input');
});

await step('hidden elements are actually hidden', async () => {
  // Regression: .form-error uses display:flex, which overrides [hidden] unless
  // the attribute is made authoritative — an empty error bar on every form.
  const visible = await page.evaluate(() =>
    [...document.querySelectorAll('[hidden]')]
      .filter(e => getComputedStyle(e).display !== 'none')
      .map(e => e.className || e.tagName));
  if (visible.length) throw new Error('rendered while hidden: ' + JSON.stringify(visible));
});

await step('bad password shows an error', async () => {
  await page.type('input[type=tel]', '+91 90000 12345');
  await page.type('input[type=password]', 'wrongpass');
  await page.click('button[type=submit]');
  await page.waitForFunction(() => {
    const e = document.querySelector('.form-error');
    return e && !e.hidden && /Invalid/.test(e.textContent);
  }, { timeout: 5000 });
});

await step('correct password signs in', async () => {
  await page.$eval('input[type=tel]', e => e.value = '');
  await page.type('input[type=tel]', '90000 12345');   // no country code — must still match
  await page.type('input[type=password]', 'password123');
  await page.click('button[type=submit]');
  await page.waitForSelector('.kpi-row', { timeout: 8000 });
});

console.log('\n— dashboard —');
await step('KPIs show real numbers', async () => {
  const kpis = await page.$$eval('.kpi', ns => ns.map(n => ({
    label: n.querySelector('.kpi-label').textContent,
    value: n.querySelector('.kpi-value').textContent
  })));
  if (kpis.length !== 6) throw new Error('expected 6 KPIs, got ' + kpis.length);
  const rentRoll = kpis.find(k => /rent roll/i.test(k.label));
  if (!/103|1\.0L/.test(rentRoll.value)) throw new Error('rent roll looked wrong: ' + rentRoll.value);
  console.log('    ' + kpis.map(k => k.label + '=' + k.value).join(' | '));
});
await step('charts render as SVG', async () => {
  const bars = await page.$$eval('.chart rect', n => n.length);
  const donut = await page.$$eval('.donut circle', n => n.length);
  if (bars < 2) throw new Error('no bars drawn');
  if (donut < 2) throw new Error('no donut segments');
});
await step('cash-flow months align with their data (timezone regression)', async () => {
  // A toISOString()-based month key shifts every bucket back one month in +offset zones.
  const series = await page.evaluate(async () => {
    const { store } = await import('/assets/js/store.js');
    return store.monthlySeries(6).map(m => ({ key: m.key, label: m.label, income: m.income, expense: m.expense }));
  });
  console.log('    ' + series.map(m => `${m.label}(${m.key}) in=${m.income} out=${m.expense}`).join(' '));
  // the dev data is dated relative to today: rent paid two months ago, tax last
  // month, a part payment and a repair this month
  const [twoAgo, lastMonth, thisMonth] = series.slice(-3);
  const now = new Date();
  const keyOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  if (twoAgo.income !== 28000) throw new Error(twoAgo.label + ' income should be 28000, got ' + twoAgo.income);
  if (lastMonth.expense !== 32000) throw new Error(lastMonth.label + ' expense should be 32000, got ' + lastMonth.expense);
  if (thisMonth.income !== 25000) throw new Error(thisMonth.label + ' income should be 25000, got ' + thisMonth.income);
  if (thisMonth.expense !== 6500) throw new Error(thisMonth.label + ' expense should be 6500, got ' + thisMonth.expense);
  if (twoAgo.key !== keyOf(new Date(now.getFullYear(), now.getMonth() - 2, 1))) throw new Error('bucket keyed as ' + twoAgo.key);
});

await step('money formatting (sign, symbol, Indian grouping)', async () => {
  const out = await page.evaluate(async () => {
    const { money } = await import('/assets/js/ui.js');
    return {
      pos: money(4000), neg: money(-4000),
      dec: money(1234.567), lakh: money(250000),
      compactNeg: money(-250000, { compact: true }),
      crore: money(18500000, { compact: true })
    };
  });
  const want = { pos:'₹4,000', neg:'-₹4,000', dec:'₹1,234.57',
                 lakh:'₹2,50,000', compactNeg:'-₹2.5L', crore:'₹1.9Cr' };
  for (const [k, v] of Object.entries(want)) {
    if (out[k] !== v) throw new Error(`money.${k}: expected ${v}, got ${out[k]}`);
  }
});

await step('no stray mobile menu button on desktop', async () => {
  const shown = await page.evaluate(() => {
    const b = document.querySelector('.only-mobile');
    return b ? getComputedStyle(b).display !== 'none' : false;
  });
  if (shown) throw new Error('hamburger visible at desktop width');
});

await step('arrears + expiring lists populate', async () => {
  const text = await page.$eval('.view', e => e.textContent);
  if (!/Anita Rao|Karthik Menon/.test(text)) throw new Error('no tenant appears in attention lists');
});

console.log('\n— navigation across every view —');
for (const path of ['properties','units','tenants','leases','invoices','payments',
                    'maintenance','expenses','documents','reports','settings']) {
  await step('view: ' + path, async () => {
    await page.evaluate(p => { location.hash = '#/' + p; }, path);
    await page.waitForFunction(p => {
      const h = document.querySelector('#main .view h1');
      return h && h.textContent.toLowerCase().includes(p.slice(0, 5));
    }, { timeout: 5000 }, path);
    await new Promise(r => setTimeout(r, 250));
    const body = await page.$eval('#main', e => e.textContent);
    if (/Something went wrong/.test(body)) throw new Error('view threw');
    if (body.trim().length < 40) throw new Error('view rendered empty');
  });
}

console.log('\n— data tables —');
await step('invoice table lists all 3 invoices', async () => {
  await go('invoices', 'Invoices');
  await page.waitForSelector('.data-table tbody tr', { timeout: 5000 });
  const rows = await page.$$eval('.data-table tbody tr', r => r.length);
  if (rows !== 3) throw new Error('expected 3 rows, got ' + rows);
});
await step('foreign keys render as names, not IDs', async () => {
  const txt = await page.$eval('.data-table tbody', e => e.textContent);
  if (/TNT-000/.test(txt)) throw new Error('raw tenant id leaked into the table');
  if (!/Anita Rao/.test(txt)) throw new Error('tenant name missing');
});
await step('filter labels are pluralised correctly', async () => {
  const labels = await page.$$eval('.facets select option:first-child', o => o.map(x => x.textContent));
  const bad = labels.filter(l => /ss$|ys$/.test(l));
  if (bad.length) throw new Error('bad plural: ' + JSON.stringify(bad));
  if (!labels.includes('All statuses')) throw new Error('got: ' + JSON.stringify(labels));
});

await step('search icon does not overlap the placeholder', async () => {
  const pad = await page.$eval('.search-input', e => parseFloat(getComputedStyle(e).paddingLeft));
  const iconRight = await page.$eval('.search-box .icon', e => e.getBoundingClientRect().right);
  const boxLeft = await page.$eval('.search-box', e => e.getBoundingClientRect().left);
  if (pad < iconRight - boxLeft) throw new Error(`padding ${pad}px is under the icon (${iconRight - boxLeft}px)`);
});

await step('row actions stay reachable on a wide table', async () => {
  const ok = await page.evaluate(() => {
    const cell = document.querySelector('.data-table tbody td.col-actions');
    if (!cell) return 'no actions cell';
    if (getComputedStyle(cell).position !== 'sticky') return 'actions column is not pinned';
    const scroller = document.querySelector('.table-scroll');
    const r = cell.getBoundingClientRect(), s = scroller.getBoundingClientRect();
    return (r.right <= s.right + 1 && r.left >= s.left) ? true : 'actions clipped out of view';
  });
  if (ok !== true) throw new Error(ok);
});

await step('page name is not shown twice at once', async () => {
  const state = await page.evaluate(() => {
    const h1 = document.querySelector('#main .view-head h1');
    const chip = document.querySelector('#page-title');
    return {
      h1: h1?.textContent,
      chipText: chip?.textContent,
      chipVisible: chip ? getComputedStyle(chip).opacity !== '0' : false
    };
  });
  if (state.h1 === state.chipText && state.chipVisible) {
    throw new Error('topbar repeats the visible page heading: ' + state.h1);
  }
});

await step('search filters rows', async () => {
  await page.type('.search-input', 'Karthik');
  await new Promise(r => setTimeout(r, 400));
  const rows = await page.$$eval('.data-table tbody tr', r => r.length);
  if (rows !== 1) throw new Error('expected 1 row after search, got ' + rows);
  await page.$eval('.search-input', e => { e.value = ''; e.dispatchEvent(new Event('input', {bubbles:true})); });
  await new Promise(r => setTimeout(r, 400));
});
await step('status filter narrows rows', async () => {
  await page.select('.facets select', 'Paid');
  await new Promise(r => setTimeout(r, 300));
  const rows = await page.$$eval('.data-table tbody tr', r => r.length);
  if (rows !== 1) throw new Error('expected 1 Paid row, got ' + rows);
  await page.select('.facets select', '');
  await new Promise(r => setTimeout(r, 300));
});
await step('column sort works', async () => {
  // the table re-renders on each click, so re-query the header every time
  const clickHeader = () => page.evaluate(() =>
    document.querySelector('.data-table th.sortable').click());
  await clickHeader();
  await new Promise(r => setTimeout(r, 250));
  const asc = await page.$eval('.data-table tbody tr td', e => e.textContent);
  await clickHeader();
  await new Promise(r => setTimeout(r, 250));
  const desc = await page.$eval('.data-table tbody tr td', e => e.textContent);
  if (!/INV-00001/.test(asc)) throw new Error('ascending sort gave: ' + asc);
  if (!/INV-00003/.test(desc)) throw new Error('descending sort gave: ' + desc);
});

console.log('\n— write paths —');
await step('dialog focuses the first field, not the close button', async () => {
  // Regression: the header's ✕ button comes first in DOM order. If the modal
  // focuses it, the next space typed activates it and discards the form.
  await go('tenants', 'Tenants');
  await page.evaluate(() => [...document.querySelectorAll('button')]
    .find(b => /New tenant/i.test(b.textContent)).click());
  await page.waitForSelector('.modal', { timeout: 5000 });
  const focused = await page.evaluate(() => {
    const a = document.activeElement;
    return { id: a?.id, tag: a?.tagName, cls: a?.className };
  });
  if (focused.id !== 'f_full_name') {
    throw new Error('focus landed on ' + JSON.stringify(focused) + ' instead of the first field');
  }
  // typing a space immediately must not close the dialog
  await page.keyboard.type('A B');
  const stillOpen = await page.evaluate(() => document.querySelectorAll('.modal').length);
  if (stillOpen !== 1) throw new Error('dialog closed while typing a space');
  await page.evaluate(() => [...document.querySelectorAll('.modal-foot .btn')]
    .find(b => /Cancel/.test(b.textContent)).click());
  await page.waitForFunction(() => !document.querySelector('.backdrop'), { timeout: 5000 });
});

await step('create a tenant end-to-end', async () => {
  await go('tenants', 'Tenants');
  await page.waitForSelector('.data-table', { timeout: 5000 });
  const before = await page.$$eval('.data-table tbody tr', r => r.length);
  const clicked = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(b => /New tenant/i.test(b.textContent));
    if (!btn) return { ok: false,
      h1: document.querySelector('#main .view h1')?.textContent,
      hash: location.hash,
      buttons: [...document.querySelectorAll('#main button')].map(b => b.textContent.trim()) };
    btn.click();
    return { ok: true };
  });
  if (!clicked.ok) throw new Error('no New-tenant button. ' + JSON.stringify(clicked));
  await page.waitForSelector('.modal', { timeout: 5000 });
  await page.type('#f_full_name', 'Test Person');
  await page.type('#f_phone', '+91 90000 00000');
  // email is deliberately left blank — it is optional
  const saved = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('.modal-foot .btn')];
    const btn = btns.find(b => /Create tenant/i.test(b.textContent));
    if (!btn) return { ok: false, modals: document.querySelectorAll('.modal').length,
                       footButtons: btns.map(b => b.textContent.trim()),
                       nameValue: document.querySelector('#f_full_name')?.value };
    btn.click();
    return { ok: true };
  });
  if (!saved.ok) throw new Error('no Create-tenant button. ' + JSON.stringify(saved));
  await page.waitForFunction(() => !document.querySelector('.backdrop'), { timeout: 5000 });
  await new Promise(r => setTimeout(r, 300));
  const after = await page.$$eval('.data-table tbody tr', r => r.length);
  if (after !== before + 1) throw new Error(`rows went ${before} -> ${after}`);
});

await step('required-field validation blocks an empty save', async () => {
  await page.evaluate(() => [...document.querySelectorAll('button')]
    .find(b => /New tenant/i.test(b.textContent)).click());
  await page.waitForSelector('.modal', { timeout: 5000 });
  await page.evaluate(() => [...document.querySelectorAll('.modal-foot .btn')]
    .find(b => /Create tenant/i.test(b.textContent)).click());
  await new Promise(r => setTimeout(r, 300));
  const err = await page.$eval('.entity-form .form-error', e => ({ hidden: e.hidden, text: e.textContent }));
  if (err.hidden || !/Required/.test(err.text)) throw new Error('validation did not fire');
  if (!await page.$('.modal')) throw new Error('modal closed despite invalid input');
  await page.evaluate(() => [...document.querySelectorAll('.modal-foot .btn')]
    .find(b => /Cancel/.test(b.textContent)).click());
});

await step('record a payment updates the invoice', async () => {
  await go('invoices', 'Invoices');
  await page.waitForSelector('.data-table tbody tr', { timeout: 5000 });
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.data-table tbody tr')];
    const row = rows.find(r => /Partial/.test(r.textContent));
    row.querySelector('.row-actions button[title="Record payment"]').click();
  });
  await page.waitForSelector('.modal', { timeout: 5000 });
  await page.evaluate(() => [...document.querySelectorAll('.modal-foot .btn')]
    .find(b => /Save payment/i.test(b.textContent)).click());
  await page.waitForFunction(() => !document.querySelector('.backdrop'), { timeout: 6000 });
  await new Promise(r => setTimeout(r, 500));
  const txt = await page.$eval('.data-table tbody', e => e.textContent);
  if (/Partial/.test(txt)) throw new Error('invoice still shows Partial after full payment');
});

await step('build an invoice with rent + electricity + water in one go', async () => {
  await go('invoices', 'Invoices');
  const before = await page.$$eval('.data-table tbody tr', r => r.length);
  await page.evaluate(() => [...document.querySelectorAll('button')]
    .find(b => /New invoice/i.test(b.textContent)).click());
  await page.waitForSelector('.line-editor', { timeout: 5000 });

  await page.select('#f_tenant_id', 'TNT-00001');

  const fillRow = async (i, desc, cat, qty, unit) => {
    const rows = await page.$$('.line-row');
    const row = rows[i];
    const d = await row.$('.line-desc'); await d.click({ clickCount: 3 }); await d.type(desc);
    await row.$eval('.line-cat', (e, v) => {
      e.value = v; e.dispatchEvent(new Event('change', { bubbles: true }));
    }, cat);
    const q = await row.$('.line-qty'); await q.click({ clickCount: 3 }); await q.type(String(qty));
    const u = await row.$('.line-unit'); await u.click({ clickCount: 3 }); await u.type(String(unit));
  };

  await fillRow(0, 'Rent · October', 'Rent', 1, 30000);
  await page.evaluate(() => [...document.querySelectorAll('.line-editor button')]
    .find(b => /Add line/i.test(b.textContent)).click());
  await fillRow(1, 'EB bill · 142 units', 'Electricity', 142, 8.5);
  await page.evaluate(() => [...document.querySelectorAll('.line-editor button')]
    .find(b => /Add line/i.test(b.textContent)).click());
  await fillRow(2, 'Water charges', 'Water', 1, 600);

  // the running total must reflect all three lines: 30000 + 1207 + 600
  const totals = await page.evaluate(() => {
    const kv = [...document.querySelectorAll('.line-totals .kv')];
    return { subtotal: kv[0].querySelector('strong').textContent,
             total: kv[2].querySelector('strong').textContent };
  });
  if (!/31,807/.test(totals.subtotal)) throw new Error('subtotal shows ' + totals.subtotal);
  if (!/31,807/.test(totals.total)) throw new Error('total shows ' + totals.total);

  await page.evaluate(() => [...document.querySelectorAll('.modal-foot .btn')]
    .find(b => /Create invoice/i.test(b.textContent)).click());
  await page.waitForFunction(() => !document.querySelector('.backdrop'), { timeout: 6000 });
  await new Promise(r => setTimeout(r, 400));

  const after = await page.$$eval('.data-table tbody tr', r => r.length);
  if (after !== before + 1) throw new Error(`rows went ${before} -> ${after}`);
  const body = await page.$eval('.data-table tbody', e => e.textContent);
  if (!/31,807/.test(body)) throw new Error('the new invoice total is not in the table');
  if (!/Mixed/.test(body)) throw new Error('a multi-category invoice should be typed "Mixed"');
});

await step('removing a line updates the running total', async () => {
  await page.evaluate(() => [...document.querySelectorAll('button')]
    .find(b => /New invoice/i.test(b.textContent)).click());
  await page.waitForSelector('.line-editor', { timeout: 5000 });
  const row = (await page.$$('.line-row'))[0];
  const u = await row.$('.line-unit'); await u.click({ clickCount: 3 }); await u.type('1000');
  await page.evaluate(() => [...document.querySelectorAll('.line-editor button')]
    .find(b => /Add line/i.test(b.textContent)).click());
  const row2 = (await page.$$('.line-row'))[1];
  const u2 = await row2.$('.line-unit'); await u2.click({ clickCount: 3 }); await u2.type('500');
  await new Promise(r => setTimeout(r, 150));
  let sub = await page.$eval('.line-totals .kv strong', e => e.textContent);
  if (!/1,500/.test(sub)) throw new Error('two lines should total 1,500, got ' + sub);

  await page.evaluate(() => document.querySelectorAll('.line-row')[1]
    .querySelector('.icon-btn').click());
  await new Promise(r => setTimeout(r, 150));
  sub = await page.$eval('.line-totals .kv strong', e => e.textContent);
  if (!/1,000/.test(sub)) throw new Error('after removing a line the total should be 1,000, got ' + sub);

  await page.evaluate(() => [...document.querySelectorAll('.modal-foot .btn')]
    .find(b => /Cancel/.test(b.textContent)).click());
  await page.waitForFunction(() => !document.querySelector('.backdrop'), { timeout: 5000 });
});

await step('the last line cannot be removed', async () => {
  await page.evaluate(() => [...document.querySelectorAll('button')]
    .find(b => /New invoice/i.test(b.textContent)).click());
  await page.waitForSelector('.line-editor', { timeout: 5000 });
  await page.evaluate(() => document.querySelector('.line-row .icon-btn').click());
  await new Promise(r => setTimeout(r, 150));
  const rows = await page.$$eval('.line-row', r => r.length);
  if (rows !== 1) throw new Error('the only line was removed');
  const err = await page.$eval('.invoice-form .form-error', e => ({ hidden: e.hidden, text: e.textContent }));
  if (err.hidden) throw new Error('no explanation shown');
  await page.evaluate(() => [...document.querySelectorAll('.modal-foot .btn')]
    .find(b => /Cancel/.test(b.textContent)).click());
  await page.waitForFunction(() => !document.querySelector('.backdrop'), { timeout: 5000 });
});

await step('the printed invoice itemises every charge', async () => {
  await go('invoices', 'Invoices');
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('.data-table tbody tr')]
      .find(r => /INV-00003/.test(r.textContent));
    row.click();
  });
  await page.waitForSelector('.invoice-doc', { timeout: 5000 });
  const txt = await page.$eval('.invoice-doc', e => e.textContent);
  for (const want of ['Rent · September', 'EB bill', 'Water charges', '400 ×']) {
    if (!txt.includes(want)) throw new Error('missing from the printed invoice: ' + want);
  }
  await page.evaluate(() => [...document.querySelectorAll('.modal-foot .btn')]
    .find(b => /Close/.test(b.textContent)).click());
  await page.waitForFunction(() => !document.querySelector('.backdrop'), { timeout: 5000 });
});

await step('invoice document opens and prints', async () => {
  await page.evaluate(() => document.querySelector('.data-table tbody tr').click());
  await page.waitForSelector('.invoice-doc', { timeout: 5000 });
  const txt = await page.$eval('.invoice-doc', e => e.textContent);
  if (!/Balance due/.test(txt)) throw new Error('invoice body incomplete');
  await page.evaluate(() => [...document.querySelectorAll('.modal-foot .btn')]
    .find(b => /Close/.test(b.textContent)).click());
});

console.log('\n— detail views —');
await step('property detail shows units and P&L', async () => {
  await page.evaluate(() => { location.hash = '#/properties/PRP-00001'; });
  await page.waitForSelector('.unit-grid', { timeout: 5000 });
  const txt = await page.$eval('.view', e => e.textContent);
  if (!/A-101/.test(txt) || !/A-102/.test(txt)) throw new Error('units missing');
  if (!/Anita Rao/.test(txt)) throw new Error('occupying tenant missing');
});
await step('tenant detail shows ledger', async () => {
  await page.evaluate(() => { location.hash = '#/tenants/TNT-00001'; });
  await page.waitForSelector('.stat-row', { timeout: 5000 });
  const txt = await page.$eval('.view', e => e.textContent);
  if (!/Outstanding/.test(txt) || !/INV-0000/.test(txt)) throw new Error('tenant ledger missing');
});

console.log('\n— reports —');
await step('the three expense figures on the reports page agree', async () => {
  await go('reports', 'Reports');
  await page.waitForSelector('.total-row', { timeout: 5000 });
  await new Promise(r => setTimeout(r, 250));
  // Regression: the category chart counted only the Expenses tab while the
  // headline and the P&L column also included maintenance costs, so one screen
  // reported two different totals for the same word.
  const out = await page.evaluate(() => {
    const num = s => Number(String(s).replace(/[^\d.-]/g, ''));
    const headline = [...document.querySelectorAll('.stat')]
      .find(s => /Operating expenses/.test(s.textContent))?.querySelector('.stat-value')?.textContent;
    const tableTotal = [...document.querySelectorAll('.total-row td')][4]?.textContent;
    const panel = [...document.querySelectorAll('.panel')]
      .find(x => /by category/.test(x.textContent));
    const chartSum = [...panel.querySelectorAll('.ranked-value')]
      .reduce((s, e) => s + num(e.textContent), 0);
    return { headline: num(headline), tableTotal: num(tableTotal), chartSum };
  });
  if (out.headline !== out.tableTotal || out.tableTotal !== out.chartSum) {
    throw new Error(`headline ${out.headline}, table ${out.tableTotal}, chart ${out.chartSum}`);
  }
  if (!out.headline) throw new Error('no expenses in the fixture to compare');
});

await step('P&L table totals correctly', async () => {
  await page.evaluate(() => { location.hash = '#/reports'; });
  await page.waitForSelector('.total-row', { timeout: 5000 });
  const cells = await page.$$eval('.total-row td', n => n.map(c => c.textContent));
  console.log('    totals row: ' + cells.join(' | '));
  if (cells.length !== 8) throw new Error('unexpected total row shape');
});

console.log('\n— money and leasing workflows —');

const clickText = (selector, re) => page.evaluate((sel, src) => {
  const btn = [...document.querySelectorAll(sel)].find(b => new RegExp(src, 'i').test(b.textContent));
  if (!btn) return false;
  btn.click();
  return true;
}, selector, re.source);
const closeModal = async () => {
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.backdrop'), { timeout: 5000 });
};
const rowAction = (rowText, title) => page.evaluate((txt, t) => {
  const row = [...document.querySelectorAll('.data-table tbody tr')].find(r => r.textContent.includes(txt));
  const btn = row && row.querySelector(`.row-actions button[title="${t}"]`);
  if (!btn) return false;
  btn.click();
  return true;
}, rowText, title);

await step('the invoice editor prices GST per line', async () => {
  await go('invoices', 'Invoices');
  await clickText('button', /New invoice/);
  await page.waitForSelector('.line-editor', { timeout: 5000 });
  const row = (await page.$$('.line-row'))[0];
  const u = await row.$('.line-unit'); await u.click({ clickCount: 3 }); await u.type('10000');
  const g = await row.$('.line-gst'); await g.click({ clickCount: 3 }); await g.type('18');
  await new Promise(r => setTimeout(r, 150));
  const totals = await page.$$eval('.line-totals .kv strong', n => n.map(x => x.textContent));
  if (!/1,800/.test(totals[1]) || !/11,800/.test(totals[2])) throw new Error('totals: ' + totals.join(' | '));
  if (!await clickText('.modal-foot .btn', /Save as draft/)) throw new Error('no Save as draft button');
  await closeModal();
});

await step('an invoice can be shared on WhatsApp and paid by UPI', async () => {
  await page.evaluate(async () => {
    const { store } = await import('/assets/js/store.js');
    store.settings.upi_id = 'vilifestyle@okhdfc';
  });
  await page.evaluate(() => [...document.querySelectorAll('.data-table tbody tr')]
    .find(r => /INV-00002/.test(r.textContent)).click());
  await page.waitForSelector('.invoice-doc', { timeout: 5000 });
  const links = await page.$$eval('.modal a', a => a.map(x => x.getAttribute('href')));
  if (!links.some(h => /^https:\/\/wa\.me\/919880011111\?text=/.test(h))) throw new Error('no WhatsApp link: ' + links.join(' '));
  if (!links.some(h => /^upi:\/\/pay\?pa=vilifestyle%40okhdfc.*am=28500\.00/.test(h))) throw new Error('no UPI link: ' + links.join(' '));
  await closeModal();
});

await step('an issued invoice is voided with a reason, not deleted', async () => {
  await go('invoices', 'Invoices');
  if (await rowAction('INV-00002', 'Delete')) throw new Error('an issued invoice offers Delete');
  if (!await rowAction('INV-00002', 'Void')) throw new Error('no Void action on INV-00002');
  await page.waitForSelector('.modal textarea', { timeout: 5000 });
  await page.type('.modal textarea', 'Raised in error');
  await clickText('.modal-foot .btn', /Void invoice/);
  await page.waitForFunction(() => !document.querySelector('.backdrop'), { timeout: 8000 });
  await new Promise(r => setTimeout(r, 300));
  const row = await page.evaluate(() => [...document.querySelectorAll('.data-table tbody tr')]
    .find(r => /INV-00002/.test(r.textContent))?.textContent);
  if (!/Void/.test(row)) throw new Error('row reads: ' + row);
});

await step('meter readings bill the occupied units in one go', async () => {
  await go('meters', 'Meter readings');
  await page.waitForSelector('.meter-table', { timeout: 5000 });
  const prev = await page.$eval('tr[data-unit="UNT-00001"] .meter-prev', e => e.value);
  if (prev !== '10382') throw new Error('previous reading not carried over: ' + prev);
  const rate = await page.$('.panel .form-grid .meter-rate');
  await rate.type('8.5');
  await page.type('tr[data-unit="UNT-00001"] .meter-cur', '10500');
  await new Promise(r => setTimeout(r, 150));
  const amount = await page.$eval('tr[data-unit="UNT-00001"] .meter-amount', e => e.textContent);
  if (!/1,003/.test(amount)) throw new Error('amount shows ' + amount);
  await clickText('button', /Save & bill/);
  // billed once the new reading is in the store and the screen has redrawn
  await page.waitForFunction(async () => {
    const { store } = await import('/assets/js/store.js');
    return store.meterReadings.length >= 2 && !document.querySelector('.meter-cur')?.value;
  }, { timeout: 10000, polling: 200 });
  const invoices = await page.evaluate(async () => {
    const { store } = await import('/assets/js/store.js');
    return store.invoices.filter(i => i.type === 'Electricity' && i.tenant_id === 'TNT-00001').map(i => i.total);
  });
  if (!invoices.includes(1003)) throw new Error('no electricity invoice: ' + JSON.stringify(invoices));
});

await step('an expiring lease is renewed from the dashboard, deposit carried over', async () => {
  // the dashboard has no page heading for go() to wait on
  await page.evaluate(() => { location.hash = '#/dashboard'; });
  await page.waitForFunction(() => [...document.querySelectorAll('.panel')]
    .find(p => /Leases expiring/.test(p.textContent))?.querySelector('.list-row'), { timeout: 5000 });
  await page.evaluate(() => [...document.querySelectorAll('.panel')].find(p => /Leases expiring/.test(p.textContent))
    .querySelector('.list-row').click());
  await page.waitForSelector('.modal', { timeout: 5000 });
  const title = await page.$eval('.modal h2', e => e.textContent);
  if (!/Renew lease · LSE-00002/.test(title)) throw new Error('opened ' + title);
  await clickText('.modal-foot .btn', /Renew lease/);
  await page.waitForFunction(() => !document.querySelector('.backdrop'), { timeout: 8000 });
  const state = await page.evaluate(async () => {
    const { store } = await import('/assets/js/store.js');
    const n = store.leases.find(l => l.renewed_from === 'LSE-00002');
    return { n: n && { status: n.deposit_status, amount: n.deposit_amount }, old: store.byId('leases', 'LSE-00002').deposit_status,
             held: store.stats.deposits_held };
  });
  if (!state.n || state.n.status !== 'Held' || Number(state.n.amount) !== 450000) throw new Error(JSON.stringify(state));
  if (state.old !== 'Transferred') throw new Error('old lease deposit ' + state.old);
  if (state.held !== 600000) throw new Error('deposits held changed to ' + state.held);
});

await step('a deposit is settled at move-out: deductions, refund, lease ended', async () => {
  await go('leases', 'Leases');
  if (!await rowAction('LSE-00001', 'Settle deposit')) throw new Error('no Settle deposit action on LSE-00001');
  await page.waitForSelector('.deduction-row', { timeout: 5000 });
  await page.type('.deduction-row .ded-desc', 'Repainting');
  await page.type('.deduction-row .ded-amount', '5000');
  await new Promise(r => setTimeout(r, 150));
  const summary = await page.$eval('.settle-summary', e => e.textContent);
  if (!/Refund to tenant/.test(summary)) throw new Error('no summary: ' + summary);
  await clickText('.modal-foot .btn', /Settle deposit/);
  await page.waitForFunction(() => !document.querySelector('.backdrop'), { timeout: 8000 });
  const after = await page.evaluate(async () => {
    const { store } = await import('/assets/js/store.js');
    const l = store.byId('leases', 'LSE-00001');
    return { status: l.status, deposit: l.deposit_status, held: store.depositLedger(l).held,
             refund: store.expenses.filter(e => e.category === 'Deposit Refund' && e.reference === 'LSE-00001').map(e => e.amount) };
  });
  if (after.status !== 'Terminated' || after.held !== 0 || !after.refund.length) throw new Error(JSON.stringify(after));
});

await step('a tenant statement and a payment receipt open and print', async () => {
  await page.evaluate(() => { location.hash = '#/tenants/TNT-00001'; });
  await page.waitForSelector('.stat-row', { timeout: 5000 });
  await clickText('.head-actions .btn', /Statement/);
  await page.waitForSelector('.statement-table', { timeout: 5000 });
  const txt = await page.$eval('.statement-table', e => e.textContent);
  if (!/Opening balance/.test(txt) || !/Closing balance/.test(txt)) throw new Error('statement incomplete');
  await closeModal();
  await go('payments', 'Payments');
  await page.evaluate(() => document.querySelector('.data-table tbody tr').click());
  await page.waitForSelector('.receipt-body', { timeout: 5000 });
  const kind = await page.$eval('.doc-kind', e => e.textContent);
  if (!/receipt/i.test(kind)) throw new Error('opened ' + kind);
  await closeModal();
});

await step('a save over someone else\'s change is refused, not silently lost', async () => {
  await go('tenants', 'Tenants');
  if (!await rowAction('Karthik', 'Edit')) throw new Error('no Edit action');
  await page.waitForSelector('#f_occupation', { timeout: 5000 });
  // someone else saves the same tenant while the form is open
  await page.evaluate(async () => {
    const res = await fetch('/api', { method: 'POST', body: JSON.stringify({
      action: 'update', token: localStorage.getItem('vipm.token'),
      payload: { table: 'Tenants', id: 'TNT-00002', data: { occupation: 'Architect' } } }) });
    const body = await res.json();
    if (!body.ok) throw new Error(body.error);
  });
  const occ = await page.$('#f_occupation');
  await occ.click({ clickCount: 3 }); await occ.type('Chef');
  await clickText('.modal-foot .btn', /Save changes/);
  await page.waitForFunction(() => {
    const e = document.querySelector('.entity-form .form-error');
    return e && !e.hidden && /changed by someone else/.test(e.textContent);
  }, { timeout: 8000 });
  await closeModal();
});

console.log('\n— theme & responsive —');
await step('brand palette meets WCAG AA contrast in both themes', async () => {
  const readings = await page.evaluate(() => {
    const lin = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    const lum = rgb => {
      const [r, g, b] = rgb.match(/\d+/g).map(Number);
      return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    };
    const ratio = (a, b) => {
      const la = lum(a), lb = lum(b), hi = Math.max(la, lb), lo = Math.min(la, lb);
      return (hi + 0.05) / (lo + 0.05);
    };
    const probe = (bgVar, fgVar) => {
      const cs = getComputedStyle(document.documentElement);
      const toRgb = v => {
        const d = document.createElement('div');
        d.style.color = cs.getPropertyValue(v).trim();
        document.body.append(d);
        const c = getComputedStyle(d).color;
        d.remove();
        return c;
      };
      return ratio(toRgb(bgVar), toRgb(fgVar));
    };
    const measure = () => ({
      brandOnSurface: probe('--surface', '--brand'),
      brandOnWeak: probe('--brand-weak', '--brand'),
      textOnSurface: probe('--surface', '--text'),
      mutedOnSurface: probe('--surface', '--muted')
    });
    const root = document.documentElement;
    const before = root.dataset.theme;
    root.dataset.theme = 'light';  const light = measure();
    root.dataset.theme = 'dark';   const dark = measure();
    root.dataset.theme = before;
    return { light, dark };
  });

  // 4.5:1 is WCAG AA for body text; 3:1 is the floor for large text / UI.
  const floors = { brandOnSurface: 4.5, brandOnWeak: 4.5, textOnSurface: 4.5, mutedOnSurface: 3 };
  for (const theme of ['light', 'dark']) {
    for (const [key, min] of Object.entries(floors)) {
      const got = readings[theme][key];
      if (got < min) throw new Error(`${theme}.${key} is ${got.toFixed(2)}:1, needs ${min}:1`);
    }
  }
  console.log('    light brand/surface ' + readings.light.brandOnSurface.toFixed(1) +
              ':1 · dark ' + readings.dark.brandOnSurface.toFixed(1) + ':1');
});

await step('dark theme applies', async () => {
  await page.evaluate(() => [...document.querySelectorAll('.topbar .icon-btn')]
    .find(b => /theme/i.test(b.title)).click());
  await new Promise(r => setTimeout(r, 300));
  const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  if (theme !== 'dark') throw new Error('theme is ' + theme);
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  if (bg === 'rgb(246, 247, 251)') throw new Error('dark tokens did not apply');
});
await step('mobile layout hides the sidebar', async () => {
  await page.setViewport({ width: 390, height: 780 });
  await new Promise(r => setTimeout(r, 300));
  const visible = await page.evaluate(() => {
    const s = document.querySelector('.sidebar');
    return s.getBoundingClientRect().left >= 0;
  });
  if (visible) throw new Error('sidebar not collapsed on mobile');
  const burger = await page.evaluate(() => !!document.querySelector('.only-mobile'));
  if (!burger) throw new Error('no menu button on mobile');
  await page.setViewport({ width: 1400, height: 950 });
});

await browser.close();
server.kill();

console.log('\n' + '─'.repeat(60));
if (errors.length) {
  console.log(`${errors.length} PROBLEM(S):`);
  errors.forEach(e => console.log('  • ' + e));
  process.exit(1);
} else {
  console.log('ALL CHECKS PASSED');
}
