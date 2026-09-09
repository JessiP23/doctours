# Doctours travel coordinator

A chat agent that books a real flight and a real hotel against the Sabre CERT sandbox
for a medical-tourism trip, then keeps the trip correct when things change — a
cancelled flight, a moved procedure, a different hotel, a tight budget. The
conversation is the patient's whole interface.

Trip: **JFK → IST → JFK**. Procedure 13 Oct 2026, 08:00 Istanbul. On the ground by
12 Oct 20:00. No return before 17 Oct 12:00. Economy, no bags, USD. Default hotel:
Holiday Inn City Istanbul.

Live: **https://doctours.vercel.app** · Health: `/api/health` · Operator console: `/ops`

---

## 1. Architecture

**Pattern:** a single-agent **tool-use loop** (ReAct-style) with **state externalized to
Postgres** and **deterministic guards in code** around the model. The model chooses and
phrases; code decides, validates, computes and books.

```
patient ──POST /api/chat──▶ runTurn()                          lib/agent/loop.ts
  1. append message
  2. loop ≤ 8×:
     a. TripState ← bookings + offers + open events            lib/agent/state.ts
     b. system prompt rebuilt from that state                  lib/agent/system.ts
     c. model call, tool_choice: any, 15 tools
     d. run tools (Zod-validated), persist results             lib/agent/tools/*
     e. `reply` → guards → 1–4 plain-text bubbles              lib/agent/guard.ts
```

| Layer    | Where                 | Rule                                                               |
| -------- | --------------------- | ------------------------------------------------------------------ |
| Rules    | `lib/trip/`           | Pure. Deadlines, cabin, party, hotel, derivation, ranking. No IO.  |
| Agent    | `lib/agent/`          | Loop, prompt, tools, guards, board. Talks to repo + provider only. |
| Provider | `lib/providers/sabre` | Auth, retries, request shapes, response mapping. No agent imports. |
| Data     | `lib/db/`             | Supabase repo. Tables below.                                       |
| UI       | `components/`, `app/` | Chat, compare panel, trips panel, operator console.                |

Layering is enforced by tests (`tests/architecture.test.ts`).

**Stack:** Next.js 16 · React 19 · TypeScript · Tailwind 4 · Zod 4 · Supabase Postgres ·
Anthropic Messages API · Sabre REST (Flight Shop, Flight Check, Create/Get/Cancel
Booking, Get Hotel Details, Hotel Price Check, Get Hotel Avail) · Luxon · pino.

### State (Postgres)

| Table           | Holds                                                                              | Why                                                               |
| --------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `conversations` | `trip_rules` snapshot (dates, party, hotel, deadlines)                             | Rules are per trip and can change (party, procedure date, hotel). |
| `messages`      | Raw Anthropic content blocks, `kind: patient \| system`                            | Exact replay; system rows hidden from the transcript.             |
| `offers`        | `flight`, `hotel_rate`, `hotel_property` — summary + raw provider                  | The model books by offer id, never by a name it remembered.       |
| `bookings`      | `confirmed \| cancelled \| superseded`, `replaced_by`, `raw` itinerary             | Real references only; rebooking chain; disruption baseline.       |
| `trip_events`   | `flight_cancelled`, `flight_schedule_change`, `hotel_cancelled`, `procedure_moved` | Things done to the trip; raised first; acknowledged once told.    |
| `tool_calls`    | Every tool input/output/error + Sabre requests                                     | Audit.                                                            |

The model remembers nothing between turns. Refresh, new tab, cold lambda — identical.

### Tools (`lib/agent/tools/`)

Each tool = Zod schema + handler. The schema is what the model sees and what validates
its input. Side effects require schema literals: `confirmed: true`, `theyToldMe: true`.

