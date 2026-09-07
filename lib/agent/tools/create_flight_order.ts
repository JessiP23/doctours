import { z } from 'zod';
import { log } from '@/lib/log';
import * as repo from '@/lib/db/repo';
import type { Json } from '@/lib/db/types';
import { travelProvider } from '@/lib/providers/sabre';
import type { FlightOffer } from '@/lib/providers/types';
import { isProviderError } from '@/lib/providers/sabre/errors';
import { validateOffer } from '@/lib/trip/validate';
import { deriveStay } from '@/lib/trip/nights';
import { rulesFor } from './context';
import { defineTool } from './define';
import { loadBookableOffer } from './search_flights';

/**
 * Books the flight.
 *
 * Guard chain, in order, before Sabre is asked to create anything:
 *   1. the offer must exist and belong to this conversation
 *   2. no flight may already be booked here (the DB also enforces this)
 *   3. the offer must not have passed its provider expiry
 *   4. Flight Check must still return it — this is where a stale price surfaces
 *   5. the re-priced itinerary is validated against the trip rules again
 * The reference returned is whatever Sabre sent back, never anything constructed.
 */
export const passengerSchema = z.object({
  givenName: z.string().min(1).describe('First name exactly as printed on the passport'),
  familyName: z.string().min(1).describe('Surname exactly as printed on the passport'),
  dateOfBirth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD')
    .describe('YYYY-MM-DD'),
  gender: z.enum(['M', 'F', 'X']),
  email: z.email(),
  phone: z.string().min(5).describe('With country code, e.g. +1 555 123 4567'),
});

export const createFlightOrderTool = defineTool({
  name: 'create_flight_order',
  description:
    'Book a flight option the patient has confirmed. Only call this after they have chosen a specific offerId, agreed to the price, and given you their passport name, date of birth, gender, email and phone. It re-checks price and timing with the airline first, so it may report that the option expired.',
  schema: z.object({
    offerId: z.string().describe('offerId from search_flights'),
    passenger: passengerSchema,
  }),
  handler: async (input, ctx) => {
    const rules = await rulesFor(ctx.conversationId);

    const existing = await repo.getLiveBooking(ctx.conversationId, 'flight');
    if (existing) {
      return {
        booked: false,
        reason: 'ALREADY_BOOKED',
        message: 'A flight is already booked for this trip.',
        bookingReference: existing.booking_reference,
      };
    }

    const { row, expired } = await loadBookableOffer(ctx.conversationId, input.offerId, 'flight');
    if (expired) {
      return {
        booked: false,
        reason: 'OFFER_EXPIRED',
        message:
          'That fare expired before it could be booked. Search again and pick from the fresh options.',
      };
    }

    const offer = row.raw as unknown as FlightOffer;
    const provider = travelProvider();

    let priced: FlightOffer;
    try {
      priced = await provider.priceFlightOffer(offer);
    } catch (e) {
      if (isProviderError(e) && (e.code === 'OFFER_EXPIRED' || e.code === 'NO_AVAILABILITY')) {
        return {
          booked: false,
          reason: 'OFFER_EXPIRED',
          message:
            'The airline no longer offers that itinerary at that price. Search again for current options.',
        };
      }
      throw e;
    }

    const priceChanged = Math.abs(priced.price.amount - offer.price.amount) > 0.01;

    // Re-validate after re-pricing: a schedule change could have moved the arrival.
    const check = validateOffer({ ...priced, slices: priced.slices }, rules);
    if (!check.ok) {
      return {
        booked: false,
        reason: 'RULES_VIOLATED',
        message: `That itinerary can no longer be booked: ${check.reason}`,
      };
    }

    if (priceChanged) {
      // Never book a different price than the one the patient agreed to.
      await repo.insertOffers(ctx.conversationId, [
        {
          kind: 'flight',
          provider: priced.provider,
          providerOfferId: priced.id,
          summary: {
            priceUSD: priced.price.amount,
            note: 're-priced at booking time',
          } as unknown as Json,
          raw: priced.raw as Json,
          expiresAt: priced.expiresAt,
        },
      ]);
      return {
        booked: false,
        reason: 'PRICE_CHANGED',
        message: 'The price changed while we were talking.',
        agreedPriceUSD: offer.price.amount,
        currentPriceUSD: priced.price.amount,
      };
    }

    const order = await provider.createFlightOrder(priced, [input.passenger]);
    const stay = deriveStay(order.slices[0], order.slices[1]);

    const booking = await repo.insertBooking(ctx.conversationId, {
      kind: 'flight',
      provider: order.provider,
      providerOrderId: order.id,
      bookingReference: order.bookingReference,
      offerId: row.id,
      details: {
        priceUSD: order.price.amount,
        outbound: {
          carrier: order.slices[0].segments[0].carrier,
          departLocal: order.slices[0].segments[0].departLocal,
          arriveLocal: order.slices[0].segments.at(-1)!.arriveLocal,
          stops: order.slices[0].stops,
        },
        inbound: {
          departLocal: order.slices[1].segments[0].departLocal,
          arriveLocal: order.slices[1].segments.at(-1)!.arriveLocal,
          stops: order.slices[1].stops,
        },
        passenger: `${input.passenger.givenName} ${input.passenger.familyName}`,
        hotelNights: stay.nights,
      } as unknown as Json,
      raw: order.raw as Json,
    });

    log.info(
      { conversationId: ctx.conversationId, bookingReference: order.bookingReference },
      'flight booked with Sabre',
    );

    return {
      booked: true,
      bookingReference: booking.booking_reference,
      priceUSD: order.price.amount,
      stay: { checkIn: stay.checkIn, checkOut: stay.checkOut, nights: stay.nights },
      nextStep: 'Book the hotel for those nights.',
    };
  },
});
