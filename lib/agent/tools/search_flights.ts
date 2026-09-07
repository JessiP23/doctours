import { z } from 'zod';
import { DateTime } from 'luxon';
import * as repo from '@/lib/db/repo';
import { log } from '@/lib/log';
import { travelProvider } from '@/lib/providers/sabre';
import type { FlightOffer } from '@/lib/providers/types';
import {
  applyPreferences,
  describeChoices,
  distinctItineraries,
  outboundDate,
  returnDate,
} from '@/lib/trip/select';
import { rulesFor } from './context';
import { defineTool } from './define';
import { persistFlightOffers, searchAllowedFlights } from './flight-offers';

/**
 * Flight search.
 *
 * Two layers, kept apart on purpose:
 *   rules        — dates, cabin, baggage, passengers, deadlines, sourcing. In code.
 *                  The model cannot touch them; every itinerary is validated first.
 *   preferences  — what the patient asked for: ranking, stops, airline, time of day,
 *                  a specific allowed date. The model maps words onto this schema and
 *                  code applies it deterministically over the rule-valid set.
 *
 * Prices are re-confirmed live (Flight Check) before anything is shown, so the
 * number the patient sees is the number they will be asked to confirm.
 */
const MAX_SHOWN = 5;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const window = z
  .object({ from: z.string().regex(TIME), to: z.string().regex(TIME) })
  .describe('Local time window, HH:mm inclusive');

export const searchFlightsTool = defineTool({
  name: 'search_flights',
  description:
    'Search round-trip flights for this trip. Cabin, baggage, passengers and the hard deadlines are fixed by the trip rules and cannot be changed. Map what the patient asked for onto the preferences: ranking, maximum stops, airline, time of day, or one of the allowed dates. The response says how many options exist and what they cover, so you can say truthfully when a preference has no match. Prices are live. Returns offerIds you can book.',
  schema: z.object({
    rankBy: z
      .enum(['price', 'fewest_stops', 'shortest'])
      .default('price')
      .describe('How to order the options. Price unless the patient asked otherwise.'),
    maxStops: z.number().int().min(0).max(3).optional().describe('0 for non-stop only'),
    airlines: z
      .array(z.string().regex(/^[A-Z0-9]{2}$/))
      .max(5)
      .optional()
      .describe('Restrict to these marketing airline IATA codes, e.g. ["TK"]'),
    departBetween: window.optional().describe('Outbound departure window at the origin'),
    returnBetween: window.optional().describe('Return departure window at the destination'),
    departOn: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe('Narrow to this outbound date, only if listed in outboundDatesAvailable'),
    returnOn: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe('Narrow to this return date, only if listed in returnDatesAvailable'),
  }),
  handler: async (input, ctx) => {
    const rules = await rulesFor(ctx.conversationId);
    const {
      offers: valid,
      rejected,
      failures,
    } = await searchAllowedFlights(rules, {
      outboundDate: input.departOn,
      returnDate: input.returnOn,
    });
    const whyFilteredOut = [...new Set(rejected.map((r) => r.reason))].slice(0, 4);

    if (valid.length === 0) {
      return {
        options: [],
        totalValidOptions: 0,
        message:
          rejected.length > 0
            ? 'Flights came back but none satisfy the trip rules.'
            : 'No flights came back for those dates.',
        whyFilteredOut,
        ...(failures.length > 0 ? { searchFailures: failures } : {}),
      };
    }

    // Preferences narrow the rule-valid set. If they narrow it to nothing, fall back
    // to the rule-valid set and say so, rather than pretending there is nothing at all.
    const { rankBy, maxStops, airlines, departBetween, returnBetween } = input;
    const preferred = applyPreferences(valid, {
      rankBy,
      maxStops,
      airlines,
      departBetween,
      returnBetween,
    });
    const preferencesMatched = preferred.length > 0;
    const pool = preferencesMatched ? preferred : applyPreferences(valid, { rankBy });

    // Re-price live before showing anything. A cached fare can be $400 off the live
    // one; the patient should only ever be quoted a price that will book.
    const provider = travelProvider();
    const shortlist = distinctItineraries(pool, MAX_SHOWN + 2);
    const checked = await Promise.allSettled(shortlist.map((o) => provider.priceFlightOffer(o)));
    const live: FlightOffer[] = [];
    let gone = 0;
    for (const [i, result] of checked.entries()) {
      if (result.status === 'fulfilled') live.push(result.value);
      else {
        gone++;
        log.info(
          { offerId: shortlist[i].id, reason: String(result.reason) },
          'offer failed live re-price, dropped',
        );
      }
    }
    const shown = applyPreferences(live, { rankBy }).slice(0, MAX_SHOWN);
    if (shown.length === 0) {
      return {
        options: [],
        totalValidOptions: valid.length,
        message: 'Every candidate fare had changed or expired when re-priced live. Search again.',
        whyFilteredOut,
      };
    }

    const rows = await persistFlightOffers(ctx.conversationId, shown);
    const expiresAt = rows[0]?.expires_at ?? null;

    return {
      options: rows.map((row) => ({ offerId: row.id, ...(row.summary as object) })),
      pricesAreLive: true,
      rankedBy: rankBy,
      preferencesMatched,
      ...(preferencesMatched
        ? {}
        : {
            note: 'No option matched all the preferences; these are the closest rule-valid options. Say so plainly.',
          }),
      totalValidOptions: valid.length,
      choices: describeChoices(valid),
      outboundDatesAvailable: [...new Set(valid.map(outboundDate))].sort(),
      returnDatesAvailable: [...new Set(valid.map(returnDate))].sort(),
      cheapestByReturnDate: Object.fromEntries(
        [...new Set(valid.map(returnDate))]
          .sort()
          .map((date) => [
            date,
            Math.min(...valid.filter((o) => returnDate(o) === date).map((o) => o.price.amount)),
          ]),
      ),
      filteredOut: rejected.length,
      whyFilteredOut,
      ...(gone > 0 ? { droppedAtRepricing: gone } : {}),
      offersExpireAt: expiresAt,
      offerValidMinutes: expiresAt
        ? Math.max(0, Math.round(DateTime.fromISO(expiresAt).diffNow('minutes').minutes))
        : null,
      hint: 'Prices include taxes and are live. Hotel nights follow from the flight chosen, so a cheaper flight landing a day early adds a night.',
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
