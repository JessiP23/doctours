import { z } from 'zod';
import { log } from '@/lib/log';
import * as repo from '@/lib/db/repo';
import type { BookingRow, Json, OfferRow } from '@/lib/db/types';
import { travelProvider, unconfirmedFlightsOf } from '@/lib/providers/sabre';
import { isProviderError } from '@/lib/providers/sabre/errors';
import type { FlightOffer, FlightOrder, Passenger } from '@/lib/providers/types';
import { deriveStay } from '@/lib/trip/nights';
import type { TripRules } from '@/lib/trip/rules';
import {
  distinctItineraries,
  excludeRefused,
  itinerarySignature,
  outboundDate,
  rank,
  returnDate,
  type RefusedFlight,
} from '@/lib/trip/select';
import { validateOffer } from '@/lib/trip/validate';
import { persistFlightOffers, searchAllowedFlights, terminalsOf } from './flight-offers';

/**
 * Selling a flight, once.
 *
 * Booking a flight and rebooking one are the same five steps — re-price live,
 * re-validate against the rules, sell, read the order back, persist it — and the
 * only difference is what happens to the row that was there before. Keeping the
 * sequence in one place is what stops a rebooking from quietly skipping the
 * deadline re-check or the schedule reconciliation that the first booking does.
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

/**
 * Sabre fares live about twenty minutes, so a patient who pauses to find their
 * passport will routinely come back to a dead offer. Refusing is correct but
 * useless on its own, so re-shop the *same itinerary* and hand back its current
 * price: the agent can then ask one question ("still want it at $X?") instead of
 * starting the search over.
 */
