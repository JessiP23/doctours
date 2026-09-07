# Doctours Travel Agent — Level 0 Plan

Scope of this document: everything needed to ship **Level 0, 100% working**, on the given stack (Next.js 16 / Claude / Supabase / Vercel / Sabre sandbox), in a shape that Levels 1–3 can grow into without rewrites. Nothing here is Level 1+ work; where a decision is made *because* of a later level, it is flagged as such.

---

## 0. The one-paragraph version

A single Next.js app. The UI is one chat screen. Every user message goes to a server route that runs a **custom agent loop** on the Anthropic Messages API with a small set of **typed tools**. The tools never talk to Sabre directly; they call a **provider adapter** (`lib/providers/sabre/*`) that knows about auth tokens, request shapes, and error normalisation. Every conversation, message, offer, order, and tool call is written to **Supabase** as it happens, so the agent is stateless between requests and a refresh loses nothing. A **trip ruleset** (dates, cabin, bags, hotel) is enforced in code — not in the prompt — so a flight that lands after 20:00 on Oct 12 can never be booked, no matter what the model says. Responses are returned as **an array of short bubbles**, non-streamed, plain text, and rendered one at a time with a typing delay so the chat feels human.

---

## 1. Requirements checklist (Level 0, verbatim from the brief → what satisfies it)

| Brief requirement | How it is satisfied | Where verified |
|---|---|---|
| Chat is the entire interface | One page, one text input, nothing else | `app/page.tsx` |
| "I need to book my trip" → confirmed flight + hotel, never leaving chat | Agent loop with `search_flights → confirm → create_flight_order → search_hotel_rates → confirm → create_hotel_booking` | E2E manual test script §9 |
| Human-like responses: no streaming, no blobs, no markdown | Model returns `{bubbles: string[]}` via a forced tool; UI renders bubbles sequentially with delay; markdown stripped defensively | `lib/agent/reply.ts` |
| Flight is a real Sabre sandbox order with a real reference | `create_flight_order` only reports a reference it got back from Sabre; reference stored in `bookings` | `lib/tools/create_flight_order.ts` |
| Hotel booked at fixed property, correct nights | `TRIP_RULES.hotel` pins the property; nights derived from flight arrival/departure dates | `lib/trip/rules.ts` |
| Hard dates respected; landing after deadline = failed booking | `validateItinerary()` filters offers *before* the model sees them and re-checks *before* `create_order`. Both layers. | `lib/trip/validate.ts` + unit tests |
| Tool calls logged on server | Every tool call → `console.log` structured JSON **and** row in `tool_calls` table (Vercel logs are ephemeral; DB is the durable proof) | `lib/agent/loop.ts` |
| Deployed to Vercel and working | GitHub → Vercel, env vars set, health check route | `app/api/health` |
| Booking rules: USD, economy, no bags, cheapest room | Encoded in `TRIP_RULES` and passed as fixed search params; the model cannot override them at Level 0 | `lib/trip/rules.ts` |
| Never report a booking it did not make | Reference is only ever read from the provider response, and the reply tool is given `bookings` from DB, not from model memory | §6.4 |

---

## 2. Stack & tooling decisions

