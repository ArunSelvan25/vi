import { toast } from './ui.js';

/**
 * Installs the service worker and handles updates.
 *
 * Nothing here is ever fatal. A browser with no service worker support, a page
 * opened straight off the file system, or a refused registration all leave the
 * app working exactly as it did before — just not installable.
 */
export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // file:// has no origin to scope a worker to, and would only throw
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return;

  window.addEventListener('load', async () => {
    try {
      // Resolved against this module, so it finds the worker at the site root
      // whether the app is served from a domain root or a project subpath.
      const reg = await navigator.serviceWorker.register(new URL('../../sw.js', import.meta.url));

      if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);

      reg.addEventListener('updatefound', () => {
        const incoming = reg.installing;
        if (!incoming) return;
        incoming.addEventListener('statechange', () => {
          // "installed" while something is already in control means this is an
          // update queued behind the running version, not a first install.
          if (incoming.state === 'installed' && navigator.serviceWorker.controller) {
            offerUpdate(incoming);
          }
        });
      });
    } catch (err) {
      // An installable app is a bonus, not a requirement — say so quietly and
      // carry on rather than putting an error in front of the user.
      console.info('Service worker not registered:', err && err.message);
    }
  });
}

let reloading = false;

/**
 * Let the user choose when to take an update.
 *
 * Swapping the code out mid-session would discard whatever is half-typed into
 * a form, so the new worker waits until they say go.
 */
function offerUpdate(worker) {
  toast('A new version is ready.', 'info', 20000, {
    label: 'Update now',
    onClick: () => {
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloading) return;      // Chrome can fire this more than once
        reloading = true;
        location.reload();
      });
      worker.postMessage({ type: 'SKIP_WAITING' });
    }
  });
}
