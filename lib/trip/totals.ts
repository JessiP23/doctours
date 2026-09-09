import type { FlightOffer, HotelRate } from '@/lib/providers/types';
import { deriveStay, type Stay } from './nights';

/**
 * Flight and hotel priced together.
 *
 * The cheapest flight is not the cheapest trip: a fare that saves $60 by landing
 * a day early adds a $108 night, and the patient who said money is tight is worse
 * off for taking it. Each itinerary implies a stay; each stay has a cheapest room;
 * the trip total is the sum, and that is what gets ranked. Pure: the caller has
 * already fetched the flights and priced a room for every distinct stay.
 */
export function stayKey(stay: Pick<Stay, 'checkIn' | 'checkOut'>): string {
  return `${stay.checkIn}|${stay.checkOut}`;
}

export function stayOf(offer: FlightOffer): Stay {
  return deriveStay(offer.slices[0], offer.slices[1]);
}

/** The distinct stays a set of itineraries implies — usually two to four. */
export function distinctStays(offers: FlightOffer[]): Stay[] {
  const seen = new Map<string, Stay>();
  for (const offer of offers) {
    const stay = stayOf(offer);
    if (!seen.has(stayKey(stay))) seen.set(stayKey(stay), stay);
  }
  return [...seen.values()];
}

/** The cheapest itineraries per stay, so each stay is represented without re-pricing everything. */
export function cheapestPerStay(offers: FlightOffer[], perStay: number): FlightOffer[] {
  const byStay = new Map<string, FlightOffer[]>();
  for (const offer of [...offers].sort((a, b) => a.price.amount - b.price.amount)) {
    const key = stayKey(stayOf(offer));
    const bucket = byStay.get(key) ?? [];
    if (bucket.length < perStay) {
      bucket.push(offer);
      byStay.set(key, bucket);
    }
  }
  return [...byStay.values()].flat();
}

export interface TripTotal {
  offer: FlightOffer;
  stay: Stay;
  /** The cheapest room for the stay, or null when the hotel had nothing for it. */
  room: HotelRate | null;
  flightUSD: number;
  hotelUSD: number | null;
  totalUSD: number | null;
}

/**
 * Ranks itineraries by flight + cheapest room for the stay each implies. Stays the
 * hotel could not price rank last, with the total left null — a total the tool
 * cannot compute is not a total.
 */
export function rankTripTotals(
  offers: FlightOffer[],
  roomByStay: Map<string, HotelRate | null>,
): TripTotal[] {
  const totals = offers.map((offer) => {
    const stay = stayOf(offer);
    const room = roomByStay.get(stayKey(stay)) ?? null;
    const flightUSD = offer.price.amount;
    const hotelUSD = room ? room.total.amount : null;
    return {
      offer,
      stay,
      room,
      flightUSD,
      hotelUSD,
      totalUSD: hotelUSD === null ? null : round2(flightUSD + hotelUSD),
    };
  });
  return totals.sort((a, b) => {
    if (a.totalUSD === null && b.totalUSD === null) return a.flightUSD - b.flightUSD;
    if (a.totalUSD === null) return 1;
    if (b.totalUSD === null) return -1;
    return a.totalUSD - b.totalUSD || a.flightUSD - b.flightUSD;
  });
}

/**
 * The sentence the agent needs: what the cheapest total is, and what the cheapest
 * flight alone would have cost once its nights are counted. Computed here so the
 * model never does the subtraction.
 */
export function describeTradeoff(ranked: TripTotal[]): {
  cheapestTotal: TripTotal | null;
  cheapestFlight: TripTotal | null;
  sameOption: boolean;
  savingsUSD: number | null;
  summary: string;
} {
  const priced = ranked.filter((t) => t.totalUSD !== null);
  const cheapestTotal = priced[0] ?? null;
  const cheapestFlight = [...ranked].sort((a, b) => a.flightUSD - b.flightUSD)[0] ?? null;
  if (!cheapestTotal || !cheapestFlight) {
    return {
      cheapestTotal,
      cheapestFlight,
      sameOption: false,
      savingsUSD: null,
      summary: 'No option could be priced as a whole trip.',
    };
  }
  const sameOption = cheapestTotal.offer.id === cheapestFlight.offer.id;
  if (sameOption || cheapestFlight.totalUSD === null) {
    return {
      cheapestTotal,
      cheapestFlight,
      sameOption,
      savingsUSD: 0,
      summary: sameOption
        ? `The cheapest flight is also the cheapest trip: $${cheapestTotal.flightUSD} for the flights plus $${cheapestTotal.hotelUSD} for ${cheapestTotal.stay.nights} night(s), $${cheapestTotal.totalUSD} in all.`
        : `The cheapest trip is $${cheapestTotal.totalUSD}: $${cheapestTotal.flightUSD} for the flights plus $${cheapestTotal.hotelUSD} for ${cheapestTotal.stay.nights} night(s). The cheapest flight alone ($${cheapestFlight.flightUSD}) implies a stay the hotel could not price.`,
    };
  }
  const savingsUSD = round2(cheapestFlight.totalUSD - cheapestTotal.totalUSD!);
  return {
    cheapestTotal,
    cheapestFlight,
    sameOption,
    savingsUSD,
    summary: `The cheapest trip is $${cheapestTotal.totalUSD}: $${cheapestTotal.flightUSD} for the flights plus $${cheapestTotal.hotelUSD} for ${cheapestTotal.stay.nights} night(s). The cheapest flight alone is $${cheapestFlight.flightUSD}, but it means ${cheapestFlight.stay.nights} night(s) at $${cheapestFlight.hotelUSD}, $${cheapestFlight.totalUSD} in all — $${savingsUSD} more.`,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
