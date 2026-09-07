import type { Cabin, FlightSearch, HotelSearch } from '@/lib/providers/types';

/**
 * Pure builders for Sabre REST request bodies. No I/O, fully unit-testable.
 *
 * Endpoints (Sabre REST, CERT base https://api.cert.platform.sabre.com):
 *   POST /v1/offers/flightShop          shop itineraries → offers/journeys/flights
 *   POST /v1/offers/flightCheck         re-validate a chosen itinerary right before booking
 *   POST /v5/get/hotelavail             availability + lead rates for hotels (geo or specific)
 *   POST /v5/hotel/pricecheck           re-price a RateKey → BookingKey (needed to book)
 *   POST /v1/trip/orders/createBooking  create the order (flight and/or hotel) → confirmationId
 *   POST /v1/trip/orders/getBooking     retrieve an order by confirmationId
 *   POST /v1/hotels/hotelSearch         (agentic-ready beta) flat JSON hotel search by airport/lat-long
 */

const SABRE_CABIN: Record<Cabin, string> = {
  economy: 'Economy',
  premium_economy: 'PremiumEconomy',
  business: 'Business',
  first: 'First',
};

export function buildFlightShopRequest(q: FlightSearch, opts: { maxStops?: number } = {}) {
  const journeys = [
    {
      departureLocation: { airportCode: q.origin },
      arrivalLocation: { airportCode: q.destination },
      departureDate: q.departDate,
    },
  ];
  if (q.returnDate) {
    journeys.push({
      departureLocation: { airportCode: q.destination },
      arrivalLocation: { airportCode: q.origin },
      departureDate: q.returnDate,
    });
  }
  return {
    journeys,
    travelers: Array.from({ length: q.adults }, () => ({ passengerTypeCode: 'ADT' })),
    fare: { cabin: { name: SABRE_CABIN[q.cabin] } },
    ...(opts.maxStops !== undefined ? { route: { maximumNumberOfStops: opts.maxStops } } : {}),
    sources: { providers: ['Sabre'], distributionModels: ['ATPCO'] },
  };
}

export interface FlightCheckFlight {
  departureAirportCode: string;
  departureDate: string; // YYYY-MM-DD
  departureTime: string; // HH:mm — the spec pattern is ^([01][0-9]|2[0-3]):[0-5][0-9]$, seconds are a 400
  arrivalAirportCode: string;
  arrivalDate: string;
  arrivalTime: string; // HH:mm
  operatingAirlineCode: string;
  operatingFlightNumber: number;
  marketingAirlineCode: string;
  marketingFlightNumber: number;
  /** Booking class Flight Shop quoted, so the fare is revalidated in that class. */
  segmentDetails?: { bookingClassCode: string };
}

/**
 * Flight Check, payload-based (ATPCO). Per Sabre's spec the PCC is mandatory for
 * ATPCO and travels in processingOptions; fare qualifiers keep the re-price in the
 * same currency and cabin as the search.
 */
export function buildFlightCheckRequest(
  journeys: FlightCheckFlight[][],
  opts: { adults: number; pcc: string; currency: string; cabin: Cabin },
) {
  return {
    journeys: journeys.map((flights) => ({ flights })),
    travelers: Array.from({ length: opts.adults }, () => ({ passengerTypeCode: 'ADT' })),
    fare: { currencyCode: opts.currency, cabin: { name: SABRE_CABIN[opts.cabin] } },
    processingOptions: { pseudoCityCode: opts.pcc },
  };
}

export interface HotelGeoSearch {
  /** IATA airport/city code used as the reference point. */
  refPointCode: string;
  radiusMiles?: number;
  pageSize?: number;
  /** RefPointType: '6' = airport, '16' = city. */
  refPointType?: string;
}

/**
 * Rate sources to query. '100' is Sabre GDS content, '113' aggregator content
 * (e.g. Booking.com). CERT inventory differs per source, so this is configurable.
 */
export type RateSource = string;

