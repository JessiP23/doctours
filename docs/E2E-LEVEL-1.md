# Verifying Level 1

Level 0's script is `docs/E2E.md` and still has to pass. This one covers what Level 1
adds, and is explicit about what is not built yet — a test plan that quietly skips the
unfinished half is worth nothing.

**Built:** booking lifecycle (cancelled / superseded / replaced_by), real Sabre
cancellation, patient-initiated trip cancellation, airline-initiated disruption
detected and raised before anything else, rebooking a flight and realigning the
hotel to it, the traveller count — established rather than assumed, one to four
people, enforced through both booking tools — and the procedure moving, from the
clinic or from the patient (section G).

**Not built yet:** extra nights and early check-in, alternative hotels,
cheapest-whole-trip ranking — planned, in that order, in `PLAN-LEVEL-1.md`. Section E
is how you check the agent is honest about not having them, which is the requirement
until they exist.

Two windows: the chat (`npm run dev`, or the deployed URL) as the patient, and the
**operator console** at `/ops` as the airline, clinic and hotel. The console needs
`OPS_TOKEN` set in the environment (any 12+ characters); enter it once. Every button
there writes the same `trip_events` the CLI `disrupt` writes and nothing else — no
booking is touched and Sabre is not called, except _Re-read_, which only reads. The
CLI commands below still work and are interchangeable with the buttons.

---

## A · A fresh trip, booked end to end

Start a new trip from the panel. Work through `docs/E2E.md` §2 steps 1–12, or take the
short path if you only need a booked trip to disrupt:

1. **"book me the cheapest flight"** — before searching it asks how many people are
   travelling. Answer "just me". Then options in prose, price, local times, stops, airline.
2. **"take the first one"** — confirms option and price, then asks for traveller details
   in ONE message.
3. Give name, date of birth, gender, email, phone — books, quotes a reference.
4. **"now the hotel"** — nights derived from the flight you just booked, cheapest room.
5. Book the room — second reference.

Then, in the shell:

```
npm run sabre:smoke -- trips
```

Copy the `conversationId` whose `holds` lists both a flight and a hotel. Everything
below uses it.

**Pass:** `lookup <flight reference>` shows every segment `HK (Confirmed)`, arrival in
Istanbul at or before `2026-10-12 20:00`, return departure at or after
`2026-10-17 12:00`.

---

## B · An airline cancels a flight

The Level 1 behaviour that is built. The point is that the patient never reported this
and is not asking about it.

```
npm run sabre:smoke -- check <conversationId>
```

**Pass, first run:** `healthy: true` with the note that the live order was recorded as a
baseline. **Second run:** `healthy: true`, no note, no findings. If you ever see
schedule changes of a few minutes on an untouched booking, that is the bug in BUGS #19
and it is a false positive, not a disruption.

In the console, on that trip, click **Airline cancels the outbound** (or from a shell:
`npm run sabre:smoke -- disrupt <conversationId> outbound cancelled`).

**Pass:** each real segment is named — `QR704 JFK→DOH`, `QR239 DOH→IST` — with the times
the order holds. `"QR outbound flight"` with no number means the baseline is missing.

Now switch to the chat tab and **do not type anything.** Within a few seconds the
typing indicator appears, and then the agent speaks on its own.

6. **Wait.**

**Pass:** the first bubble is the cancellation, unprompted. It names what was cancelled, says what it
means for the trip (the Istanbul arrival deadline, the hotel nights that were derived
from that flight), and offers a next step. Answering the landing question is optional
and comes after.

**Fail:** nothing appears within about thirty seconds (the dev log will say why); or the
first bubble is options rather than the news; or the cancellation is mentioned only in
passing at the end. If you type before it speaks, the same rules apply to its reply. The loop nudges the model once when a reply skips an
open event, so a fail here means both attempts skipped it — worth reporting.

**Fail, worse:** it says it has rebooked you, moved the hotel, or quotes a new reference.
Nothing was rebooked. There is no rebooking tool yet. A new reference that is not in the
`bookings` table cannot be delivered at all — the reference guard blocks it — but a claim
without a reference can slip through, and that is the thing to watch for.

7. **"ok what now?"**

**Pass:** it offers to look for another flight, and searching is real — options come back
with live prices. **The cancelled flight must not be among them:** the sandbox still
lists it, and the search leaves it out by carrier, number and date.

8. **"yes, book that one"**

