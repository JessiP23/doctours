import { getEnv } from '@/lib/env';
import { log } from '@/lib/log';
import type {
  FlightOffer,
  FlightOrder,
  FlightSearch,
  Guest,
  HotelBooking,
  HotelRate,
  HotelSearch,
  Passenger,
  TravelProvider,
} from '@/lib/providers/types';
import { ProviderError } from './errors';
import { sabreFetch } from './http';
import { mapFlightShopResponse, type FlightShopResponse } from './mappers';
import { cheapestFirst, mapHotelDetailsResponse, type HotelDetailsResponse } from './hotel-mappers';
import {
  buildCreateFlightBookingRequest,
  buildCreateHotelBookingRequest,
  buildFlightCheckRequest,
  buildFlightShopRequest,
  buildHotelDetailsRequest,
  buildHotelPriceCheckRequest,
  type CreateBookingFlight,
  type FlightCheckFlight,
} from './requests';

/**
 * Sabre implementation of the TravelProvider contract.
 *
 * Flights:  /v1/offers/flightShop → /v1/offers/flightCheck → /v1/trip/orders/createBooking
 * Hotel:    /v5/get/hoteldetails  → /v5/hotel/pricecheck   → /v1/trip/orders/createBooking
 *
 * Both bookings come back as a `confirmationId` — the PNR locator that becomes
 * the patient's booking reference. Nothing above this module knows any of it.
 */

const SHOP_TIMEOUT_MS = 60_000;

interface CreateBookingResponse {
  confirmationId?: string;
  booking?: { bookingId?: string };
}

interface PriceCheckResponse {
  HotelPriceCheckRS?: {
    PriceCheckInfo?: {
      BookingKey?: string;
      HotelRateInfo?: {
        Rooms?: {
          Room?:
            | {
                RatePlans?: {
                  RatePlan?:
                    | {
                        RateInfo?: { Guarantee?: { GuaranteeType?: string } };
                        ProductCode?: string;
                      }
                    | {
                        RateInfo?: { Guarantee?: { GuaranteeType?: string } };
                        ProductCode?: string;
                      }[];
                };
              }
            | {
                RatePlans?: {
                  RatePlan?:
                    | {
                        RateInfo?: { Guarantee?: { GuaranteeType?: string } };
                        ProductCode?: string;
                      }
                    | {
                        RateInfo?: { Guarantee?: { GuaranteeType?: string } };
                        ProductCode?: string;
                      }[];
                };
              }[];
        };
      };
    };
  };
}

function first<T>(value: T | T[] | undefined): T | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Sabre guarantee type → the paymentPolicy Create Booking expects. */
function paymentPolicyFor(guaranteeType: string | undefined): string {
  switch (guaranteeType) {
    case 'DEP':
      return 'DEPOSIT';
    case 'LATE':
      return 'LATE';
    case 'GUAR':
    default:
      return 'GUARANTEE';
  }
}

function flightCheckPayload(offer: FlightOffer): FlightCheckFlight[][] {
  return offer.slices.map((slice) =>
    slice.segments.map((seg) => ({
      departureAirportCode: seg.from.iata,
      departureDate: seg.departLocal.slice(0, 10),
      departureTime: `${seg.departLocal.slice(11, 16)}:00`,
      arrivalAirportCode: seg.to.iata,
      arrivalDate: seg.arriveLocal.slice(0, 10),
      arrivalTime: `${seg.arriveLocal.slice(11, 16)}:00`,
      operatingAirlineCode: seg.carrier,
      operatingFlightNumber: Number(seg.flightNumber),
      marketingAirlineCode: seg.carrier,
      marketingFlightNumber: Number(seg.flightNumber),
    })),
  );
}

function createBookingFlights(offer: FlightOffer): CreateBookingFlight[] {
  return offer.slices.flatMap((slice) =>
    slice.segments.map((seg) => {
      if (!seg.bookingClass) {
        throw new ProviderError(
          'BOOKING_FAILED',
          `Segment ${seg.carrier}${seg.flightNumber} has no booking class`,
        );
      }
      return {
        flightNumber: Number(seg.flightNumber),
        airlineCode: seg.carrier,
        fromAirportCode: seg.from.iata,
        toAirportCode: seg.to.iata,
        departureDate: seg.departLocal.slice(0, 10),
        departureTime: seg.departLocal.slice(11, 16),
        bookingClass: seg.bookingClass,
      };
    }),
  );
}

export class SabreProvider implements TravelProvider {
  readonly name = 'sabre';

  async searchFlights(q: FlightSearch): Promise<FlightOffer[]> {
    const body = buildFlightShopRequest(q);
    const response = await sabreFetch<FlightShopResponse>({
      method: 'POST',
      path: '/v1/offers/flightShop',
      body,
      timeoutMs: SHOP_TIMEOUT_MS,
    });
    const { offers, skipped } = mapFlightShopResponse(response, this.name);
    if (skipped.length > 0) log.warn({ skipped }, 'some flight offers could not be mapped');
    if (offers.length === 0) {
      throw new ProviderError(
        'NO_AVAILABILITY',
        `No flights found ${q.origin}→${q.destination} on ${q.departDate}`,
      );
    }
    return offers.slice(0, q.maxResults ?? offers.length);
  }

