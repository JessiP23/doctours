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

**SAY:** Next.js on Vercel, Postgres on Supabase, the Anthropic API with a custom
agent loop, Sabre behind a provider interface.

**SAY:** Fifteen tools, each a Zod schema plus a handler. The model never sets cabin,
bags, passengers, dates or deadlines — those are trip rules in code. It fills
preferences; code applies them. Booking needs `confirmed: true`; party size, procedure
date and hotel need `theyToldMe: true`.

**SAY:** State lives in Postgres, not the model. Every turn the prompt is rebuilt from
the tables: bookings with real references, offers with ids, untold events, and the
next step. Refresh or cold start resumes identically.

**SAY:** Guards, because the unforgivable failure is a booking that didn't happen:
references only copied from Sabre; invented locators blocked; "booking it now" with no
tool call blocked; untold changes must be the first bubble. Each nudges the model
once. 290 tests, most against real Sabre fixtures.

---

## Part 3 — level reached, and next

**SAY:** Level 0 done and verified. Level 1: all nine scenarios built and verified
live. From Level 2, the side-by-side comparison. From Level 3, the operator console
and the agent speaking first.

**SAY:** Rest of Level 2: more projections of state the agent already keeps, never a
second interface that books. Level 3: operator edits are already events told by the
same loop; editing a booking from the console is one more action. Auth: the visitor
cookie becomes a user id.

---

## Part 4 — judgment calls (38 in `docs/DECISIONS.md`)

**SAY:** Rules in code, preferences typed.

**SAY:** One hotel by design; others only on request.

**SAY:** No passport numbers — nothing here files documents.

**SAY:** Cancel-and-rebook, sell first — never leave a patient without a flight; the
superseded chain keeps history honest.

**SAY:** An operator console instead of a patient dashboard — the sandbox has no
airline or clinic, and the patient keeps one interface.

**SAY:** Codeshares excluded because the sandbox can't confirm them; totals computed
in code; the compare panel reads the offers table, not Sabre.

---

## Part 5 — what's broken (44 in `docs/BUGS.md`, most fixed)

**SAY:** Fares expire in about twenty minutes; a slow patient comes back to a dead
offer and gets re-priced.

**SAY:** Sandbox quirks: cached shop times drift from the order, so the order became
the baseline; a codeshare accepted at price check was refused at booking; the hotel
supplier rejected an early check-in note, so the room now books without it.

**SAY:** Istanbul has three properties in the sandbox — alternatives are real but few.

**SAY:** Disruptions are simulated; there is no feed. The real detection path is the
"Re-read from Sabre" button.

**SAY:** A booking turn takes thirty to fifty seconds — Sabre's calls must run in
sequence.

**SAY:** Guards are regexes; a new phrasing gets through until it's added.

**SAY:** No accounts — a browser cookie owns its trips.

**SAY:** Everything is in the repo: a walk-through per scenario, a decisions log, a
bugs file updated with the code. The rule throughout: a number the tools didn't
return is a number the patient doesn't hear.
