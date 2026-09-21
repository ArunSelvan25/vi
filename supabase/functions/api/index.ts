// Supabase Edge Function entry point: `supabase functions deploy api`.
//
// Secrets (supabase secrets set …):
//   AUTH_SECRET    random, 32+ characters — signs session tokens
//   SETUP_KEY      optional; required to create the first administrator
//   APP_TIMEZONE   the zone "today" is measured in (default Asia/Kolkata)
//   CRON_SECRET    shared with the pg_cron job that calls /cron
// SUPABASE_DB_URL is provided by Supabase itself.
import postgres from 'npm:postgres@3.4.9';
import { createBackend } from './backend.js';
import { PG_TYPES } from './schema.js';
import { makeHttpHandler } from './http.js';

const env = (key: string): string => Deno.env.get(key) ?? '';

// prepare: false — the connection goes through Supabase's pooler, where
// prepared statements do not survive between transactions.
const sql = postgres(env('SUPABASE_DB_URL'), { types: PG_TYPES, prepare: false, max: 4, idle_timeout: 20 });

const backend = createBackend({
  sql,
  authSecret: env('AUTH_SECRET'),
  setupKey: env('SETUP_KEY'),
  timeZone: env('APP_TIMEZONE') || 'Asia/Kolkata'
});

Deno.serve(makeHttpHandler(backend, { cronSecret: env('CRON_SECRET') }));
