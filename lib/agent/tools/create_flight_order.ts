import { z } from 'zod';
import { log } from '@/lib/log';
import * as repo from '@/lib/db/repo';
import type { Json } from '@/lib/db/types';
import { travelProvider } from '@/lib/providers/sabre';
import type { FlightOffer } from '@/lib/providers/types';
import { isProviderError } from '@/lib/providers/sabre/errors';
import { validateOffer } from '@/lib/trip/validate';
import { deriveStay } from '@/lib/trip/nights';
import { unconfirmedFlightsOf } from '@/lib/providers/sabre';
import {
  distinctItineraries,
  excludeRefused,
  itinerarySignature,
  outboundDate,
  rank,
  returnDate,
  type RefusedFlight,
} from '@/lib/trip/select';
import { rulesFor } from './context';
import { defineTool } from './define';
import { persistFlightOffers, searchAllowedFlights } from './flight-offers';
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
/**
 * Sabre fares live about twenty minutes, so a patient who pauses to find their
 * passport will routinely come back to a dead offer. Refusing is correct but
 * useless on its own, so re-shop the *same itinerary* and hand back its current
 * price: the agent can then ask one question ("still want it at $X?") instead of
 * starting the search over.
 */
async function reofferAfterExpiry(
  conversationId: string,
  expired: FlightOffer,
  opts: { excludeSameItinerary?: boolean; refused?: RefusedFlight[] } = {},
) {
  const rules = await rulesFor(conversationId);
  const wanted = itinerarySignature(expired);
  const searched = await searchAllowedFlights(rules, {
    outboundDate: outboundDate(expired),
    returnDate: returnDate(expired),
  });
  const offers = excludeRefused(searched.offers, opts.refused ?? []);

  const same = opts.excludeSameItinerary
    ? undefined
    : offers.find((o) => itinerarySignature(o) === wanted);
  if (same) {
    const [row] = await persistFlightOffers(conversationId, [same]);
    return {
      sameItinerary: {
        offerId: row.id,
        ...(row.summary as object),
        previousPriceUSD: expired.price.amount,
        priceChangeUSD: Number((same.price.amount - expired.price.amount).toFixed(2)),
      },
    };
  }

  const alternatives = await persistFlightOffers(
    conversationId,
    distinctItineraries(rank(offers, 'price'), 3),
  );
  return {
    sameItinerary: null,
    alternatives: alternatives.map((row) => ({ offerId: row.id, ...(row.summary as object) })),
  };
}

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
    const offer = row.raw as unknown as FlightOffer;
    const provider = travelProvider();

    if (expired) {
      const reoffer = await reofferAfterExpiry(ctx.conversationId, offer);
      return {
        booked: false,
        reason: 'OFFER_EXPIRED',
        message: reoffer.sameItinerary
          ? 'That fare expired, but the same flights are still available at the price below. Confirm the new price with the patient, then book that offerId.'
          : 'That fare expired and those exact flights are gone. Offer one of the alternatives below.',
        ...reoffer,
      };
    }

    let priced: FlightOffer;
    try {
      priced = await provider.priceFlightOffer(offer);
    } catch (e) {
      if (isProviderError(e) && (e.code === 'OFFER_EXPIRED' || e.code === 'NO_AVAILABILITY')) {
        const reoffer = await reofferAfterExpiry(ctx.conversationId, offer);
        return {
          booked: false,
          reason: 'OFFER_EXPIRED',
          message: reoffer.sameItinerary
            ? 'The airline would not re-price that fare, but the same flights are available at the price below.'
            : 'The airline no longer offers that itinerary. Offer one of the alternatives below.',
          ...reoffer,
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
      // Never book at a price the patient did not agree to. The re-priced offer is
      // persisted so confirming the new price is one step, not a fresh search.
      const [fresh] = await persistFlightOffers(ctx.conversationId, [priced]);
      return {
        booked: false,
        reason: 'PRICE_CHANGED',
        message:
          'The price changed while we were talking. Confirm the new price, then book the offerId below.',
        agreedPriceUSD: offer.price.amount,
        currentPriceUSD: priced.price.amount,
        priceChangeUSD: Number((priced.price.amount - offer.price.amount).toFixed(2)),
        offerId: fresh.id,
      };
    }

    let order;
    try {
      order = await provider.createFlightOrder(priced, [input.passenger]);
    } catch (e) {
      if (isProviderError(e) && e.code === 'NO_AVAILABILITY') {
        // The airline refused to sell that booking class. Those exact flights are
        // not bookable right now, so offer other itineraries, never the same one.
        const reoffer = await reofferAfterExpiry(ctx.conversationId, offer, {
          excludeSameItinerary: true,
          refused: unconfirmedFlightsOf(e),
        });
        return {
          booked: false,
          reason: 'AIRLINE_COULD_NOT_CONFIRM',
          message:
            'The airline would not confirm seats on those flights at that fare, so nothing was booked or charged. Tell the patient plainly and offer one of the alternatives below.',
          ...reoffer,
        };
      }
      throw e;
    }
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
