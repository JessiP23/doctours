import { DateTime } from 'luxon';
import type { Cabin, FlightOffer, FlightSegment, FlightSlice } from '@/lib/providers/types';

/**
 * Sabre Flight Shop (POST /v1/offers/flightShop) → normalized domain types.
 *
 * The response is a reference graph, not a tree:
 *   offers[].journeyRefs → journeys[].flightRefs → flights[]
 *   cabin and booking class live in offers[].items[].fares[].fareComponents[].segmentDetails[]
 *     keyed by the same flightRef
 *
 * Times are LOCAL WALL CLOCK at each airport with no UTC offset
 * ("departureDate": "2026-10-12", "departureTime": "10:40"), which is why
 * FlightSegment keeps local strings and all deadline comparisons are done in the
 * zone of the airport being compared (see lib/trip/validate.ts).
 */

export interface SabreFlight {
  id: string;
  departureAirportCode: string;
  departureDate: string;
  departureTime: string;
  arrivalAirportCode: string;
  arrivalDate: string;
  arrivalTime: string;
  operatingAirlineCode?: string;
  operatingFlightNumber?: number;
  marketingAirlineCode: string;
  marketingFlightNumber: number;
  durationInMinutes?: number;
  aircraftTypeCode?: string;
  departureTerminal?: string;
  arrivalTerminal?: string;
}

export interface SabreJourney {
  id: string;
  flightRefs: string[];
  requestedJourneyIndex: number;
}

export interface SabreSegmentDetail {
  flightRef: string;
  bookingClassCode?: string;
  cabinName?: string;
}

export interface SabreOffer {
  id: string;
  validUntil?: string;
  createdAt?: string;
  totalPrice?: { amount: string; currencyCode: string };
  journeyRefs?: string[];
  source?: { provider?: string; distributionModel?: string };
  items?: {
    fares?: {
      fareComponents?: { segmentDetails?: SabreSegmentDetail[] }[];
    }[];
  }[];
}

export interface FlightShopResponse {
  timestamp?: string;
  flights?: SabreFlight[];
  journeys?: SabreJourney[];
  offers?: SabreOffer[];
}

/**
 * Informational only. Deadline checks use the zones in TripRules for the
 * origin/destination airports, so an unknown connection airport can never cause
 * a wrong booking — at worst its zone is unknown and simply not displayed.
 */
const KNOWN_AIRPORT_TZ: Record<string, string> = {
  JFK: 'America/New_York',
  EWR: 'America/New_York',
  LGA: 'America/New_York',
  IST: 'Europe/Istanbul',
  SAW: 'Europe/Istanbul',
  AMS: 'Europe/Amsterdam',
  CDG: 'Europe/Paris',
  FRA: 'Europe/Berlin',
  MUC: 'Europe/Berlin',
  LHR: 'Europe/London',
  LIS: 'Europe/Lisbon',
  HEL: 'Europe/Helsinki',
  WAW: 'Europe/Warsaw',
  VIE: 'Europe/Vienna',
  ZRH: 'Europe/Zurich',
  DOH: 'Asia/Qatar',
  DXB: 'Asia/Dubai',
  CAI: 'Africa/Cairo',
};

export function airportTz(iata: string): string | null {
  return KNOWN_AIRPORT_TZ[iata.toUpperCase()] ?? null;
}

const CABINS: Record<string, Cabin> = {
  economy: 'economy',
  premiumeconomy: 'premium_economy',
  business: 'business',
  first: 'first',
};

export function normalizeCabin(name: string | undefined): Cabin | null {
  if (!name) return null;
  return CABINS[name.replace(/[\s_-]/g, '').toLowerCase()] ?? null;
}

/** Local wall clock at one airport; safe to diff against another time at the SAME airport. */
function wallClock(date: string, time: string): DateTime {
  return DateTime.fromISO(`${date}T${time.length === 5 ? `${time}:00` : time}`, { zone: 'utc' });
}

function localIso(date: string, time: string): string {
  return `${date}T${time.slice(0, 5)}`;
}

export interface MapResult {
  offers: FlightOffer[];
  /** Offers that could not be mapped, with the reason — surfaced for observability, never booked. */
  skipped: { offerId: string; reason: string }[];
}

/**
 * Maps a Flight Shop response into normalized offers.
 *
 * Fails soft per offer: a malformed or partially referenced offer is skipped with
 * a reason rather than throwing, so one bad entry cannot break a whole search.
 */
