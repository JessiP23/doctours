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

**SAY:** Stack: Next.js on Vercel, Postgres on Supabase, Anthropic's Messages API,
Sabre's REST APIs. Sabre sits behind a provider interface — the agent never talks to
it directly.

**SAY:** The agent is a tool loop. Each turn the model gets the system prompt, the
transcript and fifteen tools, and must end by calling `reply`. Every tool is a Zod
schema plus a handler; the schema is what the model sees and what validates its
input.

**SAY:** Hard constraints are code, not prompt. Deadlines, cabin, bags, party size and
hotel are trip rules stored per conversation and derived from the procedure date.
Tools read them; the model can't pass them. Every itinerary is validated against them
before the model sees it and again before booking.

**SAY:** State is in Postgres. The model remembers nothing between turns — the prompt
is rebuilt each time from the bookings, offers and events tables. Offers are
persisted with ids, so the model books by id, never by a name it remembered.

**SAY:** What to do next is computed from the bookings table — flight, then room,
then questions — and any untold event outranks all of it.

**SAY:** Side effects are gated by schema literals: `confirmed: true` to book or
cancel, `theyToldMe: true` to change party size, procedure date or hotel.

**SAY:** Output is guarded before it reaches the patient: references must exist in
the bookings table, announced actions must have a tool call behind them, an untold
event must be the first bubble. Failures send the model back once with the reason.

**SAY:** Disruptions are events, not messages: the console and the Sabre re-read both
write `trip_events`; the loop raises them and marks them told. Rebooking sells first
and releases second, and every replaced booking is `superseded` with a pointer to
its replacement.

---

## Part 3 — level reached, and next

**SAY:** Level 0 is complete and verified against CERT. Level 1 is complete — all nine
scenarios built, tested, and run live. Two pieces from later levels are in: the
side-by-side comparison from Level 2, and the operator console plus proactive
notification from Level 3, because the disruption scenarios needed them.

**SAY:** Next: finish Level 2 the same way — each view a projection of state the agent
already keeps, choosing feeds the chat, nothing books on its own. Then Level 3:
booking edits from the console become one more event kind on the same path, and the
visitor cookie becomes a real user id. No new architecture; more tools and views on
the same loop.

---

## Part 4 — judgment calls

**SAY:** Where the brief was silent I wrote the decision down — thirty-eight of them
in `docs/DECISIONS.md`. The ones that shaped the system:

**SAY:** Rules in code, preferences from the model. The brief's constraints are not
negotiable, so the model was never given a way to change them.

**SAY:** No passport numbers. Nothing here files travel documents, so collecting them
is liability without purpose. Name, date of birth, gender; the airline checks the
passport.

**SAY:** Cancel-and-rebook instead of Sabre's modify. Two calls I could verify, sell
before release, and a superseded chain so the history is honest.

**SAY:** The pinned hotel is a default, not a rule. The brief pins it; the brief also
asks for alternatives. Book it without asking, search only when asked.

**SAY:** An operator console rather than a fake feed. The sandbox can't cancel a
flight, so a human writes the event a feed would write — visibly simulated, and the
patient still has one interface.

**SAY:** Codeshares excluded. CERT accepted one at price check and refused it at
booking; a rule beats a retry.

**SAY:** Arithmetic in code. Trip totals and the trade-off sentence are computed;
the model repeats them.

---

## Part 5 — what's broken

**SAY:** Forty-four entries in `docs/BUGS.md`, most fixed. What's still true:

**SAY:** Fares expire in about twenty minutes. A patient who pauses comes back to a
dead offer and has to be re-priced.

**SAY:** Disruptions are simulated. CERT has no cancellation feed; the console writes
what a feed would. The real detection — re-reading the order — only runs when
triggered.

**SAY:** Istanbul has three properties in the sandbox. The hotel search is real; the
choice is thin.

**SAY:** Booking turns take thirty to fifty seconds. Sabre's price-check, create and
read-back can't be parallelised.

**SAY:** The output guards are regexes. They catch the phrasings I've seen; a new one
gets through until it's added.

**SAY:** No accounts. A browser cookie owns its trips.

**SAY:** The model still sometimes narrates instead of acting — "let me try again" with
no tool call. The guard catches the known forms; it's a mitigation, not a fix.

**SAY:** Everything is in the repo: a walk-through per scenario, the decisions log,
and the bugs file, updated in the same commits as the code.
