# Level 1 — the nine questions, and how each one is shown

Level 0 is done, deployed and verified. This plan is organised the way the brief is:
nine "what if" questions. For each one — who triggers it, what is built, what is
left, and exactly how it is shown on camera.

## Two kinds of trigger

Every Level 1 scenario starts in one of two places, and the demo has to be honest
about which.

**The patient says it, in the chat.** Cancelling, bringing a companion, wanting
fewer stops, wanting to arrive early, wanting a cheaper trip. These are already
testable by typing.

**Someone else does it, outside the chat.** An airline cancels a flight. A clinic
moves a procedure. A hotel drops a reservation. The patient did not do these and is
not asking about them — the whole point is that the agent raises them first. Sabre
CERT has no feed for any of it, so these are driven from an **operator console**: a
separate route (`/ops`) where an operator plays the airline, the clinic or the
hotel. It writes the same `trip_events` rows a real feed would write, and nothing
else — it never touches Sabre and never edits a booking. The chat reads those events
on its next turn, exactly as it does today for the CLI `disrupt` command.

The console is not a patient interface, and the conversation stays the whole
interface for the patient. Say that on camera: "this is the airline's side of the
world, simulated, because the sandbox cannot cancel a flight for us."

---

## The nine questions

| #   | The brief asks                                                                           | Trigger  | Status                                                                                                                                                                        | Left to build                                                                                                               |
| --- | ---------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 1   | Outbound cancelled → arrives a different day → hotel dates wrong. Fix both.              | Operator | **Done, verified live.** Console cancels it, the agent speaks first, rebooks, leaves the cancelled flight out, and moves the room.                                            | Nothing.                                                                                                                    |
| 2   | Return cancelled → stuck longer → needs more nights.                                     | Operator | **Done.** Same path; the realignment moves the checkout.                                                                                                                      | One live run with _Airline cancels the return_.                                                                             |
| 3   | Lands before check-in. Get in early? Arrives a full day early — pay for the extra night. | Patient  | **Half.** Early landing is flagged when rooms are shown. No early check-in request, no extra night.                                                                           | Extra night via `rebook_hotel` with an earlier check-in; early check-in as a request on the reservation.                    |
| 4   | Procedure moved → whole trip needs new dates. Rebook flights and hotel together.         | Operator | **Built.** Rules derive from the procedure date; console and `set_procedure_date` both go through `moveProcedure`; the agent walks search → `rebook_flight` → `rebook_hotel`. | One live run: console moves it to Oct 20, agent raises it, new references chained to the old.                               |
| 5   | Patient cancels entirely. Undo both.                                                     | Patient  | **Built.** Hotel first, verified with Sabre, cost stated first, `confirmed` required.                                                                                         | Nothing.                                                                                                                    |
| 6   | Brings someone. Husband and wife want one bed, sisters want two. Book the right room.    | Patient  | **Built.** Count established by the greeting, prices for everyone, bed setups are separate options, everyone on the ticket and the room.                                      | Nothing.                                                                                                                    |
| 7   | Doesn't want the default hotel. Search others, book one instead.                         | Patient  | **Not built.** One property, pinned.                                                                                                                                          | `search_hotels` by geo around the arrival airport; the chosen property becomes this trip's hotel; rooms and booking follow. |
| 8   | Money is tight. Flight and hotel prices trade off. Bring the total down.                 | Patient  | **Not built.** Flights rank by price alone.                                                                                                                                   | `compare_trip_totals`: hotel total for each distinct stay a flight implies, ranked by flight + hotel.                       |
| 9   | Hates connections. Fewest stops even if it costs more.                                   | Patient  | **Built.** `rankBy: fewest_stops`, `maxStops: 0`.                                                                                                                             | Nothing.                                                                                                                    |

Seven done, one half, two not — plus the operator console and the agent speaking
first, which the brief only asks for at Level 3. Everything not built reuses the
rebooking tools that already exist; none of it needs a new Sabre call type.

---

## What gets built, in order

### A · Operator console — `/ops` — **done**

Unlocks the demo for 1, 2 and 4, and makes "it came from them" visible instead of
typed into a terminal.

- `app/ops/page.tsx`: recent trips with what they hold and any open events. Per
  trip, buttons: **Airline cancels outbound / return**, **Airline changes the
  schedule**, **Hotel cancels the reservation**, **Clinic moves the procedure to
  <date>**, **Re-read from Sabre** (the real `checkFlightHealth`), **Clear events**.
- `app/api/ops/[action]/route.ts`: each button is one POST. Every action writes
  `trip_events` (source `simulated`) through the same functions the CLI uses;
  `check` is the only one that reaches Sabre, read-only.
- Gated by `OPS_TOKEN` (env, compared in the route). No accounts; it is not a
  product surface, it is the sandbox's missing half.
- New event kinds: `hotel_cancelled`, `procedure_moved`. The prompt's untold-changes
  block already renders any kind; the raised-event guard gets words for both.

**Done when:** clicking "Airline cancels outbound" and then typing "what time do I
land?" in the chat produces the cancellation first, and `rebook_flight` follows.

### B · Procedure moved — question 4 — **built**

