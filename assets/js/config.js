/**
 * Runtime configuration.
 *
 * By default the API URL is not baked into the build: each person pastes their
 * own API URL (the Supabase function) on first run and it is kept in
 * localStorage, so one published site can serve any database.
 *
 * localStorage is scoped per origin, so a URL entered while developing on
 * localhost does NOT carry over to the deployed GitHub Pages site.
 *
 * If this deployment only ever talks to one database, put its API URL here and
 * the setup wizard is skipped for everyone. It is not a secret — every action
 * except ping/login/setup still requires a valid session token, and roles are
 * enforced server-side — but anyone who can read the page can see it, so only
 * do this for a private repo or a portfolio you are happy to have probed.
 */
const DEFAULT_API_URL = '';

const APPS_SCRIPT = /^https:\/\/script\.google\.com\//;

const KEYS = {
  api: 'vipm.apiUrl',
  token: 'vipm.token',
  user: 'vipm.user',
  theme: 'vipm.theme'
};

export const config = {
  get apiUrl() {
    const stored = localStorage.getItem(KEYS.api);
    // After the move to Supabase, a browser that still remembers the retired
    // Apps Script deployment follows the published default instead — otherwise
    // every device set up before the move would keep talking to the old sheet.
    if (stored && DEFAULT_API_URL && APPS_SCRIPT.test(stored) && !APPS_SCRIPT.test(DEFAULT_API_URL)) {
      return DEFAULT_API_URL;
    }
    // an explicitly stored '' means "disconnected", and beats the baked-in default
    return stored !== null ? stored : DEFAULT_API_URL;
  },
  set apiUrl(v) { localStorage.setItem(KEYS.api, v ? v.trim() : ''); },

  get token() { return localStorage.getItem(KEYS.token) || ''; },
  set token(v) { v ? localStorage.setItem(KEYS.token, v) : localStorage.removeItem(KEYS.token); },

  get user() { try { return JSON.parse(localStorage.getItem(KEYS.user) || 'null'); } catch { return null; } },
  set user(v) { v ? localStorage.setItem(KEYS.user, JSON.stringify(v)) : localStorage.removeItem(KEYS.user); },

  get theme() { return localStorage.getItem(KEYS.theme) || 'light'; },
  set theme(v) { localStorage.setItem(KEYS.theme, v); },

  clearSession() { this.token = null; this.user = null; }
};
