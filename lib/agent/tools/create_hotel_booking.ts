import { z } from 'zod';
import { log } from '@/lib/log';
import * as repo from '@/lib/db/repo';
import type { Json } from '@/lib/db/types';
import { travelProvider } from '@/lib/providers/sabre';
import type { FlightSlice, HotelRate } from '@/lib/providers/types';
import { isProviderError } from '@/lib/providers/sabre/errors';
import { rulesFor } from './context';
import { MAX_TRAVELLERS } from './set_party_size';
import { defineTool } from './define';
import { describeProperty } from './property';
import { loadBookableOffer } from './search_flights';

/**
 * Books the room.
 *
 * Same guard chain as the flight: the rate must exist in this conversation, no
 * room may already be booked, and Hotel Price Check must still honour the rate —
 * which is also what produces the booking key, so an expired rate cannot book.
 */
export const createHotelBookingTool = defineTool({
  name: 'create_hotel_booking',
  description:
    'Book a room the patient has confirmed. Only call this after they have chosen a specific rateId and agreed to the total. Pass one guest per traveller, the patient first — everyone staying in the room goes on the booking. The rate is re-confirmed with the hotel first, so it may report that it is no longer available.',
  schema: z.object({
    rateId: z.string().describe('rateId from search_hotel_rates'),
    guests: z
      .array(
        z.object({
          givenName: z.string().min(1),
          familyName: z.string().min(1),
          email: z.email(),
          phone: z.string().min(5),
        }),
      )
      .min(1)
      .max(MAX_TRAVELLERS)
      .describe('One entry per traveller staying in the room, the patient first'),
  }),
  handler: async (input, ctx) => {
    const rules = await rulesFor(ctx.conversationId);

    // Everyone travelling is on the room, or the booking does not match the trip.
    if (input.guests.length !== rules.adults) {
      return {
        booked: false,
        reason: 'GUEST_COUNT_MISMATCH',
        message: `This trip is set to ${rules.adults} traveller(s) but you sent ${input.guests.length} guest(s). Every traveller goes on the room.`,
        travellers: rules.adults,
      };
    }

    const existing = await repo.getLiveBooking(ctx.conversationId, 'hotel');
    if (existing) {
      return {
        booked: false,
        reason: 'ALREADY_BOOKED',
        message: 'A room is already booked for this trip.',
        bookingReference: existing.booking_reference,
      };
    }

    const { row } = await loadBookableOffer(ctx.conversationId, input.rateId, 'hotel_rate');
    const rate = row.raw as unknown as HotelRate;

    let booking;
    try {
      booking = await travelProvider().createHotelBooking(rate, input.guests);
    } catch (e) {
      if (isProviderError(e) && (e.code === 'OFFER_EXPIRED' || e.code === 'NO_AVAILABILITY')) {
        return {
          booked: false,
          reason: 'RATE_UNAVAILABLE',
          message:
            'The hotel no longer holds that rate. Search the rooms again and pick from what is available now.',
        };
      }
      throw e;
    }

    // Kept on the booking so "where is it, how far from where I land" is answerable
    // for the rest of the trip without another provider call.
    const flight = await repo.getLiveBooking(ctx.conversationId, 'flight');
    const flightSlices = ((flight?.raw ?? {}) as { bookedSlices?: FlightSlice[] }).bookedSlices;
    const arrivalAirport = flightSlices?.[0]?.segments.at(-1)?.to.iata;
    const property = await describeProperty(rate.location ?? null, arrivalAirport);

    const saved = await repo.insertBooking(ctx.conversationId, {
      kind: 'hotel',
      provider: booking.provider,
      providerOrderId: booking.id,
      bookingReference: booking.bookingReference,
      offerId: row.id,
      details: {
        hotel: booking.propertyName,
        room: booking.roomName,
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
        nights: rate.nights,
        totalUSD: booking.total.amount,
        refundable: rate.refundable,
        cancelBy: rate.cancelBy,
        guests: input.guests.map((g) => `${g.givenName} ${g.familyName}`),
        ...(property ? { property } : {}),
      } as unknown as Json,
      raw: booking.raw as Json,
    });

    log.info(
      { conversationId: ctx.conversationId, bookingReference: booking.bookingReference },
      'hotel booked with Sabre',
    );

    return {
      booked: true,
      bookingReference: saved.booking_reference,
      hotel: booking.propertyName,
      room: booking.roomName,
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      totalUSD: booking.total.amount,
      ...(property ? { property } : {}),
    };
  },
});
