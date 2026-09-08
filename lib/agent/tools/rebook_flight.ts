import { z } from 'zod';
import { log } from '@/lib/log';
import * as repo from '@/lib/db/repo';
import type { BookingRow } from '@/lib/db/types';
import { travelProvider } from '@/lib/providers/sabre';
import { isProviderError } from '@/lib/providers/sabre/errors';
import { rulesFor } from './context';
import { defineTool } from './define';
import { flightBookingRow, sellFlightOffer, travellersOf } from './flight-booking';
import { loadBookableOffer } from './search_flights';

/**
 * Moves the patient onto different flights.
 *
 * This is the other half of a cancellation. Detecting that an airline dropped a
 * leg and telling the patient costs nothing; the trip is not repaired until they
 * are on something else, and until the hotel follows.
 *
 * Order matters, and it is the opposite of cancelling a trip. The replacement is
 * sold FIRST, and the old order is only released once the new one exists — the
 * worst state a patient can be in is holding no flight at all, so a failed sell
 * has to leave them exactly where they were. If the sell works and the cancel does
 * not, that is reported by reference: two live orders is something an operator can
 * fix, and a comfortable lie about it is not.
 *
 * The old row becomes `superseded` and points at its replacement. The trip moved,
 * it was not abandoned, and an operator reading the history later can see which
 * booking replaced which and why.
 *
 * Passports come from the booking being replaced, so a patient whose flight the
 * airline cancelled is not asked for their date of birth a second time.
 */