export function buildHotelAvailRequest(
  pcc: string,
  stay: Pick<HotelSearch, 'checkIn' | 'checkOut' | 'adults' | 'currency'>,
  target: { hotelCodes: string[] } | HotelGeoSearch,
  opts: { rateSource?: RateSource } = {},
) {
  const searchTarget =
    'hotelCodes' in target
      ? {
          HotelRefs: {
            HotelRef: target.hotelCodes.map((code) => ({ HotelCode: code, CodeContext: 'GLOBAL' })),
          },
        }
      : {
          GeoSearch: {
            GeoRef: {
              Radius: target.radiusMiles ?? 20,
              UOM: 'MI',
              RefPoint: {
                Value: target.refPointCode,
                ValueContext: 'CODE',
                RefPointType: target.refPointType ?? '6',
              },
            },
          },
        };

  return {
    GetHotelAvailRQ: {
      POS: { Source: { PseudoCityCode: pcc } },
      SearchCriteria: {
        OffSet: 1,
        SortBy: 'AverageNightlyRate', // v5 accepts: NegotiatedRateAvailability, DistanceFrom, AverageNightlyRate, SabreRating, AverageNightlyRateBeforeTax
        SortOrder: 'ASC',
        PageSize: 'hotelCodes' in target ? target.hotelCodes.length : (target.pageSize ?? 20),
        RateDetailsInd: true,
        ...searchTarget,
        RateInfoRef: {
          CurrencyCode: stay.currency,
          ConvertedRateInfoOnly: true,
          BestOnly: '2',
          PrepaidQualifier: 'IncludePrepaid',
          StayDateTimeRange: { StartDate: stay.checkIn, EndDate: stay.checkOut },
          Rooms: { Room: [{ Index: 1, Adults: stay.adults, Children: 0 }] },
          RateSource: opts.rateSource ?? '100',
        },
      },
    },
  };
}

export function buildHotelDetailsRequest(
  pcc: string,
  hotelCode: string,
  stay: Pick<HotelSearch, 'checkIn' | 'checkOut' | 'adults' | 'currency'>,
) {
  return {
    GetHotelDetailsRQ: {
      POS: { Source: { PseudoCityCode: pcc } },
      SearchCriteria: {
        HotelRefs: { HotelRef: { HotelCode: hotelCode, CodeContext: 'GLOBAL' } },
        RateInfoRef: {
          CurrencyCode: stay.currency,
          ConvertedRateInfoOnly: true,
          PrepaidQualifier: 'IncludePrepaid',
          RefundableOnly: false,
          StayDateTimeRange: { StartDate: stay.checkIn, EndDate: stay.checkOut },
          Rooms: {
            Room: [{ Index: 1, Adults: stay.adults, Children: 0 }],
            RoomSetTypes: {
              RoomSet: [{ Type: 'BedType' }, { Type: 'RoomType' }, { Type: 'RateSource' }],
            },
          },
          RateSource: '100',
        },
        HotelContentRef: {
          DescriptiveInfoRef: {
            PropertyInfo: true,
            LocationInfo: true,
            Descriptions: {
              Description: [
                { Type: 'ShortDescription' },
                { Type: 'CancellationPolicy' },
                { Type: 'GuaranteePolicy' },
              ],
            },
          },
        },
      },
    },
  };
}

export function buildHotelPriceCheckRequest(pcc: string, rateKey: string) {
  return {
    HotelPriceCheckRQ: {
      POS: { Source: { PseudoCityCode: pcc } },
      RateInfoRef: { RateKey: rateKey },
    },
  };
}

export function buildGetBookingRequest(confirmationId: string) {
  return { confirmationId };
}

/** Agency identity stamped on every booking. Placeholder values are fine in CERT. */
export const AGENCY = {
  address: {
    name: 'Doctours',
    street: '1 Medical Tourism Way',
    city: 'New York',
    stateProvince: 'NY',
    postalCode: '10001',
    countryCode: 'US',
    freeText: 'Doctours medical travel',
  },
  ticketingPolicy: 'TODAY',
} as const;

export interface CreateBookingFlight {
  flightNumber: number;
  airlineCode: string;
  fromAirportCode: string;
  toAirportCode: string;
  departureDate: string;
  departureTime: string; // HH:mm
  bookingClass: string;
}

export interface CreateBookingTraveler {
  givenName: string;
  surname: string;
  birthDate?: string;
  gender?: 'MALE' | 'FEMALE' | 'UNDISCLOSED';
  passengerCode?: string;
}