export function mapFlightShopResponse(response: FlightShopResponse, provider = 'sabre'): MapResult {
  const flightsById = new Map((response.flights ?? []).map((f) => [f.id, f]));
  const journeysById = new Map((response.journeys ?? []).map((j) => [j.id, j]));
  const offers: FlightOffer[] = [];
  const skipped: { offerId: string; reason: string }[] = [];

  for (const offer of response.offers ?? []) {
    try {
      if (!offer.totalPrice) throw new Error('offer has no totalPrice');
      const amount = Number(offer.totalPrice.amount);
      if (!Number.isFinite(amount))
        throw new Error(`unparseable price "${offer.totalPrice.amount}"`);

      // flightRef → cabin / booking class, from every fare component of this offer.
      const segmentInfo = new Map<string, SabreSegmentDetail>();
      for (const item of offer.items ?? []) {
        for (const fare of item.fares ?? []) {
          for (const component of fare.fareComponents ?? []) {
            for (const detail of component.segmentDetails ?? []) {
              if (!segmentInfo.has(detail.flightRef)) segmentInfo.set(detail.flightRef, detail);
            }
          }
        }
      }

      const journeys = (offer.journeyRefs ?? [])
        .map((ref) => {
          const journey = journeysById.get(ref);
          if (!journey) throw new Error(`journeyRef ${ref} not found`);
          return journey;
        })
        .sort((a, b) => a.requestedJourneyIndex - b.requestedJourneyIndex);
      if (journeys.length === 0) throw new Error('offer references no journeys');

      const slices: FlightSlice[] = journeys.map((journey) => {
        const flights = journey.flightRefs
          .map((ref) => {
            const flight = flightsById.get(ref);
            if (!flight) throw new Error(`flightRef ${ref} not found`);
            return flight;
          })
          .sort(
            (a, b) =>
              wallClock(a.departureDate, a.departureTime).toMillis() -
              wallClock(b.departureDate, b.departureTime).toMillis(),
          );
        if (flights.length === 0) throw new Error(`journey ${journey.id} has no flights`);

        const segments: FlightSegment[] = flights.map((flight) => {
          const detail = segmentInfo.get(flight.id);
          const cabin = normalizeCabin(detail?.cabinName);
          if (!cabin) throw new Error(`flight ${flight.id} has no recognizable cabin`);
          return {
            from: { iata: flight.departureAirportCode, tz: airportTz(flight.departureAirportCode) },
            to: { iata: flight.arrivalAirportCode, tz: airportTz(flight.arrivalAirportCode) },
            departLocal: localIso(flight.departureDate, flight.departureTime),
            arriveLocal: localIso(flight.arrivalDate, flight.arrivalTime),
            carrier: flight.marketingAirlineCode,
            flightNumber: String(flight.marketingFlightNumber),
            cabin,
            durationMin:
              flight.durationInMinutes ??
              Math.round(
                wallClock(flight.arrivalDate, flight.arrivalTime).diff(
                  wallClock(flight.departureDate, flight.departureTime),
                  'minutes',
                ).minutes,
              ),
            bookingClass: detail?.bookingClassCode,
            operatingCarrier: flight.operatingAirlineCode ?? flight.marketingAirlineCode,
            operatingFlightNumber: String(
              flight.operatingFlightNumber ?? flight.marketingFlightNumber,
            ),
            providerFlightId: flight.id,
            ...(flight.departureTerminal ? { departureTerminal: flight.departureTerminal } : {}),
            ...(flight.arrivalTerminal ? { arrivalTerminal: flight.arrivalTerminal } : {}),
          };
        });

        // Flight time plus layovers. Each layover is a wall-clock difference at one
        // airport, so it needs no timezone knowledge.
        const flightMinutes = segments.reduce((sum, s) => sum + s.durationMin, 0);
        let layoverMinutes = 0;
        for (let i = 1; i < flights.length; i++) {
          const previous = flights[i - 1];
          const next = flights[i];
          layoverMinutes += Math.round(
            wallClock(next.departureDate, next.departureTime).diff(
              wallClock(previous.arrivalDate, previous.arrivalTime),
              'minutes',
            ).minutes,
          );
        }

        return {
          segments,
          stops: segments.length - 1,
          durationMin: flightMinutes + layoverMinutes,
        };
      });

      const cabins = new Set(slices.flatMap((s) => s.segments.map((seg) => seg.cabin)));

      offers.push({
        id: offer.id,
        provider,
        slices,
        price: { amount, currency: offer.totalPrice.currencyCode },
        cabin: cabins.size === 1 ? [...cabins][0] : 'economy',
        checkedBagsIncluded: 0,
        expiresAt: offer.validUntil ?? null,
        raw: offer,
      });
    } catch (e) {
      skipped.push({
        offerId: offer.id ?? '(no id)',
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return { offers, skipped };
}
