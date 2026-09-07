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
  departureTime: string; // HH:mm[:ss]
  arrivalAirportCode: string;
  arrivalDate: string;
  arrivalTime: string;
  operatingAirlineCode: string;
  operatingFlightNumber: number;
  marketingAirlineCode: string;
  marketingFlightNumber: number;
}

export function buildFlightCheckRequest(journeys: FlightCheckFlight[][], adults: number) {
  return {
    journeys: journeys.map((flights) => ({ flights })),
    travelers: Array.from({ length: adults }, () => ({ passengerTypeCode: 'ADT' })),
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
