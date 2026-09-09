import { getEnv, paymentCard } from '@/lib/env';
import { log } from '@/lib/log';
import type {
  CancellationResult,
  FlightOffer,
  FlightOrder,
  FlightSearch,
  FlightSlice,
  GeoPoint,
  Guest,
  HotelBooking,
  HotelBookingOptions,
  HotelRate,
  HotelSearch,
  Passenger,
  TravelProvider,
} from '@/lib/providers/types';
import { TtlCache } from '@/lib/providers/cache';
import { reconcileSlices, type OrderFlight } from '@/lib/trip/disruption';
import { ProviderError } from './errors';
import { sabreFetch } from './http';
import { mapFlightShopResponse, type FlightShopResponse } from './mappers';
import { cheapestFirst, mapHotelDetailsResponse, type HotelDetailsResponse } from './hotel-mappers';
import {
  buildCreateFlightBookingRequest,
  buildHotelAvailRequest,
  buildCreateHotelBookingRequest,
  buildFlightCheckRequest,
  buildCancelBookingRequest,
  buildFlightShopRequest,
  buildGetBookingRequest,
  buildHotelDetailsRequest,
  buildHotelPriceCheckRequest,
  sabreGender,
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

/**
 * How long an identical flight search may be reused. Long enough to cover a
 * patient refining their request across a few turns, short enough that the
 * candidate set stays current. Prices are always re-checked live regardless.
 */
const SHOP_CACHE_TTL_MS = 180_000;

const shopCache = new TtlCache<FlightShopResponse>('flightShop', { ttlMs: SHOP_CACHE_TTL_MS });

function shopCacheKey(q: FlightSearch): string {
  return [
    q.origin,
    q.destination,
    q.departDate,
    q.returnDate ?? '-',
    q.adults,
    q.cabin,
    q.currency,
  ].join('|');
}

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

export interface UnconfirmedFlight {
  carrier: string;
  flightNumber: string;
}

/** "Flight number: UA8842 returned status code: UC." → { carrier: 'UA', flightNumber: '8842' } */
export function parseUnconfirmedFlights(errors: { description?: string }[]): UnconfirmedFlight[] {
  const out: UnconfirmedFlight[] = [];
  for (const e of errors) {
    const m = e.description?.match(/Flight number:\s*([A-Z0-9]{2})\s*(\d{1,4})/);
    if (m) out.push({ carrier: m[1], flightNumber: m[2] });
  }
  return out;
}

/** Reads the refused flights back out of a NO_AVAILABILITY error, if the provider recorded them. */
export function unconfirmedFlightsOf(error: unknown): UnconfirmedFlight[] {
  const details = (error as { details?: { unconfirmedFlights?: UnconfirmedFlight[] } })?.details;
  return details?.unconfirmedFlights ?? [];
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

/**
 * Flight Check echoes back the exact flights, in the same shape Flight Shop
 * returned them: times as HH:mm (not HH:mm:ss) and the real operating carrier,
 * which differs from the marketing carrier on a codeshare. Sending either
 * differently is a 400.
 */
function flightCheckPayload(offer: FlightOffer): FlightCheckFlight[][] {
  return offer.slices.map((slice) =>
    slice.segments.map((seg) => ({
      departureAirportCode: seg.from.iata,
      departureDate: seg.departLocal.slice(0, 10),
      departureTime: seg.departLocal.slice(11, 16),
      arrivalAirportCode: seg.to.iata,
      arrivalDate: seg.arriveLocal.slice(0, 10),
      arrivalTime: seg.arriveLocal.slice(11, 16),
      operatingAirlineCode: seg.operatingCarrier ?? seg.carrier,
      operatingFlightNumber: Number(seg.operatingFlightNumber ?? seg.flightNumber),
      marketingAirlineCode: seg.carrier,
      marketingFlightNumber: Number(seg.flightNumber),
      ...(seg.bookingClass ? { segmentDetails: { bookingClassCode: seg.bookingClass } } : {}),
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
    const response = await shopCache.get(shopCacheKey(q), () =>
      sabreFetch<FlightShopResponse>({
        method: 'POST',
        path: '/v1/offers/flightShop',
        body: buildFlightShopRequest(q),
        timeoutMs: SHOP_TIMEOUT_MS,
      }),
    );
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
   * Flight Check: revalidates the exact flights live and returns the current
   * offer, plus the raw response so a mismatch can be diagnosed from a fixture.
   * The returned offer's segments carry the booking class Flight Check actually
   * validated, which may differ from the cached class Flight Shop quoted.
   */
  async flightCheck(
    offer: FlightOffer,
  ): Promise<{ raw: FlightShopResponse; offer: FlightOffer | null }> {
    const env = getEnv();
    const body = buildFlightCheckRequest(flightCheckPayload(offer), {
      adults: 1,
      pcc: env.SABRE_PCC,
      currency: offer.price.currency,
      cabin: offer.cabin,
    });
    const raw = await sabreFetch<FlightShopResponse>({
      method: 'POST',
      path: '/v1/offers/flightCheck',
      body,
      timeoutMs: SHOP_TIMEOUT_MS,
    });
    const { offers, skipped } = mapFlightShopResponse(raw, this.name);
    if (skipped.length > 0) log.warn({ skipped }, 'flight check offers could not be mapped');
    const priced = offers[0] ?? null;
    if (priced) {
      const before = offer.slices.flatMap((sl) => sl.segments.map((g) => g.bookingClass));
      const after = priced.slices.flatMap((sl) => sl.segments.map((g) => g.bookingClass));
      if (before.join() !== after.join()) {
        log.info(
          { before, after },
          'flight check moved the itinerary to different booking classes',
        );
      }
    }
    return { raw, offer: priced };
  }

  /**
   * Re-validates a chosen itinerary and returns the current offer.
   *
   * This is the expiry/price-change check: a stale fare surfaces here rather than
   * at booking time.
   */
  async priceFlightOffer(offer: FlightOffer): Promise<FlightOffer> {
    const { offer: priced } = await this.flightCheck(offer);
    if (!priced) {
      throw new ProviderError(
        'OFFER_EXPIRED',
        'These flights are no longer available at that price',
      );
    }
    return priced.slices.length > 0 ? priced : { ...priced, slices: offer.slices };
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
        gender: sabreGender(p.gender),
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
      const errors =
        (response as { errors?: { type?: string; description?: string }[] }).errors ?? [];
      // The airline did not confirm the segments (UC, or left at NN past the wait):
      // the fare is effectively not sellable right now. Surface it as availability,
      // which the tools know how to recover from, rather than as an opaque failure.
      const unconfirmed = errors.filter(
        (e) => e.type === 'UNABLE_TO_BOOK_FLIGHTS_WRONG_STATUS_CODE',
      );
      if (unconfirmed.length > 0) {
        throw new ProviderError(
          'NO_AVAILABILITY',
          `The airline could not confirm seats: ${unconfirmed.map((e) => e.description).join('; ')}`,
          { details: { unconfirmedFlights: parseUnconfirmedFlights(unconfirmed), response } },
        );
      }
      throw new ProviderError('BOOKING_FAILED', 'Sabre created no confirmation for this flight', {
        details: response,
      });
    }

    // The sell succeeded, so what the order holds is now the truth about this trip.
    // Flight Shop is cache-based and can be minutes off it, and those shopped times
    // are what we would otherwise quote the patient and compare future checks
    // against. One read settles both. It is deliberately not fatal: the booking
    // exists either way, and the reference matters more than the polish.
    let slices = offer.slices;
    try {
      const order = (await retrieveBooking(bookingReference)).raw as {
        flights?: OrderFlight[];
      };
      slices = reconcileSlices(offer.slices, order.flights ?? []);
      const times = (ss: FlightSlice[]) =>
        ss.flatMap((s) => s.segments.map((g) => `${g.departLocal}/${g.arriveLocal}`)).join(',');
      if (times(slices) !== times(offer.slices)) {
        log.warn(
          { bookingReference, shopped: times(offer.slices), held: times(slices) },
          'the order holds different times than the shopped itinerary',
        );
      }
    } catch (e) {
      log.warn(
        { bookingReference, err: (e as Error).message },
        'could not read the order back after booking; keeping shopped times',
      );
    }

    return {
      id: response.booking?.bookingId ?? bookingReference,
      bookingReference,
      provider: this.name,
      offerId: offer.id,
      slices,
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

  async createHotelBooking(
    rate: HotelRate,
    guests: Guest[],
    options: HotelBookingOptions = {},
  ): Promise<HotelBooking> {
    if (guests.length === 0) {
      throw new ProviderError('BOOKING_FAILED', 'A room booking needs at least one guest');
    }
    // The lead guest carries the contact details; everyone in the party goes on the
    // room, which is what makes a two-person booking a two-person booking rather
    // than one name and an assumption.
    const [lead] = guests;
    const env = getEnv();
    const card = paymentCard(env);

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

    // Deposit and guarantee policies need a card on the booking; fail before Sabre
    // does, with a message that says what to configure.
    if (!card && paymentPolicy !== 'LATE') {
      throw new ProviderError(
        'BOOKING_FAILED',
        `This rate requires a ${paymentPolicy.toLowerCase()} and no agency payment card is configured (PAYMENT_CARD_* environment variables)`,
      );
    }

    const response = await sabreFetch<CreateBookingResponse>({
      method: 'POST',
      path: '/v1/trip/orders/createBooking',
      body: buildCreateHotelBookingRequest({
        pcc: env.SABRE_PCC,
        bookingKey,
        travelers: guests.map((g) => ({ givenName: g.givenName, surname: g.familyName })),
        contact: { emails: [lead.email], phones: [lead.phone] },
        paymentPolicy,
        card,
        ...(options.specialInstruction ? { specialInstruction: options.specialInstruction } : {}),
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
      guest: lead,
      raw: response,
    };
  }

  /**
   * Cancels an order, then reads it back.
   *
   * Sabre answers 200 for a partial cancel, so the response alone does not mean the
   * order is gone. Get Booking is the authority: an order that still lists flights
   * or hotels was not fully cancelled, and the caller must say which half is live
   * rather than tell a patient their trip is undone when it is not.
   */
  async cancelBooking(reference: string): Promise<CancellationResult> {
    const env = getEnv();
    const raw = await sabreFetch<Record<string, unknown>>({
      method: 'POST',
      path: '/v1/trip/orders/cancelBooking',
      body: buildCancelBookingRequest({ confirmationId: reference, pcc: env.SABRE_PCC }),
      timeoutMs: SHOP_TIMEOUT_MS,
    });

    const remaining: string[] = [];
    try {
      const after = (await retrieveBooking(reference)).raw as {
        flights?: unknown[];
        hotels?: unknown[];
      };
      if (after.flights?.length) remaining.push(`${after.flights.length} flight segment(s)`);
      if (after.hotels?.length) remaining.push(`${after.hotels.length} hotel stay(s)`);
    } catch {
      // The order is unreadable after cancelling, which is what a fully cancelled
      // order looks like in CERT. Treat it as gone rather than as an error.
      log.info({ reference }, 'order no longer retrievable after cancel');
    }

    const cancelled = remaining.length === 0;
    log.info({ reference, cancelled, remaining }, 'cancel booking verified');
    return { reference, cancelled, remaining, raw };
  }
}

/**
 * Coordinates never change, so a resolved airport is cached for the life of the
 * process. The lookup itself is a hotel availability search around that airport
 * code — Sabre echoes the point it resolved the code to, which is the only place
 * in this integration that turns an IATA code into a position.
 */
const airportPointCache = new Map<string, GeoPoint | null>();

/**
 * Where an airport is, as Sabre resolves it. Works for any IATA code the GDS
 * knows; returns null rather than a guess when it resolves nothing, so a caller
 * can say it does not know.
 */
export async function resolveAirportPoint(iata: string): Promise<GeoPoint | null> {
  const code = iata.trim().toUpperCase();
  const cached = airportPointCache.get(code);
  if (cached !== undefined) return cached;

  const env = getEnv();
  // A one-night stay far in the future: the dates are irrelevant, the reference
  // point is the whole reason for the call, and a small page keeps it cheap.
  const body = buildHotelAvailRequest(
    env.SABRE_PCC,
    { checkIn: '2027-01-11', checkOut: '2027-01-12', adults: 1, currency: 'USD' },
    { refPointCode: code, radiusMiles: 1, pageSize: 1 },
  );

  let point: GeoPoint | null = null;
  try {
    const response = await sabreFetch<{
      GetHotelAvailRS?: { HotelAvailInfos?: { SearchLatitude?: number; SearchLongitude?: number } };
    }>({ method: 'POST', path: '/v5/get/hotelavail', body, timeoutMs: SHOP_TIMEOUT_MS });
    const infos = response.GetHotelAvailRS?.HotelAvailInfos;
    if (typeof infos?.SearchLatitude === 'number' && typeof infos.SearchLongitude === 'number') {
      point = { latitude: infos.SearchLatitude, longitude: infos.SearchLongitude };
    }
  } catch (e) {
    // Not knowing where an airport is must never break a room search.
    log.warn({ code, err: (e as Error).message }, 'could not resolve an airport to a point');
  }

  airportPointCache.set(code, point);
  return point;
}

export interface RetrievedBooking {
  reference: string;
  /** Sabre's normalized view: flights, hotels, travelers, payments, status. */
  raw: unknown;
}

/** Retrieves an order by reference — used to prove a booking exists and to inspect it. */
export async function retrieveBooking(reference: string): Promise<RetrievedBooking> {
  const raw = await sabreFetch<Record<string, unknown>>({
    method: 'POST',
    path: '/v1/trip/orders/getBooking',
    body: buildGetBookingRequest(reference),
    timeoutMs: SHOP_TIMEOUT_MS,
  });
  return { reference, raw };
}

let instance: TravelProvider | undefined;

/** The provider the tools use. Swapping this is how another GDS would be added. */
export function travelProvider(): TravelProvider {
  instance ??= new SabreProvider();
  return instance;
}
