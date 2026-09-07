# Manual end-to-end script (run on the deployed URL)

1. Open the URL → greeting arrives as 1–2 short bubbles, plain text, no markdown.
2. "I need to book my trip" → agent restates the trip in one bubble and offers to look for flights.
3. "yes" → 2–3 flight options in prose; every option lands in Istanbul before 8:00 PM on Oct 12 and departs Istanbul after 12:00 PM on Oct 17.
4. "the cheapest" → agent confirms price and times, then asks for passenger details one question at a time.
5. Provide name, date of birth, email, phone → agent confirms → flight booked → the reference quoted matches the `bookings` table.
6. Agent proposes hotel nights derived from the flight → "yes" → cheapest room → confirm → hotel booked → second reference.
7. Refresh the page → full history intact.
8. Check Vercel logs and the `tool_calls` table: Sabre requests present for every search/booking.
9. Negative: ask for a flight that lands after the cutoff → agent explains and refuses to book it.
10. Negative: wait for an offer to expire, then "book that one" → agent reports plainly that it expired and searches again.

Record every reference in `docs/BOOKINGS.md`.
