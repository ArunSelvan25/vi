import { el, icon, toast, clear, skeletonDashboard } from './ui.js';
import { config } from './config.js';
import { store } from './store.js';
import { start, navigate, parseHash } from './router.js';
import { crudView } from './views/crud.js';
import { dashboardView } from './views/dashboard.js';
import { billingView } from './views/billing.js';
import { leasesView } from './views/leases.js';
import { propertyDetail, unitDetail, tenantDetail } from './views/details.js';
import { leaseDetail, invoiceDetail, paymentDetail, recordDetail } from './views/records.js';
import { installHovercards } from './components/hovercard.js';
import { reportsView } from './views/reports.js';
import { settingsView } from './views/settings.js';
import { setupView, loginView } from './views/onboarding.js';
import { registerServiceWorker } from './pwa.js';

/**
 * Grouped so twelve destinations read as four short lists rather than one long
 * one. Group titles double as a mental model of the domain.
 */
const NAV = [
  { group: null, items: [
    { path: 'dashboard', label: 'Dashboard', icon: 'dashboard' }
  ]},
  { group: 'Portfolio', items: [
    { path: 'properties', label: 'Properties', icon: 'building' },
    { path: 'units', label: 'Units', icon: 'grid' }
  ]},
  { group: 'Leasing', items: [
    { path: 'tenants', label: 'Tenants', icon: 'users' },
    { path: 'leases', label: 'Leases', icon: 'file' }
  ]},
  { group: 'Money', items: [
    // invoices and the payments against them live together; their record
    // pages keep their own addresses, so they light this item up too
    { path: 'billing', label: 'Billing', icon: 'receipt', also: ['invoices', 'payments'] },
    { path: 'expenses', label: 'Expenses', icon: 'wallet' },
    { path: 'reports', label: 'Reports', icon: 'chart' }
  ]},
  { group: 'Operations', items: [
    { path: 'maintenance', label: 'Maintenance', icon: 'wrench' },
    { path: 'documents', label: 'Documents', icon: 'folder' },
    { path: 'settings', label: 'Settings', icon: 'settings' }
  ]}
];

const PAGE_TITLES = {
  dashboard: 'Dashboard', properties: 'Properties', units: 'Units', tenants: 'Tenants',
  leases: 'Leases', billing: 'Billing', invoices: 'Invoices', payments: 'Payments', maintenance: 'Maintenance',
  expenses: 'Expenses', documents: 'Documents', reports: 'Reports', settings: 'Settings'
};

const root = document.getElementById('app');

// ── shell ───────────────────────────────────────────────────────────────────

function applyTheme() {
  document.documentElement.dataset.theme = config.theme;
}

