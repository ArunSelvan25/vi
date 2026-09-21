-- A monthly lease can bill on a fixed day of the month. Each invoice is raised
-- on that day for the cycle just ended (the day after the previous rent day up
-- to this one); a part cycle is charged day by day at each month's own length.
-- 1–28, or 31 for "the last day of the month"; blank keeps the old behaviour of
-- periods counted from the lease start. Deliberately not billing_day, which is
-- an old unused column whose values may be stale.

alter table leases add column rent_day integer
  constraint leases_rent_day_check check (rent_day is null or rent_day between 1 and 28 or rent_day = 31);
