import { z } from 'zod';
import { log } from '@/lib/log';
import * as repo from '@/lib/db/repo';
import { travelProvider } from '@/lib/providers/sabre';
import { isProviderError } from '@/lib/providers/sabre/errors';
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
 * Moves the room — to different nights, or to a different room.
 *
 * The nights a patient holds were derived from the flights they held. Rebook the
 * flight onto a different day and the room is silently wrong: they land before it
 * starts, or check out after they have gone. This is what closes that gap, and it
 * is also how a room change is done at all, since only one room may be live.
 *
 * Same order as the flight: sell the new room first, retire the old row, then
 * release the old reservation. A patient with no room is worse than a patient
 * briefly holding two, and a failed sell leaves them exactly where they were.
 *
 * The old row becomes `superseded`, pointing at its replacement — the stay moved
 * rather than being abandoned.
 */
export const rebookHotelTool = defineTool({
  name: 'rebook_hotel',
  description:
    'Replace the room this trip already holds with a different one the patient has confirmed — different nights after a flight change, an extra night at the start so the room is ready when they land, or a different room type. Not create_hotel_booking, which refuses when a room exists. Search rooms for the dates you want first, tell the patient the cost and the cancellation terms, and only call this once they agree. It books the new room before releasing the old.',
  schema: z.object({
    rateId: z.string().describe('rateId of the replacement room, from search_hotel_rates'),
    guests: z
      .array(guestSchema)
      .min(1)
      .max(MAX_TRAVELLERS)
      .describe('One entry per traveller staying in the room, the patient first'),
    earlyCheckIn: earlyCheckInField,
    confirmed: z
      .literal(true)
      .describe(
        'Only true after the patient has agreed to this specific room, its total and its cancellation terms.',
      ),
    reason: z
      .string()
      .min(3)
      .max(200)
      .describe('Why, in the words you gave the patient — stored on the booking it replaces.'),
  }),
  handler: async (input, ctx) => {
    const rules = await rulesFor(ctx.conversationId);
    const old = await repo.getLiveBooking(ctx.conversationId, 'hotel');

    if (!old) {
      return {
        rebooked: false,
        reason: 'NOTHING_TO_REPLACE',
        message:
          'No room is booked on this trip, so there is nothing to replace. Use create_hotel_booking.',
      };
    }

    if (input.guests.length !== rules.adults) {
      return {
        rebooked: false,
        reason: 'GUEST_COUNT_MISMATCH',
        message: `This trip is set to ${rules.adults} traveller(s) but you sent ${input.guests.length} guest(s). Every traveller goes on the room.`,
        travellers: rules.adults,
      };
    }

    const { row } = await loadBookableOffer(ctx.conversationId, input.rateId, 'hotel_rate');

    // Sell before anything is retired: a failure leaves the old room untouched.
    const slices = await bookedFlightSlices(ctx.conversationId);
    const sale = await sellHotelRate(
      row,
      input.guests,
      { earlyCheckIn: input.earlyCheckIn },
      { rules, slices },
    );
    if (!sale.sold) {
      return {
        rebooked: false,
        stillBooked: old.booking_reference,
        message: 'Nothing changed — the patient still holds their original room.',
        ...sale.failure,
      };
    }

    const {
      row: newRow,
      property,
      coverage,
      flightStay,
    } = await hotelBookingRow(ctx.conversationId, row, sale, input.guests);
    // The room is sold. Nothing past this point may throw and lose the reference.
    let booking;
    try {
      booking = await repo.replaceBooking(ctx.conversationId, old.id, input.reason, newRow);
    } catch (e) {
      log.error(
        {
          conversationId: ctx.conversationId,
          sold: sale.booking.bookingReference,
          err: String(e),
        },
        'room sold but the booking could not be recorded',
      );
      return {
        rebooked: false,
        reason: 'SOLD_BUT_NOT_RECORDED',
        soldReference: sale.booking.bookingReference,
        stillBooked: old.booking_reference,
        message: `The replacement room WAS booked with the hotel as ${sale.booking.bookingReference}, but this trip's records could not be updated, so both reservations are live right now. Tell the patient both references and that someone is sorting it out. Do not cancel anything and do not try again.`,
      };
    }

    let oldReleased = false;
    let cancelDetail: string | undefined;
    try {
      const result = await travelProvider().cancelBooking(old.booking_reference);
      oldReleased = result.cancelled;
      if (!result.cancelled) cancelDetail = `still holds ${result.remaining.join(' and ')}`;
    } catch (e) {
      cancelDetail = isProviderError(e) ? e.message : e instanceof Error ? e.message : String(e);
    }
    if (!oldReleased) {
      log.error(
        { conversationId: ctx.conversationId, reference: old.booking_reference, cancelDetail },
        'replacement room booked but the old reservation could not be released',
      );
    }

    // Does the new stay actually cover the flights? Moving the room to the wrong
    // nights is the same failure as leaving it on the old ones. A night booked
    // before the flight lands is covered, not wrong — it is what an early arrival
    // asked for.
    const previous = (old.details ?? {}) as {
      totalUSD?: number;
      checkIn?: string;
      checkOut?: string;
    };

    log.info(
      {
        conversationId: ctx.conversationId,
        from: old.booking_reference,
        to: booking.booking_reference,
        oldReleased,
      },
      'hotel rebooked',
    );

    return {
      rebooked: true,
      bookingReference: booking.booking_reference,
      replaced: old.booking_reference,
      hotel: sale.booking.propertyName,
      room: sale.booking.roomName,
      checkIn: sale.booking.checkIn,
      checkOut: sale.booking.checkOut,
      nights: sale.rate.nights,
      totalUSD: sale.booking.total.amount,
      previousTotalUSD: previous.totalUSD ?? null,
      previousNights:
        previous.checkIn && previous.checkOut
          ? { checkIn: previous.checkIn, checkOut: previous.checkOut }
          : null,
      refundable: sale.rate.refundable,
      cancelBy: sale.rate.cancelBy,
      oldReservationReleased: oldReleased,
      ...describeCoverage(coverage, flightStay),
      ...describeRequests(sale.requests),
      ...(property ? { property } : {}),
      ...(oldReleased
        ? {}
        : {
            warning: `The new room is booked, but the old reservation ${old.booking_reference} could not be released${cancelDetail ? ` (${cancelDetail})` : ''}. Tell the patient the new room is confirmed and that the old one is still being released — do not describe it as cancelled.`,
          }),
    };
  },
});
