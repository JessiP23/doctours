import { z } from 'zod';
import { DateTime } from 'luxon';
import * as repo from '@/lib/db/repo';
import type { Json } from '@/lib/db/types';
import { travelProvider } from '@/lib/providers/sabre';
import type { FlightOffer } from '@/lib/providers/types';
import { partitionOffers } from '@/lib/trip/validate';
import { deriveStay } from '@/lib/trip/nights';
import { rulesFor } from './context';
import { defineTool } from './define';

/**
 * Flight search.
 *
 * Dates, cabin, bag count and passenger count come from the trip rules, never
 * from the model — the only thing the model chooses is how to rank results.
 * Offers that break a hard deadline are removed before the model sees them, and
 * every surviving offer is persisted so booking can only reference a real one.
 */
const MAX_SHOWN = 5;

export const searchFlightsTool = defineTool({
  name: 'search_flights',
  description:
    'Search round-trip flights for this trip. Dates, cabin and baggage are fixed by the trip rules, so you only choose the ranking. Options that would land too late or leave too early are filtered out before you see them. Returns offerIds you can book.',
  schema: z.object({
    rankBy: z
      .enum(['price', 'fewest_stops', 'shortest'])
      .default('price')
      .describe('How to order the options. Price unless the patient asked otherwise.'),
  }),
  handler: async (input, ctx) => {
    const rules = await rulesFor(ctx.conversationId);
    const provider = travelProvider();

    // Search every candidate departure pairing and let the rules decide, rather
    // than assuming which day works — an overnight flight can land a day later.
    const searches = rules.outboundDepartureDates.flatMap((departDate) =>
      rules.returnDepartureDates.map((returnDate) => ({ departDate, returnDate })),
    );

    const found: FlightOffer[] = [];
    const failures: string[] = [];
    for (const { departDate, returnDate } of searches) {
      try {
        const offers = await provider.searchFlights({
          origin: rules.origin,
          destination: rules.destination,
          departDate,
          returnDate,
          adults: rules.adults,
          cabin: rules.cabin,
          currency: rules.currency,
        });
        found.push(...offers);
      } catch (e) {
        failures.push(`${departDate}/${returnDate}: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (found.length >= 60) break; // enough to choose from; keep the turn fast
    }

    if (found.length === 0) {
      return {
        options: [],
        note: 'No flights came back for any candidate date.',
        searchFailures: failures,
      };
    }

    const { valid, rejected } = partitionOffers(found, rules);

    const ranked = [...valid].sort((a, b) => {
      if (input.rankBy === 'fewest_stops') {
        const stops = (o: FlightOffer) => o.slices.reduce((n, s) => n + s.stops, 0);
        return stops(a) - stops(b) || a.price.amount - b.price.amount;
      }
      if (input.rankBy === 'shortest') {
        const duration = (o: FlightOffer) => o.slices.reduce((n, s) => n + s.durationMin, 0);
        return duration(a) - duration(b) || a.price.amount - b.price.amount;
      }
      return a.price.amount - b.price.amount;
    });

    // Deduplicate itineraries that differ only by fare code.
    const seen = new Set<string>();
    const shown: FlightOffer[] = [];
    for (const offer of ranked) {
      const key = offer.slices
        .flatMap((s) => s.segments.map((g) => `${g.carrier}${g.flightNumber}${g.departLocal}`))
        .join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      shown.push(offer);
      if (shown.length === MAX_SHOWN) break;
    }

    const rows = await repo.insertOffers(
      ctx.conversationId,
      shown.map((offer) => {
        const stay = deriveStay(offer.slices[0], offer.slices[1]);
        return {
          kind: 'flight' as const,
          provider: offer.provider,
          providerOfferId: offer.id,
          summary: {
            priceUSD: offer.price.amount,
            carrier: offer.slices[0].segments[0].carrier,
            outbound: {
              departLocal: offer.slices[0].segments[0].departLocal,
              arriveLocal: offer.slices[0].segments.at(-1)!.arriveLocal,
              stops: offer.slices[0].stops,
              via: offer.slices[0].segments.slice(0, -1).map((s) => s.to.iata),
              durationHours: Math.round((offer.slices[0].durationMin / 60) * 10) / 10,
            },
            inbound: {
              departLocal: offer.slices[1].segments[0].departLocal,
              arriveLocal: offer.slices[1].segments.at(-1)!.arriveLocal,
              stops: offer.slices[1].stops,
              via: offer.slices[1].segments.slice(0, -1).map((s) => s.to.iata),
            },
            hotelNights: stay.nights,
            checkIn: stay.checkIn,
            checkOut: stay.checkOut,
          } as unknown as Json,
          raw: offer.raw as Json,
          expiresAt: offer.expiresAt,
        };
      }),
    );

    return {
      options: rows.map((row) => ({ offerId: row.id, ...(row.summary as object) })),
      rankedBy: input.rankBy,
      filteredOut: rejected.length,
      // Give the model the reasons so it can answer "why not the 9pm one?" honestly.
      whyFilteredOut: [...new Set(rejected.map((r) => r.reason))].slice(0, 4),
      offersExpireAt: rows[0]?.expires_at ?? null,
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
