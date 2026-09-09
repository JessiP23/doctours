# Video script

Only two kinds of line. **TYPE** is what you type or click. **SAY** is what you read
aloud. Have the dev-server log visible in a corner: every SAY about a tool matches a
`tool ok` line you can point at.

Setup before recording: `npm run dev`; chat at `localhost:3000` (new chat); `/ops`
open in a second tab, token entered; a terminal for `npm run sabre:smoke -- lookup`;
Supabase `bookings` table in a third tab.

---

## Part 1 — the automation, step by step

**SAY:** This is Doctours' travel coordinator. A patient has a procedure in Istanbul
on 13 October. The conversation is their whole interface. Everything I book is real,
against Sabre's certification sandbox, and I'll show the agent's internals as we go.

**SAY:** The agent opened the conversation itself — there's no model call for that,
it's a fixed greeting — and its first question is the party size, because prices,
room occupancy and passports all depend on it.

**TYPE:** `just me`

**SAY:** Two tool calls just happened. `set_party_size` with `travellers: 1` and
`theyToldMe: true` — that literal is in the schema, so the model can't file a number
the patient never said; it's written to this trip's rules snapshot in Postgres. Then
`search_flights`: four Sabre Flight Shop calls in parallel, one per allowed date pair,
about thirty-five itineraries back. Code, not the model, validates each one against
the trip rules — on the ground by the twelfth at eight pm, no return before the
seventeenth at noon, economy, no codeshares. The survivors are re-priced live with
Flight Check, the twelve most useful are persisted as offers with ids, and the model
is handed those ids. It read out one; the panel opened with all twelve.

**SAY:** The panel is not a tool and not a second interface. It's a projection of the
offers table — the same rows the model sees — with the facts a patient compares on:
hours inside the deadline, nights implied, cheapest and non-stop badges.

**TYPE:** click **Take this flight** on the cheapest card

**SAY:** Clicking sent a sentence into the chat. Nothing was booked. The model matched
the sentence to an offer id under LIVE STATE and asked for details — name, date of
birth, gender, email, phone. No passport number: nothing here files travel documents,
so we don't collect them.

**TYPE:** `gukesh amir, 6 may 1950, male, jessi316866@gmail.com, 6463875453`

**SAY:** It reads the details back before booking. That's a prompt rule: a typo in a
ticketed name costs money and only the patient can catch it.

**TYPE:** `yes`

**SAY:** `create_flight_order`. Guard chain first: the offer exists in this
conversation, nothing is already booked, the fare hasn't expired. Then three Sabre
calls in order — Flight Check re-prices, Create Booking sells, Get Booking reads the
order back. The reference you see was copied from Sabre's response; no code path
constructs one. The itinerary Sabre actually holds is stored as the baseline for
disruption checks. Then, without being asked, it went to the hotel: `nextStep` is
computed from the bookings table — flight booked, no room, so room. `search_hotel_rates`
derived the nights from the booked flight, called Get Hotel Details, and because this
flight lands before check-in it priced the night before as well.

**TYPE:** `the 5 nights, and ask them for early check-in`

**SAY:** `create_hotel_booking` with `earlyCheckIn: true` and no guests — the travellers
come from the flight booking, so it never asks for details twice. Hotel Price Check
mints the booking key, Create Booking sells the room with an early check-in
instruction written by code from the itinerary, not typed by the model. If the
supplier refuses the note, it books the room without it and says so. Two references,
both real.

**TYPE:** in the terminal: `npm run sabre:smoke -- lookup <flight reference>`

**SAY:** Every segment HK — held and confirmed. That's the same Get Booking call the
agent used.

---

**SAY:** Now the part the brief calls Level 1: things that happen to the trip. The
sandbox has no airline feed, so this console plays the airline. It writes one row to
`trip_events` and nothing else — no booking touched, Sabre not called.

**TYPE:** in `/ops`, on this trip, click **Airline cancels the outbound**

**SAY:** Switch to the chat and don't type. The console handed the conversation to
the agent after responding — Next.js `after()` — and the chat polls while idle.