| Tool                   | Does                                                                                  | Refuses / guarantees                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `get_trip_state`       | Authoritative state from the DB.                                                      | —                                                                                       |
| `set_party_size`       | 1–4 travellers → trip rules.                                                          | `theyToldMe`; refuses once booked.                                                      |
| `set_procedure_date`   | New date → every rule re-derived; says which bookings no longer fit.                  | `theyToldMe`; refuses past/unchanged; books nothing.                                    |
| `search_flights`       | 4 Flight Shop calls in parallel → rule filter → live re-price → 12 offers.            | Model sets preferences only (rank, stops, airline, window). Cancelled flights excluded. |
| `compare_trip_totals`  | Flight + cheapest room per implied stay, ranked by sum; trade-off sentence.           | Arithmetic in code. Options without a room have no total.                               |
| `create_flight_order`  | Flight Check → Create Booking → Get Booking; stores held itinerary.                   | Offer must exist, be unexpired, re-validate after re-price; refuses if a flight exists. |
| `search_hotels`        | Geo availability around arrival airport; distance, address, lead rate.                | Only when asked. Only properties Sabre priced.                                          |
| `choose_hotel`         | Property → `rules.hotel`; room tools follow.                                          | `theyToldMe`; held room untouched (→ `rebook_hotel`).                                   |
| `search_hotel_rates`   | Rooms for the nights the flight implies; night-before priced on early landing.        | Occupancy ≥ party; check-in time from the property.                                     |
| `create_hotel_booking` | Price Check → Create Booking; guests from the flight booking; `earlyCheckIn` request. | Refuses if a room exists; request refused → books without, says so.                     |
| `rebook_flight`        | Sell new → supersede old → cancel old → hotel fit check.                              | `confirmed`; passengers reused; never leaves the patient with no flight.                |
| `rebook_hotel`         | Same order for rooms.                                                                 | `confirmed`; reports whether nights cover the flights.                                  |
| `cancel_trip`          | Hotel first, then flight, each verified by Get Booking.                               | `confirmed` + reason; partial failure reported, never "cancelled".                      |
| `reply`                | Terminal. 1–4 bubbles.                                                                | Forced every turn.                                                                      |

### Guards (`lib/agent/guard.ts`, `lib/agent/loop.ts`)

| Guard            | Blocks                                                                     |
| ---------------- | -------------------------------------------------------------------------- |
| Reference        | Any locator-shaped token not in `bookings`.                                |
| Announced action | "booking it now", "let me pull up…", "let me try again" with no tool call. |
| Raised event     | A reply whose first bubble does not name an open `trip_event`.             |
| Rule refresh     | Prompt re-read after a rule-changing tool, within the same turn.           |

Each failure sends the model back once with the reason.

### Disruptions and proactivity

Anything done to the trip from outside is a `trip_events` row: the operator console
(`/ops`) writes them (source `simulated`); "Re-read from Sabre" compares the live order
against the stored itinerary (source `provider`). After a console action the agent's
turn runs via `after()`; the chat polls while idle, so the patient is told without
typing. Events go to the top of the prompt and are acknowledged once delivered.

### Compare panel (Level 2)

Interviewed one user; the ask was options laid out side by side instead of read out of
bubbles. `lib/agent/board.ts` projects the `offers` table into cards — price, times,
stops, hours inside the deadline, nights implied, trip total when a matching room is on
the table, badges, booked/expired state. No Sabre call, no model turn. Choosing a card
sends a sentence into the chat; booking still goes through the normal confirm path.

---

## 2. Levels

**Level 0** — book flight + hotel by conversation. Done, verified against CERT.

**Level 1** — the brief's nine questions. All built, verified live.

| #   | Question                       | How                                                                        |
| --- | ------------------------------ | -------------------------------------------------------------------------- |
| 1   | Outbound cancelled             | Event → agent speaks first → `rebook_flight` → `rebook_hotel`.             |
| 2   | Return cancelled               | Same path; checkout moves.                                                 |
| 3   | Lands before check-in          | Night-before rate priced; `earlyCheckIn` filed as a request.               |
| 4   | Procedure moved                | `set_procedure_date` / console; rules re-derived; same rebooking sequence. |
| 5   | Patient cancels                | `cancel_trip`, hotel first, verified.                                      |
| 6   | Brings someone                 | Party size established, prices for all, occupancy filter, all on the room. |
| 7   | Doesn't want the default hotel | `search_hotels` → `choose_hotel`; default pinned until asked.              |
| 8   | Money is tight                 | `compare_trip_totals`; total ranked in code.                               |
| 9   | Hates connections              | `rankBy: fewest_stops`, `maxStops: 0`.                                     |

**Level 2** — side-by-side comparison panel. Built.

