-- VI Property & Tenancy Manager — initial Postgres schema for Supabase.
--
-- A one-to-one translation of the Google Sheet tabs described in
-- docs/SHEET_SCHEMA.md. Column names are unchanged, so the SPA keeps reading
-- the same fields; what changes is that the database now enforces the rules
-- Code.gs used to check by hand:
--
--   * references are foreign keys — a unit cannot point at a missing property,
--     and a row that is still referenced cannot be deleted;
--   * statuses are CHECK constraints — a typo can no longer invent a new one;
--   * a unit cannot be let twice over overlapping dates (exclusion constraint);
--   * money is numeric, never a float;
--   * ids are still human-readable (PRP-00001) and never reused, from a
--     high-water mark kept in id_counters.
--
-- Access: every table has row-level security switched on with NO policies, and
-- the anon/authenticated roles have no grants. Supabase's public REST API can
-- therefore read and write nothing. The only way in is the `api` edge function,
-- which connects as the database owner and applies the app's own roles
-- (viewer / manager / admin), exactly as the Apps Script Web App did.

create extension if not exists btree_gist;

-- ───────────────────────────────────────────────────────────── plumbing ──

/** Highest number ever issued per table, so a deleted row never frees its id. */
create table id_counters (
  table_name text primary key,
  last_value integer not null default 0 check (last_value >= 0)
);

/**
 * Reserve `p_count` consecutive numbers for a table and return the first.
 * `p_floor` is the highest number already present in the table, so a row added
 * by hand in the table editor can only push numbering up, never be collided
 * with. The row lock taken by the upsert serialises concurrent callers.
 */
create function reserve_ids(p_table text, p_count integer default 1, p_floor integer default 0)
returns integer
language sql
as $$
  insert into id_counters (table_name, last_value) values (p_table, p_floor + p_count)
  on conflict (table_name) do update
    set last_value = greatest(id_counters.last_value, p_floor) + p_count
  returning last_value - p_count + 1;
$$;

/**
 * A counter per table, bumped by every statement that writes to it. The SPA
 * sends back the counters it holds and bootstrap omits tables that have not
 * moved — the job tableHash() did by fingerprinting every row of every tab.
 */
create table table_versions (
  table_name text primary key,
  version    bigint not null default 0
);

create function bump_table_version() returns trigger
language plpgsql
as $$
begin
  insert into table_versions (table_name, version) values (tg_table_name, 1)
  on conflict (table_name) do update set version = table_versions.version + 1;
  return null;
end;
$$;

/**
 * updated_at and the optimistic-locking version, maintained by the database.
 * `row_version` replaces the `_v` fingerprint: a form sends back the version it
 * was opened on and the update is refused if the row has moved since.
 */
create function touch_row() returns trigger
language plpgsql
as $$
begin
  new.updated_at  := now();
  new.row_version := old.row_version + 1;
  return new;
end;
$$;

/** Script Properties that are state rather than secrets (FIRST_SEEN, LAST_REFRESH). */
create table app_state (
  key   text primary key,
  value text not null
);

/** Sign-in throttling, replacing CacheService. Rows older than the window are ignored and purged. */
create table login_throttle (
  identifier   text primary key,            -- normalised phone, or '__global' for the spray counter
  failures     integer not null default 0,
  locked_until timestamptz,
  updated_at   timestamptz not null default now()
);

-- ───────────────────────────────────────────────────────────── settings ──

create table settings (
  key   text primary key,
  value text not null default ''
);

insert into settings (key, value) values
  ('org_name', 'VI Properties'), ('currency', 'INR'), ('currency_symbol', '₹'),
  ('locale', 'en-IN'), ('date_format', 'dd MMM yyyy'), ('invoice_prefix', 'INV'),
  ('default_late_fee', '0'), ('default_grace_days', '5'), ('reminder_days_before', '3'),
  ('reminder_enabled', 'false'), ('lease_expiry_alert_days', '45'), ('session_hours', '12'),
  ('reminder_overdue_days', '1,7,14,30'), ('gstin', ''), ('sac_code', '997212'),
  ('default_gst_rate', '0'), ('upi_id', ''), ('whatsapp_country_code', '91')