**TYPE:** wait

**SAY:** It spoke first. The open event went to the top of its system prompt, above
anything I could have typed, and a guard checked that the first bubble actually names
the cancellation — if it hadn't, the loop would have sent it back once. The event is
now acknowledged, so it won't be repeated.

**TYPE:** `ok find me flights`

**SAY:** Same `search_flights`, one difference: the cancelled flight is excluded by
carrier, number and date. The sandbox still sells it; we won't offer it back.

**TYPE:** click **Take this flight** on the cheapest → `yes`

**SAY:** `rebook_flight`, not `create_flight_order` — create refuses while a flight
exists. It sells the replacement first, records the old row as superseded pointing at
the new one, and only then cancels the old order. A patient holding no flight is the
worst state, so a failed sell changes nothing. Traveller details were reused. Then it
compared the room to the new flights: the nights no longer cover them, so it searched
rooms for the new dates and is waiting for a yes.

**TYPE:** `yes move the room`

**SAY:** `rebook_hotel`, same order: new room sold, old row superseded, old
reservation released.

**TYPE:** Supabase: `select kind, booking_reference, status, replaced_by, change_reason from bookings order by created_at`

**SAY:** The chain. Nothing was deleted; the trip moved and the history says why, in
the words the patient was given.

---

**TYPE:** in `/ops`, click **Clinic moves the procedure to** — leave the default date

**SAY:** Every date on this trip derives from one fact, the procedure date: arrive by
the evening before, leave no earlier than four days after, which days to shop.
`moveProcedure` recomputed the rules snapshot, judged the booked flights against them
with the same validators the search uses, and wrote a `procedure_moved` event.

**TYPE:** wait

**SAY:** Raised first, unprompted, with the new date and which leg no longer fits.
From here it's the same rebooking sequence, on the new dates. The patient could also
have told us themselves — `set_procedure_date` runs the same function, without the
event, because then they already know.

---

**TYPE:** `I don't want this hotel, what else is there?`

**SAY:** `search_hotels`. The default hotel is booked without asking; alternatives
only when asked. This is Sabre's geo availability around the arrival airport for the
nights the flights imply — the three properties Istanbul has in the sandbox, each
with distance, address and a price for these nights, each persisted with an id. The
panel shows them as cards.

**TYPE:** click **Stay here** on the Hilton

**SAY:** `choose_hotel`: the trip's hotel is trip state, like the party size. It
rewrote `rules.hotel`; every room tool reads the rules, so they follow without
knowing anything changed. The room already held is untouched until the patient agrees
to move it.

**TYPE:** `money is tight — was there a cheaper way to do the whole trip?`

**SAY:** `compare_trip_totals`. The cheapest flight isn't the cheapest trip when it
lands a day early and adds a night. It re-priced the cheapest flights for each
distinct stay, priced one room per stay concurrently, ranked by the sum, and wrote the
trade-off sentence with the subtraction already done. The model repeats a number; it
never computes one.

**TYPE:** `cancel the whole thing`

**SAY:** It states the cost first and books nothing. `cancel_trip` takes a
`confirmed: true` literal, so discussing cancellation can't perform it.

**TYPE:** `yes cancel it`

**SAY:** Hotel first, then flight, each verified by reading the order back. If either
were still live it would say which, never "cancelled".

**TYPE:** terminal: `lookup` both references

**SAY:** Both empty. That's the automation, end to end.

---

## Part 2 — how it's put together

**SAY:** Next.js on Vercel, Postgres on Supabase, the Anthropic Messages API with a
custom agent loop, Sabre REST behind a `TravelProvider` interface the agent never
looks past.

**SAY:** Fifteen tools, each a Zod schema and a handler. The schema is both what the
model sees and what validates its input. The model never sets cabin, baggage,
passengers, dates or deadlines — those are trip rules in code, snapshotted per
conversation, derived from the procedure date. The model fills preferences; code
applies them. Booking takes `confirmed: true`; party size, procedure date and hotel
take `theyToldMe: true`.

