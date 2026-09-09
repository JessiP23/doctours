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
  guestsField,
  resolveGuests,
  hotelBookingRow,
  sellHotelRate,
} from './hotel-booking';
import { loadBookableOffer } from './search_flights';

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
    'Book a room the patient has confirmed. Only call this after they have chosen a specific rateId and agreed to the total. The travellers on the flight booking go on the room automatically — do not ask for their details again; pass guests only when no flight is booked. The rate is re-confirmed with the hotel first, so it may report that it is no longer available.',
  schema: z.object({
    rateId: z.string().describe('rateId from search_hotel_rates'),
    guests: guestsField,
    earlyCheckIn: earlyCheckInField,
  }),
  handler: async (input, ctx) => {
    const rules = await rulesFor(ctx.conversationId);

    // Everyone travelling is on the room, or the booking does not match the trip.
    // The travellers come from the flight booking unless there is none.
    const resolved = await resolveGuests(ctx.conversationId, input.guests, rules.adults);
    if (!resolved.ok) {
      return {
        booked: false,
        reason: resolved.reason,
        message: resolved.message,
        travellers: rules.adults,
      };
    }
    const guests = resolved.guests;

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
      guests,
      { earlyCheckIn: input.earlyCheckIn },
      { rules, slices },
    );
    if (!sale.sold) return { booked: false, ...sale.failure };

    const {
      row: newRow,
      property,
      coverage,
      flightStay,
    } = await hotelBookingRow(ctx.conversationId, row, sale, guests);
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
      guests: guests.map((g) => `${g.givenName} ${g.familyName}`),
      guestsFrom: resolved.source === 'flight' ? 'the flight booking' : 'the details given',
      ...describeCoverage(coverage, flightStay),
      ...describeRequests(sale),
      ...(property ? { property } : {}),
    };
  },
});