- `lib/trip/derive.ts`: from `procedureAtLocal` derive `mustArriveByLocal` (the
  evening before, 20:00), `earliestReturnDepartureLocal` (procedure day + 4, 12:00),
  and the outbound/return shop dates. The existing constants become the derivation's
  output for Oct 13 — a test asserts they are identical, so nothing moves.
- `set_procedure_date` tool: writes the new date and derived rules to the
  conversation's snapshot. Callable by the agent when the patient reports it; the
  console's "clinic moves the procedure" writes a `procedure_moved` event and updates
  the rules directly. Both are `moveProcedure` in `lib/agent/procedure.ts`, which
  also says which booked leg no longer fits, using the same validators the search
  uses. Migration `0006` adds the event kind. The loop re-reads the rules within
  the turn after a tool changes them (`refreshesRules`), so the prompt never
  describes the old deadlines while the tools obey the new ones.
- No new rebooking tool. The prompt walks it: raise the change → search flights
  (already obeying the new rules) → `rebook_flight` → `rebook_hotel`. Each step
  confirms with the patient; nothing is bought in the turn that proposes it.

**Done when:** console moves the procedure to Oct 20, the agent raises it before
answering, and the trip ends with new flight and room references chained to the old
ones via `superseded`.

### C · Early check-in and the extra night — question 3

- `search_hotel_rates` already accepts explicit dates. The prompt gains the path:
  when the patient lands before check-in and wants the room, offer the night before
  as an extra night, price it, and move the room with `rebook_hotel` once they agree.
  The extra night is an ordinary rate, charged the ordinary way — say so.
- Early check-in on the same day is a request, not a booking: `specialInstruction`
  already exists on the hotel Create Booking request. Add `earlyCheckIn: true` to the
  booking and rebooking tools, filed as that instruction, and have the agent say
  plainly it is a request the hotel may not honour.

**Done when:** "I land at 6am, can I get in early?" leads to the two options — a
request for that day, or an extra night with its price — and the chosen one is real.

### D · Other hotels — question 7

- `search_hotels` tool: geo availability around the arrival airport (the request
  builder already has the geo path and the probe found properties). Returns a short
  list with name, address, distance from the airport, and lead rate — nothing the
  provider did not send.
- The chosen property becomes this trip's `rules.hotel`, the same way the traveller
  count became trip state. `search_hotel_rates` and both hotel booking tools read it
  from the rules already, so they follow without change.
- Level 0's pinned property becomes the default, not the rule. DECISIONS records the
  change and why.

**Done when:** "I don't want the Holiday Inn" produces real alternatives with
distances, and a room at the chosen one is booked with a Sabre reference.

### E · Cheapest whole trip — question 8

- `compare_trip_totals` tool: take the valid flight options, group by the stay each
  implies (usually two to four distinct check-in/check-out pairs), price the
  cheapest room for each stay concurrently, and return options ranked by flight +
  hotel with both numbers shown. Rates cached per stay for the turn.
- The ranking is a tool result, never the model's arithmetic. The agent says what the
  cheapest total is and what it costs in timing to get it.

**Done when:** "cheapest overall" returns a total that differs from cheapest-flight,
and the agent explains the trade in one sentence.

---

## Three rules that still hold

1. **Propose → confirm → apply.** Nothing is bought in the turn that suggests it.
2. **Rules in code, preferences typed.** The procedure date and the hotel become
   per-trip rules; the model fills schema fields, it never reasons over a shortlist.
3. **Every commit ends verified against CERT**, with a walk-through in
   `E2E-LEVEL-1.md` and a `DECISIONS.md` entry for any judgment call.

## Deliberately not doing

- **A patient-facing dashboard.** The operator console is for the operator. The
  patient has the conversation.
- **A live disruption feed.** There is none in CERT. The console and the CLI write
  what a feed would write; say so on camera.
- **Sabre `modifyBooking`.** Cancel-and-rebook uses the two calls we trust; the
  `superseded` chain is what makes that honest.
- **Passport numbers.** Nothing here files travel documents (DECISIONS #30).

## Order and why

A first: it turns three of the nine from "run a CLI command" into something you can
show, and it is small — the functions exist, it is a page and a route. B next: it is
the biggest remaining question and it reuses everything A exposes. C is small and
independent. D and E are independent of each other and of B; do D before E because
E's hotel pricing is cheaper to reason about once the hotel is per-trip state.

## The video, in this order

1. Fresh trip, two travellers, book flight and room. (0, 6, 9 in passing: ask for
   non-stop, then cheapest.)
2. Operator console: airline cancels the outbound. Back to the chat, type anything.
   The agent raises it, searches, rebooks, moves the room. Show the `superseded`
   chain in the database. (1, 2)
3. Operator console: clinic moves the procedure. Same shape, whole trip. (4)
4. Patient: "I land at six in the morning" → early check-in or extra night. (3)
5. Patient: "I don't want that hotel" → alternatives with distances → book one. (7)
6. Patient: "what's the cheapest overall?" → flight + hotel total. (8)
7. Patient cancels everything. Verify with Sabre on camera. (5)

Each step says out loud what is real and what is simulated. That sentence is worth
more than any of the features.
