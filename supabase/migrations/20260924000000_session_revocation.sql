-- Signing out ends the session on the server, not just in the browser.
--
-- Sessions are signed tokens, so the server cannot forget one on its own. Two
-- ways to end them early:
--   * revoked_sessions — one token, the one a device signed out with. Kept only
--     until that token would have expired anyway.
--   * app_users.sessions_revoked_at — every token issued to the account before
--     this moment ("sign out other devices", or an admin signing a user out).

alter table app_users add column sessions_revoked_at timestamptz;

create table revoked_sessions (
  token_hash text primary key,              -- sha256 of the token, never the token itself
  expires_at timestamptz not null
);
create index revoked_sessions_expires_at on revoked_sessions (expires_at);

-- Same as every other table: nothing through Supabase's public REST API.
alter table revoked_sessions enable row level security;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on table revoked_sessions from anon, authenticated;
  end if;
end;
$$;