export async function reofferAfterExpiry(
  conversationId: string,
  expired: FlightOffer,
  opts: { excludeSameItinerary?: boolean; refused?: RefusedFlight[] } = {},
) {
  const rules = await repo
    .getConversation(conversationId)
    .then((c) => c!.trip_rules as unknown as TripRules);
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

export type SoldFlight = {
  order: FlightOrder;
  stay: ReturnType<typeof deriveStay>;
  /** The order holds different times than the itinerary that was quoted. */
  scheduleDiffers: boolean;
};

/** Either the flight was sold, or it was not and the caller has something to say. */
export type SellResult =
  { sold: true; result: SoldFlight } | { sold: false; failure: Record<string, unknown> };

/**
 * Prices, validates and sells one flight offer with the provider. Writes nothing:
 * the caller records it, which is what lets a rebooking retire the old row and
 * insert the replacement in one step instead of tripping over the index that
 * allows only one live booking per kind.
 */
export async function sellFlightOffer(args: {
  conversationId: string;
  rules: TripRules;
  offerRow: OfferRow;
  expired: boolean;
  passengers: Passenger[];
}): Promise<SellResult> {
  const { conversationId, rules, offerRow, passengers } = args;
  const offer = offerRow.raw as unknown as FlightOffer;
  const provider = travelProvider();

  if (args.expired) {
    const reoffer = await reofferAfterExpiry(conversationId, offer);
    return {
      sold: false,
      failure: {
        reason: 'OFFER_EXPIRED',
        message: reoffer.sameItinerary
          ? 'That fare expired, but the same flights are still available at the price below. Confirm the new price with the patient, then use that offerId.'
          : 'That fare expired and those exact flights are gone. Offer one of the alternatives below.',
        ...reoffer,
      },
    };
  }

  let priced: FlightOffer;
  try {
    priced = await provider.priceFlightOffer(offer);
  } catch (e) {
    if (isProviderError(e) && (e.code === 'OFFER_EXPIRED' || e.code === 'NO_AVAILABILITY')) {
      const reoffer = await reofferAfterExpiry(conversationId, offer);
      return {
        sold: false,
        failure: {
          reason: 'OFFER_EXPIRED',
          message: reoffer.sameItinerary
            ? 'The airline would not re-price that fare, but the same flights are available at the price below.'
            : 'The airline no longer offers that itinerary. Offer one of the alternatives below.',
          ...reoffer,
        },
      };
    }
    throw e;
  }

  // Re-validate after re-pricing: a schedule change could have moved the arrival.
  const check = validateOffer(priced, rules);
  if (!check.ok) {
    return {
      sold: false,
      failure: {
        reason: 'RULES_VIOLATED',
        message: `That itinerary can no longer be booked: ${check.reason}`,
      },
    };
  }

  if (Math.abs(priced.price.amount - offer.price.amount) > 0.01) {
    // Never book at a price the patient did not agree to. The re-priced offer is
    // persisted so confirming the new price is one step, not a fresh search.
    const [fresh] = await persistFlightOffers(conversationId, [priced]);
    return {
      sold: false,
      failure: {
        reason: 'PRICE_CHANGED',
        message:
          'The price changed while we were talking. Confirm the new price, then use the offerId below.',
        agreedPriceUSD: offer.price.amount,
        currentPriceUSD: priced.price.amount,
        priceChangeUSD: Number((priced.price.amount - offer.price.amount).toFixed(2)),
        offerId: fresh.id,
      },
    };
  }

  let order: FlightOrder;
  try {
    order = await provider.createFlightOrder(priced, passengers);
  } catch (e) {
    if (isProviderError(e) && e.code === 'NO_AVAILABILITY') {
      // The airline refused to sell that booking class. Those exact flights are
      // not bookable right now, so offer other itineraries, never the same one.
      const reoffer = await reofferAfterExpiry(conversationId, offer, {
        excludeSameItinerary: true,
        refused: unconfirmedFlightsOf(e),
      });
      return {
        sold: false,
        failure: {
          reason: 'AIRLINE_COULD_NOT_CONFIRM',
          message:
            'The airline would not confirm seats on those flights at that fare, so nothing was booked or charged. Tell the patient plainly and offer one of the alternatives below.',
          ...reoffer,
        },
      };
    }
    throw e;
  }

  const stay = deriveStay(order.slices[0], order.slices[1]);
  const timesOf = (slices: FlightOrder['slices']) =>
    slices.flatMap((s) => s.segments.map((g) => `${g.departLocal}/${g.arriveLocal}`)).join(',');
  const scheduleDiffers = timesOf(priced.slices) !== timesOf(order.slices);

  log.info({ conversationId, bookingReference: order.bookingReference }, 'flight sold by Sabre');
  return { sold: true, result: { order, stay, scheduleDiffers } };
}

/** The row a sold flight becomes. Shared so a rebooking records exactly what a first booking does. */
export function flightBookingRow(
  offerRow: OfferRow,
  sold: SoldFlight,
  passengers: Passenger[],
): repo.NewBooking {
  const { order, stay } = sold;
  return {
    kind: 'flight',
    provider: order.provider,
    providerOrderId: order.id,
    bookingReference: order.bookingReference,
    offerId: offerRow.id,
    details: {
      priceUSD: order.price.amount,
      outbound: {
        carrier: order.slices[0].segments[0].carrier,
        departLocal: order.slices[0].segments[0].departLocal,
        arriveLocal: order.slices[0].segments.at(-1)!.arriveLocal,
        stops: order.slices[0].stops,
        arrivalAirport: order.slices[0].segments.at(-1)!.to.iata,
        ...terminalsOf(order.slices[0]),
      },
      inbound: {
        departLocal: order.slices[1].segments[0].departLocal,
        arriveLocal: order.slices[1].segments.at(-1)!.arriveLocal,
        stops: order.slices[1].stops,
        ...terminalsOf(order.slices[1]),
      },
      travellers: passengers.map((p) => `${p.givenName} ${p.familyName}`),
      hotelNights: stay.nights,
    } as unknown as Json,
    // Sabre's response, the itinerary the order holds segment by segment, and the
    // travellers as filed. The itinerary is what every disruption check compares
    // against; the travellers are what lets a rebooking reuse the passports the
    // patient already gave rather than asking for them twice.
    raw: {
      ...(order.raw as object),
      bookedSlices: order.slices,
      travellers: passengers,
    } as unknown as Json,
  };
}

/** The travellers a booking was filed for, so a replacement can reuse them. */
export function travellersOf(booking: BookingRow): Passenger[] {
  const raw = (booking.raw ?? {}) as { travellers?: unknown };
  const parsed = z.array(passengerSchema).safeParse(raw.travellers);
  return parsed.success ? parsed.data : [];
}
