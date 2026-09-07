import type { Cabin } from '@/lib/providers/types';

/**
 * The trip contract for Level 0.
 *
 * Every hard constraint from the brief lives here — not in the prompt. Tools read
 * these values instead of accepting them from the model, and `validate.ts` enforces
 * them before anything is booked. Later levels turn some fields into per-conversation
 * parameters (they are already snapshotted into `conversations.trip_rules`).
 *
 * Local times are wall-clock strings interpreted in the paired IANA zone.
 */
export interface HotelRule {
  providerPropertyId: string;
  name: string;
  city: string;
  checkInTime: string; // HH:mm local
  checkOutTime: string; // HH:mm local
}

export interface TripRules {
  origin: string;
  destination: string;
  originTz: string;
  destinationTz: string;
  procedureAtLocal: string; // destination local
  mustArriveByLocal: string; // destination local, inclusive
  earliestReturnDepartureLocal: string; // destination local, inclusive
  /** Departure dates (origin local) to shop for the outbound leg. */
  outboundDepartureDates: string[];
  /** Departure dates (destination local) to shop for the return leg. */
  returnDepartureDates: string[];
  adults: number;
  cabin: Cabin;
  checkedBags: number;
  currency: string;
  /**
   * Whether itineraries may include codeshare segments — a seat sold by one
   * airline on a flight operated by another. Sabre CERT cannot confirm those
   * sells (the operating carrier's confirmation is not simulated), so they are
   * excluded here; production can allow them once the sell path is proven.
   */
  allowCodeshares: boolean;
  hotel: HotelRule;
}

export const TRIP_RULES: TripRules = {
  origin: 'JFK',
  destination: 'IST',
  originTz: 'America/New_York',
  destinationTz: 'Europe/Istanbul',
  procedureAtLocal: '2026-10-13T08:00',
  mustArriveByLocal: '2026-10-12T20:00',
  earliestReturnDepartureLocal: '2026-10-17T12:00',
  // JFK→IST is overnight (~10h + 7h offset): a departure on the 11th lands on the 12th.
  outboundDepartureDates: ['2026-10-11', '2026-10-10'],
  returnDepartureDates: ['2026-10-17', '2026-10-18'],
  adults: 1,
  cabin: 'economy',
  checkedBags: 0,
  currency: 'USD',
  allowCodeshares: false,
  hotel: {
    // Pinned after probing CERT inventory: of the three Istanbul properties that
    // return bookable rates for these dates (Holiday Inn City $107.94/night,
    // Hilton $382.54, Ritz-Carlton $468.91) this is the cheapest and sits in
    // Fatih, close to the hospital district. See docs/DECISIONS.md #13.
    providerPropertyId: '100071112',
    name: 'Holiday Inn City Istanbul',
    city: 'Istanbul',
    checkInTime: '15:00',
    checkOutTime: '12:00',
  },
};
