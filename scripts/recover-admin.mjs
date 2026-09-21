#!/usr/bin/env node
/**
 * Break-glass: make a phone number an active administrator with a new
 * password, and clear any sign-in lockout on it. The replacement for the
 * spreadsheet's "Recover admin access" menu.
 *
 *   DATABASE_URL=… node scripts/recover-admin.mjs <phone> [name]
 *
 * It talks to the database directly, so only someone holding the database
 * connection string can run it — which is the point: it works when nobody can
 * sign in, and it is not reachable from the public API. The password is asked
 * for, never passed as an argument.
 */
import { ask, askHidden } from './lib/prompt.mjs';
import postgres from 'postgres';
import { createBackend } from '../supabase/functions/api/backend.js';
import { PG_TYPES } from '../supabase/functions/api/schema.js';


const [phone, name] = process.argv.slice(2);
if (!phone) {
  console.log('Usage: DATABASE_URL=… node scripts/recover-admin.mjs <phone> [name]');
  process.exit(1);
}

const url = process.env.DATABASE_URL || await askHidden('Supabase connection string: ');
const password = process.env.NEW_ADMIN_PASSWORD || await askHidden('New password (10+ characters): ');
const sql = postgres(url, { types: PG_TYPES, max: 1, prepare: false, onnotice: () => {} });
try {
  // the session secret is not needed to write an account; any value satisfies the constructor
  const backend = createBackend({ sql, authSecret: crypto.randomUUID() + crypto.randomUUID(),
                                  timeZone: process.env.APP_TIMEZONE || 'Asia/Kolkata' });
  const who = await backend.recoverAccess(phone, password, name || 'Administrator');
  console.log(`${who.name} (${who.phone}) is now an active administrator. Sign in with that number and the new password.`);
} catch (e) {
  console.error('✗ ' + e.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