**SAY:** State lives in Postgres, not in the model. Every turn the system prompt is
rebuilt from the tables: what's booked with real references, which offers are on the
table with their ids, what's still untold, and `nextStep` computed from the bookings.
A refresh, a new tab or a cold lambda resume identically. Rules can change mid-turn —
party size, procedure date, hotel — and the loop re-reads them so the prompt never
describes yesterday's trip.

**SAY:** Four guards, because the one unforgivable failure is reporting a booking that
didn't happen. References are only copied from Sabre. The prompt may only quote
references in the bookings table. A regex blocks locator-shaped tokens that aren't in
it. Another catches "booking it now" or "let me try again" with no tool call behind
it. Another checks that an untold change is the first bubble. Each nudges the model
once with the reason. Two hundred and ninety tests, most of them against real Sabre
fixtures.

---

## Part 3 — level reached, and next

**SAY:** Level 0 complete and verified against CERT. Level 1: all nine scenarios built
and verified live. From Level 2, the side-by-side comparison. From Level 3, the
operator console and the agent speaking first — the disruption scenarios needed them.

**SAY:** The rest of Level 2 I'd build the same way as the comparison: projections of
state the agent already keeps, never a second interface that books on its own.
Level 3 is mostly here — operator edits are `trip_events`, told to the patient by the
same loop; what's missing is editing a booking from the console, which is one more
action writing the same kind of event. Auth is one change: the visitor cookie becomes
a user id.

---

## Part 4 — judgment calls (38 in `docs/DECISIONS.md`)

**SAY:** Rules in code, preferences typed — the model maps words onto a schema and
never reasons over dates or deadlines.

**SAY:** One hotel by design, others on request — "doesn't want the default" is a
preference, so the default is booked without asking and the search runs only when
asked.

**SAY:** No passport numbers — nothing here files documents; collecting them would be
holding sensitive data for no purpose.

**SAY:** Cancel-and-rebook, sell first — no `modifyBooking`; two calls I trust, in the
order that never leaves a patient without a flight, and a superseded chain that keeps
the history honest.

**SAY:** An operator console, not a patient dashboard — the sandbox has no airline or
clinic, so a console that writes only events keeps the demo honest about what's
simulated, and the patient keeps one interface.

**SAY:** Codeshares excluded because CERT can't confirm them; the order, not the
shop cache, is the baseline for disruption checks; totals and the trade-off sentence
computed in code; the compare panel reads the offers table.

---

## Part 5 — what's broken (44 in `docs/BUGS.md`, most fixed)

**SAY:** Fares expire after about twenty minutes. A patient who goes to find their
passport comes back to a dead offer; the agent re-prices and says so, but it's a real
gap.

**SAY:** CERT quirks worked around, not fixed: the flight shop is cached and its times
drift from the order by minutes, which produced false schedule changes until the order
became the baseline; a codeshare Flight Check accepted was refused at Create Booking,
which is why codeshares are excluded; the hotel supplier rejected a reservation with an
early check-in note attached, so the room is now booked without it and the patient is
told.

**SAY:** Istanbul inventory in the sandbox is three properties. The alternatives
search works; the list is short because the sandbox is.

**SAY:** Disruptions are simulated. There is no cancellation feed in CERT; the console
writes what a feed would write. The real detection path — re-reading the order and
comparing statuses — is exercised only by the "Re-read from Sabre" button.

**SAY:** Latency. A booking turn is thirty to fifty seconds because Sabre's price
check, create and read-back must run in sequence. Searches are parallel; bookings
can't be.

**SAY:** The guards are regexes, not understanding. They catch the phrasings I've seen
the model use and nudge once; a new phrasing gets through until it's added.

**SAY:** No accounts. A browser cookie owns its trips — fine for a demo, not for a
patient.

**SAY:** Everything shown is in the repo with a walk-through per scenario, a decisions
log, and a bugs file updated in the same commit as the code. The rule I held
throughout: a number the tools didn't return is a number the patient doesn't hear.
