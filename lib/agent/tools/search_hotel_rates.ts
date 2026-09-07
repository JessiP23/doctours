import { z } from 'zod';
import { DateTime } from 'luxon';
import * as repo from '@/lib/db/repo';
import type { Json } from '@/lib/db/types';
import { travelProvider } from '@/lib/providers/sabre';
import { deriveStay } from '@/lib/trip/nights';
import type { FlightOffer } from '@/lib/providers/types';
import { rulesFor } from './context';
import { defineTool } from './define';

/**
 * Room search at the pinned property.
 *
 * The nights are derived from the flight that was actually booked, so the stay
 * can never drift from the itinerary. Explicit dates are accepted only as an
 * override for the cases the conversation genuinely needs them.
 */
const MAX_SHOWN = 4;

export const searchHotelRatesTool = defineTool({
  name: 'search_hotel_rates',
  description:
    'Find rooms at the trip hotel. Nights are taken from the booked flight automatically, so normally call this with no arguments. Returns rateIds you can book, cheapest first.',
  schema: z.object({
    checkIn: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe('Only to override the dates derived from the flight'),
    checkOut: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
  }),
  handler: async (input, ctx) => {
    const rules = await rulesFor(ctx.conversationId);

    let checkIn = input.checkIn;
    let checkOut = input.checkOut;
    let derivedFrom = 'the dates you gave me';
    /** Local arrival time, so an early landing can be mentioned rather than discovered at the desk. */
    let arriveLocal: string | undefined;

    if (!checkIn || !checkOut) {
      const flight = await repo.getLiveBooking(ctx.conversationId, 'flight');
      if (!flight) {
        return {
          rooms: [],
          reason: 'NO_FLIGHT_YET',
          message:
            'Book the flight first — the hotel nights follow from it. Or pass explicit dates.',
        };
      }
      const offerRow = flight.offer_id
        ? await repo.getOffer(ctx.conversationId, flight.offer_id)
        : null;
      if (offerRow) {
        const offer = offerRow.raw as unknown as FlightOffer;
        const stay = deriveStay(offer.slices[0], offer.slices[1]);
        checkIn = stay.checkIn;
        checkOut = stay.checkOut;
        arriveLocal = offer.slices[0].segments.at(-1)?.arriveLocal;
      } else {
        const details = flight.details as { hotelNights?: number } | null;
        return {
          rooms: [],
          reason: 'DATES_UNKNOWN',
          message: `Could not read the flight dates back${details?.hotelNights ? ` (expected ${details.hotelNights} nights)` : ''}. Ask for the dates and pass them explicitly.`,
        };
      }
      derivedFrom = 'the flight you booked';
    }

    const rates = await travelProvider().searchHotelRates({
      propertyId: rules.hotel.providerPropertyId,
      checkIn,
      checkOut,
      adults: rules.adults,
      currency: rules.currency,
    });

    // One option per (room type, bed setup, refundability) so the model is not
    // shown four identical rooms that differ only by internal rate code.
    const seen = new Set<string>();
    const shown = [];
    for (const rate of rates) {
      const key = `${rate.roomName}|${rate.bedTypes.join('+')}|${rate.refundable}`;
      if (seen.has(key)) continue;
      seen.add(key);
      shown.push(rate);
      if (shown.length === MAX_SHOWN) break;
    }

    const rows = await repo.insertOffers(
      ctx.conversationId,
      shown.map((rate) => ({
        kind: 'hotel_rate' as const,
        provider: rate.provider,
        providerOfferId: rate.id,
        summary: {
          room: rate.roomName,
          description: rate.roomDescription,
          beds: rate.bedTypes,
          sleeps: rate.maxOccupancy,
          ratePlan: rate.ratePlanName,
          nightlyUSD: rate.nightly.amount,
          totalUSD: rate.total.amount,
          nights: rate.nights,
          refundable: rate.refundable,
          cancelBy: rate.cancelBy,
          meals: rate.mealPlan,
        } as unknown as Json,
        raw: rate as unknown as Json,
        expiresAt: rate.expiresAt,
      })),
    );

    // The room is not ready until check-in time; if the flight lands well before it,
    // that is the patient's problem to know about now, not at the desk.
    let earlyArrival: { arriveLocal: string; checkInFrom: string; hoursEarly: number } | undefined;
    if (arriveLocal) {
      const arrival = DateTime.fromISO(arriveLocal, { zone: rules.destinationTz });
      const ready = DateTime.fromISO(`${checkIn}T${rules.hotel.checkInTime}`, {
        zone: rules.destinationTz,
      });
      const hoursEarly = ready.diff(arrival, 'hours').hours;
      if (hoursEarly >= 2) {
        earlyArrival = {
          arriveLocal,
          checkInFrom: rules.hotel.checkInTime,
          hoursEarly: Math.round(hoursEarly * 10) / 10,
        };
      }
    }

    return {
      hotel: rules.hotel.name,
      checkIn,
      checkOut,
      ...(earlyArrival ? { earlyArrival } : {}),
      nights: rows[0] ? (rows[0].summary as { nights?: number }).nights : undefined,
      datesFrom: derivedFrom,
      checkInFrom: rules.hotel.checkInTime,
      rooms: rows.map((row) => ({ rateId: row.id, ...(row.summary as object) })),
      note: 'Cheapest first. Totals include taxes. The rate is re-confirmed with the hotel when booking.',
    };
  },
});