function shell() {
  const user = config.user || {};
  const sidebar = el('aside', { class: 'sidebar', id: 'sidebar' }, [
    el('div', { class: 'brand' }, [
      icon('building', 22),
      el('span', { text: store.settings.org_name || 'Property Manager' })
    ]),
    el('nav', { class: 'nav', 'aria-label': 'Main' }, NAV.map(group =>
      el('div', { class: 'nav-group' }, [
        group.group ? el('div', { class: 'nav-group-label', text: group.group }) : null,
        ...group.items.map(item =>
          el('a', {
            class: 'nav-item', href: '#/' + item.path,
            dataset: { path: item.path, also: (item.also || []).join(' ') },
            onClick: () => document.body.classList.remove('nav-open')
          }, [icon(item.icon, 17), el('span', { text: item.label })])
        )
      ])
    )),
    el('div', { class: 'sidebar-foot' }, [
      el('div', { class: 'user-chip' }, [
        el('div', { class: 'avatar', text: (user.name || user.phone || '?').slice(0, 1).toUpperCase() }),
        el('div', {}, [
          el('strong', { text: user.name || user.phone }),
          el('small', { class: 'muted', text: user.role })
        ])
      ]),
      el('button', {
        class: 'icon-btn', title: 'Sign out',
        onClick: () => { config.clearSession(); location.reload(); }
      }, [icon('logout', 18)])
    ])
  ]);

  const topbar = el('header', { class: 'topbar' }, [
    el('button', {
      class: 'icon-btn only-mobile', title: 'Menu',
      onClick: () => document.body.classList.toggle('nav-open')
    }, [icon('menu', 20)]),
    el('span', { class: 'topbar-title', id: 'page-title', 'aria-hidden': 'true' }),
    el('div', { class: 'topbar-spacer' }),
    el('button', {
      class: 'icon-btn', title: 'Refresh data',
      onClick: async (e) => {
        const btn = e.currentTarget;
        btn.classList.add('spinning');
        try { await store.refresh(); render(); toast('Data refreshed', 'ok'); }
        catch (err) { toast(err.message, 'danger'); }
        finally { btn.classList.remove('spinning'); }
      }
    }, [icon('refresh', 18)]),
    el('button', {
      class: 'icon-btn', title: 'Toggle theme',
      onClick: () => {
        config.theme = config.theme === 'dark' ? 'light' : 'dark';
        applyTheme();
        render();
      }
    }, [icon(config.theme === 'dark' ? 'sun' : 'moon', 18)])
  ]);

  const main = el('main', { class: 'main', id: 'main' });
  return el('div', { class: 'layout' }, [
    sidebar,
    el('div', { class: 'content' }, [topbar, main]),
    el('div', { class: 'nav-scrim', onClick: () => document.body.classList.remove('nav-open') })
  ]);
}

let layout = null;

