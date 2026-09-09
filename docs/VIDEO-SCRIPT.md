# Video script — Doctours travel coordinator

Target: 10–12 minutes. Two windows open: the chat (deployed URL) and the operator
console at `/ops`. A terminal for `npm run sabre:smoke -- lookup <ref>`. Supabase
table view on a third tab for the `bookings` chain. Speak plainly; every claim
below is something the screen shows.

Structure follows the brief: **1** show it working, **2** how the agent is put
together, **3** the level reached and the next one, **4** judgment calls, **5**
what's broken.

---

## 0 · Opening (30s)

**Say:** "This is Doctours' travel coordinator. A patient has a procedure in
Istanbul on 13 October. The only interface is this conversation — it books a real
flight and a real hotel against Sabre's certification sandbox, and every reference
you'll see can be looked up in Sabre. I'll show it working end to end, then how it's
built, what I decided where the brief was silent, and what's still broken."

---

## 1 · Show it working (5–6 min)

### 1a · A whole trip, priced as a whole (Level 0 + Q8, Q9, Q6)

Fresh chat. The greeting asks how many are travelling.

**Type:** `just me`
**Say:** "It asks the party size before it searches — prices, room occupancy and
how many passports it needs all depend on it, so it's trip state, not an assumption."

**Type:** `money is tight, what's the cheapest way to do the whole trip, flights and hotel?`
**Say (while it runs, ~20s):** "It's re-pricing eleven flights live and pricing a room
for every distinct stay those flights imply — the cheapest fare often lands a day
early and adds a night. It ranks by the sum, and the sentence it gives me has the
arithmetic already done, so the model never adds prices."

When the answer lands: point at the total, the two halves, and the trade-off.

**Click** the **Compare N options** pill. **Say:** "Same options, side by side. This
panel is a projection of what the agent already showed — same ids, same prices, no
new search. What it adds is what you compare on: how far inside the deadline each
flight lands, the nights it implies, the trip total when a matching room is on the
table." **Click** _Take this flight_ on the cheapest. **Say:** "Choosing doesn't book.
It says so in the chat, and the agent takes it from there — the conversation stays
the interface."

Give details when asked, confirm the read-back, watch it book flight then room.

**Say:** "Two references. Both real." Terminal: `lookup <flight ref>` — segments
`HK`. "And it told me I land before check-in — the hotel says 2 pm."

### 1b · The airline cancels the flight — and the agent speaks first (Q1, Q2)

Console tab. **Say:** "The sandbox can't cancel a flight for us, so this console
plays the airline. It writes the event a real feed would write and nothing else — no
booking is touched, Sabre isn't called."

**Click** _Airline cancels the outbound_. Switch to the chat. **Don't type.**

**Say:** "I haven't said anything." Wait for the typing indicator and the bubble.
"It raised it before anything else, named the exact flights, and said what it does
to the hotel nights."

**Type:** `ok find me flights` → **Say:** "The cancelled flight isn't offered back —
the sandbox still lists it; the search excludes it by carrier, number and date."
**Type:** `take the cheapest` → confirm. **Say:** "Rebooking sells the replacement
first and releases the old order second. A patient with no flight is the worst
state, so a failed sell leaves them where they were. Then it tells me the room no
longer covers the new flights." → **Type:** `yes move the room`.

Supabase tab: `select kind, booking_reference, status, replaced_by, change_reason
from bookings order by created_at`. **Say:** "The old rows are `superseded`, each
pointing at what replaced it, with the reason in the words I was given. The trip
moved; it wasn't abandoned."

### 1c · The clinic moves the procedure (Q4)

Console: **Clinic moves the procedure to** — default a week later. **Click.**
**Say:** "Every date on this trip derives from one fact, the procedure date: land by
the evening before, no return before four days after, which days to shop. Move the
date, everything recomputes." Chat: wait; it raises it, then `ok find me flights` →
dates are the new ones → rebook → room follows. (If short on time, show the console
flash and the first bubble only.)

### 1d · Not that hotel (Q7), early landing (Q3), cancel (Q5)

