-- Indexes for server-side paging.
--
-- The browser now asks for invoices, payments, expenses, tickets, documents
-- and the audit trail a page at a time: scoped to a property, unit, tenant or
-- lease, and ordered by date. These cover the scopes and orders that had no
-- index (see supabase/functions/api/queries.js). Adding an index changes no
-- data.

create index if not exists invoices_property      on invoices (property_id);
create index if not exists invoices_unit          on invoices (unit_id);
create index if not exists invoices_due           on invoices (due_date, seq);

create index if not exists payments_lease         on payments (lease_id);
create index if not exists payments_property      on payments (property_id);
create index if not exists payments_date          on payments (payment_date, seq);

create index if not exists maintenance_unit       on maintenance (unit_id);
create index if not exists maintenance_tenant     on maintenance (tenant_id);
create index if not exists maintenance_reported   on maintenance (reported_date, seq);

create index if not exists expenses_unit          on expenses (unit_id);
create index if not exists expenses_date          on expenses (date, seq);

create index if not exists documents_type_entity  on documents (entity_type, entity_id);
create index if not exists documents_expiry       on documents (expiry_date) where expiry_date is not null;

create index if not exists activity_log_seq       on activity_log (seq);