function render() {
  const ctx = parseHash();
  if (!layout || !layout.isConnected) {
    clear(root);
    layout = shell();
    root.append(layout);
  }
  for (const a of layout.querySelectorAll('.nav-item')) {
    const active = a.dataset.path === ctx.path || (a.dataset.also || '').split(' ').includes(ctx.path);
    a.classList.toggle('active', active);
    if (active) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  const titleEl = layout.querySelector('#page-title');
  if (titleEl) titleEl.textContent = PAGE_TITLES[ctx.path] || '';
  const main = layout.querySelector('#main');
  clear(main);
  const handler = routeHandler(ctx.path);
  try {
    main.append(handler ? handler(ctx) : notFoundView(ctx));
  } catch (err) {
    console.error(err);
    main.append(el('div', { class: 'view' }, [
      el('h1', { text: 'Something went wrong' }),
      el('pre', { class: 'error-box', text: err.message })
    ]));
  }
  main.scrollTop = 0;
  // a record's page is titled by the record, not by the list it belongs to
  const recordTitle = ctx.id ? main.querySelector('.detail-head h1')?.textContent : '';
  if (titleEl && recordTitle) titleEl.textContent = recordTitle;
  watchHeading(main, layout.querySelector('#page-title'));
  document.title = (recordTitle || PAGE_TITLES[ctx.path] || 'Not found') + ' · ' +
    (store.settings.org_name || 'Property Manager');
}

let headingObserver = null;

/**
 * Reveal the sticky topbar title only once the page's own <h1> has scrolled
 * away, so the page name is never rendered twice on screen at the same time.
 */
function watchHeading(main, titleEl) {
  headingObserver?.disconnect();
  if (!titleEl) return;
  const heading = main.querySelector('.view-head h1, .view h1');
  if (!heading || !('IntersectionObserver' in window)) {
    titleEl.classList.add('visible');
    return;
  }
  titleEl.classList.remove('visible');
  headingObserver = new IntersectionObserver(
    ([entry]) => titleEl.classList.toggle('visible', !entry.isIntersecting),
    { rootMargin: `-${56}px 0px 0px 0px`, threshold: 0 }
  );
  headingObserver.observe(heading);
}

/**
 * A list, or with an id one record's own page. Every list row opens the
 * record's page, and every page links onward to the records around it.
 */
/**
 * A list that has moved: send the address on to where it lives now, replacing
 * the old one in history so Back does not bounce straight here again.
 */
function moved(to) {
  navigate(to, { replace: true });
  return el('div', { class: 'view' });
}

function listOrDetail(list, detail) {
  return (ctx) => (ctx.id ? detail(ctx.id, ctx) : list(ctx));
}

function routeHandler(path) {
  const open = (entity) => (row) => navigate(entity + '/' + encodeURIComponent(row.id));
  const handlers = {
    dashboard: dashboardView,
    properties: listOrDetail(() => crudView('properties', { onRowClick: open('properties') }), propertyDetail),
    units: listOrDetail(() => crudView('units', { filterKeys: ['status', 'furnishing'], onRowClick: open('units') }),
                        unitDetail),
    tenants: listOrDetail(() => crudView('tenants', { onRowClick: open('tenants') }), tenantDetail),
    leases: listOrDetail(leasesView, leaseDetail),
    billing: billingView,
    // the old list addresses still work: they open the matching Billing tab
    invoices: listOrDetail(() => moved('billing'), invoiceDetail),
    payments: listOrDetail(() => moved('billing?tab=payments'), paymentDetail),
    maintenance: listOrDetail(() => crudView('maintenance', { filterKeys: ['status', 'priority', 'category'],
      onRowClick: open('maintenance') }), (id) => recordDetail('maintenance', id)),
    expenses: listOrDetail(() => crudView('expenses', { filterKeys: ['category'], onRowClick: open('expenses') }),
                           (id) => recordDetail('expenses', id)),
    documents: listOrDetail(() => crudView('documents', { filterKeys: ['category', 'entity_type'],
      onRowClick: open('documents') }), (id) => recordDetail('documents', id)),
    reports: reportsView,
    settings: settingsView
  };
  return handlers[path] || null;
}

function notFoundView() {
  return el('div', { class: 'view' }, [
    el('h1', { text: 'Page not found' }),
    el('button', { class: 'btn btn-primary', onClick: () => navigate('dashboard') }, ['Go to dashboard'])
  ]);
}

// ── boot ────────────────────────────────────────────────────────────────────

function showScreen(node) { clear(root); layout = null; root.append(node); }

/**
 * @param snapshot all the data, when sign-in already returned it. Only ever
 *   the one from this sign-in: a store left over from an earlier session is
 *   never reused, because the next account may be allowed to see less.
 */
async function boot(snapshot) {
  applyTheme();

  if (!config.apiUrl) {
    showScreen(setupView(() => boot()));
    return;
  }
  if (!config.token) {
    showScreen(loginView((snap) => boot(snap)));
    return;
  }

  // Show the app chrome with skeleton content rather than a bare spinner, so
  // the layout does not jump once the data lands.
  clear(root);
  layout = shell();
  root.append(layout);
  const mainEl = layout.querySelector('#main');
  mainEl.append(skeletonDashboard());

  try {
    if (snapshot && Array.isArray(snapshot.properties)) store.apply(snapshot);
    else await store.load();
  } catch (err) {
    if (err.code === 'AUTH_REQUIRED') { showScreen(loginView((snap) => boot(snap))); return; }
    showScreen(el('div', { class: 'auth-screen' }, [
      el('div', { class: 'auth-card' }, [
        el('h2', { text: 'Could not load data' }),
        el('p', { class: 'form-error', text: err.message }),
        el('button', { class: 'btn btn-primary btn-block', onClick: () => boot() }, ['Try again']),
        el('button', { class: 'link-btn', onClick: () => { config.apiUrl = null; config.clearSession(); location.reload(); } },
          ['Connect a different database'])
      ])
    ]));
    return;
  }

  if (!location.hash) navigate('dashboard', { replace: true });
  layout = null;
  start(() => render());
}

registerServiceWorker();
installHovercards();
boot();
