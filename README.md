# Doctours travel coordinator

A chat application that books a real flight and a real hotel against the Sabre CERT
sandbox for a medical-tourism trip. The conversation is the entire interface: no
forms, no results page, no date picker.

The trip it books: **JFK → IST → JFK**, procedure 13 October 2026 at 8:00 AM Istanbul
time, on the ground in Istanbul by 8:00 PM on the 12th, no flight home before noon on
the 17th, economy, no checked bags, USD, staying at the **Holiday Inn City Istanbul**.

- Live app: **https://doctours.vercel.app**
- Health check: [/api/health](https://doctours.vercel.app/api/health) — four checks: configuration, database schema, Sabre auth, model
- Judgment calls: [`docs/DECISIONS.md`](docs/DECISIONS.md)
- Known bugs, honestly: [`docs/BUGS.md`](docs/BUGS.md)
- Booking references from real runs: [`docs/BOOKINGS.md`](docs/BOOKINGS.md)
- Manual test script: [`docs/E2E.md`](docs/E2E.md)
- The plan this was built to: [`docs/PLAN.md`](docs/PLAN.md)

## How the agent is put together

One `POST /api/chat` per user turn. No streaming — a turn produces an array of short
bubbles that the client reveals one at a time, so the chat reads like a person typing.

```
browser ──POST /api/chat {text}──▶ route ──▶ runTurn()            lib/agent/loop.ts
                                              │
   1. append the user message to `messages`
   2. load history (raw Anthropic content blocks) from Supabase
   3. loop, at most 8 times:
        a. project TripState from `bookings` + recent `offers`      lib/agent/state.ts
        b. build the system prompt around that live state           lib/agent/system.ts
        c. call the model with tool_choice: "any", system cached
        d. persist the assistant blocks
        e. for each tool_use except `reply`: validate with the
           tool's Zod schema, run it inside a provider trace,
           record a row in `tool_calls`, return a tool_result
        f. `reply` called → guards → humanize → return bubbles
```

**Trips.** There are no accounts. A httpOnly _visitor_ cookie owns the trips a browser
has started and a second cookie remembers which one is open, so the Trips panel can list
them with their progress ("fully booked · ABC12D, XYZ98W") and switching only ever opens
a trip that browser created. Replacing the visitor id with a real user id is the whole of
what authentication would change.

**State.** The agent holds nothing in memory between requests. Everything is in
Postgres: the conversation, the exact Anthropic content blocks, every offer the model
was shown, every booking, every tool call. The model is _told_ the current state each
turn rather than remembering it, so a page refresh, a new tab or a cold lambda all
resume identically.

**Tools** (`lib/agent/tools/`). The Level 0 six, and the interesting part is what they refuse:

| Tool                   | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `get_trip_state`       | Authoritative "what is actually booked", read from the database.                                                                                                                                                                                                                                                                                                                                                                     |
| `search_flights`       | Takes a ranking, and optionally narrows to a departure or return date the rules already allow. It **cannot** set cabin, baggage, passengers or the route. Itineraries breaking a deadline are removed before the model sees them; the rejection reasons are returned so the agent can explain a refusal truthfully. Reports the total valid count and which dates have options, so it cannot claim a date is empty from a shortlist. |
| `create_flight_order`  | Guard chain: the offer exists in this conversation → nothing already booked → not past its expiry → Flight Check still honours it → re-validated against the rules _after_ re-pricing → a changed price is reported, never charged.                                                                                                                                                                                                  |
| `search_hotel_rates`   | Nights are derived from the flight actually booked, so the stay cannot drift from the itinerary.                                                                                                                                                                                                                                                                                                                                     |
| `create_hotel_booking` | Hotel Price Check re-confirms the rate and mints the booking key, so an expired rate cannot book.                                                                                                                                                                                                                                                                                                                                    |
| `reply`                | Terminal. Forced by `tool_choice: "any"`, so every turn ends in `{bubbles: string[1..4], expectsInput}` — plain text, short, no markdown.                                                                                                                                                                                                                                                                                            |

Level 1 added the rest, all on the same pattern — rules in code, preferences typed,
nothing bought in the turn that proposes it: `set_party_size`, `set_procedure_date`
(every trip date derives from it), `compare_trip_totals` (flight + room ranked by the
sum, arithmetic done in code), `search_hotels` / `choose_hotel` (alternatives only when
the patient asks; the default stays pinned), `rebook_flight` / `rebook_hotel` (sell
first, release second, `superseded` chain) and `cancel_trip`. The room tools take
`earlyCheckIn` as a request filed on the reservation. `docs/PLAN-LEVEL-1.md` maps the
brief's nine questions to them; `docs/E2E-LEVEL-1.md` is how each is verified against
CERT. What the sandbox cannot originate — an airline cancelling, a clinic moving a
procedure — an operator does from `/ops` (needs `OPS_TOKEN`), and the agent tells the
patient without being asked.

**Never reporting a booking that did not happen.** Four independent layers:

1. A booking reference is only ever read from the provider's response. No code path
   constructs one.
2. The prompt's BOOKED section is rendered from the `bookings` table, and the model may
   only quote references that appear there.
3. `lib/agent/guard.ts` scans outgoing bubbles for record-locator-shaped tokens and
   blocks any that are not in that table, correcting the model once.
4. The same guard blocks a turn-closing reply that _announces_ a booking ("booking it
   now") when no booking tool ran that turn.

**Provider isolation.** Tools depend on the `TravelProvider` interface
(`lib/providers/types.ts`), never on Sabre. `lib/providers/sabre/` owns auth, retries,
request shapes and the mapping from Sabre's reference-graph responses to normalized
offers. Adding another GDS, or making the trip generic over origin and destination, is
work inside that folder.

**Sabre endpoints used** (agentic-ready REST, not the MCP server — see DECISIONS #12):

```
flights  POST /v1/offers/flightShop → /v1/offers/flightCheck → /v1/trip/orders/createBooking
hotel    POST /v5/get/hoteldetails  → /v5/hotel/pricecheck   → /v1/trip/orders/createBooking
```

Both bookings return Sabre's `confirmationId`, which is the reference the patient is
given.

**Codeshares.** Flight Shop is cache-based and the sell is live. In CERT, a seat sold by
one airline on another airline's flight (`operatingAirlineCode ≠ marketingAirlineCode`)
passes Flight Check and then fails the sell with `UC`, every time, because the operating
carrier's confirmation is not simulated; an airline selling its own seats confirms
instantly. Flight Shop has no "online only" filter, so `TRIP_RULES.allowCodeshares`
makes those itineraries ineligible in `validateOffer` — they are never shown, and the
agent can say why if asked. See DECISIONS #18.

**Timezones.** Sabre returns local wall-clock times with no UTC offset. Deadline checks
therefore use the zones declared in the trip rules, after asserting the segment's
airport is the expected origin or destination; layovers are wall-clock differences at a
single airport, needing no zone at all. An unknown connection airport can never cause a
wrong booking.

## Running it

Requires Node 22 and a Supabase project.

```bash
npm install
cp .env.example .env            # fill in the values
npm run db:sql                  # paste the output into Supabase → SQL editor → Run
                                # (prints every migration, in order)
npm run dev                     # http://localhost:3000
curl -s localhost:3000/api/health | jq
```

Health must show four green checks (env, database schema, Sabre auth, model) before the
chat will work.

### Talking to Sabre directly

`scripts/sabre-smoke.ts` exercises the API without the agent, and saves raw responses to
`tests/fixtures/sabre/` (account identifiers redacted) so mappers are written and tested
against real payloads:

```bash
npm run sabre:smoke -- auth
npm run sabre:smoke -- flights [departDate] [returnDate]
npm run sabre:smoke -- hotel <hotelCode> [checkIn] [checkOut]
npm run sabre:smoke -- hotels-probe          # which hotel search strategies return rates
npm run sabre:smoke -- e2e --dry-run         # the whole booking path without creating anything
npm run sabre:smoke -- e2e                   # books a flight and a hotel for real, verifies both
                                             # with Get Booking, records them in docs/BOOKINGS.md
npm run sabre:smoke -- lookup <reference>    # prove a reference is a real Sabre order
```

`e2e` is the deterministic proof of the integration — the same provider calls and
trip rules the agent uses, with no model in the loop.

### Checks

```bash
npm run check      # typecheck, lint, prettier, tests
```

`npm run check` also runs on `git push` via a pre-push hook. The mapper tests run
against committed real CERT payloads, so they need no network.

## What a booking actually is

Both bookings are Sabre orders in the CERT environment, retrievable by reference.
`npm run sabre:smoke -- lookup <reference>` reads one back and prints what Sabre holds.
A confirmed flight order looks like this:

| Field                                     | Meaning                                                                                                            |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `bookingId`                               | the record locator quoted to the patient, e.g. `OCGMJQ`                                                            |
| `flights[].flightStatusCode`              | **`HK` = confirmed** — the seat is held. This is the field that proves a booking is real                           |
| `flights[].bookingClass`, `cabinTypeName` | the class actually sold, e.g. `V` / `ECONOMY`                                                                      |
| `startDate`, `endDate`                    | the span the order holds                                                                                           |
| `isTicketed`                              | `false` — booked, not yet ticketed. Ticketing is a separate step (Fulfill Flight Tickets) and is out of scope here |
| `travelers[]`                             | the passenger as filed                                                                                             |

A hotel order carries `hotels[]` with the property name, `checkInDate` / `checkOutDate`,
the room and rate, `paymentPolicy` (`DEPOSIT` here — hence the agency card), and
`confirmationId`, which is _the hotel's own_ confirmation number, separate from the Sabre
record locator.

**"Fixed property"** means what the brief asks for: one named hotel where every patient
stays, not a hotel search. It is `TRIP_RULES.hotel` — Holiday Inn City Istanbul, CERT
property `100071112`. The **nights are not fixed**: they are derived from the flight
actually booked, so a flight landing a day early produces a six-night stay and a
different flight a five-night one. Both cases have been booked and verified.

## Deploying

1. Import the repo on Vercel (framework auto-detects as Next.js; no build config needed).
2. Set these environment variables for Production and Preview:

   | Variable                    | Notes                                     |
   | --------------------------- | ----------------------------------------- |
   | `ANTHROPIC_API_KEY`         |                                           |
   | `ANTHROPIC_MODEL`           | e.g. `claude-sonnet-4-5`                  |
   | `SABRE_BASE_URL`            | `https://api.cert.platform.sabre.com`     |
   | `SABRE_USER_ID`             | as issued, e.g. `V1:<EPR>`                |
   | `SABRE_PASSWORD`            |                                           |
   | `SABRE_PCC`                 |                                           |
   | `SUPABASE_URL`              |                                           |
   | `SUPABASE_SERVICE_ROLE_KEY` | server-only; never exposed to the browser |

3. Deploy, then open `/api/health` and confirm four green checks.

The chat route runs on the Node runtime with `maxDuration = 60`: a flight search makes
several concurrent Sabre calls and the agent may take a few model turns.

## Logging

Every tool call is written to the `tool_calls` table with its input, output, error, the
upstream HTTP requests it made (method, URL, status, duration) and total duration —
durable proof that Sabre was really called, since platform logs are ephemeral. The same
events go to stdout as JSON via pino, with credentials redacted at the logger.

```sql
select created_at, tool_name, duration_ms, provider_requests, error
from tool_calls order by id desc limit 20;
```
