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

/** Stable identity of an itinerary, independent of fare code or price. */
export function itinerarySignature(offer: FlightOffer): string {
  return offer.slices
    .flatMap((slice) => slice.segments.map((s) => `${s.carrier}${s.flightNumber}@${s.departLocal}`))
    .join('|');
}

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

export type Ranking = 'price' | 'fewest_stops' | 'shortest';

export function rank(offers: FlightOffer[], by: Ranking): FlightOffer[] {
  const stops = (o: FlightOffer) => o.slices.reduce((n, s) => n + s.stops, 0);
  const duration = (o: FlightOffer) => o.slices.reduce((n, s) => n + s.durationMin, 0);
  return [...offers].sort((a, b) => {
    if (by === 'fewest_stops') return stops(a) - stops(b) || a.price.amount - b.price.amount;
    if (by === 'shortest') return duration(a) - duration(b) || a.price.amount - b.price.amount;
    return a.price.amount - b.price.amount;
  });
}

/** One entry per distinct itinerary, so the model is not shown the same flights at four fare codes. */
export function distinctItineraries(offers: FlightOffer[], limit: number): FlightOffer[] {
  const seen = new Set<string>();
  const out: FlightOffer[] = [];
  for (const offer of offers) {
    const key = itinerarySignature(offer);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(offer);
    if (out.length === limit) break;
  }
  return out;
}

export function outboundDate(offer: FlightOffer): string {
  return offer.slices[0].segments[0].departLocal.slice(0, 10);
}

export function returnDate(offer: FlightOffer): string {
  return offer.slices[1].segments[0].departLocal.slice(0, 10);
}