  /**
   * Re-validates a chosen itinerary and returns the current offer.
   *
   * This is the expiry/price-change check: Flight Check re-prices the exact
   * flights, so a stale offer surfaces here rather than at booking time.
   */
  async priceFlightOffer(offer: FlightOffer): Promise<FlightOffer> {
    const body = buildFlightCheckRequest(flightCheckPayload(offer), 1);
    const response = await sabreFetch<FlightShopResponse>({
      method: 'POST',
      path: '/v1/offers/flightCheck',
      body,
      timeoutMs: SHOP_TIMEOUT_MS,
    });
    const { offers } = mapFlightShopResponse(response, this.name);
    const priced = offers[0];
    if (!priced) {
      throw new ProviderError(
        'OFFER_EXPIRED',
        'These flights are no longer available at that price',
      );
    }
    // Keep the caller's slices (already validated) but adopt the fresh price and id.
    return { ...priced, slices: priced.slices.length > 0 ? priced.slices : offer.slices };
  }

  async createFlightOrder(offer: FlightOffer, passengers: Passenger[]): Promise<FlightOrder> {
    const env = getEnv();
    const body = buildCreateFlightBookingRequest({
      pcc: env.SABRE_PCC,
      flights: createBookingFlights(offer),
      travelers: passengers.map((p) => ({
        givenName: p.givenName,
        surname: p.familyName,
        birthDate: p.dateOfBirth,
      })),
      contact: { emails: [passengers[0].email], phones: [passengers[0].phone] },
    });

    const response = await sabreFetch<CreateBookingResponse>({
      method: 'POST',
      path: '/v1/trip/orders/createBooking',
      body,
      timeoutMs: SHOP_TIMEOUT_MS,
    });

    // The reference is only ever read from the provider's response.
    const bookingReference = response.confirmationId;
    if (!bookingReference) {
      throw new ProviderError('BOOKING_FAILED', 'Sabre created no confirmation for this flight', {
        details: response,
      });
    }

    return {
      id: response.booking?.bookingId ?? bookingReference,
      bookingReference,
      provider: this.name,
      offerId: offer.id,
      slices: offer.slices,
      price: offer.price,
      passengers,
      raw: response,
    };
  }

  async searchHotelRates(q: HotelSearch): Promise<HotelRate[]> {
    const env = getEnv();
    const response = await sabreFetch<HotelDetailsResponse>({
      method: 'POST',
      path: '/v5/get/hoteldetails',
      body: buildHotelDetailsRequest(env.SABRE_PCC, q.propertyId, q),
      timeoutMs: SHOP_TIMEOUT_MS,
    });
    const { rates, skipped } = mapHotelDetailsResponse(
      response,
      { checkIn: q.checkIn, checkOut: q.checkOut, propertyId: q.propertyId },
      this.name,
    );
    if (skipped.length > 0) log.warn({ skipped }, 'some hotel rates could not be mapped');
    if (rates.length === 0) {
      throw new ProviderError('NO_AVAILABILITY', `No rooms available ${q.checkIn} → ${q.checkOut}`);
    }
    return cheapestFirst(rates);
  }

  async createHotelBooking(rate: HotelRate, guest: Guest): Promise<HotelBooking> {
    const env = getEnv();

    // Price Check both re-confirms the rate and mints the BookingKey that
    // Create Booking requires, so an expired rate fails here, before booking.
    const priceCheck = await sabreFetch<PriceCheckResponse>({
      method: 'POST',
      path: '/v5/hotel/pricecheck',
      body: buildHotelPriceCheckRequest(env.SABRE_PCC, rate.id),
      timeoutMs: SHOP_TIMEOUT_MS,
    });

    const info = priceCheck.HotelPriceCheckRS?.PriceCheckInfo;
    const bookingKey = info?.BookingKey;
    if (!bookingKey) {
      throw new ProviderError('OFFER_EXPIRED', 'That room rate is no longer available', {
        details: priceCheck,
      });
    }
    const ratePlan = first(first(info?.HotelRateInfo?.Rooms?.Room)?.RatePlans?.RatePlan);
    const paymentPolicy = paymentPolicyFor(ratePlan?.RateInfo?.Guarantee?.GuaranteeType);

    const response = await sabreFetch<CreateBookingResponse>({
      method: 'POST',
      path: '/v1/trip/orders/createBooking',
      body: buildCreateHotelBookingRequest({
        pcc: env.SABRE_PCC,
        bookingKey,
        travelers: [{ givenName: guest.givenName, surname: guest.familyName }],
        contact: { emails: [guest.email], phones: [guest.phone] },
        paymentPolicy,
      }),
      timeoutMs: SHOP_TIMEOUT_MS,
    });

    const bookingReference = response.confirmationId;
    if (!bookingReference) {
      throw new ProviderError('BOOKING_FAILED', 'Sabre created no confirmation for this hotel', {
        details: response,
      });
    }

    return {
      id: response.booking?.bookingId ?? bookingReference,
      bookingReference,
      provider: this.name,
      rateId: rate.id,
      propertyName: rate.propertyName,
      roomName: rate.roomName,
      checkIn: rate.checkIn,
      checkOut: rate.checkOut,
      total: rate.total,
      guest,
      raw: response,
    };
  }
}

let instance: TravelProvider | undefined;

/** The provider the tools use. Swapping this is how another GDS would be added. */
export function travelProvider(): TravelProvider {
  instance ??= new SabreProvider();
  return instance;
}
