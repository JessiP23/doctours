/**
 * Normalized travel domain types.
 *
 * Everything above the provider layer (tools, agent, DB summaries, UI) speaks these
 * types only. Provider-specific payloads are kept in `raw` fields for debugging and
 * later operations (rebooking, cancellation) but are never interpreted elsewhere.
 *
 * All local times are ISO-8601 strings WITHOUT offset (e.g. "2026-10-12T19:40")
 * paired with an IANA `tz`. Comparisons must always go through luxon with that zone.
 */

export interface Money {
  amount: number; // major units, e.g. 742.10
  currency: string; // ISO 4217, e.g. "USD"
}

export type Cabin = 'economy' | 'premium_economy' | 'business' | 'first';

export interface Airport {
  iata: string;
  /**
   * IANA zone, when known. Informational only: deadline comparisons use the zones
   * declared in TripRules for the origin/destination, so an unknown connection
   * airport can never lead to a wrong booking.
   */
  tz: string | null;
}

export interface FlightSegment {
  from: Airport;
  to: Airport;
  departLocal: string; // local wall time at `from`
  arriveLocal: string; // local wall time at `to`
  carrier: string; // marketing carrier IATA code
  flightNumber: string;
  cabin: Cabin;
  durationMin: number;
  /** Booking class letter (RBD) as filed, needed when creating the booking. */
  bookingClass?: string;
  /** Provider's own id for this flight, used to build the Flight Check payload. */
  providerFlightId?: string;
}

/** One direction of travel (outbound or return), possibly with connections. */
export interface FlightSlice {
  segments: FlightSegment[];
  stops: number; // segments.length - 1
  durationMin: number; // first departure → last arrival
}

export interface FlightOffer {
  id: string; // provider offer id / our stable key to re-price and book
  provider: string;
  slices: FlightSlice[]; // [outbound] or [outbound, return]
  price: Money;
  cabin: Cabin;
  checkedBagsIncluded: number;
  expiresAt: string | null; // ISO with offset, if the provider gives one
  raw: unknown;
}

export interface FlightSearch {
  origin: string;
  destination: string;
  departDate: string; // YYYY-MM-DD
  returnDate?: string; // YYYY-MM-DD → round trip when present
  adults: number;
  cabin: Cabin;
  currency: string;
  maxResults?: number;
}

export interface Passenger {
  givenName: string;
  familyName: string;
  dateOfBirth: string; // YYYY-MM-DD
  gender: 'M' | 'F' | 'X';
  email: string;
  phone: string; // E.164 preferred
}

export interface FlightOrder {
  id: string; // provider order / PNR id
  bookingReference: string; // what the patient is told (record locator)
  provider: string;
  offerId: string;
  slices: FlightSlice[];
  price: Money;
  passengers: Passenger[];
  raw: unknown;
}

export interface HotelSearch {
  propertyId: string; // provider property id
  checkIn: string; // YYYY-MM-DD
  checkOut: string; // YYYY-MM-DD
  adults: number;
  currency: string;
}

export interface HotelRate {
  /** Provider rate key. Long and opaque; the model only ever sees our own offer id. */
  id: string;
  provider: string;
  propertyId: string;
  propertyName: string;
  roomName: string;
  /** Human description of the room, e.g. "2 Single Beds Standard 22 SqM Room". */
  roomDescription: string | null;
  bedTypes: string[];
  maxOccupancy: number | null;
  /** Rate plan product code, required to create the booking. */
  productCode: string | null;
  ratePlanName: string | null;
  checkIn: string;
  checkOut: string;
  nights: number;
  nightly: Money;
  /** Total including taxes and fees — what the patient actually pays. */
  total: Money;
  taxes: Money | null;
  refundable: boolean | null;
  /** Free cancellation deadline, ISO with offset, when the provider states one. */
  cancelBy: string | null;
  mealPlan: string | null;
  prepaid: boolean | null;
  availableQuantity: number | null;
  expiresAt: string | null;
  raw: unknown;
}

export interface Guest {
  givenName: string;
  familyName: string;
  email: string;
  phone: string;
}

export interface HotelBooking {
  id: string;
  bookingReference: string;
  provider: string;
  rateId: string;
  propertyName: string;
  roomName: string;
  checkIn: string;
  checkOut: string;
  total: Money;
  guest: Guest;
  raw: unknown;
}

/**
 * The contract every provider implements. The agent's tools depend on this,
 * never on a concrete provider module.
 */
export interface TravelProvider {
  readonly name: string;
  searchFlights(q: FlightSearch): Promise<FlightOffer[]>;
  priceFlightOffer(offer: FlightOffer): Promise<FlightOffer>;
  createFlightOrder(offer: FlightOffer, passengers: Passenger[]): Promise<FlightOrder>;
  searchHotelRates(q: HotelSearch): Promise<HotelRate[]>;
  createHotelBooking(rate: HotelRate, guest: Guest): Promise<HotelBooking>;
}
