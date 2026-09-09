import { z } from 'zod';
import { log } from '@/lib/log';
import * as repo from '@/lib/db/repo';
import { rulesFor } from './context';
import { defineTool } from './define';
import {
  bookedFlightSlices,
  describeCoverage,
  describeRequests,
  earlyCheckInField,
  guestSchema,
  hotelBookingRow,
  sellHotelRate,
} from './hotel-booking';
import { loadBookableOffer } from './search_flights';
import { MAX_TRAVELLERS } from './set_party_size';

/**
 * Books the room.
 *
 * Same guard chain as the flight: the guest list must match the traveller count,
 * no room may already be booked, and Hotel Price Check must still honour the rate —
 * which is also what produces the booking key, so an expired rate cannot book.
 */
export const createHotelBookingTool = defineTool({
  name: 'create_hotel_booking',
  description:
    'Book a room the patient has confirmed. Only call this after they have chosen a specific rateId and agreed to the total. Pass one guest per traveller, the patient first — everyone staying in the room goes on the booking. The rate is re-confirmed with the hotel first, so it may report that it is no longer available.',
  schema: z.object({
    rateId: z.string().describe('rateId from search_hotel_rates'),
    guests: z
      .array(guestSchema)
      .min(1)
      .max(MAX_TRAVELLERS)
      .describe('One entry per traveller staying in the room, the patient first'),
    earlyCheckIn: earlyCheckInField,
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
        message:
          'A room is already booked for this trip. To move it to different nights or a different room, use rebook_hotel — it replaces this booking rather than adding a second one.',
        bookingReference: existing.booking_reference,
      };
    }

    const { row } = await loadBookableOffer(ctx.conversationId, input.rateId, 'hotel_rate');
    const slices = await bookedFlightSlices(ctx.conversationId);
    const sale = await sellHotelRate(
      row,
      input.guests,
      { earlyCheckIn: input.earlyCheckIn },
      { rules, slices },
    );
    if (!sale.sold) return { booked: false, ...sale.failure };

    const {
      row: newRow,
      property,
      coverage,
      flightStay,
    } = await hotelBookingRow(ctx.conversationId, row, sale, input.guests);
    const saved = await repo.insertBooking(ctx.conversationId, newRow);

    log.info(
      { conversationId: ctx.conversationId, bookingReference: sale.booking.bookingReference },
      'hotel booked with Sabre',
    );

    return {
      booked: true,
      bookingReference: saved.booking_reference,
      hotel: sale.booking.propertyName,
      room: sale.booking.roomName,
      checkIn: sale.booking.checkIn,
      checkOut: sale.booking.checkOut,
      totalUSD: sale.booking.total.amount,
      ...describeCoverage(coverage, flightStay),
      ...describeRequests(sale),
      ...(property ? { property } : {}),
    };
  },
});
