import { z } from 'zod';
import * as repo from '@/lib/db/repo';
import type { Json, OfferRow } from '@/lib/db/types';
import { travelProvider } from '@/lib/providers/sabre';
import { isProviderError } from '@/lib/providers/sabre/errors';
import type { FlightSlice, Guest, HotelBooking, HotelRate } from '@/lib/providers/types';
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

export type SellHotelResult =
  | { sold: true; booking: HotelBooking; rate: HotelRate }
  | { sold: false; failure: Record<string, unknown> };

/** Re-confirms the rate with the hotel and sells it. Writes nothing. */
export async function sellHotelRate(offerRow: OfferRow, guests: Guest[]): Promise<SellHotelResult> {
  const rate = offerRow.raw as unknown as HotelRate;
  try {
    const booking = await travelProvider().createHotelBooking(rate, guests);
    return { sold: true, booking, rate };
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
 * stored so they stay answerable without another one.
 */
export async function hotelBookingRow(
  conversationId: string,
  offerRow: OfferRow,
  sold: { booking: HotelBooking; rate: HotelRate },
  guests: Guest[],
): Promise<{ row: repo.NewBooking; property: Awaited<ReturnType<typeof describeProperty>> }> {
  const { booking, rate } = sold;
  const flight = await repo.getLiveBooking(conversationId, 'flight');
  const flightSlices = ((flight?.raw ?? {}) as { bookedSlices?: FlightSlice[] }).bookedSlices;
  const arrivalAirport = flightSlices?.[0]?.segments.at(-1)?.to.iata;
  const property = await describeProperty(rate.location ?? null, arrivalAirport);

  return {
    property,
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
        ...(property ? { property } : {}),
      } as unknown as Json,
      raw: booking.raw as Json,
    },
  };
}
