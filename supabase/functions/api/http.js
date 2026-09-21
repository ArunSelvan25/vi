/**
 * The HTTP surface of the backend.
 *
 *   OPTIONS            CORS preflight
 *   GET                health check only — it takes no action, token or callback
 *   POST {action,…}    the app's API; the session token travels in the body
 *   POST /cron         the daily jobs, for pg_cron; needs the CRON_SECRET header
 *
 * Errors are answered as {ok:false, error} with status 200, exactly as the Web
 * App answered them, so the SPA's error handling is unchanged.
 */
import { constantTimeEquals, nowIso } from './backend.js';

/** Far above any real payload (an invoice with a year of line items is well under 100 kB). */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

const JOBS = ['dailyMaintenanceJob', 'dailyReminderJob'];

const CORS = {
  // Sessions are bearer tokens in the request body, never cookies, so allowing
  // any origin exposes nothing a direct request could not already reach.
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, authorization, apikey, x-client-info',
  'Access-Control-Max-Age': '86400'
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

/**
 * @param backend   what createBackend returned
 * @param options.cronSecret  shared secret the scheduled jobs must present; empty disables /cron
 */
export function makeHttpHandler(backend, { cronSecret = '' } = {}) {
  const health = () => json({ ok: true, data: { service: 'vi-property-manager', time: nowIso(backend.env.tz) } });

  return async function serve(req) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (req.method === 'GET' || req.method === 'HEAD') return health();
    if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);

    const declared = Number(req.headers.get('content-length') || 0);
    if (declared > MAX_BODY_BYTES) return json({ ok: false, error: 'Request too large' }, 413);
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) return json({ ok: false, error: 'Request too large' }, 413);

    let body = {};
    try { body = JSON.parse(text || '{}') || {}; } catch (e) { body = {}; }
    if (typeof body !== 'object' || Array.isArray(body)) body = {};

    if (new URL(req.url).pathname.replace(/\/+$/, '').endsWith('/cron')) {
      const presented = req.headers.get('x-cron-secret') || '';
      if (!cronSecret || !constantTimeEquals(presented, cronSecret)) {
        return json({ ok: false, error: 'Forbidden' }, 403);
      }
      if (JOBS.indexOf(body.job) < 0) return json({ ok: false, error: 'Unknown job' }, 400);
      try {
        return json({ ok: true, data: await backend[body.job]() });
      } catch (err) {
        console.error('scheduled job failed', body.job, err);
        return json({ ok: false, error: String(err && err.message || err) }, 500);
      }
    }

    const token = typeof body.token === 'string' ? body.token : '';
    const payload = body.payload && typeof body.payload === 'object' ? body.payload : {};
    return json(await backend.handle(typeof body.action === 'string' ? body.action : '', payload, token));
  };
}