**Type:** `I don't want this hotel, what else is there?` → real properties with
distance from the airport and a price for these nights. **Say:** "The default hotel
stays pinned and is booked without asking. Alternatives only when the patient asks —
and only what Sabre returned." Open the compare panel: hotel cards. **Type:** `the
Hilton` → it switches the trip's hotel and searches rooms there.

**Type:** `can I get into the room early?` → two honest answers: an extra paid night
with its price, or a request the hotel may not honour. **Say:** "Two options, both
real — one is a rate, the other is text on the reservation. It never promises early
check-in."

**Type:** `cancel the whole thing` → it states the cost → `yes cancel it` → hotel
first, then flight. Terminal: `lookup` both — empty. **Say:** "Cancellation needs an
explicit confirmed flag in the tool schema; discussing cancelling can't perform it."

---

## 2 · How it's put together (2–3 min)

Show `lib/agent/tools/` in the editor, then `lib/agent/system.ts`, then the
`bookings` / `offers` / `trip_events` tables.

**Say:**

"Next.js on Vercel, Postgres on Supabase, the Anthropic Messages API with a custom
agent loop, and Sabre's REST APIs behind a `TravelProvider` interface — the agent
never imports Sabre.

**Tools.** Fifteen, each a Zod schema plus a handler; the schema is what the model
sees and what validates its input. The interesting part is what they refuse. The
model can't set cabin, baggage, passengers, dates or deadlines — those are trip
rules, in code, snapshotted per conversation and derived from the procedure date.
The model fills preferences: cheapest, fewest stops, a date the rules already
allow. Every itinerary is validated against the rules before the model sees it and
again before it's booked. Booking tools take a `confirmed: true` literal; party size
and the procedure date take `theyToldMe: true`, so a value the patient never said
can't be filed.

**State.** The agent remembers nothing between requests. Every turn the system
prompt is rebuilt from the database: what's booked with real references, what
options are on the table with their ids, what still needs doing, and anything that
happened to the trip the patient hasn't been told. A refresh, a new tab or a cold
lambda all resume identically. Offers are persisted, so the model books by id and
never by a name it remembered.

**Deciding what to do next.** `nextStep` is computed, not remembered: no flight →
flight; flight and no room → room; both → answer questions. Open trip events outrank
everything and go first in the prompt. The loop ends every turn with a `reply` tool
that returns one to four plain-text bubbles.

**Guards, because the one unforgivable failure is reporting a booking that didn't
happen.** A reference is only ever copied from Sabre's response. The prompt may only
quote references in the bookings table. A regex guard blocks locator-shaped tokens
that aren't in that table. Another catches 'booking it now' or 'let me try again'
with no tool call behind it. A third checks the first bubble actually raises an
untold change. Each nudges the model once with the reason.

**Proactive.** An operator action runs the agent's turn after the response; the
chat polls while idle and reveals what it hasn't shown. Events are acknowledged once
delivered, so nothing is re-announced."

---

## 3 · Level reached, and the next one (1 min)

**Say:** "Level 0 complete and verified against CERT. Level 1: all nine scenarios
built and verified live. From Level 2, the side-by-side comparison. From Level 3, the
operator console and the agent speaking first — the disruption scenarios needed
them, so they came early.

The rest of Level 2 I'd approach the same way the compare view was done: as
projections of state the agent already keeps, never as parallel interfaces that
book on their own. Level 3 is mostly here — operator edits are `trip_events`, told
to the patient by the same loop; what's missing is the operator editing a booking
directly, and that would be another action on the console writing the same event.
Auth is one change: the visitor cookie becomes a user id."

---

## 4 · Judgment calls (1–2 min) — `docs/DECISIONS.md`, 38 entries

Pick five to say aloud:

- **Rules in code, preferences typed.** The deadlines, cabin, bags and party size
  are never the model's to set. It maps the patient's words onto a schema; code
  applies it.
- **One hotel by design, others on request.** The brief pins a hotel; a patient who
  doesn't want it is a preference, not a rule change — so the default is booked
  without asking, and the search runs only when asked.
- **No passport numbers.** Nothing here files travel documents, so collecting them
  would be holding sensitive data for no purpose. Name, date of birth, gender; the
  airline checks the passport at the desk.
- **Cancel-and-rebook, sell first.** No `modifyBooking`. Two calls I trust, in the
  order that never leaves a patient without a flight, and a `superseded` chain that
  makes the history honest.
- **An operator console, not a patient dashboard.** The sandbox has no airline or
  clinic; a console that writes only events lets the demo be honest about what's
  simulated. The patient still has exactly one interface.

Also worth a sentence each: codeshares excluded because CERT can't confirm them;
the order, not the shopped cache, is the baseline for disruption checks; totals and
the trade-off sentence computed in code; the compare panel reads the offers table.

---

## 5 · What's broken (1 min) — `docs/BUGS.md`, 42 entries, most fixed

**Say it straight:**

- "Fares expire after about twenty minutes. A patient who goes to find their
  passport comes back to a dead offer; the agent re-prices and says so, but it's a
  real gap in the experience. (BUGS #6)"
- "CERT quirks I had to work around, not fix: the flight shop is cache-based and
  its times drift from the order by minutes, which produced false schedule changes
  until the order became the baseline; a codeshare Flight Check accepted was refused
  at Create Booking, which is why codeshares are excluded; and the hotel supplier
  rejected a reservation with an early check-in note attached, so the room is now
  booked without it and the patient is told. (#13, #19, #41)"
- "Istanbul inventory in the sandbox is three properties. Alternatives work, but the
  list is short, and that's the sandbox, not the search."
- "Disruptions are simulated. There is no cancellation feed in CERT; the console
  writes what a feed would write, and the real detection path — re-reading the order
  and comparing statuses — is exercised only by the 'Re-read from Sabre' button."
- "Latency: a booking turn is thirty to fifty seconds because Sabre calls run in
  sequence where they must — price check, create, read back. Searches are
  parallelised; bookings can't be."
- "The model still occasionally announces work it hasn't done. The guards catch
  the patterns I've seen and nudge once; they are regexes, not understanding, and
  a new phrasing will get through until it's added."
- "No accounts. A browser cookie owns its trips. Fine for a demo, not for a patient."

**Close:** "Everything shown is in the repo with a walk-through for each scenario,
a decisions log, and a bugs file that's updated in the same commit as the code.
The rule I held throughout: a number the tools didn't return is a number the
patient doesn't hear."