| Concern | Decision | Why (and what was rejected) |
|---|---|---|
| Framework | **Next.js 16 (App Router), TypeScript strict** — already in the repo | Required. Note the repo's `AGENTS.md`: this Next version has breaking changes; read `node_modules/next/dist/docs/` before writing route handlers. |
| Package manager | **pnpm** (or stay on npm — but pick one and commit the lockfile) | Speed. Vercel auto-detects. |
| Agent runtime | **`@anthropic-ai/sdk` directly, custom loop** | Rejected Vercel AI SDK: it is built around streaming and `useChat`, and the brief explicitly forbids streaming and wants multi-bubble replies. A ~120-line hand-written loop gives full control of the tool-result → DB → next-turn cycle, which is the thing the reviewers weigh most ("agentic architecture"). |
| Model | `claude-sonnet-4-5` (or latest Sonnet available with the provided key) for the loop; no separate model for replies | Fast enough for a chat turn with 2–4 tool calls; strong tool use. Make it an env var `ANTHROPIC_MODEL` so it's a one-line swap. |
| Tool schemas | **Zod** schemas → JSON schema via `zod-to-json-schema` (or Zod 4's built-in `z.toJSONSchema`) | One source of truth for validation (server side) and the tool definition the model sees. |
| Database | **Supabase Postgres**, accessed with `@supabase/supabase-js` using the **service-role key on the server only** | No auth product at Level 0; anonymous conversations keyed by a cookie. RLS on, but only the server talks to the DB. Migrations as SQL files in `supabase/migrations/` and applied with the Supabase CLI. |
| ORM | **None** (supabase-js + hand-written typed queries in `lib/db/*.ts`) | Drizzle/Prisma add build steps and edge-cases on Vercel for very little gain at this table count (5 tables). Generate DB types with `supabase gen types` for safety. |
| Travel provider | **Adapter interface** `TravelProvider` with one implementation `SabreProvider` | See §5. This is the most important structural call in the project. |
| HTTP client | Native `fetch` + a tiny `sabreFetch()` wrapper (auth, retries on 401/429, timing, logging) | No axios. |
| Validation of dates/times | **`luxon`** (or Temporal polyfill) | Every hard deadline is *local time in Istanbul*. You need real IANA zone math (`Europe/Istanbul`, `America/New_York`). Never compare naive strings. |
| UI | Tailwind 4 (already there) + hand-rolled chat; no component library | The interface is one screen. A lib is overhead and hurts the "delightful/human" feel less than good spacing and timing do. |
| Testing | **Vitest** for pure logic (`validate.ts`, `rules.ts`, bubble splitter, provider response mappers using recorded sandbox fixtures) | The parts that can silently book a wrong trip are pure functions — test them. No E2E framework at Level 0; a written manual script (§9) plus the DB `tool_calls` table as evidence. |
| Logging | `pino` (JSON) → Vercel logs; mirror tool calls to `tool_calls` table | Brief asks for server logs; the DB copy is what you'll actually show in the video. |
| Lint/format | ESLint (there) + Prettier + `tsc --noEmit` in a `pnpm check` script, run as a pre-push hook (`simple-git-hooks`) | Keeps every small commit green. |
| Hosting | Vercel, Node runtime (not Edge) for the agent route, `maxDuration = 60` | Sabre calls + 3–4 model turns can exceed 10s. Node runtime has the full SDK support. Hobby plan allows 60s. |
| Secrets | `.env.local` locally; Vercel env vars in prod; `env.ts` with Zod that **fails the build** if any are missing | Prevents the "works locally, broken link on review" failure. |

---

## 3. Repository layout

```
doctours/
├─ app/
│  ├─ layout.tsx
│  ├─ page.tsx                      # the chat (client component inside)
│  ├─ api/
│  │  ├─ chat/route.ts              # POST: one user turn → agent loop → bubbles
│  │  ├─ conversation/route.ts      # GET: hydrate history after refresh
│  │  └─ health/route.ts            # GET: env + DB + Sabre token sanity
├─ components/
│  ├─ Chat.tsx                      # message list + input, bubble sequencing
│  ├─ Bubble.tsx
│  └─ TypingIndicator.tsx
├─ lib/
│  ├─ env.ts                        # Zod-validated process.env
│  ├─ log.ts                        # pino instance
│  ├─ db/
│  │  ├─ client.ts                  # server-only supabase client
│  │  ├─ conversations.ts
│  │  ├─ messages.ts
│  │  ├─ offers.ts
│  │  ├─ bookings.ts
│  │  └─ toolCalls.ts
│  ├─ trip/
│  │  ├─ rules.ts                   # TRIP_RULES constant (origin, dates, cabin, hotel…)
│  │  ├─ validate.ts                # pure: is this itinerary/stay legal for these rules?
│  │  └─ nights.ts                  # pure: check-in/out from arrival/departure
│  ├─ providers/
│  │  ├─ types.ts                   # TravelProvider interface + normalized domain types
│  │  └─ sabre/
│  │     ├─ auth.ts                 # token acquisition/caching
│  │     ├─ http.ts                 # sabreFetch wrapper
│  │     ├─ flights.ts              # shop / price / order
│  │     ├─ hotels.ts               # avail / rates / book
│  │     ├─ mappers.ts              # raw Sabre JSON → normalized types
│  │     └─ errors.ts               # → ProviderError {code: 'OFFER_EXPIRED'|'PRICE_CHANGED'|…}
│  ├─ agent/
│  │  ├─ loop.ts                    # run one turn: build messages → call model → dispatch tools → repeat
│  │  ├─ system.ts                  # system prompt builder (persona + rules + live state)
│  │  ├─ tools/
│  │  │  ├─ index.ts                # registry: name → {schema, handler}
│  │  │  ├─ search_flights.ts
│  │  │  ├─ create_flight_order.ts
│  │  │  ├─ search_hotel_rates.ts
│  │  │  ├─ create_hotel_booking.ts
│  │  │  ├─ get_trip_state.ts
│  │  │  └─ reply.ts                # terminal tool: {bubbles: string[]}
│  │  └─ state.ts                   # TripState projection from DB rows
│  └─ text/
│     └─ humanize.ts                # strip markdown, cap bubble length, split
├─ supabase/
│  └─ migrations/0001_init.sql
├─ tests/                           # vitest: validate, nights, mappers (fixtures), humanize
├─ scripts/
│  └─ sabre-smoke.ts                # CLI: auth → shop → (optionally) book, prints raw JSON; run day 1
├─ docs/
│  ├─ PLAN.md                       # this file
│  ├─ DECISIONS.md                  # running log of judgment calls (feeds the video)
│  └─ BUGS.md                       # known issues, kept honest
└─ .env.example
```

---

## 4. Data model (Supabase)

Five tables. Everything the agent "knows" between turns is re-derivable from these.

```sql
-- 0001_init.sql
create table conversations (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  trip_rules jsonb not null,            -- snapshot of TRIP_RULES at creation (future-proofs L3 "any origin/destination")
  status text not null default 'open'   -- open | completed
);

create table messages (
  id bigserial primary key,
  conversation_id uuid not null references conversations(id) on delete cascade,
  role text not null check (role in ('user','assistant','tool_use','tool_result')),
  content jsonb not null,               -- exact Anthropic content block(s); replayable
  created_at timestamptz not null default now()
);
create index on messages (conversation_id, id);

create table offers (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  kind text not null check (kind in ('flight','hotel_rate')),
  provider text not null default 'sabre',
  provider_offer_id text not null,      -- what you must send back to Sabre to book
  summary jsonb not null,               -- normalized: price, segments/room, times (what the model saw)
  raw jsonb not null,                   -- full provider payload (debugging + rebooking later)
  expires_at timestamptz,               -- from provider if given, else now()+N min
  created_at timestamptz not null default now()
);
create index on offers (conversation_id, kind, created_at desc);

create table bookings (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  kind text not null check (kind in ('flight','hotel')),
  provider text not null default 'sabre',
  provider_order_id text not null,      -- Sabre order/PNR id
  booking_reference text not null,      -- what the patient is told
  status text not null default 'confirmed',   -- confirmed | cancelled (L1)
  offer_id uuid references offers(id),
  details jsonb not null,               -- normalized itinerary / stay
  raw jsonb not null,
  created_at timestamptz not null default now()
);
create unique index on bookings (conversation_id, kind) where status = 'confirmed';  -- one live flight + one live hotel per trip

create table tool_calls (
  id bigserial primary key,
  conversation_id uuid references conversations(id) on delete cascade,
  tool_name text not null,
  input jsonb not null,
  output jsonb,
  error text,
  provider_requests jsonb,              -- [{method,url,status,ms}] — proof Sabre was called
  duration_ms int,
  created_at timestamptz not null default now()
);
```

Notes
- `messages.content` stores the raw Anthropic content blocks so the history can be replayed into the next model call without transformation. Tool-use / tool-result pairs are stored too; that's how the model "remembers" what it searched.
- The partial unique index on `bookings` is the DB-level guard against double-booking on a retry.
- Row Level Security: enable on all tables, no policies for `anon` → only the service-role server client can read/write. Zero client-side DB access at Level 0.

---

## 5. Provider adapter (`lib/providers`)

### 5.1 Why an adapter, decided up front

Two reasons, both relevant on day 1:

1. **The brief's language does not match Sabre's product names.** "Sabre Flights / Sabre Stays", "offers expire on their own timer", "a real Sabre order with a real booking reference", and "sandbox books against fake inventory" are the vocabulary of an *offer/order* API (this is exactly how Duffel describes Duffel Flights/Stays and Duffel Airways test inventory). Sabre's actual developer surface is either the classic GDS REST flow (Bargain Finder Max → Create Passenger Name Record → PNR locator, plus Get Hotel Avail / Hotel Price Check / Enhanced Hotel Book) or the newer NDC **Offer and Order** APIs. You will not know which shape the provided token unlocks until you call it. An adapter means the agent, tools, DB, and UI are written once against normalized types, and the only file that changes when you discover the real API is `providers/sabre/*`.
2. **Level 3 ("any origin/destination", "thousands of patients") is trivially easier** if provider specifics never leak past this boundary.

Record this as **Decision #1 in `docs/DECISIONS.md`**; it's one of the judgment calls the reviewers want to hear.

### 5.2 Interface

```ts
export interface TravelProvider {
  searchFlights(q: FlightSearch): Promise<FlightOffer[]>;           // one-way or round-trip, cabin, pax, bags=0
  priceFlightOffer(offerId: string): Promise<FlightOffer>;          // re-price right before booking (catches expiry/price change)
  createFlightOrder(offerId: string, pax: Passenger[]): Promise<FlightOrder>;   // returns bookingReference
  searchHotelRates(q: HotelSearch): Promise<HotelRate[]>;           // fixed property id, dates, guests
  createHotelBooking(rateId: string, guest: Guest): Promise<HotelBooking>;      // returns bookingReference
}
```

Normalized types carry: `id`, `price {amount, currency}`, `expiresAt`, and for flights `slices[] → segments[] {from,to,departAtLocal,arriveAtLocal,tz,carrier,flightNo,cabin}`, `stops`, `totalDurationMin`. For hotel rates: `propertyId`, `propertyName`, `roomName`, `bedType`, `checkIn`, `checkOut`, `nightly`, `total`, `refundable`.

### 5.3 Sabre specifics to nail on Day 1 morning (the smoke script)

Do this **before** writing a single agent line. `scripts/sabre-smoke.ts` should, from the CLI:
1. Authenticate with the provided token/credentials against the CERT/sandbox base URL; print the token TTL.
2. Run one flight shop JFK→IST for Oct 12 (or Oct 11 evening) and IST→JFK Oct 17 with cabin economy, 1 adult. Save the raw response to `tests/fixtures/sabre/flight-shop.json`.
3. Run one hotel availability/rates call for your chosen property for Oct 12–17. Save the fixture.
4. Optionally create one order end-to-end and print the reference. **That is your first booking reference deliverable** — save it in `docs/BOOKINGS.md` immediately.

Outputs of this step decide: token lifetime (cache strategy), whether offers carry `expires_at`, how passenger data must be shaped, what a "booking reference" field is called, and what error codes look like when an offer is stale. Write the mappers and `errors.ts` from the fixtures, and unit-test them against the fixtures.

Token handling: cache the Sabre access token in module memory with expiry, refresh on 401 once. (Vercel functions are warm often enough that this matters; if it proves flaky, cache in a `provider_tokens` table — one extra migration, no other change.)

### 5.4 Hotel choice

Pick one property near a major Istanbul clinic district that is **guaranteed to return sandbox availability** in the smoke test (you may need to try a few; some sandbox properties return nothing). Pin it as `TRIP_RULES.hotel = {providerPropertyId, name, checkInTime: '15:00', tz: 'Europe/Istanbul'}`. The name is what the agent says; the id is what the tool sends.

---

## 6. Agent design (`lib/agent`)

### 6.1 The loop (one HTTP request = one user turn)

```
POST /api/chat {conversationId?, text}
  1. load or create conversation (cookie-backed id)
  2. insert user message
  3. state = projectTripState(conversationId)        // from offers + bookings tables
  4. history = load messages (raw content blocks)
  5. loop (max 8 iterations):
       resp = anthropic.messages.create({ system: buildSystem(rules, state), tools, messages: history, tool_choice: 'any' })
       persist assistant content blocks
       for each tool_use block:
           if name === 'reply' → validate bubbles, persist, RETURN {bubbles}
           else → run handler (validated via Zod), persist tool_result, log tool_calls row
       append tool_results to history; continue
  6. if loop exhausted → deterministic fallback reply ("Give me a second, I'm still checking…") + log
```

Key properties
- **`tool_choice: 'any'`** plus a terminal **`reply` tool** means the model must *always* end the turn with structured bubbles. This is how you get "no blobs, no markdown" reliably instead of hoping the prompt is followed. Plain-text responses are never rendered; if one occurs (it won't with `any`), it's converted through `humanize()` as a safety net.
- The agent is **stateless** across requests. Everything is in `messages` + `offers` + `bookings`. Refresh the page → `GET /api/conversation` → same chat, same offers, same references.
- Prompt caching: mark the system prompt + tool definitions block with `cache_control` — history grows every turn and this keeps latency and cost flat.

### 6.2 Tools (Level 0 set — exactly six)

| Tool | Input (Zod) | What the handler does | Returns to model |
|---|---|---|---|
| `get_trip_state` | `{}` | Reads DB projection | rules summary, what's booked, what's pending, current offers (ids + one-line summaries) |
| `search_flights` | `{direction: 'outbound'\|'return'\|'roundtrip', preferences?: {sort: 'price'\|'duration'}}` | Dates/cabin/bags/pax are **taken from rules, not from the model**. Calls provider, **filters with `validateItinerary()`**, stores top N (≤5) offers in `offers`, returns compact summaries with `offerId` | `[{offerId, priceUSD, stops, departLocal, arriveLocal, durationH, carrier}]` + how many were rejected by the deadline rule and why |
| `create_flight_order` | `{offerId, passenger: {givenName, familyName, dob, gender, email, phone}}` | Loads offer from DB (must exist, must belong to conversation, must not be expired) → `priceFlightOffer` → re-validate deadline → `createFlightOrder` → insert `bookings` → return **reference from provider response** | `{bookingReference, itinerary}` or `{error: 'OFFER_EXPIRED'|'PRICE_CHANGED', newPrice?}` |
| `search_hotel_rates` | `{checkIn?, checkOut?}` (optional; defaults derived from the **booked** flight) | Fixed property from rules; computes nights via `nights.ts`; provider search; sorts cheapest first; stores rates as offers | `[{rateId, roomName, bed, nightlyUSD, totalUSD, refundable}]` + the exact nights |
| `create_hotel_booking` | `{rateId, guest: {...}}` | Same guard pattern as flights; insert `bookings` | `{bookingReference, checkIn, checkOut, roomName, totalUSD}` |
| `reply` | `{bubbles: string[] (1–4, each ≤ 220 chars, no markdown), expectsInput: boolean}` | Terminal. Server strips markdown, rejects over-long, persists | — |

Design rules baked into the tools
- **Guardrails live in code.** The model cannot pass a date, a cabin, or a bag count at Level 0. When Level 1/2 loosens this, you add optional fields with defaults — the code path stays the same.
- **Tools return the smallest useful payload.** 5 flights × 6 fields, not the raw Sabre JSON. Context stays small, replies stay fast, and the model can't hallucinate details it never saw.
- **Every "create" tool is idempotent per conversation** thanks to the unique index; a retried request returns the existing booking instead of double-booking.
- **Passenger details are collected conversationally** and only stored inside the tool input / booking row. No forms.

### 6.3 System prompt (short, and mostly *state*, not *rules*)

Sections, in order: persona (Doctours travel coordinator, warm, brief, one thought per message, plain text, no lists/markdown, no emojis, speaks like a competent human on WhatsApp); the trip in one paragraph (rendered from `TRIP_RULES`); the live state (rendered from DB: what's booked with references, what offers are on the table, what's still needed); conversation policy (always confirm the specific option and price before booking; never state a reference that isn't in "Booked" state above; ask for one piece of missing info at a time; if a tool returns an error, say what happened plainly and offer the next step); output contract (always finish with `reply`; 1–4 bubbles; first bubble is the point, the rest add detail).

Because state is injected every turn from the DB, the model doesn't need to "remember" — it's told. That is the answer to "how it tracks state" in the video.

### 6.4 The one thing that ends the review: never claim an unmade booking

Three independent layers:
1. `create_*` tools return the reference **only** from the provider response object; there is no code path that fabricates or echoes one from input.
2. The system prompt's "Booked" section is rendered **from the `bookings` table**, and the prompt says the model may only quote references that appear there.
3. Server-side post-check on `reply`: regex the bubbles for anything that looks like a reference (`\b[A-Z0-9]{5,8}\b` etc.); if a token matches a reference pattern and is not in `bookings` for this conversation, reject the reply and re-prompt the model once with the correction. Cheap, and it makes the guarantee mechanical.

### 6.5 Human-like delivery (Conversationality is the #2 grading axis)

- Server returns `{bubbles: string[]}`. Client shows a typing indicator, then reveals bubble *i* after `min(300 + 28 × chars, 1800)` ms. No streaming; nothing arrives mid-sentence.
- Bubble copy guidelines (in the prompt + enforced by `humanize()`): sentence case, contractions, one idea per bubble, prices as "$742", times as "6:40 pm local", no bullet points, no headers, no asterisks, no "Here are your options:" preambles.
- Offers are presented in prose, max 3 at once ("Cheapest is Turkish at $742, lands 4:15 pm on the 12th, non-stop. There's a $610 Lufthansa one with a stop in Frankfurt that gets in at 6:50 pm — still before your cutoff. Want either of those?").
- The user's own bubbles render instantly; the assistant never sends more than 4 bubbles per turn.

---

## 7. Trip rules & validation (`lib/trip`)

```ts
export const TRIP_RULES = {
  origin: 'JFK', destination: 'IST',
  originTz: 'America/New_York', destinationTz: 'Europe/Istanbul',
  procedureAt: '2026-10-13T08:00',                 // local IST
  mustArriveBy: '2026-10-12T20:00',                // local IST, inclusive
  earliestReturnDeparture: '2026-10-17T12:00',     // local IST
  cabin: 'economy', checkedBags: 0, currency: 'USD', adults: 1,
  outboundSearchWindow: ['2026-10-11', '2026-10-12'],   // search both days; the validator decides
  returnSearchWindow:   ['2026-10-17', '2026-10-18'],
  hotel: { providerPropertyId: '…', name: '…', checkInTime: '15:00' },
} as const;
```

`validateItinerary(offer, rules)` → `{ok: true} | {ok: false, reason}`. Checks: final outbound segment arrival (in `Europe/Istanbul`) ≤ `mustArriveBy`; first return segment departure ≥ `earliestReturnDeparture`; all segments cabin = economy; currency USD. Unit tests must include: arrival 19:59 passes, 20:00 passes, 20:01 fails; overnight flights landing on the 12th vs the 13th; an itinerary whose arrival time is given in UTC (a classic silent failure).

`deriveNights(flightBooking)` → `{checkIn, checkOut}`: check-in = local arrival date of outbound; check-out = local departure date of return. For Level 0 that is Oct 12 → Oct 17 (5 nights) or Oct 11 → Oct 17 (6 nights) if the cheapest legal flight lands on the 11th. The agent explains the night count before booking.

---

## 8. Commit-by-commit roadmap (Day 1 & Day 2)

Push every item as its own commit to `main`. Conventional-commit prefixes so the history reads like a story. Estimated times assume ~10–12 focused hours/day; adjust, but keep the order — each step is testable on its own.

### Day 1 — plumbing, provider, proof of a real booking

| # | Commit | Done when |
|---|---|---|
| 1 | `chore: tooling — pnpm, prettier, vitest, check script, pre-push hook` | `pnpm check` passes on the template |
| 2 | `docs: add PLAN, DECISIONS, BUGS, .env.example` | this file in `docs/` |
| 3 | `feat(env): zod-validated env loader` | build fails on missing var |
| 4 | `feat(log): pino logger` | JSON lines in `pnpm dev` |
| 5 | `feat(sabre): auth + fetch wrapper with retry/timing` | `scripts/sabre-smoke.ts auth` prints a token |
| 6 | `feat(sabre): flight shop mapper + fixture` | smoke prints ≥1 normalized JFK→IST offer; fixture saved |
| 7 | `feat(sabre): hotel rates mapper + fixture; pin hotel` | smoke prints ≥1 rate for the pinned property |
| 8 | `feat(trip): rules + validateItinerary + deriveNights with tests` | vitest green incl. boundary cases |
| 9 | `feat(sabre): createFlightOrder + createHotelBooking` | smoke books both; **reference recorded in docs/BOOKINGS.md** |
| 10 | `feat(db): supabase client + 0001_init migration + typed queries` | migration applied to hosted project; `health` route returns ok |
| 11 | `chore(vercel): first deploy with env vars, health route live` | public URL returns health ok — **deploy on Day 1, not Day 2** |

### Day 2 — agent, chat, polish

| # | Commit | Done when |
|---|---|---|
| 12 | `feat(agent): tool registry + zod→json-schema + reply tool` | unit test: registry exposes 6 tools |
| 13 | `feat(agent): loop with persistence, tool_calls logging, prompt cache` | `curl POST /api/chat` returns bubbles; rows appear in all tables |
| 14 | `feat(agent): system prompt builder with live TripState` | prompt snapshot test |
| 15 | `feat(tools): search_flights + create_flight_order (guarded)` | booked via curl; deadline-violating offers never surface |
| 16 | `feat(tools): search_hotel_rates + create_hotel_booking` | nights derived from booked flight |
| 17 | `feat(agent): reference post-check on reply` | test: fake reference in bubbles is rejected |
| 18 | `feat(ui): chat page — bubbles, typing indicator, sequenced reveal, hydrate on refresh` | refresh keeps history |
| 19 | `feat(ui): landing state + first assistant greeting` | opens with a short human hello, asks what they need |
| 20 | `fix: humanize — strip markdown, cap bubble length` | tests |
| 21 | `feat(api): conversation GET + cookie` | new tab, same trip |
| 22 | `test: full manual run-through per docs/E2E.md; record references` | 2 clean end-to-end runs on the Vercel URL, references in `BOOKINGS.md` |
| 23 | `docs: README (architecture, running, judgment calls, known bugs)` | reviewer can run it locally in 5 minutes |
| 24 | `chore: final Level 0 tag v0.1.0` | tag pushed **before** the deadline; record the video from this commit |

If you're ahead at #22, **do not start Level 1** on Day 2. Spend the time on conversational quality (#18–20) and error copy — that's graded higher than a half-built Level 1.

---

## 9. Manual E2E script (`docs/E2E.md`, run on the deployed URL)

1. Open URL → greeting arrives as 1–2 bubbles, no markdown.
2. "I need to book my trip" → agent restates trip in one bubble, offers to find flights.
3. "yes" → 2–3 flight options in prose, all landing before 8 pm Oct 12; return departs after noon Oct 17.
4. "the cheapest" → agent confirms price/times and asks for passenger details, one question at a time.
5. Provide name/DOB/email/phone → agent confirms → booked → **reference quoted matches `bookings` table**.
6. Agent proposes the hotel nights derived from the flight → "yes" → cheapest room → confirm → booked → second reference.
7. Refresh page → full history intact. Check Vercel logs and `tool_calls` for the Sabre requests.
8. Negative: ask for "the 9pm arrival" → agent explains it lands after the cutoff and won't book it.
9. Negative: wait for offer expiry, then "book that one" → agent reports the offer expired, re-searches (Level 0 acceptable behaviour: honest error + re-search).

---

## 10. Judgment calls to log now (`docs/DECISIONS.md` seeds)

1. Provider adapter because the brief's "offers/orders" vocabulary may not match the Sabre API the token unlocks (§5.1).
2. Custom agent loop on the Anthropic SDK instead of Vercel AI SDK: the brief forbids streaming and wants multi-bubble human replies.
3. A terminal `reply` tool with `tool_choice: 'any'` to make "no blobs / no markdown" mechanical rather than prompt-hoped.
4. Rules enforced in code, twice (filter at search, re-check at book). The model never chooses dates or cabin at Level 0.
5. "On the ground by 8 pm Oct 12" interpreted as scheduled arrival of the last outbound segment in Istanbul local time, inclusive. Oct 11 arrivals are allowed (and add a hotel night — agent says so).
6. "Cannot fly home before Oct 17 12:00" interpreted as first return segment scheduled departure ≥ 12:00 IST.
7. Hotel nights = arrival date → return departure date, derived from the *booked* flight, never assumed.
8. Anonymous cookie conversations; no auth at Level 0 (nothing in the brief requires identity, and it keeps the interface "just the chat").
9. Passenger details collected in chat, one at a time, stored only on the booking.
10. Tool-call log kept in the DB as well as server logs, because Vercel logs are ephemeral and the reviewers need proof.

---

## 11. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Sabre sandbox returns no availability for chosen dates/property | Smoke test on Day 1 morning; keep 2–3 candidate hotels; if flights are sparse, widen `outboundSearchWindow` to Oct 10–12 |
| Token lifetime short / rate limits | Cached token with refresh-on-401; single retry with backoff on 429; keep search N small |
| Vercel timeout on a long turn | Node runtime, `maxDuration: 60`, cap loop at 8 iterations, small tool payloads, prompt caching |
| Model narrates results in markdown or a wall of text | Forced `reply` tool + `humanize()` + bubble length caps + UI sequencing |
| Double booking on retry/refresh | Partial unique index on `bookings`; create tools check DB first |
| Timezone bugs around the deadline | Luxon with explicit zones; boundary unit tests; never parse provider times without their offset |
| Offer expiry mid-conversation | Level 0: catch `OFFER_EXPIRED`, tell the user plainly, re-search. (Level 3 will add proactive re-pricing.) |
| Losing track of judgment calls for the video | `DECISIONS.md` updated in the same commit as the decision |

---

## 12. Definition of done for Level 0

- Two consecutive clean end-to-end runs on the Vercel URL with flight + hotel references recorded in `docs/BOOKINGS.md`.
- `pnpm check` (tsc, eslint, vitest) green on `main`.
- A deadline-violating flight is provably unbookable (test + manual step 8).
- Refresh keeps the conversation.
- `tool_calls` shows every Sabre request for those runs.
- README explains: architecture, tools, state, judgment calls, known bugs.
- Tag `v0.1.0` pushed before the two-day mark; video recorded from that commit.
