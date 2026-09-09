# Video script

**TYPE** = what you type or click. **SAY** = what you read. Keep the dev-server log in
a corner; every tool named below shows there as `tool ok`.

Setup: `npm run dev`; chat at `localhost:3000`, new chat; `/ops` in a second tab;
a terminal for `npm run sabre:smoke -- lookup`; Supabase `bookings` table in a third.

---

## Part 1 — the automation

**SAY:** Doctours' travel coordinator. A patient has a procedure in Istanbul on 13
October. The chat is the whole interface; every booking is real, against Sabre's
sandbox.

**TYPE:** `just me`

**SAY:** Two tools ran. `set_party_size` saved the traveller count to this trip's
rules. `search_flights` hit Sabre, filtered every itinerary against the trip rules in
code, re-priced the survivors live, and saved twelve as bookable offers. The panel
shows all twelve; the chat reads out one.

**TYPE:** click **Take this flight** on the cheapest card

**SAY:** Clicking only puts a sentence in the chat. Nothing is booked. The agent asks
for passenger details — no passport number, we never store one.

**TYPE:** `gukesh amir, 6 may 1950, male, jessi316866@gmail.com, 6463875453`

**TYPE:** `yes`

**SAY:** `create_flight_order`: re-priced with Flight Check, sold with Create Booking,
read back with Get Booking. The reference comes straight from Sabre. Then, on its own,
`search_hotel_rates` — the next step is computed from what's booked. Nights come from
the flight, and because it lands before check-in, the night before was priced too.

**TYPE:** `the 5 nights, and ask them for early check-in`

**SAY:** `create_hotel_booking`. Guests were taken from the flight booking, so nothing
was asked twice. The early check-in request was written by code onto the reservation;
if the hotel's system refuses it, the room is booked without it and the patient is
told.

**TYPE:** terminal: `npm run sabre:smoke -- lookup <flight reference>`

**SAY:** Every segment confirmed in Sabre.

---

**SAY:** Level 1 — things that happen to the trip. The sandbox has no airline feed, so
this console plays the airline. It writes one event row and nothing else.

**TYPE:** `/ops` → **Airline cancels the outbound** → back to the chat, don't type

**SAY:** The agent spoke first. The event sits at the top of its prompt, a guard checks
the first bubble names the cancellation, and the event is marked told so it isn't
repeated.

**TYPE:** `ok find me flights`

**SAY:** Same search; the cancelled flight is excluded even though the sandbox still
sells it.

**TYPE:** click **Take this flight** → `yes`

**SAY:** `rebook_flight`: new flight sold first, old one released second, details
reused. Then it noticed the room no longer covers the new dates and searched rooms.

**TYPE:** `yes move the room`

**SAY:** `rebook_hotel`, same order.

**TYPE:** Supabase: `select kind, booking_reference, status, replaced_by, change_reason from bookings order by created_at`

**SAY:** Old rows are `superseded`, each pointing at its replacement, with the reason.

---

**TYPE:** `/ops` → **Clinic moves the procedure to** (default date) → chat, don't type

**SAY:** Every trip date derives from the procedure date. It recomputed the rules,
found the flights no longer fit, and raised it first. From here it's the same
rebooking.

---

**TYPE:** `I don't want this hotel, what else is there?`

**SAY:** `search_hotels` — real properties around the airport, priced for these nights.
The default hotel is booked without asking; alternatives only when asked.

**TYPE:** click **Stay here** on the Hilton

**SAY:** `choose_hotel` made it the trip's hotel; the room tools follow automatically.

**TYPE:** `money is tight — was there a cheaper way to do the whole trip?`

**SAY:** `compare_trip_totals` prices flight plus hotel for every option and ranks by
the sum. The arithmetic is in code; the model repeats it.

**TYPE:** `cancel the whole thing`

**SAY:** It states the cost and books nothing — cancelling needs an explicit confirm.

**TYPE:** `yes cancel it`

**SAY:** Hotel first, then flight, each verified in Sabre.

**TYPE:** terminal: `lookup` both references

**SAY:** Both empty. That's the automation end to end.

---

## Part 2 — how it's built

**SAY:** Next.js, Postgres, Anthropic API, Sabre behind a provider interface.

**SAY:** A tool loop. Fifteen tools, each a Zod schema and a handler. Every turn ends
with `reply`.

**SAY:** Rules are code. Deadlines, cabin, bags, party size, hotel — stored per trip,
read by the tools, never set by the model.

**SAY:** State is Postgres. The prompt is rebuilt every turn from bookings, offers and
events. The model books by id.

**SAY:** Side effects need a schema literal: `confirmed: true`, `theyToldMe: true`.

**SAY:** Output is guarded: references must exist in the database, announced actions
must have a tool call, untold events go first. One retry with the reason.

---

## Part 3 — level, and next

**SAY:** Level 0 done. Level 1 done, all nine, verified live. From Level 2, the
comparison panel. From Level 3, the console and proactive notification.

**SAY:** Next: more views as projections of the same state; console edits as events on
the same path; cookie becomes user id. Same loop, more tools.

---

## Part 4 — judgment calls

**SAY:** Thirty-eight in `DECISIONS.md`. The big ones:

**SAY:** Rules in code, not in the prompt.

**SAY:** No passport numbers — nothing files them.

**SAY:** Cancel-and-rebook, sell first, `superseded` chain.

**SAY:** Pinned hotel is a default; search only when asked.

**SAY:** Operator console instead of a fake feed.

**SAY:** Codeshares excluded — CERT can't confirm them.

**SAY:** Totals computed in code, never by the model.

---

## Part 5 — what's broken

**SAY:** Fares expire in twenty minutes.

**SAY:** Disruptions are simulated — CERT has no feed.

**SAY:** Three hotels in the sandbox.

**SAY:** Booking turns take thirty to fifty seconds.

**SAY:** The guards are regexes.

**SAY:** No accounts — a cookie owns the trips.

**SAY:** The model still narrates instead of acting sometimes. The guard catches the
known forms.

**SAY:** All of it is in `BUGS.md`, updated with the code.
