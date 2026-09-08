# Level 1 — roadmap

Level 0 is done, deployed and verified. Nothing in Level 0 gets restructured: every
item below extends the existing seams rather than replacing them.

## What Level 0 already gives us

| Level 1 needs                | Already there                                                                             |
| ---------------------------- | ----------------------------------------------------------------------------------------- |
| Rank by fewest layovers      | **Done.** `search_flights` takes `rankBy: 'fewest_stops'`, tested                         |
| Rules that vary per trip     | `conversations.trip_rules` is a snapshot, not a constant                                  |
| Cancelling frees a slot      | `bookings` partial unique index applies only to `status = 'confirmed'`                    |
| Bed types for a companion    | Hotel mapper carries `bedTypes` and `maxOccupancy`; 10 of 35 rates are twin               |
| Searching other hotels       | `buildHotelAvailRequest` already has the geo path; the probe found 3 Istanbul properties  |
| Two passengers on a ticket   | Create Booking takes a `travelers` array; the provider signature is already `Passenger[]` |
| Repeated searches stay fast  | `TtlCache` — reused by the cheapest-total work                                            |
| Preferences from plain words | `FlightPreferences` schema + `applyPreferences`                                           |

So Level 1 is mostly **new tools over existing machinery**, plus one migration.

## Three rules for every commit

1. **Propose → confirm → apply.** Nothing destructive happens in the turn that
   suggests it. A reschedule tool returns a plan with prices; a separate apply tool
   executes it after the patient says yes. This is correct behaviour for someone's
   surgery trip, and it keeps every turn well under the platform's 60-second limit —
   a reschedule touches four provider calls and cannot share a turn with a search.
2. **Rules stay in code, preferences stay typed.** New capabilities are either a
   rule (enforced, immovable) or a preference (a schema field the model fills). Never
   free-text reasoning over a shortlist.
3. **Every commit ends working end to end**, with a smoke command or test that proves
   it against CERT, and a `DECISIONS.md` entry for any judgment call.

## Deliberately not doing

- **Tables, charts, side-by-side comparison.** That is Level 2's first bullet, and
  Level 0 requires plain-text replies. Keep the chat prose.
- **Airline disruption feeds.** There is no cancellation webhook in CERT. The trigger
  for "my flight was cancelled" is the patient saying so, or an operator; a
  `simulate-disruption` smoke command demonstrates it. Say this on camera rather than
  implying a live feed exists.
- **`modifyBooking` for hotel date changes.** Sabre has it, but cancel-and-rebook uses
  the two calls we already trust and is far more reliable in CERT. It produces a new
  reference, which is why bookings get a `superseded` state and a `replaced_by` link.
  Note the tradeoff in DECISIONS; a production system would try modify first.

---

## The commits

Each block is a complete spec — precise enough to hand straight to an agent as the
prompt for that commit.

### 1 · `feat(db): booking lifecycle — cancelled, superseded, and the chain between them`

**Files:** `supabase/migrations/0003_booking_lifecycle.sql`, `lib/db/types.ts`, `lib/db/repo.ts`, `tests/`

Add to `bookings`: `status` gains `'superseded'`; new `replaced_by uuid references bookings(id)`,
`cancelled_at timestamptz`, `change_reason text`. The existing partial unique index on
`status = 'confirmed'` stays exactly as it is — that is what lets a cancelled or
superseded booking sit alongside its replacement.

Repo functions: `cancelBookingRow(id, reason)`, `supersedeBookingRow(oldId, newId, reason)`,
`listBookingHistory(conversationId)` returning newest first with the chain resolved.

Statuses are deliberately only these four. There is no `paid` (Doctours pays, and the
agency card guarantees the room) and no `pending` (Create Booking is synchronous).
Record that in DECISIONS so the omission reads as a decision, not an oversight.

**Done when:** a conversation can hold a cancelled flight, a superseded flight and a
confirmed flight at once; `get_trip_state` shows only the live ones; history is
traceable. Tests cover each transition and the index still rejecting two live bookings.

### 2 · `feat(sabre): cancel an order`

**Files:** `lib/providers/sabre/requests.ts`, `lib/providers/sabre/index.ts`, `lib/providers/types.ts`, `scripts/sabre-smoke.ts`

`POST /v1/trip/orders/cancelBooking` with `{confirmationId, targetPcc, retrieveBooking: true,
cancelAll: true, errorHandlingPolicy: 'ALLOW_PARTIAL_CANCEL'}`. Add `cancelBooking(reference)`
to the `TravelProvider` interface and implement it. Then **verify with Get Booking** — a
cancel that Sabre accepted but did not apply must not be reported as done.

Smoke: `npm run sabre:smoke -- cancel <reference>` prints what was cancelled and what
Get Booking says afterwards.

**Done when:** one of the existing test references is cancelled and the lookup proves it.

