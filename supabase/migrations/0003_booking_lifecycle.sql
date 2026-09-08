-- Booking lifecycle: a trip changes, and the history of how it changed matters.
--
-- Level 0 only needed 'confirmed' and 'cancelled'. Level 1 rebooks — a cancelled
-- flight, a moved procedure — and a rebooking is a cancel plus a new booking that
-- must stay linked to what it replaced, or an operator can never answer "what
-- happened to this patient's trip".
--
-- Deliberately only these three states. There is no 'paid' (Doctours pays, and the
-- agency card guarantees the room) and no 'pending' (Create Booking is synchronous:
-- it either returns a confirmation or it fails). See docs/DECISIONS.md.

alter table bookings drop constraint if exists bookings_status_check;
alter table bookings add constraint bookings_status_check
  check (status in ('confirmed', 'cancelled', 'superseded'));

alter table bookings add column if not exists replaced_by uuid references bookings(id);
alter table bookings add column if not exists cancelled_at timestamptz;
alter table bookings add column if not exists change_reason text;

-- The Level 0 guard is unchanged and is what makes this work: only one *confirmed*
-- booking of each kind per conversation, so a cancelled or superseded row can sit
-- alongside its replacement.
--   create unique index bookings_one_live_per_kind
--     on bookings (conversation_id, kind) where status = 'confirmed';

create index if not exists bookings_replaced_by_idx on bookings (replaced_by);

comment on column bookings.replaced_by is
  'The booking that took this one''s place when the trip was rebooked.';
comment on column bookings.change_reason is
  'Why this booking was cancelled or superseded, in the words the patient was given.';
