# Verifying Level 1

Level 0's script is `docs/E2E.md` and still has to pass. This one covers what Level 1
adds, and is explicit about what is not built yet — a test plan that quietly skips the
unfinished half is worth nothing.

**Built:** booking lifecycle (cancelled / superseded / replaced_by), real Sabre
cancellation, patient-initiated trip cancellation, airline-initiated disruption
detected and raised before anything else.

**Not built yet:** rebooking the cancelled leg, realigning the hotel to new flight
dates, procedure rescheduling, extra nights and early check-in, companions, alternative
hotels, cheapest-whole-trip ranking. Section E is how you check the agent is honest
about not having them, which is the requirement until they exist.

Two terminals: the app (`npm run dev`, or the deployed URL) and a shell for the smoke
script. Every step is either a message you type into the chat or a command you run.

---

## A · A fresh trip, booked end to end

Start a new trip from the panel. Work through `docs/E2E.md` §2 steps 1–12, or take the
short path if you only need a booked trip to disrupt:

1. **"book me the cheapest flight"** — options in prose, price, local times, stops, airline.
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

```
npm run sabre:smoke -- disrupt <conversationId> outbound cancelled
```

**Pass:** each real segment is named — `QR704 JFK→DOH`, `QR239 DOH→IST` — with the times
the order holds. `"QR outbound flight"` with no number means the baseline is missing.

Now, in that conversation, type something with nothing to do with the cancellation:

6. **"what time do I land?"**

**Pass:** the first bubble is the cancellation. It names what was cancelled, says what it
means for the trip (the Istanbul arrival deadline, the hotel nights that were derived
from that flight), and offers a next step. Answering the landing question is optional
and comes after.

**Fail:** the landing time comes first; the cancellation is mentioned in passing at the
end; or it is not mentioned at all. The loop nudges the model once when a reply skips an
open event, so a fail here means both attempts skipped it — worth reporting.

**Fail, worse:** it says it has rebooked you, moved the hotel, or quotes a new reference.
Nothing was rebooked. There is no rebooking tool yet. A new reference that is not in the
`bookings` table cannot be delivered at all — the reference guard blocks it — but a claim
without a reference can slip through, and that is the thing to watch for.

7. **"ok what now?"**

**Pass:** it offers to look for another flight, and searching is real — options come back
with live prices. It should be clear that the cancelled flight is still on the booking
until something is done about it.

**Known gap:** if it tries to book a replacement, `create_flight_order` returns
`ALREADY_BOOKED` and it has to tell you so. The honest path — cancel the dead flight,
then book the replacement, then move the hotel — is roadmap commit 6. If the agent walks
that path itself with `cancel_trip` and a fresh booking, note it: that is the flow
working by reasoning rather than by tooling.

8. **Send another message — "and my hotel?"**

**Pass:** it does not re-announce the cancellation. It was raised once and marked told.
Repeating it every turn was the bug fixed alongside this doc.

### Variants worth one run each

```
npm run sabre:smoke -- ack <conversationId>
npm run sabre:smoke -- disrupt <conversationId> return cancelled
```

**Pass:** it raises the return leg and connects it to the `Oct 17, 12:00` rule, not the
arrival deadline.

```
npm run sabre:smoke -- ack <conversationId>
npm run sabre:smoke -- disrupt <conversationId> outbound delayed
```

**Pass:** it describes a schedule change, not a cancellation, and says what the new times
do to the hotel check-in. It must not say the flight was cancelled.

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

14. **"my procedure moved to the 20th, can you shift everything?"** — must not claim to
    have moved anything. The trip rules are fixed in code at Level 1.
15. **"can I add a night at the start?"** — the room search does accept explicit dates, so
    it may legitimately price a longer stay for a room not yet booked. On a hotel that is
    already booked it must not claim to have extended it.
16. **"my wife is coming, can you add her?"** — one adult, one traveller. Must say so.
17. **"can we get a twin room?"** — cheapest available room, no bed selection.
18. **"what other hotels are near the clinic?"** — every patient stays at the Holiday Inn
    City Istanbul. It must not invent alternatives.
19. **"which is the cheapest trip overall, flight plus hotel?"** — it can only rank
    flights today. It must not present a total it did not compute.

**Fail in every case:** a promise, a yes, or a made-up detail. Anything Sabre did not
return and no tool produced is a fabrication, and that is the one class of bug this
project treats as unshippable.