### 3 · `feat(agent): cancel the trip`

**Files:** `lib/agent/tools/cancel_trip.ts`, `index.ts`, `system.ts`

Answers _"What if the patient cancels the trip entirely?"_ completely.

`cancel_trip({ scope: 'flight' | 'hotel' | 'both', confirmed: boolean })`. The schema
requires `confirmed: true`, and the prompt says it may only be passed after the patient
has said yes in the conversation — the same shape as the booking guard. Cancels the hotel
first (it carries a cancellation deadline and a deposit), then the flight, marks both
rows cancelled with the reason, and reports what was cancelled, what the terms were, and
anything non-refundable. If one leg fails, say exactly which is still live.

**Done when:** book → cancel → `get_trip_state` shows nothing booked, and a fresh booking
is possible in the same conversation.

### 4 · `feat(trip): derive the rules from the procedure date`

**Files:** `lib/trip/rules.ts`, `tests/trip.test.ts`

Today the deadlines are literals. Replace them with the relationships they encode:

```
deriveTripRules({ procedureAtLocal, origin, destination, travellers, hotel }) → TripRules
  mustArriveByLocal            = 20:00 the evening before the procedure
  earliestReturnDepartureLocal = 12:00 four days after the procedure
  outboundDepartureDates       = the two days before mustArriveBy
  returnDepartureDates         = the earliest return day and the one after
```

`TRIP_RULES` becomes `deriveTripRules(DEFAULT_TRIP)` and produces byte-identical values
to today, so every existing boundary test must still pass unchanged. That is the proof
the refactor is safe.

**Done when:** moving the procedure a week later moves all four fields consistently, and
the Level 0 tests are untouched and green.

### 5 · `feat(agent): reschedule the whole trip when the procedure moves`

**Files:** `lib/agent/trip-service.ts` (new), `lib/agent/tools/reschedule_trip.ts`, `apply_reschedule.ts`

Answers _"the procedure gets moved and the whole trip needs new dates."_

`reschedule_trip({ newProcedureAtLocal })` — **proposes only.** Derives new rules, searches
flights under them, derives the new stay, prices the cheapest compliant room, and returns a
plan: new flight option, new nights, new total, and the delta against what is booked. Nothing
is cancelled.

`apply_reschedule({ planId, confirmed })` — executes in a safe order: book the new flight
first, then the new hotel, and only then cancel the old ones, linking each old row to its
replacement with `replaced_by`. **Book before cancel**: if the new booking fails, the patient
still has their original trip. If the new hotel fails after the new flight succeeded, say so
plainly and leave both old bookings live.

Extract the shared work into `trip-service.ts` — `bookFlightFor(rules, offer, travellers)`,
`bookStayFor(rules, stay)`, `replaceBooking(oldId, newId, reason)` — so the booking tools
and the disruption tools call the same code rather than duplicating the guard chain.

**Done when:** a booked trip is rescheduled two weeks later and Get Booking shows a new
confirmed flight and hotel with aligned dates, both old references cancelled and linked.

### 6 · `feat(agent): handle a cancelled flight, outbound or home`

**Files:** `lib/agent/tools/report_disruption.ts`, `apply_disruption_fix.ts`, `scripts/sabre-smoke.ts`

Answers the first two Level 1 questions.

`report_disruption({ leg: 'outbound' | 'return', kind: 'cancelled' | 'delayed', newArrivalLocal? })`
proposes the fix; `apply_disruption_fix({ planId, confirmed })` performs it.

- **Outbound cancelled** → rebook the outbound under the same rules (the deadline still
  applies — a replacement that lands after 8 PM is not a fix), recompute the stay, and
  adjust the hotel. Report the new check-in and the cost difference.
- **Return cancelled** → rebook the return, which usually adds nights. Extend the stay and
  quote the extra nights explicitly.

The trigger is the conversation or an operator, and `npm run sabre:smoke -- simulate-disruption
<conversationId> outbound` drives it for the demo. Be explicit in the video that CERT has no
cancellation feed.

**Done when:** both directions are demonstrated end to end and the hotel dates always match
the flight actually held.

### 7 · `feat(hotel): early arrival, early check-in, and the extra night`

**Files:** `lib/agent/tools/create_hotel_booking.ts`, `search_hotel_rates.ts`, `system.ts`

Answers _"lands before check-in… and if they arrive a full day early, how do they pay?"_

`earlyArrival` is already surfaced. Add: when it is present, the booking sends
`specialInstruction` requesting early check-in (Create Booking already accepts it), and the
agent says it is a **request the hotel may decline**, never a guarantee. When the flight lands a
full day early, the derived stay already adds the night — make the cost explicit: quote the
extra night's rate and the new total as a difference, not just a bigger number.

**Done when:** a booking made from a 05:30 arrival carries the instruction, Get Booking shows
it, and the agent's message states the extra night's cost.

