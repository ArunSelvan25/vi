/**
 * Writes the API URL (the Supabase function, or the Apps Script Web App until
 * it is retired) into assets/js/config.js at deploy time,
 * so every device lands straight on the login screen instead of the setup
 * wizard.
 *
 * Reads VIPM_API_URL from the environment (a GitHub repository secret in CI).
 * Does nothing when it is unset, so a normal checkout keeps the wizard.
 *
 * NOTE: this does not keep the URL confidential. It is written into a file that
 * is published to GitHub Pages, so anyone who can load the site can read it.
 * It only keeps the URL out of your git history. The endpoint is safe to expose
 * — every action except ping/login/setup requires a valid session token — but
 * set a SETUP_KEY secret as well so the first-run bootstrap cannot be
 * hijacked. See docs/SUPABASE_MIGRATION.md.
 */
import fs from 'fs';

const CONFIG = new URL('../assets/js/config.js', import.meta.url);
const url = (process.env.VIPM_API_URL || '').trim();

if (!url) {
  console.log('VIPM_API_URL not set — leaving the setup wizard in place.');
  process.exit(0);
}

const SUPABASE = /^https:\/\/[a-z0-9-]+\.supabase\.co\/functions\/v1\/[A-Za-z0-9_-]+$/;
const APPS_SCRIPT = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/;
if (!SUPABASE.test(url) && !APPS_SCRIPT.test(url)) {
  console.error('VIPM_API_URL does not look like the API URL.');
  console.error('Expected: https://<project>.supabase.co/functions/v1/api');
  console.error('Received: ' + url.replace(/\/\/[^/]+/, '//***'));
  process.exit(1);
}

const source = fs.readFileSync(CONFIG, 'utf8');
const line = /^const DEFAULT_API_URL = '.*';$/m;

if (!line.test(source)) {
  console.error('Could not find the DEFAULT_API_URL line in assets/js/config.js.');
  process.exit(1);
}

// JS string literal, single-quoted; the URL pattern above already excludes
// quotes and backslashes, so no escaping is needed.
fs.writeFileSync(CONFIG, source.replace(line, `const DEFAULT_API_URL = '${url}';`));
console.log('Injected API URL ending /' + url.split('/').slice(-2).join('/'));