/**
 * Create Booking validates these with regular expressions and answers 400 on a
 * mismatch, so inputs are normalized here rather than trusted:
 *   names   ^[^\s]+(\s[^\s]+)*$   (surname additionally forbids digits)
 *   phones  ^[0-9+-]+$              (no spaces, no parentheses)
 */
export function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

export function normalizePhone(phone: string): string {
  const cleaned = phone.replace(/[^0-9+-]/g, '');
  // Keep a single leading +, drop any others.
  return cleaned.startsWith('+')
    ? `+${cleaned.slice(1).replace(/\+/g, '')}`
    : cleaned.replace(/\+/g, '');
}

export function sabreGender(
  g: 'M' | 'F' | 'X' | undefined,
): CreateBookingTraveler['gender'] | undefined {
  if (g === 'M') return 'MALE';
  if (g === 'F') return 'FEMALE';
  if (g === 'X') return 'UNDISCLOSED';
  return undefined;
}

export interface CreateBookingContact {
  emails: string[];
  phones: string[];
}

/**
 * Create Booking for air content. Returns a confirmationId (the PNR locator),
 * which is the booking reference the patient is given.
 */
export function buildCreateFlightBookingRequest(args: {
  pcc: string;
  flights: CreateBookingFlight[];
  travelers: CreateBookingTraveler[];
  contact: CreateBookingContact;
}) {
  return {
    errorHandlingPolicy: ['HALT_ON_ERROR'],
    targetPcc: args.pcc,
    receivedFrom: 'Doctours agent',
    agency: AGENCY,
    travelers: args.travelers.map((t) => ({
      givenName: normalizeName(t.givenName),
      surname: normalizeName(t.surname),
      ...(t.birthDate ? { birthDate: t.birthDate } : {}),
      ...(t.gender ? { gender: t.gender } : {}),
      passengerCode: t.passengerCode ?? 'ADT',
    })),
    contactInfo: { emails: args.contact.emails, phones: args.contact.phones.map(normalizePhone) },
    flightDetails: {
      flights: args.flights.map((f) => ({
        flightNumber: f.flightNumber,
        airlineCode: f.airlineCode,
        fromAirportCode: f.fromAirportCode,
        toAirportCode: f.toAirportCode,
        departureDate: f.departureDate,
        departureTime: f.departureTime,
        bookingClass: f.bookingClass,
        flightStatusCode: 'NN',
      })),
      flightPricing: [{}],
    },
  };
}

/**
 * Create Booking for a CSL hotel. `bookingKey` comes from Hotel Price Check;
 * `paymentPolicy` from the guarantee type it reports.
 */
export function buildCreateHotelBookingRequest(args: {
  pcc: string;
  bookingKey: string;
  travelers: CreateBookingTraveler[];
  contact: CreateBookingContact;
  paymentPolicy: string;
  specialInstruction?: string;
}) {
  return {
    errorHandlingPolicy: ['HALT_ON_ERROR'],
    targetPcc: args.pcc,
    receivedFrom: 'Doctours agent',
    agency: AGENCY,
    travelers: args.travelers.map((t) => ({
      givenName: normalizeName(t.givenName),
      surname: normalizeName(t.surname),
      passengerCode: t.passengerCode ?? 'ADT',
    })),
    contactInfo: { emails: args.contact.emails, phones: args.contact.phones.map(normalizePhone) },
    hotel: {
      useCsl: true,
      bookingKey: args.bookingKey,
      rooms: [{ travelerIndices: args.travelers.map((_, i) => i + 1) }],
      ...(args.specialInstruction ? { specialInstruction: args.specialInstruction } : {}),
      paymentPolicy: args.paymentPolicy,
    },
  };
}

/** Agentic-ready Hotel Search (beta): flat JSON, searches around an airport code. */
export function buildHotelSearchBetaRequest(
  stay: Pick<HotelSearch, 'checkIn' | 'checkOut' | 'adults'>,
  ref: { airportCode: string; radiusMiles?: number },
) {
  return {
    radiusInMiles: ref.radiusMiles ?? 20,
    checkInDate: stay.checkIn,
    checkOutDate: stay.checkOut,
    numberOfAdults: stay.adults,
    referencePoint: ref.airportCode,
  };
}