### 8 · `feat(trip): a companion`

**Files:** `lib/trip/rules.ts`, `lib/providers/types.ts`, `lib/trip/select.ts`, hotel tools, `system.ts`

Answers _"a husband and wife probably want one bed, two sisters probably want two."_

`TripRules.travellers: Traveller[]` replaces `adults` (which becomes `travellers.length`).
Flight search and booking pass all travellers; Create Booking's `travelers` array already
supports it.

Room selection gains a `beds: 'one' | 'two'` preference and filters rates on `bedTypes` and
`maxOccupancy >= travellers.length`. **The agent asks; it does not infer.** A relationship is a
hint for how to phrase the question, never a reason to book a bed configuration silently — the
prompt must say so, and the tool must not accept a relationship as a substitute for an answer.

**Done when:** a two-traveller trip books a twin room and a one-bed room on request, both
travellers appear on the flight order, and the agent asked rather than assumed.

### 9 · `feat(hotel): choose a different hotel`

**Files:** `lib/providers/sabre/index.ts`, `lib/providers/sabre/hotel-mappers.ts`, `lib/agent/tools/search_hotels.ts`, `select_hotel.ts`

Answers _"the patient doesn't want the default hotel."_

`searchHotels({ nearCode, radiusMiles, checkIn, checkOut })` on the geo path we already
built — the probe proved Ritz-Carlton, Hilton and Holiday Inn return rates around IST at
30 miles. Map `HotelAvailInfo` into properties with a lead rate and distance.
`select_hotel({ propertyId })` writes the choice into the conversation's `trip_rules.hotel`;
the existing room search and booking flow then works unchanged.

The default stays pinned, and the agent still explains that the Holiday Inn is the clinic's
property — this is an override, not a free-for-all.

**Done when:** a room is booked at the Hilton in one conversation and the Holiday Inn in
another, from the same code.

### 10 · `feat(trip): the cheapest whole trip, not the cheapest flight`

**Files:** `lib/trip/select.ts`, `lib/agent/tools/search_flights.ts`, `tests/`

Answers _"flight price and hotel price trade off against each other."_

For each candidate flight, derive the stay and price the cheapest compliant room for those
nights, then rank by **flight + room**. A $1,069 flight landing a day early costs an extra
night; a $1,286 flight landing on time may win. Reuse `TtlCache` keyed on
`(propertyId, checkIn, checkOut)` so scoring twenty flights makes two or three hotel calls,
not twenty.

New preference `optimizeFor: 'flight_price' | 'total_trip_cost'`. The response shows the
breakdown so the agent can explain _why_ the dearer flight is cheaper overall — that
sentence is the whole point of the feature.

**Done when:** on the real fixtures, total-cost ranking differs from flight-price ranking,
and the agent's explanation names both numbers.

### 11 · `test: Level 1 end to end, and the honest write-up`

**Files:** `scripts/sabre-smoke.ts`, `docs/E2E.md`, `docs/BUGS.md`, `docs/DECISIONS.md`, `README.md`

Extend the deterministic script with `e2e-cancel`, `e2e-disruption`, `e2e-reschedule`,
`e2e-companion` — each booking against CERT, verifying with Get Booking, recording
references. Update the conversation checklist with the Level 1 flows, and write up every
judgment call and every remaining gap.

**Done when:** `npm run sabre:smoke -- e2e-all` runs the whole Level 1 surface against CERT
and ends with verified references for each flow.

---

## Order and why

1–2–3 first: the state model and cancel are what everything else composes from, and commit 3
alone completely answers one Level 1 question. 4–5 next: deriving rules from the procedure
date is the refactor that unlocks rescheduling, and doing it early means the later commits
inherit it. 6 reuses 5's service layer almost entirely. 7–8–9 are independent and can be
reordered freely. 10 is last because it is the only one that benefits from everything else
being stable. Fewest-stops ranking needs no commit — demonstrate it.

## Risks to watch

| Risk                                              | Handling                                                                                                                                                                                                       |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A cancel succeeds at Sabre but the DB write fails | Verify with Get Booking, then write; on write failure the next `get_trip_state` reconciles from Sabre rather than trusting our row                                                                             |
| Rebooking leaves the patient with nothing         | Always book the replacement before cancelling the original                                                                                                                                                     |
| CERT refuses a cancel on a ticketed order         | Our orders are `isTicketed: false`, so this should not arise — but check `isCancelable` before promising                                                                                                       |
| Turn exceeds 60s                                  | Propose and apply are separate tools in separate turns; hotel rates cached                                                                                                                                     |
| Tool count grows past what the model handles well | Level 1 adds eight tools to six. Keep each single-purpose; if the model starts mis-selecting, group the disruption tools behind one `fix_trip` tool with an operation enum rather than shortening descriptions |
