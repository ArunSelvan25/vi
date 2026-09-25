-- Generate rent: what it needs beyond the invoices themselves.
--
-- 1. rent_offline — rent periods settled before or outside the app. A lease
--    moved in from paper has months nobody will ever invoice here; marking
--    them "billed outside the app" (with a reason) stops Generate rent from
--    offering them again. Nothing here is money: it is not income, not owed,
--    and never shown as an invoice. Deleting a row (Undo) offers the period
--    again.
--
-- 2. invoice_items.late_fee_for — a late fee is now charged on the tenant's
--    next invoice, as its own line, naming the overdue invoice it is for. This
--    is how "charged once per overdue invoice" is kept. (A late fee added the
--    old way, on the overdue invoice itself, is still recognised by its
--    category.) Deleting a draft that carried the fee frees it to be offered
--    again; the overdue invoice is never deleted (only drafts can be).
--
-- 3. invoices.late_fee_waived — the reason a late fee was waived for good.
--    Blank means not waived. Who waived it and when is in the activity log.
--
-- Nothing existing is changed or back-filled.

create table rent_offline (
  seq bigint generated always as identity,  -- insertion order
  id            text primary key,
  -- the record belongs to the lease: deleting a lease takes it with it
  lease_id      text not null references leases (id) on delete cascade,
  period_start  date not null,
  period_end    date not null,
  reason        text not null,
  created_by    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  row_version   integer not null default 1,

  constraint rent_offline_dates check (period_end >= period_start),
  constraint rent_offline_once unique (lease_id, period_start)
);
create index rent_offline_lease on rent_offline (lease_id);

create trigger rent_offline_touch before update on rent_offline
  for each row execute function touch_row();
create trigger rent_offline_version after insert or update or delete or truncate on rent_offline
  for each statement execute function bump_table_version();
insert into table_versions (table_name, version) values ('rent_offline', 0) on conflict do nothing;

alter table invoice_items add column late_fee_for text references invoices (id) on delete set null;
create index invoice_items_late_fee_for on invoice_items (late_fee_for) where late_fee_for is not null;

alter table invoices add column late_fee_waived text;

-- Same as every other table: nothing through Supabase's public REST API.
alter table rent_offline enable row level security;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on table rent_offline from anon, authenticated;
  end if;
end;
$$;