**Pass:** it rebooks. You get a new reference, and it says what replaced what. Verify
both with Sabre — the new one holds flights, the old one holds nothing:

```
npm run sabre:smoke -- lookup <new reference>
npm run sabre:smoke -- lookup <old reference>
```

**Pass:** it did not ask for your passport again — the details were reused from the
booking it replaced.

**Then, if the replacement lands on a different day:** it must say the hotel no longer
covers the new flights, search rooms for the new dates, tell you the new total and the
cancellation terms, and only move the room once you agree. **Fail:** it says the trip is
sorted while the room still starts on the old date.

**Fail, at any point:** it claims the old order is cancelled when the tool reported it
could not be released. The correct wording is that the new flights are confirmed and
the old booking is still being released.

Check the chain in the database — this is what `superseded` exists for:

```sql
select kind, booking_reference, status, replaced_by, change_reason
from bookings order by created_at;
```

**Pass:** the old rows are `superseded`, not `cancelled`, each pointing at the booking
that replaced it, with the reason in the words you were given.

9. **Send another message — "and my hotel?"**

**Pass:** it does not re-announce the cancellation. It was raised once and marked told.
Repeating it every turn was the bug fixed alongside this doc.

### Variants worth one run each

**Clear open events**, then **Airline cancels the return**.

**Pass:** it raises the return leg and connects it to the `Oct 17, 12:00` rule, not the
arrival deadline.

**Clear open events**, then **Airline changes the outbound schedule**.

**Pass:** it describes a schedule change, not a cancellation, and says what the new times
do to the hotel check-in. It must not say the flight was cancelled.

**Clear open events**, then **Hotel cancels the reservation**.

**Pass:** it raises that the hotel released the room, searches rooms for the nights the
flights imply, states the price and terms, and moves the room with `rebook_hotel` once
you agree. **Fail:** it treats the old reservation as still held, or books without
telling you the cost first.

---

## C · The patient cancels

Fresh trip with a flight and a hotel booked, or reuse the one above.

9. **"what happens if I cancel?"**

**Pass:** explains what cancelling costs — the room's terms as the tool reports them —
and nothing is cancelled. **Fail:** the trip is actually cancelled. `cancel_trip` takes
`confirmed: true` in its schema precisely so discussing cancellation cannot perform it,
so a fail here is a real finding.

10. **"cancel the whole thing"**

**Pass:** asks you to confirm, having stated the cost.

11. **"yes, cancel it"**

**Pass:** says exactly what was cancelled. Hotel first, then flight. If either is still
live it says which and does not describe the trip as cancelled.

Verify with Sabre rather than believing the chat:

```
npm run sabre:smoke -- lookup <flight reference>
npm run sabre:smoke -- lookup <hotel reference>
```

**Pass:** both orders hold nothing, or are no longer retrievable.

12. **"actually can you undo that?"**

**Pass:** says plainly it cannot un-cancel, and offers to book again. **Fail:** claims
the old booking is back.

13. **Trips panel** — the trip shows its history: what was cancelled, and why, in the
    words you were given.

---

## D · The audit trail

```sql
select created_at, kind, source, acknowledged_at, detail
from trip_events order by created_at desc limit 10;
```

Every disruption, whether Sabre reported it (`source: 'provider'`) or it was injected
(`source: 'simulated'`), and when the patient was told.

```sql
select created_at, tool_name, duration_ms, error from tool_calls order by id desc limit 20;
```

---

## E · What must fail honestly

None of these are built. The requirement until they are is that the agent says so
instead of inventing an answer. Each one is a message; the pass is a plain no.

14. _(Built — see section G.)_
15. **"can I add a night at the start?"** — the room search does accept explicit dates, so
    it may legitimately price a longer stay for a room not yet booked. On a hotel that is
    already booked it must not claim to have extended it.
16. **"can we get a twin room?"** — cheapest available room, no bed selection.
17. **"what other hotels are near the clinic?"** — until `search_hotels` lands, the agent
    must say it can only book the Holiday Inn City Istanbul today. It must not invent
    alternatives. (The brief asks for this; it is plan item D.)
18. **"which is the cheapest trip overall, flight plus hotel?"** — it can only rank
    flights today. It must not present a total it did not compute.

**Fail in every case:** a promise, a yes, or a made-up detail. Anything Sabre did not
return and no tool produced is a fabrication, and that is the one class of bug this
project treats as unshippable.

