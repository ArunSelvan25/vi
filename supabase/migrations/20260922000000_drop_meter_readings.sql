-- Meter readings are gone from the app: an electricity or water bill is now a
-- line on the tenant's invoice (category Electricity / Water / Gas), typed in
-- the invoice editor. The consumption each past reading billed is already on
-- its invoice's line items, so dropping the readings loses no billed amount.

drop table if exists meter_readings;
delete from table_versions where table_name = 'meter_readings';
