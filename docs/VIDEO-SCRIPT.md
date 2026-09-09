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

**SAY:** It's a Next.js app on Vercel with Postgres on Supabase. The agent is a loop
over the Anthropic API with fifteen tools, and Sabre sits behind a provider interface.
The model never touches Sabre directly — tools do. Every tool is a schema plus a
handler, and the hard rules of the trip — deadlines, cabin, bags, party size, hotel —
live in code, not in the prompt, so the model can't change them. Nothing is kept in
the model's memory: every turn the prompt is rebuilt from the database — what's
booked, what's on offer, what hasn't been told yet — and the next step is computed
from that. Anything with a side effect needs an explicit flag in the schema, and
every reply is checked before it goes out: no reference that isn't in the database, no
"booking it now" without a booking, and any untold change goes first.

---

## Part 3 — level, and next

**SAY:** Level 0 is done. Level 1 is done — all nine scenarios, verified live. I also
built the comparison panel from Level 2 and the operator console with proactive
notification from Level 3, because the disruption scenarios needed them. Next would be
the rest of Level 2 as more views over the same state, and Level 3 as console edits
flowing through the same event path. Same loop, more tools.

---

## Part 4 — judgment calls

**SAY:** The brief left some things open, so I had to decide them myself. Each decision
is written in `DECISIONS.md` with the reason. The main ones:

The brief gives fixed dates and rules but doesn't say who enforces them. I put them in
code, so the model can't bend them.

The brief doesn't say what passenger data to collect. I collect name, date of birth and
gender only — no passport numbers, because nothing in this system needs them.

The brief says "rebook" but not how. Sabre has a modify call; I chose cancel-and-rebook
instead, booking the new flight before releasing the old one, so the patient never
ends up with nothing.

The brief pins one hotel and also asks for alternatives. I treat the pinned hotel as the
default and only search others when the patient asks.

The brief asks for airline cancellations, but the sandbox can't produce one. I built an
operator console that simulates them, openly, instead of faking a feed.

The sandbox accepted a codeshare flight at price check and then refused to book it. I
excluded codeshares.

And every price total is computed in code, never by the model.

---

## Part 5 — what's broken

**SAY:** Fares expire in twenty minutes, so a slow patient gets re-priced.
Disruptions are simulated — the sandbox has no feed. Istanbul has three hotels in
the sandbox. A booking turn takes thirty to fifty seconds because Sabre's calls are
sequential. The output guards are regexes, so a new phrasing gets through until it's
added. There are no accounts — a cookie owns the trips. And the model still sometimes
narrates instead of acting; the guard catches the known forms. All of it is in
`BUGS.md`.
