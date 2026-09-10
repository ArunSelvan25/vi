/** Hash router — GitHub Pages serves this without any redirect rules. */
const routes = new Map();
let notFound = null;
let current = null;

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
  window.addEventListener('hashchange', run);
  run();
}

export function currentRoute() { return current; }
