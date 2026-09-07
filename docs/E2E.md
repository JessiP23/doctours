# Verifying Level 0

Two ways to prove the same thing. The script is deterministic and fast; the
conversation is the product.

## 1. The integration, without the model

```
npm run sabre:smoke -- e2e --dry-run   # shops, applies the rules, re-prices, books nothing
npm run sabre:smoke -- e2e             # books flight + hotel, reads both back, records them
```

`e2e` uses the same provider and the same trip rules as the agent. It prints one
JSON line per step and ends with `verified with Get Booking` and
`recorded in docs/BOOKINGS.md`. A run that ends any other way is a failure.

## 2. The conversation

On the deployed URL (or `npm run dev`), start a new trip from the panel and work
through this. Each numbered line is a message; the expectation follows.

1. **"I need to book my trip"** — restates the trip in one or two short bubbles, plain
   text, no markdown, and offers to look for flights.
2. **"what's the cheapest?"** — two or three options in prose with price, local times,
   stops and airline. Prices are live, not cached.
3. **"only non-stop"** — every option is non-stop, or it says plainly there are none.
4. **"I only want to fly Turkish"** — only TK options.
5. **"anything on Delta?"** — says truthfully that Delta is not among the options and
   describes what is. It must not invent one.
6. **"something leaving in the morning"** — departures between 06:00 and 12:00.
7. **"why can't I leave on the 14th?"** — explains the dates set around the procedure.
   It must not invent clinical reasoning.
8. **"book the cheapest one"** — confirms option and price, then asks for the traveller's
   details in ONE message.
9. Give name, date of birth, gender, email, phone — books, then quotes a reference.
   **Verify it:** `npm run sabre:smoke -- lookup <reference>` must show every segment
   `HK (Confirmed)`, arrival in Istanbul at or before `2026-10-12 20:00`, and return
   departure at or after `2026-10-17 12:00`.
10. **hotel** — proposes nights derived from that flight (not fixed dates), at the
    Holiday Inn City Istanbul, cheapest room first. If the flight lands well before
    3 PM check-in, it says so.
11. **"what other hotels are there?"** — explains every patient stays at this property.
12. Book a room — second reference, verifiable the same way.
13. **Refresh the page** — the whole conversation is still there.
14. **Trips panel** — the trip is listed as `fully booked` with both references.

## Negative checks

- Ask for "a flight arriving 9 pm on the 12th": refuses and explains the cutoff. No
  such option is ever shown, because the rules filter before the model sees anything.
- Leave the conversation 25 minutes, then confirm a fare: says the fare expired and
  quotes the current price for the same flights.
- Ask "did you book it yet?" before booking: says nothing is booked. It can never
  quote a reference that is not in the `bookings` table.

## The audit trail

```sql
select created_at, tool_name, duration_ms, provider_requests, error
from tool_calls order by id desc limit 20;
```

Every Sabre request the agent made, with status and duration.
