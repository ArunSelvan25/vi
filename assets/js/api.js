import { config } from './config.js';

/**
 * Calls the Apps Script Web App.
 *
 * The body is sent as text/plain on purpose: that keeps the request a CORS
 * "simple request", so the browser never sends a preflight OPTIONS — which
 * Apps Script cannot answer. The payload is still JSON.
 */
export async function api(action, payload = {}, { signal } = {}) {
  const url = config.apiUrl;
  if (!url) throw new ApiError('No API URL configured', 'NO_API_URL');

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, payload, token: config.token }),
      redirect: 'follow',
      signal
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError(
      'Could not reach the API. Check the deployment URL and that access is set to "Anyone".',
      'NETWORK'
    );
  }

  if (!res.ok) throw new ApiError(`API returned HTTP ${res.status}`, 'HTTP_' + res.status);

  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    // Apps Script serves an HTML error page when the deployment is misconfigured.
    throw new ApiError(
      'The API returned HTML instead of JSON — the Web App is probably not deployed with access "Anyone".',
      'BAD_RESPONSE'
    );
  }

  if (!body.ok) {
    if (body.error === 'AUTH_REQUIRED') {
      config.clearSession();
      throw new ApiError('Your session expired. Please sign in again.', 'AUTH_REQUIRED');
    }
    // someone else saved the same record first — the form says so and stays open
    if (/^CONFLICT: /.test(body.error || '')) {
      throw new ApiError(body.error.replace(/^CONFLICT: /, ''), 'CONFLICT');
    }
    throw new ApiError(body.error || 'Unknown API error', 'API');
  }
  return body.data;
}

export class ApiError extends Error {
  constructor(message, code) { super(message); this.name = 'ApiError'; this.code = code; }
}

/** Probe a candidate URL before we save it during setup. */
export async function ping(url) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action: 'ping', payload: {} }),
    redirect: 'follow'
  });
  const body = JSON.parse(await res.text());
  if (!body.ok) throw new ApiError(body.error || 'Ping failed', 'PING');
  return body.data;
}