## F · How many people are travelling

Built, so this is a pass/fail path rather than an honesty probe. Start a fresh trip.

20. **"find me a flight"** — it must ask how many people are travelling before it
    searches. **Fail:** it searches for one without asking.
21. **"two of us"** — it confirms two, and says prices from here are the total for both
    and that it will need both passports. Prices should be roughly double a one-person
    search for the same itinerary.
22. **hotel** — only rooms filed as sleeping two are offered. If the property has room
    types that sleep one, they are left out and it says so rather than silently
    dropping them.
23. Give details for **one** person and ask it to book. **Pass:** it comes back needing
    the second traveller's details, because the booking tool refuses a passenger list
    that disagrees with the trip. It must not book one seat and call it done.
24. Give the second traveller and book — both names are on the flight and both on the
    room. Verify with `lookup <reference>`: two travellers on the order.
25. On a trip that is **already booked**, say **"actually a third person is coming"** —
    **pass:** it says the count cannot just be changed, names what is booked, and
    explains that it means cancelling and rebooking. **Fail:** it says it has added
    them, or changes the number and carries on as if the booking matched.

## G · The clinic moves the procedure

Built. Every date on the trip — the arrival deadline, the earliest return, the days
that are shopped — is derived from the procedure date, so moving it moves the whole
contract; the agent then repairs the bookings with the same sequence a cancellation
uses. Run the migration first if you have not: `0006_procedure_moved.sql`.

Start from a trip with a flight and a room booked (section A). Two doors, test both.

### From the console — the patient does not know

26. In the console, on that trip, the **Clinic moves the procedure to** button has a
    date beside it, defaulting to a week after the current procedure. Leave it, or
    set `2026-10-20 08:00`, and click. From a shell it is
    `npm run sabre:smoke -- ops procedure-moved <conversationId> 2026-10-20T08:00`.

**Pass:** the flash shows `was … now …` and, under `flight`, `fits: false` with the
leg that broke — for the default trip the return, because leaving on the 17th is
before the new earliest departure (the 24th at noon). The trip's line now reads
`procedure 2026-10-20 08:00`. Nothing in Sabre changed: `lookup <flight reference>`
still shows the segments `HK`.

27. Switch to the chat and **wait**.

**Pass:** the first bubble says the clinic moved the procedure, to when — "Tuesday 20
October at 8:00 am" — then what it does to the trip: the flight home leaves too early
for the new date, so the flights and the room have to move. It offers to look for
flights. **Fail:** it answers something else first; it says it has already rebooked
anything; it quotes a new reference.

28. **"ok, find me flights"**

**Pass:** the options are for the new dates — outbound landing by the 19th, return on
or after the 24th at noon. The old dates do not appear. If the options land on the
same day as before, the search is still using the old rules: that is a bug, report it.

29. **"take the cheapest"** → confirm → it calls `rebook_flight`.

**Pass:** new reference, old one superseded, and — because the stay changed — it says
the room no longer covers the flights, searches rooms for the new nights, gives the
total and the terms, and waits.

30. **"yes, move the room"**

**Pass:** `rebook_hotel`; new room reference. `lookup` both new references with Sabre.
The chain in the database shows both old rows `superseded`, each pointing at its
replacement, with the moved procedure as the reason.

31. **"what's my procedure date now?"**

**Pass:** the 20th at 8:00 am, and it does not re-announce the move as news.

### From the chat — the patient tells us

32. On a booked trip with no open events: **"the clinic just called, my procedure is now
    on the 20th at 8am"**

**Pass:** it calls `set_procedure_date` (nothing appears in the console's _Untold_ list,
because the patient already knows), then tells them which leg no longer fits and
offers to search. The rest is steps 28–30.

33. **"actually can we do the 12th instead?"** on the same trip.

**Pass:** it records the 12th and says the outbound now lands too late (the 12th at
5:30 am is after the new 11 October 20:00 deadline), and offers to search. Or, if the
date is too close to today to shop, it says so plainly — the tool refuses dates within
four days rather than searching into the past.

34. **"my procedure is on the 13th at 11 now"** — a same-day time change.

**Pass:** it records it and says nothing has to move: the flights still land the
evening before and leave four days after, and the room follows the flights.

**Fail, in every step:** the agent moving a procedure it was not told about, proposing
a date itself, or describing the trip as sorted while the room still starts on the
old date.