on conflict (key) do nothing;

-- ──────────────────────────────────────────────────────────────── users ──

create table app_users (
  seq bigint generated always as identity,  -- insertion order, as rows sat in the tab
  id                  text primary key,
  name                text not null default '',
  phone               text not null,
  -- the comparable form of the number: digits only, last ten (normalisePhone)
  phone_key           text generated always as (right(regexp_replace(phone, '[^0-9]', '', 'g'), 10)) stored,
  email               text,
  role                text not null default 'viewer' check (role in ('viewer', 'manager', 'admin')),
  salt                text not null,
  password_hash       text not null,
  password_changed_at timestamptz not null default now(),
  active              boolean not null default true,
  last_login          timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  row_version         integer not null default 1
);
create unique index app_users_phone_key on app_users (phone_key) where phone_key <> '';

-- ─────────────────────────────────────────────────────────── portfolio ──

create table properties (
  seq bigint generated always as identity,  -- insertion order, as rows sat in the tab
  id             text primary key,
  name           text not null,
  type           text,
  address_line1  text,
  address_line2  text,
  city           text,
  state          text,
  postal_code    text,
  country        text,
  owner_name     text,
  purchase_date  date,
  purchase_price numeric(14,2),
  current_value  numeric(14,2),
  status         text not null default 'Active' check (status in ('Active', 'Inactive', 'Sold')),
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  row_version    integer not null default 1
);

create table units (
  seq bigint generated always as identity,  -- insertion order, as rows sat in the tab
  id             text primary key,
  property_id    text not null references properties (id) on delete restrict,
  unit_number    text not null,
  floor          text,
  bedrooms       numeric(4,1),
  bathrooms      numeric(4,1),
  area_sqft      numeric(10,2),
  furnishing     text,
  rent_amount    numeric(14,2),
  deposit_amount numeric(14,2),
  status         text not null default 'Vacant'
                 check (status in ('Vacant', 'Occupied', 'Reserved', 'Under Maintenance')),
  amenities      text,
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  row_version    integer not null default 1,
  -- lets a lease prove its unit belongs to the property it names
  unique (id, property_id)
);
create index units_property on units (property_id);

