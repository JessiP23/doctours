-- Not every user-role row is the patient talking.
--
-- The agent loop appends user-role rows that carry tool results and, sometimes, a
-- correction to the model ("you announced an action you did not take"). The model
-- needs them in its history; the patient must never see them as their own words.
-- And when a trip changes without the patient asking — an airline cancels a flight —
-- the agent has to speak first, which means a turn that no patient message started.
-- That opener is a user-role row too, and it is not the patient either.
--
-- `kind` tells them apart. 'patient' is what the person typed. 'system' is plumbing
-- and prompts from the app itself, hidden from the transcript, kept for the model.

alter table messages
  add column if not exists kind text not null default 'patient'
  check (kind in ('patient', 'system'));

comment on column messages.kind is
  'patient = typed by the person; system = tool results, corrections and proactive openers written by the app, hidden from the transcript';
