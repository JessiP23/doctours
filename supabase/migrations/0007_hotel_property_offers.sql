-- A patient who does not want the default hotel is shown real alternatives. Each
-- one is an offer like a flight or a room rate: persisted so the id the model
-- hands back (choose_hotel) resolves to exactly what the provider returned, never
-- to a name the model remembered.
alter table offers drop constraint if exists offers_kind_check;
alter table offers add constraint offers_kind_check check (kind in ('flight', 'hotel_rate', 'hotel_property'));