create table tenants (
  seq bigint generated always as identity,  -- insertion order, as rows sat in the tab
  id              text primary key,
  full_name       text not null,
  email           text,
  phone           text,
  alt_phone       text,
  id_type         text,
  id_number       text,
  occupation      text,
  emergency_name  text,
  emergency_phone text,
  status          text not null default 'Active' check (status in ('Active', 'Prospect', 'Past')),
  notes           text,
  gstin           text check (gstin is null or gstin = '' or gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  row_version     integer not null default 1
);

create table leases (
  seq bigint generated always as identity,  -- insertion order, as rows sat in the tab
  id             text primary key,
  property_id    text not null references properties (id) on delete restrict,
  unit_id        text not null,
  tenant_id      text not null references tenants (id) on delete restrict,
  start_date     date not null,
  end_date       date,
  rent_amount    numeric(14,2) not null default 0 check (rent_amount >= 0),
  deposit_amount numeric(14,2) not null default 0 check (deposit_amount >= 0),
  deposit_status text not null default 'Pending'
                 check (deposit_status in ('Pending', 'Held', 'Partially Refunded', 'Refunded', 'Forfeited', 'Transferred')),
  frequency      text not null default 'Monthly'
                 check (frequency in ('Monthly', 'Quarterly', 'Half-Yearly', 'Yearly')),
  billing_day    integer,                        -- unused by the app; kept so old values survive
  late_fee       numeric(14,2) not null default 0 check (late_fee >= 0),
  grace_days     integer not null default 0 check (grace_days >= 0),
  escalation_pct numeric(6,3) not null default 0,
  status         text not null default 'Active' check (status in ('Active', 'Upcoming', 'Expired', 'Terminated')),
  notes          text,
  gst_rate       numeric(5,2) not null default 0 check (gst_rate between 0 and 100),
  renewed_from   text references leases (id) on delete restrict,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  row_version    integer not null default 1,

  check (end_date is null or end_date >= start_date),
  foreign key (unit_id, property_id) references units (id, property_id) on delete restrict,
  -- assertUnitIsFree, enforced: no two live leases on one unit over overlapping dates
  constraint leases_unit_not_double_let exclude using gist (
    unit_id with =,
    daterange(start_date, end_date, '[]') with &&
  ) where (status not in ('Terminated', 'Expired'))
);
create index leases_unit     on leases (unit_id);
create index leases_tenant   on leases (tenant_id);
create index leases_property on leases (property_id);

-- ───────────────────────────────────────────────────────────── billing ──

create table invoices (
  seq bigint generated always as identity,  -- insertion order, as rows sat in the tab
  id              text primary key,
  lease_id        text references leases (id) on delete restrict,
  tenant_id       text not null references tenants (id) on delete restrict,
  unit_id         text references units (id) on delete restrict,
  property_id     text references properties (id) on delete restrict,
  type            text not null,
  period_start    date,
  period_end      date,
  issue_date      date,
  due_date        date,
  amount          numeric(14,2) not null default 0,
  tax             numeric(14,2) not null default 0,
  total           numeric(14,2) not null default 0,
  amount_paid     numeric(14,2) not null default 0,
  balance         numeric(14,2) not null default 0,
  status          text not null default 'Unpaid'
                  check (status in ('Draft', 'Unpaid', 'Partial', 'Paid', 'Overdue', 'Void')),
  notes           text,
  cgst            numeric(14,2),
  sgst            numeric(14,2),
  igst            numeric(14,2),
  place_of_supply text,
  last_reminded   date,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  row_version     integer not null default 1,

  -- nothing is owed on a void invoice
  check (status <> 'Void' or balance = 0)
);
create index invoices_tenant       on invoices (tenant_id);
create index invoices_lease_period on invoices (lease_id, period_start);
create index invoices_open         on invoices (due_date) where status in ('Unpaid', 'Partial', 'Overdue');

create table invoice_items (
  seq bigint generated always as identity,  -- insertion order, as rows sat in the tab
  id          text primary key,
  -- the lines are part of the invoice: deleting a draft takes them with it
  invoice_id  text not null references invoices (id) on delete cascade,
  description text not null,
  category    text not null default 'Other',
  quantity    numeric(14,3) not null default 1,
  unit_amount numeric(14,4) not null default 0,
  amount      numeric(14,2) not null default 0,
  notes       text,
  tax_rate    numeric(5,2) not null default 0 check (tax_rate between 0 and 100),
  tax_amount  numeric(14,2) not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  row_version integer not null default 1
);
create index invoice_items_invoice on invoice_items (invoice_id);

create table payments (
  seq bigint generated always as identity,  -- insertion order, as rows sat in the tab
  id           text primary key,
  invoice_id   text references invoices (id) on delete restrict,   -- null = money on account
  lease_id     text references leases (id) on delete restrict,
  tenant_id    text references tenants (id) on delete restrict,
  property_id  text references properties (id) on delete restrict,
  payment_date date not null default current_date,
  amount       numeric(14,2) not null check (amount > 0),
  method       text,
  reference    text,          -- free text; for 'Deposit Adjustment' it is the lease id
  received_by  text,
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  row_version  integer not null default 1
);
create index payments_invoice on payments (invoice_id);
create index payments_tenant  on payments (tenant_id);
create index payments_deposit on payments (reference) where method = 'Deposit Adjustment';

-- ──────────────────────────────────────────────────────────── operations ──

create table maintenance (
  seq bigint generated always as identity,  -- insertion order, as rows sat in the tab
  id             text primary key,
  property_id    text references properties (id) on delete restrict,
  unit_id        text references units (id) on delete restrict,
  tenant_id      text references tenants (id) on delete restrict,
  title          text not null,
  description    text,
  category       text,
  priority       text not null default 'Medium',
  status         text not null default 'Open',
  reported_date  date,
  scheduled_date date,
  completed_date date,
  vendor_name    text,
  vendor_phone   text,
  cost           numeric(14,2),
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  row_version    integer not null default 1
);
create index maintenance_property on maintenance (property_id);

create table expenses (
  seq bigint generated always as identity,  -- insertion order, as rows sat in the tab
  id             text primary key,
  property_id    text references properties (id) on delete restrict,
  unit_id        text references units (id) on delete restrict,
  date           date not null default current_date,
  category       text,
  vendor         text,
  description    text,
  amount         numeric(14,2) not null default 0,
  payment_method text,
  reference      text,        -- a maintenance ticket id, or the lease id of a Deposit Refund
  receipt_url    text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  row_version    integer not null default 1
);
create index expenses_property  on expenses (property_id);
create index expenses_reference on expenses (reference);

create table documents (
  seq bigint generated always as identity,  -- insertion order, as rows sat in the tab
  id          text primary key,
  entity_type text,
  entity_id   text,           -- polymorphic (property, unit, tenant or lease), so not a foreign key
  title       text,
  category    text,
  url         text,
  issue_date  date,
  expiry_date date,
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  row_version integer not null default 1
);
create index documents_entity on documents (entity_id);

create table meter_readings (
  seq bigint generated always as identity,  -- insertion order, as rows sat in the tab
  id               text primary key,
  property_id      text not null references properties (id) on delete restrict,
  unit_id          text not null references units (id) on delete restrict,
  lease_id         text references leases (id) on delete restrict,
  tenant_id        text references tenants (id) on delete restrict,
  category         text not null check (category in ('Electricity', 'Water', 'Gas')),
  reading_date     date not null,
  previous_reading numeric(14,3) not null default 0,
  current_reading  numeric(14,3) not null,
  consumption      numeric(14,3) not null default 0,
  rate             numeric(14,4) not null default 0,
  amount           numeric(14,2) not null default 0,
  invoice_id       text references invoices (id) on delete set null,
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  row_version      integer not null default 1,
  check (current_reading >= previous_reading)
);
create index meter_readings_unit on meter_readings (unit_id, category, reading_date);

-- ─────────────────────────────────────────────────────────── audit trail ──

create table activity_log (
  seq bigint generated always as identity,  -- insertion order, as rows sat in the tab
  id        text primary key,
  timestamp timestamptz not null default now(),
  actor     text,
  action    text not null,
  entity    text,
  entity_id text,
  details   text
);
create index activity_log_recent on activity_log (timestamp desc);

-- ────────────────────────────────────────────────────────────── triggers ──

do $$
declare
  t text;
begin
  foreach t in array array['properties', 'units', 'tenants', 'leases', 'invoices', 'invoice_items',
                           'payments', 'maintenance', 'expenses', 'documents', 'meter_readings',
                           'app_users']
  loop
    execute format('create trigger %I before update on %I for each row execute function touch_row()',
                   t || '_touch', t);
  end loop;

  foreach t in array array['properties', 'units', 'tenants', 'leases', 'invoices', 'invoice_items',
                           'payments', 'maintenance', 'expenses', 'documents', 'meter_readings',
                           'app_users', 'settings', 'activity_log']
  loop
    execute format('create trigger %I after insert or update or delete or truncate on %I '
                   'for each statement execute function bump_table_version()', t || '_version', t);
    insert into table_versions (table_name, version) values (t, 0) on conflict do nothing;
  end loop;
end;
$$;

-- ──────────────────────────────────────────────────────────────── access ──

-- Nothing is reachable through Supabase's auto-generated REST API. The edge
-- function connects as the owner (which bypasses RLS) and enforces roles itself.
do $$
declare
  t text;
begin
  foreach t in array array['id_counters', 'table_versions', 'app_state', 'login_throttle', 'settings',
                           'app_users', 'properties', 'units', 'tenants', 'leases', 'invoices',
                           'invoice_items', 'payments', 'maintenance', 'expenses', 'documents',
                           'meter_readings', 'activity_log']
  loop
    execute format('alter table %I enable row level security', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on table %I from anon, authenticated', t);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function reserve_ids(text, integer, integer) from anon, authenticated, public;
  end if;
end;
$$;
