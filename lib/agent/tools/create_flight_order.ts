import { z } from 'zod';
import * as repo from '@/lib/db/repo';
import { rulesFor } from './context';
import { defineTool } from './define';
import { flightBookingRow, passengerSchema, sellFlightOffer } from './flight-booking';
import { loadBookableOffer } from './search_flights';
import { MAX_TRAVELLERS } from './set_party_size';

/**
 * Books the flight.
 *
 * Guard chain, in order, before Sabre is asked to create anything:
 *   1. the passenger list must match the traveller count set on this trip
 *   2. no flight may already be booked here (the DB also enforces this)
 *   3. the offer must exist and belong to this conversation
 *   4. the offer must not have passed its provider expiry
 *   5. Flight Check must still return it — this is where a stale price surfaces
 *   6. the re-priced itinerary is validated against the trip rules again
 * Steps 3 to 6 and the sell itself live in `flight-booking.ts`, shared with
 * rebooking so a replacement flight is checked exactly as strictly as a first one.
 * The reference returned is whatever Sabre sent back, never anything constructed.
 */
export { passengerSchema };

export const createFlightOrderTool = defineTool({
  name: 'create_flight_order',
  description:
    'Book a flight option the patient has confirmed. Only call this after they have chosen a specific offerId, agreed to the price, and given you passport name, date of birth, gender, email and phone for EVERY traveller on the trip. It re-checks price and timing with the airline first, so it may report that the option expired.',
  schema: z.object({
    offerId: z.string().describe('offerId from search_flights'),
    passengers: z
      .array(passengerSchema)
      .min(1)
      .max(MAX_TRAVELLERS)
      .describe('One entry per traveller on this trip, the patient first'),
  }),
  handler: async (input, ctx) => {
    const rules = await rulesFor(ctx.conversationId);

    // The party size is trip state, not something the model may imply by sending a
    // different number of passports. A mismatch means the two disagree about who is
    // going, which is exactly the confusion that got a companion booked in words only.
    if (input.passengers.length !== rules.adults) {
      return {
        booked: false,
        reason: 'TRAVELLER_COUNT_MISMATCH',
        message: `This trip is set to ${rules.adults} traveller(s) but you sent ${input.passengers.length}. Collect details for every traveller, or call set_party_size first if the number itself is wrong.`,
        travellers: rules.adults,
      };
    }

    const existing = await repo.getLiveBooking(ctx.conversationId, 'flight');
    if (existing) {
      return {
        booked: false,
        reason: 'ALREADY_BOOKED',
        message:
          'A flight is already booked for this trip. To move the patient onto different flights, use rebook_flight — it replaces this booking rather than adding a second one.',
        bookingReference: existing.booking_reference,
      };
    }

    const { row, expired } = await loadBookableOffer(ctx.conversationId, input.offerId, 'flight');
    const sale = await sellFlightOffer({
      conversationId: ctx.conversationId,
      rules,
      offerRow: row,
      expired,
      passengers: input.passengers,
    });

    if (!sale.sold) return { booked: false, ...sale.failure };

    const { order, stay, scheduleDiffers } = sale.result;
    const booking = await repo.insertBooking(
      ctx.conversationId,
      flightBookingRow(row, sale.result, input.passengers),
    );
    return {
      booked: true,
      bookingReference: booking.booking_reference,
      priceUSD: order.price.amount,
      stay: { checkIn: stay.checkIn, checkOut: stay.checkOut, nights: stay.nights },
      confirmedItinerary: {
        outbound: (booking.details as { outbound?: unknown }).outbound,
        inbound: (booking.details as { inbound?: unknown }).inbound,
      },
      ...(scheduleDiffers
        ? {
            scheduleChangedOnConfirmation:
              'The airline holds slightly different times than the ones quoted. The confirmed times above are the real ones — tell the patient what changed before moving on.',
          }
        : {}),
      nextStep: 'Book the hotel for those nights.',
    };
  },
});