**Level 3** — operator console + proactive notification. Built early; needed by Level 1.

**Next:** remaining Level 2 views as projections of the same state; console booking
edits as events on the same path; visitor cookie → user id.

---

## 3. Running it

Node 22, a Supabase project, Sabre CERT credentials, an Anthropic key.

```bash
npm install
cp .env.example .env        # fill in values; OPS_TOKEN enables /ops
npm run db:sql              # paste output into Supabase → SQL editor → Run
npm run dev                 # http://localhost:3000
curl -s localhost:3000/api/health | jq   # env, schema, Sabre auth, model must be green
```

Checks: `npm run check` (typecheck, lint, format, 290 tests) · `npm run build`.

### Using it

1. New chat → answer the party-size question → `find me the cheapest flight` or
   `money is tight, cheapest way to do the whole trip`.
2. The **Compare N options** panel opens with every option; click a card or type.
3. Give name, date of birth, gender, email, phone once. Confirm the read-back.
4. Hotel follows automatically; ask for the night before or early check-in.
5. `/ops`: airline cancels / changes schedule, hotel cancels, clinic moves the
   procedure, re-read from Sabre. Return to the chat and wait — the agent speaks.
6. Verify anything: `npm run sabre:smoke -- lookup <reference>`.

### CLI (`scripts/sabre-smoke.ts`)

```
npm run sabre:smoke -- auth | flights | hotel <code> | hotels-probe
npm run sabre:smoke -- e2e [--dry-run]            # whole booking path, no model
npm run sabre:smoke -- lookup <reference>         # prove an order exists
npm run sabre:smoke -- trips                      # conversation ids and what they hold
npm run sabre:smoke -- check <conversationId>     # re-read order, record disruptions
npm run sabre:smoke -- ops <action> <conversationId> [value]   # any console action
npm run sabre:smoke -- cancel <reference>
```

---

## 4. Judgment calls

Where the brief was silent, the decision and why.

- **Rules in code, preferences from the model** — the model can't bend a deadline it
  can't pass.
- **Custom agent loop on the Anthropic SDK** — full control of tool dispatch, guards,
  persistence.
- **Terminal `reply` tool, `tool_choice: any`** — every turn ends in structured bubbles.
- **State in Postgres, prompt rebuilt each turn** — no memory to drift; resumable.
- **Offers persisted with ids** — book by id, never by recollection.
- **Live re-price before showing any fare** — the number shown is the number booked.
- **Codeshares excluded** — CERT accepts them at price check and refuses at sell.
- **Order is the truth, not the shop** — shop times drift; stored itinerary comes from Get
  Booking.
- **No passport numbers** — nothing files them; name, DOB, gender only.
- **Party size established, never assumed** — asked in the greeting; gated on search.
- **Sell before release on every rebooking** — a patient is never left without a flight.
- **`superseded` chain** — history says what replaced what and why.
- **Cancellation needs `confirmed: true` and cancels the hotel first** — discussing can't
  perform.
- **Pinned hotel is a default, not a rule** — alternatives only when asked.
- **Every date derives from the procedure date** — one function; nothing half-moved.
- **Arithmetic in code** — totals and the trade-off sentence are computed, repeated by
  the model.
- **Operator console instead of a fake feed** — visible simulation; one patient interface.
- **Agent speaks first** — an untold event outranks whatever was typed.
- **Compare panel reads the offers table** — no second interface that books.
- **Agency card from the environment** — the patient is never asked for payment.

---

## 5. Known bugs and limits

- Fares expire in ~20 minutes; a slow patient is re-priced.
- Disruptions are simulated; CERT has no feed. Real detection only runs on "Re-read".
- Istanbul has three properties in the sandbox.
- A booking turn takes 30–50 s; Sabre's price check → create → read-back are sequential.
- Output guards are regexes; an unseen phrasing gets through until added.
- The model still sometimes narrates instead of acting; guards catch known forms.
- No accounts; a browser cookie owns its trips.
- Flight Shop times drift from the order by minutes; handled by using the order as
  baseline, but the first `check` on an old booking only records it.
- Hotel supplier may reject a reservation carrying a special instruction; the room is
  then booked without it.
- Rules default check-in 15:00 for the pinned hotel; the property reports 14:00. The
  property's value is preferred when present.
