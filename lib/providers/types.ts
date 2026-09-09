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
  /** Operating carrier, which differs from the marketing carrier on codeshares. */
  operatingCarrier?: string;
  operatingFlightNumber?: string;
  /** Provider's own id for this flight, used to build the Flight Check payload. */
  providerFlightId?: string;
  /** Terminal names exactly as the provider reports them, when it reports them. */
  departureTerminal?: string;
  arrivalTerminal?: string;
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

/** Properties near a point, for a patient who does not want the default hotel. */
export interface HotelAreaSearch {
  /** IATA code of the airport to search around — where the patient lands. */
  nearAirport: string;
  checkIn: string; // YYYY-MM-DD
  checkOut: string; // YYYY-MM-DD
  adults: number;
  currency: string;
  radiusMiles?: number;
}

/**
 * A property the provider returned for an area search, with the cheapest rate it
 * quoted for the stay. Nothing here is filled in from anywhere but the response.
 */
export interface HotelProperty {
  /** Provider property id — what a room search at this hotel takes. */
  id: string;
  provider: string;
  name: string;
  chain: string | null;
  /** Provider's own star-style rating, as a string exactly as sent. */
  rating: string | null;
  location: PropertyLocation | null;
  /** Distance from the airport searched around, as the provider reports it. */
  distanceFromAirport: { miles: number; direction: string | null } | null;
  /** The cheapest rate quoted for the stay: what "from $X" means. */
  leadRate: { total: Money; nightly: Money | null; nights: number } | null;
  /** Check-in / check-out times as the property states them, when it does. */
  policies: { checkInTime: string | null; checkOutTime: string | null } | null;
  raw: unknown;
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
  /** The property's address and coordinates, when the provider reports them. */
  location: PropertyLocation | null;
  /** Check-in / check-out times as the property states them, when it does. */
  policies: { checkInTime: string | null; checkOutTime: string | null } | null;
  raw: unknown;
}

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

/**
 * Where a property actually is. Every field is optional because a provider may
 * report any subset, and a missing field must read as unknown rather than as an
 * invented one.
 */
export interface PropertyLocation {
  addressLines: string[];
  city: string | null;
  postalCode: string | null;
  country: string | null;
  phone: string | null;
  coords: GeoPoint | null;
}

export interface Guest {
  givenName: string;
  familyName: string;
  email: string;
  phone: string;
}

/** Anything filed on the reservation beyond the room and the guests. */
export interface HotelBookingOptions {
  /**
   * Free text the hotel sees on the reservation — an early check-in request, say.
   * A request, never a guarantee: the property decides on the day.
   */
  specialInstruction?: string;
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
export interface CancellationResult {
  reference: string;
  /** True only when the provider confirms nothing bookable is left on the order. */
  cancelled: boolean;
  /** What is still live, when a partial cancel leaves something behind. */
  remaining: string[];
  raw: unknown;
}

export interface TravelProvider {
  readonly name: string;
  searchFlights(q: FlightSearch): Promise<FlightOffer[]>;
  priceFlightOffer(offer: FlightOffer): Promise<FlightOffer>;
  createFlightOrder(offer: FlightOffer, passengers: Passenger[]): Promise<FlightOrder>;
  searchHotelRates(q: HotelSearch): Promise<HotelRate[]>;
  searchHotels(q: HotelAreaSearch): Promise<HotelProperty[]>;
  createHotelBooking(
    rate: HotelRate,
    guests: Guest[],
    options?: HotelBookingOptions,
  ): Promise<HotelBooking>;
  /** Cancels an order and verifies the outcome before reporting success. */
  cancelBooking(reference: string): Promise<CancellationResult>;
}
