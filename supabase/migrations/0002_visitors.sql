-- Multiple trips per browser.
--
-- There are no accounts at Level 0, so a conversation belongs to a "visitor":
-- an opaque id in a httpOnly cookie. It scopes the trip list to the browser that
-- created those trips, and is the natural seam to replace with a real user id
-- when authentication arrives.

alter table conversations add column if not exists visitor_id text;

create index if not exists conversations_visitor_idx
  on conversations (visitor_id, created_at desc);
