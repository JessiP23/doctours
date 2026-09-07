import * as repo from '@/lib/db/repo';
import type { Json, OfferRow } from '@/lib/db/types';
import { log } from '@/lib/log';
import { travelProvider } from '@/lib/providers/sabre';
import type { FlightOffer } from '@/lib/providers/types';
import { deriveStay } from '@/lib/trip/nights';
import type { TripRules } from '@/lib/trip/rules';
import { partitionOffers, type ValidationCode } from '@/lib/trip/validate';

/**
 * Shared flight-offer plumbing for the search and booking tools, so both
 * describe, persist and identify offers exactly the same way.
 */

export {
  distinctItineraries,
  excludeRefused,
  isCodeshare,
  itinerarySignature,
  outboundDate,
  rank,
  returnDate,
  type Ranking,
  type RefusedFlight,
} from '@/lib/trip/select';

export function summarizeFlightOffer(offer: FlightOffer) {
  const [outbound, inbound] = offer.slices;
  const stay = deriveStay(outbound, inbound);
  return {
    priceUSD: offer.price.amount,
    carrier: outbound.segments[0].carrier,
    outbound: {
      departLocal: outbound.segments[0].departLocal,
      arriveLocal: outbound.segments.at(-1)!.arriveLocal,
      stops: outbound.stops,
      via: outbound.segments.slice(0, -1).map((s) => s.to.iata),
      durationHours: Math.round((outbound.durationMin / 60) * 10) / 10,
    },
    inbound: {
      departLocal: inbound.segments[0].departLocal,
      arriveLocal: inbound.segments.at(-1)!.arriveLocal,
      stops: inbound.stops,
      via: inbound.segments.slice(0, -1).map((s) => s.to.iata),
    },
    hotelNights: stay.nights,
    checkIn: stay.checkIn,
    checkOut: stay.checkOut,
  };
}

export async function persistFlightOffers(
  conversationId: string,
  offers: FlightOffer[],
): Promise<OfferRow[]> {
  return repo.insertOffers(
    conversationId,
    offers.map((offer) => ({
      kind: 'flight' as const,
      provider: offer.provider,
      providerOfferId: offer.id,
      summary: summarizeFlightOffer(offer) as unknown as Json,
      raw: offer as unknown as Json,
      expiresAt: offer.expiresAt,
    })),
  );
}

export interface SearchOutcome {
  offers: FlightOffer[];
  rejected: { reason: string; code: ValidationCode }[];
  failures: string[];
}

/**
 * Searches every candidate departure/return pairing allowed by the rules and
 * returns only itineraries that satisfy them.
 *
 * Pairings run concurrently: each Sabre shop call takes about six seconds, and
 * doing them in sequence made a search feel like a stall in conversation.
 */
export async function searchAllowedFlights(
  rules: TripRules,
  opts: { outboundDate?: string; returnDate?: string } = {},
): Promise<SearchOutcome> {
  const outboundDates = opts.outboundDate ? [opts.outboundDate] : rules.outboundDepartureDates;
  const returnDates = opts.returnDate ? [opts.returnDate] : rules.returnDepartureDates;
  const provider = travelProvider();

  const results = await Promise.allSettled(
    outboundDates.flatMap((departDate) =>
      returnDates.map(async (returnDate) => ({
        departDate,
        returnDate,
        offers: await provider.searchFlights({
          origin: rules.origin,
          destination: rules.destination,
          departDate,
          returnDate,
          adults: rules.adults,
          cabin: rules.cabin,
          currency: rules.currency,
        }),
      })),
    ),
  );

  const found: FlightOffer[] = [];
  const failures: string[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') found.push(...result.value.offers);
    else
      failures.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
  }
  if (failures.length > 0) log.warn({ failures }, 'some flight searches failed');

  const { valid, rejected } = partitionOffers(found, rules);
  return {
    offers: valid,
    rejected: rejected.map((r) => ({ reason: r.reason, code: r.code })),
    failures,
  };
}
