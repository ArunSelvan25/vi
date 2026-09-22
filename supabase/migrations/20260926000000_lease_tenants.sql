-- More than one person on a lease.
--
-- A lease keeps exactly one primary tenant (leases.tenant_id): the person the
-- rent is billed to, whose name is on the invoices, statements and deposit.
-- Everyone else living in the unit — two friends sharing a room, a spouse, a
-- flatmate — is a row here, pointing at their own tenant record, so their
-- phone, ID proof and emergency contact are collected exactly as a primary
-- tenant's are.
--
--   role            Co-tenant — signed the agreement and shares responsibility
--                   Occupant  — lives there, but is not a party to the agreement
--   move_in_date    when they joined, if later than the lease start
--   move_out_date   when they left, if before the lease ends; blank = still living there
--
-- Nothing here is billed, so no invoice, payment or deposit figure changes.
-- The rule that the primary tenant is never also listed here is enforced by
-- the API, which also swaps the two when the primary changes.

create table lease_tenants (
  seq bigint generated always as identity,  -- insertion order
  id            text primary key,
  -- the occupants are part of the lease: deleting a lease takes them with it
  lease_id      text not null references leases (id) on delete cascade,
  tenant_id     text not null references tenants (id) on delete restrict,
  role          text not null default 'Co-tenant' check (role in ('Co-tenant', 'Occupant')),
  relationship  text,
  move_in_date  date,
  move_out_date date,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  row_version   integer not null default 1,

  constraint lease_tenants_once unique (lease_id, tenant_id),
  constraint lease_tenants_dates check (move_out_date is null or move_in_date is null or move_out_date >= move_in_date)
);
create index lease_tenants_tenant on lease_tenants (tenant_id);

create trigger lease_tenants_touch before update on lease_tenants
  for each row execute function touch_row();
create trigger lease_tenants_version after insert or update or delete or truncate on lease_tenants
  for each statement execute function bump_table_version();
insert into table_versions (table_name, version) values ('lease_tenants', 0) on conflict do nothing;

-- Same as every other table: nothing through Supabase's public REST API.
alter table lease_tenants enable row level security;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on table lease_tenants from anon, authenticated;
  end if;
end;
$$;