export const rebookFlightTool = defineTool({
  name: 'rebook_flight',
  description:
    'Replace the flight this trip already holds with a different one the patient has confirmed. Use this when a flight was cancelled or the patient wants different flights — not create_flight_order, which refuses when a flight exists. It books the replacement first, then releases the old order, reuses the traveller details already on file, and tells you whether the hotel nights still line up.',
  schema: z.object({
    offerId: z.string().describe('offerId of the replacement, from search_flights'),
    confirmed: z
      .literal(true)
      .describe(
        'Only true after the patient has agreed to these specific replacement flights and their price.',
      ),
    reason: z
      .string()
      .min(3)
      .max(200)
      .describe('Why, in the words you gave the patient — stored on the booking it replaces.'),
  }),
  handler: async (input, ctx) => {
    const rules = await rulesFor(ctx.conversationId);
    const old = await repo.getLiveBooking(ctx.conversationId, 'flight');

    if (!old) {
      return {
        rebooked: false,
        reason: 'NOTHING_TO_REPLACE',
        message:
          'No flight is booked on this trip, so there is nothing to replace. Use create_flight_order.',
      };
    }

    const passengers = travellersOf(old);
    if (passengers.length !== rules.adults) {
      // Bookings written before the travellers were kept on the row cannot be
      // rebooked without asking again. Say which, rather than guess at a passport.
      return {
        rebooked: false,
        reason: 'TRAVELLER_DETAILS_UNAVAILABLE',
        message: `The traveller details filed on ${old.booking_reference} could not be read back for all ${rules.adults} traveller(s), so it cannot be replaced automatically. Ask the patient to confirm passport name, date of birth, gender, email and phone for each traveller, then cancel this booking and book the replacement.`,
        bookingReference: old.booking_reference,
      };
    }

    const { row, expired } = await loadBookableOffer(ctx.conversationId, input.offerId, 'flight');

    // Sell before anything is retired: if this fails, nothing has changed.
    const sale = await sellFlightOffer({
      conversationId: ctx.conversationId,
      rules,
      offerRow: row,
      expired,
      passengers,
    });
    if (!sale.sold) {
      return {
        rebooked: false,
        stillBooked: old.booking_reference,
        message: 'Nothing changed — the patient still holds their original flight.',
        ...sale.failure,
      };
    }

    const { order, stay, scheduleDiffers } = sale.result;
    // The seat is sold. From here nothing may throw: an exception would lose a real
    // reference the patient is already entitled to, and leave two live orders with
    // no record of the second. It happened once — a status precondition on the
    // wrong step — so the failure is reported instead.
    let booking;
    try {
      booking = await repo.replaceBooking(
        ctx.conversationId,
        old.id,
        input.reason,
        flightBookingRow(row, sale.result, passengers),
      );
    } catch (e) {
      log.error(
        { conversationId: ctx.conversationId, sold: order.bookingReference, err: String(e) },
        'flight sold but the booking could not be recorded',
      );
      return {
        rebooked: false,
        reason: 'SOLD_BUT_NOT_RECORDED',
        soldReference: order.bookingReference,
        stillBooked: old.booking_reference,
        message: `The replacement flight WAS booked with the airline as ${order.bookingReference}, but this trip's records could not be updated, so both bookings are live right now. Tell the patient both references and that someone is sorting it out. Do not cancel anything and do not try again.`,
      };
    }

    // Now, and only now, release the old order with the airline.
    let oldCancelled = false;
    let cancelDetail: string | undefined;
    try {
      const result = await travelProvider().cancelBooking(old.booking_reference);
      oldCancelled = result.cancelled;
      if (!result.cancelled) cancelDetail = `still holds ${result.remaining.join(' and ')}`;
    } catch (e) {
      cancelDetail = isProviderError(e) ? e.message : e instanceof Error ? e.message : String(e);
    }
    if (!oldCancelled) {
      log.error(
        { conversationId: ctx.conversationId, reference: old.booking_reference, cancelDetail },
        'replacement booked but the old order could not be released',
      );
    }

    const hotel = await repo.getLiveBooking(ctx.conversationId, 'hotel');
    const realignment = hotelRealignment(hotel, stay);

    log.info(
      {
        conversationId: ctx.conversationId,
        from: old.booking_reference,
        to: booking.booking_reference,
        oldCancelled,
      },
      'flight rebooked',
    );

    return {
      rebooked: true,
      bookingReference: booking.booking_reference,
      replaced: old.booking_reference,
      priceUSD: order.price.amount,
      previousPriceUSD: (old.details as { priceUSD?: number }).priceUSD ?? null,
      confirmedItinerary: {
        outbound: (booking.details as { outbound?: unknown }).outbound,
        inbound: (booking.details as { inbound?: unknown }).inbound,
      },
      stay: { checkIn: stay.checkIn, checkOut: stay.checkOut, nights: stay.nights },
      oldOrderReleased: oldCancelled,
      ...(oldCancelled
        ? {}
        : {
            warning: `The replacement is booked, but the old order ${old.booking_reference} could not be released${cancelDetail ? ` (${cancelDetail})` : ''}. Tell the patient their new flights are confirmed and that the old booking is still being released — do not describe it as cancelled.`,
          }),
      ...(realignment
        ? {
            hotelNeedsRealignment: realignment,
            nextStep:
              'The hotel nights no longer match these flights. Search rooms for the new dates, tell the patient what it costs, then use rebook_hotel once they agree.',
          }
        : hotel
          ? { nextStep: 'The hotel nights still match these flights. Nothing else to change.' }
          : { nextStep: 'Book the hotel for those nights.' }),
      ...(scheduleDiffers
        ? {
            scheduleChangedOnConfirmation:
              'The airline holds slightly different times than the ones quoted. The confirmed times above are the real ones.',
          }
        : {}),
    };
  },
});

/**
 * Whether the room the patient holds still covers the flights they now hold.
 *
 * The nights were derived from the old itinerary, so a replacement that lands or
 * leaves on a different day leaves a real gap — a patient landing a day before
 * their room starts is the failure this exists to catch.
 */
export function hotelRealignment(
  hotel: BookingRow | null,
  stay: { checkIn: string; checkOut: string; nights: number },
) {
  if (!hotel) return null;
  const details = (hotel.details ?? {}) as { checkIn?: string; checkOut?: string; nights?: number };
  if (details.checkIn === stay.checkIn && details.checkOut === stay.checkOut) return null;
  return {
    reference: hotel.booking_reference,
    was: { checkIn: details.checkIn ?? null, checkOut: details.checkOut ?? null },
    now: { checkIn: stay.checkIn, checkOut: stay.checkOut, nights: stay.nights },
  };
}
