-- The clinic can move the procedure. Like a cancelled flight, that is something
-- done to the trip from outside the conversation, so it is a trip event: the agent
-- raises it before anything else, and the trip's rules are recomputed from the new
-- date (lib/trip/derive.ts). The check constraint is the closed list of kinds.
alter table trip_events drop constraint if exists trip_events_kind_check;
alter table trip_events add constraint trip_events_kind_check check (kind in (
  'flight_cancelled',
  'flight_schedule_change',
  'hotel_cancelled',
  'procedure_moved',
  'operator_note'
));
