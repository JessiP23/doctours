-- Things that happen to a trip without the patient asking.
--
-- An airline cancels a flight, a schedule moves, an operator edits a booking. None
-- of these arrive through the conversation, so they cannot live only in the message
-- history: they are facts about the trip that the agent must raise the next time the
-- patient says anything, and that an operator must be able to see was raised.
--
-- Level 3's "tell the user when an operator makes an edit" is the same table.

create table if not exists trip_events (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid not null references conversations(id) on delete cascade,
  booking_id       uuid references bookings(id) on delete set null,
  kind             text not null check (kind in (
    'flight_cancelled',
    'flight_schedule_change',
    'hotel_cancelled',
    'operator_note'
  )),
  -- What changed, in provider terms: segment statuses, old and new times, the
  -- reference affected. Enough for the agent to explain it without guessing.
  detail           jsonb not null,
  /** Who or what noticed. 'provider' = read back from Sabre, 'operator' = a human. */
  source           text not null default 'provider' check (source in ('provider', 'operator', 'simulated')),
  created_at       timestamptz not null default now(),
  -- Set once the agent has told the patient and dealt with it.
  acknowledged_at  timestamptz
);

-- The query the agent makes every turn: what has happened that the patient has not
-- been told about yet.
create index if not exists trip_events_open_idx
  on trip_events (conversation_id, created_at)
  where acknowledged_at is null;

alter table trip_events enable row level security;
