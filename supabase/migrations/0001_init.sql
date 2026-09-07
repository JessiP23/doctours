-- Doctours travel agent — initial schema.
-- All agent state lives here; the server is stateless between requests.

create extension if not exists "pgcrypto";

-- One trip conversation. trip_rules is a snapshot so later levels can vary rules per trip.
create table if not exists conversations (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  trip_rules  jsonb not null,
  status      text not null default 'open' check (status in ('open', 'completed', 'cancelled'))
);

-- Exact Anthropic content blocks, replayable as model history.
create table if not exists messages (
  id               bigserial primary key,
  conversation_id  uuid not null references conversations(id) on delete cascade,
  role             text not null check (role in ('user', 'assistant')),
  content          jsonb not null,
  created_at       timestamptz not null default now()
);
create index if not exists messages_conversation_idx on messages (conversation_id, id);

-- Offers the model has been shown. Booking tools may only reference rows from here.
create table if not exists offers (
  id                 uuid primary key default gen_random_uuid(),
  conversation_id    uuid not null references conversations(id) on delete cascade,
  kind               text not null check (kind in ('flight', 'hotel_rate')),
  provider           text not null,
  provider_offer_id  text not null,
  summary            jsonb not null,
  raw                jsonb not null,
  expires_at         timestamptz,
  created_at         timestamptz not null default now()
);
create index if not exists offers_conversation_idx on offers (conversation_id, kind, created_at desc);

-- Confirmed bookings. booking_reference is ONLY ever copied from a provider response.
create table if not exists bookings (
  id                 uuid primary key default gen_random_uuid(),
  conversation_id    uuid not null references conversations(id) on delete cascade,
  kind               text not null check (kind in ('flight', 'hotel')),
  provider           text not null,
  provider_order_id  text not null,
  booking_reference  text not null,
  status             text not null default 'confirmed' check (status in ('confirmed', 'cancelled')),
  offer_id           uuid references offers(id),
  details            jsonb not null,
  raw                jsonb not null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
-- At most one live booking of each kind per conversation: the DB-level guard against double booking.
create unique index if not exists bookings_one_live_per_kind
  on bookings (conversation_id, kind) where status = 'confirmed';

-- Every tool invocation, with the upstream requests it made. Durable proof Sabre was called.
create table if not exists tool_calls (
  id                 bigserial primary key,
  conversation_id    uuid references conversations(id) on delete cascade,
  tool_name          text not null,
  input              jsonb not null,
  output             jsonb,
  error              jsonb,
  provider_requests  jsonb,
  duration_ms        integer,
  created_at         timestamptz not null default now()
);
create index if not exists tool_calls_conversation_idx on tool_calls (conversation_id, id);

-- updated_at maintenance
create or replace function set_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;
drop trigger if exists conversations_updated_at on conversations;
create trigger conversations_updated_at before update on conversations for each row execute function set_updated_at();
drop trigger if exists bookings_updated_at on bookings;
create trigger bookings_updated_at before update on bookings for each row execute function set_updated_at();

-- Lock everything down: only the server (service role) reads or writes.
alter table conversations enable row level security;
alter table messages      enable row level security;
alter table offers        enable row level security;
alter table bookings      enable row level security;
alter table tool_calls    enable row level security;
