/**
 * Stamps a build id into sw.js at deploy time.
 *
 * The browser decides whether a service worker has changed by comparing the
 * file byte for byte. Without this, publishing new HTML, CSS or JS would leave
 * sw.js identical, no update would be detected, and every installed device
 * would keep serving the previous release out of its cache — indefinitely.
 *
 * The id also names the cache, so activating the new worker drops the old
 * cache and refetches the whole shell as one set. That is what stops a release
 * from mixing old and new files.
 *
 * Uses the commit SHA in CI, falling back to a timestamp so a manual deploy is
 * still safe.
 */
import fs from 'fs';
import { execSync } from 'child_process';

const SW = new URL('../sw.js', import.meta.url);

function buildId() {
  const sha = (process.env.GITHUB_SHA || '').trim();
  if (sha) return sha.slice(0, 12);
  try {
    return execSync('git rev-parse --short=12 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
  } catch {
    // not a checkout — a timestamp still changes on every deploy, which is all
    // the browser needs to notice
    return new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  }
}

const source = fs.readFileSync(SW, 'utf8');
const line = /^const BUILD = '.*';$/m;

if (!line.test(source)) {
  console.error('Could not find the BUILD line in sw.js.');
  process.exit(1);
}

const id = buildId();
if (!/^[A-Za-z0-9._-]+$/.test(id)) {
  console.error('Refusing to stamp an unexpected build id: ' + id);
  process.exit(1);
}

fs.writeFileSync(SW, source.replace(line, `const BUILD = '${id}';`));
console.log('Stamped service worker build ' + id);
