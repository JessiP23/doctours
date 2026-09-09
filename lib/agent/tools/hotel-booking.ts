import { z } from 'zod';
import { DateTime } from 'luxon';
import * as repo from '@/lib/db/repo';
import type { Json, OfferRow } from '@/lib/db/types';
import { travelProvider } from '@/lib/providers/sabre';
import { isProviderError } from '@/lib/providers/sabre/errors';
import type { FlightSlice, Guest, HotelBooking, HotelRate } from '@/lib/providers/types';
import { compareStay, deriveStay, type Stay, type StayCoverage } from '@/lib/trip/nights';
import type { TripRules } from '@/lib/trip/rules';
import { describeProperty } from './property';

/**
 * Selling a room, once.
 *
 * Shared by booking a room and moving one to different nights, so a realigned
 * stay is recorded with the same address, the same terms and the same guest list
 * as a first booking rather than a thinner version of it.
 */
export const guestSchema = z.object({
  givenName: z.string().min(1),
  familyName: z.string().min(1),
  email: z.email(),
  phone: z.string().min(5),
});

/** Schema field shared by both room tools: ask the hotel to let them in early. */
export const earlyCheckInField = z
  .boolean()
  .optional()
  .describe(
    'Only when the patient has asked to get into the room before check-in time on their arrival day. Files an early check-in request on the reservation — a request the hotel may not honour, and you must say so. It is not the same as booking the night before, which is an ordinary paid night with its own rateId.',
  );

export type SellHotelResult =
  | { sold: true; booking: HotelBooking; rate: HotelRate; requests: string[] }
  | { sold: false; failure: Record<string, unknown> };

export interface SellHotelOptions {
  earlyCheckIn?: boolean;
}

/** The flights this trip holds, as the order holds them. */
export async function bookedFlightSlices(conversationId: string): Promise<FlightSlice[] | null> {
  const flight = await repo.getLiveBooking(conversationId, 'flight');
  const slices = ((flight?.raw ?? {}) as { bookedSlices?: FlightSlice[] }).bookedSlices;
  return slices && slices.length >= 2 ? slices : null;
}

/**
 * What the hotel is told when the patient asks to get in early. Built from the
 * itinerary rather than typed by the model, so the time the hotel reads is the
 * time the airline holds. Short and plain: it is read by a person at a desk.
 */
export function earlyCheckInInstruction(slices: FlightSlice[] | null, rules: TripRules): string {
  const arrival = slices?.[0]?.segments.at(-1)?.arriveLocal;
  if (!arrival) return 'Early check-in requested if available.';
  const at = DateTime.fromISO(arrival, { zone: rules.destinationTz });
  return `Early check-in requested if available: guest lands ${at.toFormat('d LLL')} at ${at.toFormat('HH:mm')}.`;
}

/** Re-confirms the rate with the hotel and sells it. Writes nothing. */
export async function sellHotelRate(
  offerRow: OfferRow,
  guests: Guest[],
  options: SellHotelOptions = {},
  context?: { rules: TripRules; slices: FlightSlice[] | null },
): Promise<SellHotelResult> {
  const rate = offerRow.raw as unknown as HotelRate;
  const requests: string[] = [];
  const instruction =
    options.earlyCheckIn && context ? earlyCheckInInstruction(context.slices, context.rules) : null;
  if (instruction) requests.push(instruction);
  try {
    const booking = await travelProvider().createHotelBooking(
      rate,
      guests,
      instruction ? { specialInstruction: instruction } : {},
    );
    return { sold: true, booking, rate, requests };
  } catch (e) {
    if (isProviderError(e) && (e.code === 'OFFER_EXPIRED' || e.code === 'NO_AVAILABILITY')) {
      return {
        sold: false,
        failure: {
          reason: 'RATE_UNAVAILABLE',
          message:
            'The hotel no longer holds that rate. Search the rooms again and pick from what is available now.',
        },
      };
    }
    throw e;
  }
}

/**
 * The row a sold room becomes, including where the property is and how far that is
 * from where this trip lands — both answerable from calls already made, and both
 * stored so they stay answerable without another one. Also how the nights relate
 * to the flights, so a night booked on purpose before the flight lands is never
 * later mistaken for a room on the wrong dates.
 */
export async function hotelBookingRow(
  conversationId: string,
  offerRow: OfferRow,
  sold: { booking: HotelBooking; rate: HotelRate; requests?: string[] },
  guests: Guest[],
): Promise<{
  row: repo.NewBooking;
  property: Awaited<ReturnType<typeof describeProperty>>;
  flightStay: Stay | null;
  coverage: StayCoverage | null;
}> {
  const { booking, rate } = sold;
  const slices = await bookedFlightSlices(conversationId);
  const arrivalAirport = slices?.[0]?.segments.at(-1)?.to.iata;
  const property = await describeProperty(rate.location ?? null, arrivalAirport);
  const flightStay = slices ? deriveStay(slices[0], slices[1]) : null;
  const coverage = flightStay ? compareStay(booking, flightStay) : null;
  const requests = sold.requests ?? [];

  return {
    property,
    flightStay,
    coverage,
    row: {
      kind: 'hotel',
      provider: booking.provider,
      providerOrderId: booking.id,
      bookingReference: booking.bookingReference,
      offerId: offerRow.id,
      details: {
        hotel: booking.propertyName,
        room: booking.roomName,
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
        nights: rate.nights,
        totalUSD: booking.total.amount,
        refundable: rate.refundable,
        cancelBy: rate.cancelBy,
        guests: guests.map((g) => `${g.givenName} ${g.familyName}`),
        ...(coverage && coverage.nightsBefore > 0
          ? { nightsBeforeFlight: coverage.nightsBefore }
          : {}),
        ...(coverage && coverage.nightsAfter > 0
          ? { nightsAfterFlight: coverage.nightsAfter }
          : {}),
        ...(requests.length > 0 ? { requests } : {}),
        ...(property ? { property } : {}),
      } as unknown as Json,
      raw: booking.raw as Json,
    },
  };
}

/** What the tool result says about the nights, in words the agent can pass on. */
export function describeCoverage(coverage: StayCoverage | null, flightStay: Stay | null) {
  if (!coverage || !flightStay) return {};
  if (coverage.coverage === 'matches') return { coversFlights: true };
  if (coverage.coverage === 'covers') {
    return {
      coversFlights: true,
      extraNights: {
        before: coverage.nightsBefore,
        after: coverage.nightsAfter,
        note: `The room is held ${coverage.nightsBefore > 0 ? `${coverage.nightsBefore} night(s) before the flight lands` : ''}${coverage.nightsBefore > 0 && coverage.nightsAfter > 0 ? ' and ' : ''}${coverage.nightsAfter > 0 ? `${coverage.nightsAfter} night(s) after it leaves` : ''} — paid nights, so the room is theirs when they arrive.`,
      },
    };
  }
  return {
    coversFlights: false,
    nightsWarning: `These nights do not cover the booked flights (${flightStay.checkIn} to ${flightStay.checkOut}). Say so rather than treating the trip as settled.`,
  };
}

/** What a filed early check-in request means, said once so both tools say it the same way. */
export function describeRequests(requests: string[]) {
  if (requests.length === 0) return {};
  return {
    requestsFiled: requests,
    requestsNote:
      'Filed on the reservation as a request. The hotel decides on the day — tell the patient it is asked for, not guaranteed, and that the room is only theirs from check-in time unless the night before is booked.',
  };
}
