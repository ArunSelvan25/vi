/** Hash router — GitHub Pages serves this without any redirect rules. */
const routes = new Map();
let notFound = null;
let current = null;
let runner = null;

export function route(path, handler) { routes.set(path, handler); }
export function setNotFound(handler) { notFound = handler; }

export function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [pathPart, queryPart] = raw.split('?');
  const segments = pathPart.split('/').filter(Boolean);
  const query = Object.fromEntries(new URLSearchParams(queryPart || ''));
  return { path: segments[0] || 'dashboard', id: segments[1] || null, segments, query };
}

export function navigate(to, { replace = false } = {}) {
  const url = '#/' + String(to).replace(/^#?\/?/, '');
  if (replace) location.replace(url); else location.hash = url;
}

export function start(render) {
  const run = () => {
    const ctx = parseHash();
    current = ctx;
    const handler = routes.get(ctx.path) || notFound;
    render(ctx, handler);
  };
  // boot() runs again after a re-sign-in; one listener, not one per boot
  if (runner) window.removeEventListener('hashchange', runner);
  window.addEventListener('hashchange', run);
  runner = run;
  run();
}

/**
 * Draw the current screen again from the store, in place.
 *
 * Screens used to call location.reload() after a save, which threw away the
 * page and fetched the whole workbook a second time — after the save had
 * already brought the store up to date.
 */
export function refreshView() {
  if (runner) runner();
}

export function currentRoute() { return current; }
