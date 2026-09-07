import { z } from 'zod';
import { DateTime } from 'luxon';
import * as repo from '@/lib/db/repo';
import { rulesFor } from './context';
import { defineTool } from './define';
import {
  distinctItineraries,
  outboundDate,
  persistFlightOffers,
  rank,
  returnDate,
  searchAllowedFlights,
} from './flight-offers';

/**
 * Flight search.
 *
 * The model chooses the ranking and may narrow to one of the departure or
 * return dates the rules already allow — it cannot invent a date, change cabin,
 * add baggage or alter passenger counts, and every itinerary is still validated
 * against the hard deadlines before it is shown.
 *
 * The response reports how many valid options exist and which dates they cover,
 * so the agent can never claim "there is nothing on the 17th" from a shortlist.
 */
const MAX_SHOWN = 5;

export const searchFlightsTool = defineTool({
  name: 'search_flights',
  description:
    'Search round-trip flights for this trip. Cabin, baggage and passenger count are fixed by the trip rules. Options that would land too late or leave too early are filtered out before you see them. Use returnOn or departOn only to narrow to a date the patient asked about; the response tells you which dates have options.',
  schema: z.object({
    rankBy: z
      .enum(['price', 'fewest_stops', 'shortest'])
      .default('price')
      .describe('How to order the options. Price unless the patient asked otherwise.'),
    departOn: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe('Narrow to this outbound date, only if it is listed in outboundDatesAvailable'),
    returnOn: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe('Narrow to this return date, only if it is listed in returnDatesAvailable'),
  }),
  handler: async (input, ctx) => {
    const rules = await rulesFor(ctx.conversationId);
    const { offers, rejected, failures } = await searchAllowedFlights(rules, {
      outboundDate: input.departOn,
      returnDate: input.returnOn,
    });

    if (offers.length === 0) {
      return {
        options: [],
        totalValidOptions: 0,
        message:
          rejected.length > 0
            ? 'Flights came back but none satisfy the trip deadlines.'
            : 'No flights came back for those dates.',
        whyFilteredOut: [...new Set(rejected.map((r) => r.reason))].slice(0, 4),
        ...(failures.length > 0 ? { searchFailures: failures } : {}),
      };
    }

    const shown = distinctItineraries(rank(offers, input.rankBy), MAX_SHOWN);
    const rows = await persistFlightOffers(ctx.conversationId, shown);
    const expiresAt = rows[0]?.expires_at ?? null;

    return {
      options: rows.map((row) => ({ offerId: row.id, ...(row.summary as object) })),
      rankedBy: input.rankBy,
      totalValidOptions: offers.length,
      // Prevents claiming a date has nothing when it was simply outside the shortlist.
      outboundDatesAvailable: [...new Set(offers.map(outboundDate))].sort(),
      returnDatesAvailable: [...new Set(offers.map(returnDate))].sort(),
      cheapestByReturnDate: Object.fromEntries(
        [...new Set(offers.map(returnDate))]
          .sort()
          .map((date) => [
            date,
            Math.min(...offers.filter((o) => returnDate(o) === date).map((o) => o.price.amount)),
          ]),
      ),
      filteredOut: rejected.length,
      whyFilteredOut: [...new Set(rejected.map((r) => r.reason))].slice(0, 4),
      offersExpireAt: expiresAt,
      offerValidMinutes: expiresAt
        ? Math.max(0, Math.round(DateTime.fromISO(expiresAt).diffNow('minutes').minutes))
        : null,
      note: 'Prices include taxes. Hotel nights follow from the flight chosen, so a cheaper flight landing a day early adds a night.',
      ...(failures.length > 0 ? { searchFailures: failures } : {}),
    };
  },
});

/** Shared by the booking tools: an offer must exist, belong here, and still be valid. */
export async function loadBookableOffer(
  conversationId: string,
  offerId: string,
  kind: 'flight' | 'hotel_rate',
) {
  const row = await repo.getOffer(conversationId, offerId);
  if (!row || row.kind !== kind) {
    throw new Error(
      `No ${kind === 'flight' ? 'flight' : 'room'} option with id ${offerId} in this conversation`,
    );
  }
  const expired = row.expires_at ? DateTime.fromISO(row.expires_at) < DateTime.now() : false;
  return { row, expired };
}
