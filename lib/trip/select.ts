import type { FlightOffer } from '@/lib/providers/types';

/**
 * Pure itinerary selection helpers — identity, ranking, de-duplication and
 * exclusions. No IO and no server-only imports, so they are usable from the
 * agent tools, the e2e script and unit tests alike.
 */

/** Stable identity of an itinerary, independent of fare code or price. */
export function itinerarySignature(offer: FlightOffer): string {
  return offer.slices
    .flatMap((slice) => slice.segments.map((s) => `${s.carrier}${s.flightNumber}@${s.departLocal}`))
    .join('|');
}

/** A codeshare is a seat sold by one airline on a flight operated by another. */
export function isCodeshare(offer: FlightOffer): boolean {
  return offer.slices.some((slice) =>
    slice.segments.some(
      (s) => s.operatingCarrier !== undefined && s.operatingCarrier !== s.carrier,
    ),
  );
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

/** One entry per distinct itinerary, so the same flights are not shown at four fare codes. */
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

export interface RefusedFlight {
  carrier: string;
  flightNumber: string;
}

/**
 * Safety net for a live refusal: drops the flights the airline just refused and
 * every other codeshare marketed by the same carrier, keeping that carrier's own
 * flights and everything else. With codeshares excluded by rule this rarely
 * matters, but any airline can refuse a sell, and offering the same thing again
 * only costs the patient another failure.
 */
export function excludeRefused(offers: FlightOffer[], refused: RefusedFlight[]): FlightOffer[] {
  if (refused.length === 0) return offers;
  const flights = new Set(refused.map((r) => `${r.carrier}${r.flightNumber}`));
  const carriers = new Set(refused.map((r) => r.carrier));
  return offers.filter((offer) =>
    offer.slices.every((slice) =>
      slice.segments.every((s) => {
        if (flights.has(`${s.carrier}${s.flightNumber}`)) return false;
        const codeshare = s.operatingCarrier !== undefined && s.operatingCarrier !== s.carrier;
        return !(codeshare && carriers.has(s.carrier));
      }),
    ),
  );
}

/**
 * Soft preferences the patient expresses in conversation. Distinct from the hard
 * rules in TripRules: rules are enforced in code and cannot be changed by the
 * model; preferences are what the model maps the patient's words onto, and code
 * applies them deterministically. "Fewest stops", "only Turkish", "leave in the
 * evening" all land here — never as free-text reasoning over a shortlist.
 */
export interface FlightPreferences {
  rankBy?: Ranking;
  /** Maximum stops per direction; 0 = non-stop only. */
  maxStops?: number;
  /** Restrict to these marketing carriers (IATA codes). */
  airlines?: string[];
  /** Outbound departure window, local time at the origin, "HH:mm" inclusive. */
  departBetween?: { from: string; to: string };
  /** Return departure window, local time at the destination, "HH:mm" inclusive. */
  returnBetween?: { from: string; to: string };
}

function timeOf(localIso: string): string {
  return localIso.slice(11, 16);
}

function inWindow(time: string, window: { from: string; to: string } | undefined): boolean {
  if (!window) return true;
  return window.from <= window.to
    ? time >= window.from && time <= window.to
    : time >= window.from || time <= window.to; // window crossing midnight
}

/** Applies preferences as filters, then ranks. Never widens beyond the offers given. */
export function applyPreferences(offers: FlightOffer[], prefs: FlightPreferences): FlightOffer[] {
  const airlines = prefs.airlines?.map((a) => a.toUpperCase());
  const filtered = offers.filter((offer) => {
    if (prefs.maxStops !== undefined && offer.slices.some((s) => s.stops > prefs.maxStops!))
      return false;
    if (
      airlines?.length &&
      !offer.slices.every((s) => s.segments.every((g) => airlines.includes(g.carrier)))
    ) {
      return false;
    }
    if (!inWindow(timeOf(offer.slices[0].segments[0].departLocal), prefs.departBetween))
      return false;
    if (
      offer.slices[1] &&
      !inWindow(timeOf(offer.slices[1].segments[0].departLocal), prefs.returnBetween)
    ) {
      return false;
    }
    return true;
  });
  return rank(filtered, prefs.rankBy ?? 'price');
}

/** What is on offer, so the agent can say "no non-stops, but…" truthfully. */
export function describeChoices(offers: FlightOffer[]) {
  const carriers = new Map<string, number>();
  let nonStop = 0;
  for (const o of offers) {
    const c = o.slices[0].segments[0].carrier;
    carriers.set(c, (carriers.get(c) ?? 0) + 1);
    if (o.slices.every((s) => s.stops === 0)) nonStop++;
  }
  return {
    total: offers.length,
    nonStop,
    carriers: Object.fromEntries([...carriers.entries()].sort((a, b) => b[1] - a[1])),
    cheapestUSD: offers.length ? Math.min(...offers.map((o) => o.price.amount)) : null,
  };
}
