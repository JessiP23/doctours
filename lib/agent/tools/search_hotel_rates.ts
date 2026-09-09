import { z } from 'zod';
import { DateTime } from 'luxon';
import * as repo from '@/lib/db/repo';
import type { Json } from '@/lib/db/types';
import { travelProvider } from '@/lib/providers/sabre';
import { isProviderError } from '@/lib/providers/sabre/errors';
import { deriveStay } from '@/lib/trip/nights';
import type { HotelRate } from '@/lib/providers/types';
import type { FlightOffer, FlightSlice } from '@/lib/providers/types';
import { rulesFor } from './context';
import { defineTool } from './define';
import { describeProperty } from './property';

/**
 * Room search at the pinned property.
 *
 * The nights are derived from the flight that was actually booked, so the stay
 * can never drift from the itinerary. Explicit dates are accepted only as an
 * override for the cases the conversation genuinely needs them.
 */
const MAX_SHOWN = 4;
/** Landing this many hours or more before check-in time is worth a word — and a price. */
const EARLY_ARRIVAL_HOURS = 2;

function noRoomsIsAnAnswer(e: unknown): HotelRate[] {
  if (isProviderError(e) && e.code === 'NO_AVAILABILITY') return [];
  throw e;
}

/**
 * Rooms the party can actually use, one per (room type, bed setup, refundability)
 * so the model is not shown four identical rooms that differ only by internal
 * rate code. Sabre does not always file an occupancy, and an unknown is not a
 * refusal — it is reported so the agent can say the hotel has not stated it.
 */
function pickRooms(rates: HotelRate[], adults: number, max = MAX_SHOWN) {
  const fits = rates.filter((r) => r.maxOccupancy === null || r.maxOccupancy >= adults);
  const seen = new Set<string>();
  const rooms: HotelRate[] = [];
  for (const rate of fits) {
    const key = `${rate.roomName}|${rate.bedTypes.join('+')}|${rate.refundable}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rooms.push(rate);
    if (rooms.length === max) break;
  }
  return { rooms, fits: fits.length };
}

function insertRateOffers(
  conversationId: string,
  rates: HotelRate[],
  flags: { extraNight: boolean },
) {
  return repo.insertOffers(
    conversationId,
    rates.map((rate) => ({
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
        checkIn: rate.checkIn,
        checkOut: rate.checkOut,
        refundable: rate.refundable,
        cancelBy: rate.cancelBy,
        meals: rate.mealPlan,
        ...(flags.extraNight ? { fromTheNightBefore: true } : {}),
      } as unknown as Json,
      raw: rate as unknown as Json,
      expiresAt: rate.expiresAt,
    })),
  );
}

export const searchHotelRatesTool = defineTool({
  name: 'search_hotel_rates',
  description:
    'Find rooms at the trip hotel. Nights are taken from the booked flight automatically, so normally call this with no arguments. Returns rateIds you can book, cheapest first. When the flight lands well before check-in time it also prices the night before as extraNight, with its own rateIds, so the patient can choose to have the room from the moment they land.',
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
    /** Where the patient actually lands, which is what "how far is the hotel" means. */
    let arrivalAirport: string | undefined = rules.destination;

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
      // The itinerary the order holds, not the one that was shopped: the nights
      // follow the times Sabre actually sells, and a reconciled arrival can fall on
      // a different day than the cache said.
      const booked = ((flight.raw ?? {}) as { bookedSlices?: FlightSlice[] }).bookedSlices;
      const offerRow =
        booked && booked.length >= 2
          ? null
          : flight.offer_id
            ? await repo.getOffer(ctx.conversationId, flight.offer_id)
            : null;
      const slices =
        booked && booked.length >= 2
          ? booked
          : offerRow
            ? (offerRow.raw as unknown as FlightOffer).slices
            : null;
      if (slices) {
        const stay = deriveStay(slices[0], slices[1]);
        checkIn = stay.checkIn;
        checkOut = stay.checkOut;
        arriveLocal = slices[0].segments.at(-1)?.arriveLocal;
        arrivalAirport = slices[0].segments.at(-1)?.to.iata;
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

    const search = (from: string) =>
      travelProvider().searchHotelRates({
        propertyId: rules.hotel.providerPropertyId,
        checkIn: from,
        checkOut,
        adults: rules.adults,
        currency: rules.currency,
      });

    const rates = await search(checkIn);

    // When the room is ready: what the property itself states, and only failing
    // that what the trip rules assume. A hotel the patient chose may have told us
    // nothing, in which case no early-arrival arithmetic is done on a guess.
    const checkInFrom = rates[0]?.policies?.checkInTime ?? rules.hotel.checkInTime;

    // The room is not ready until check-in time; if the flight lands well before it,
    // that is the patient's problem to know about now, not at the desk — and the
    // night before is priced in the same breath, so "can I get in early?" has a
    // real answer with a real number.
    let earlyArrival: { arriveLocal: string; checkInFrom: string; hoursEarly: number } | undefined;
    if (arriveLocal && checkInFrom) {
      const arrival = DateTime.fromISO(arriveLocal, { zone: rules.destinationTz });
      const ready = DateTime.fromISO(`${checkIn}T${checkInFrom}`, { zone: rules.destinationTz });
      const hoursEarly = ready.diff(arrival, 'hours').hours;
      if (hoursEarly >= EARLY_ARRIVAL_HOURS) {
        earlyArrival = { arriveLocal, checkInFrom, hoursEarly: Math.round(hoursEarly * 10) / 10 };
      }
    }

    const nightBefore = earlyArrival
      ? (DateTime.fromISO(checkIn).minus({ days: 1 }).toISODate() as string)
      : null;

    // The extra night is optional, so its search finding nothing is an answer ("no
    // room from the night before"), not an error.
    const extraRates = nightBefore ? await search(nightBefore).catch(noRoomsIsAnAnswer) : null;

    const shown = pickRooms(rates, rules.adults);
    const tooSmall = rates.length - shown.fits;
    const rows = await insertRateOffers(ctx.conversationId, shown.rooms, { extraNight: false });

    const extraShown = extraRates ? pickRooms(extraRates, rules.adults, 2) : null;
    const extraRows = extraShown
      ? await insertRateOffers(ctx.conversationId, extraShown.rooms, { extraNight: true })
      : [];

    // Where the property is, and how far that is from wherever this patient lands.
    // Both come from calls already being made; the agent had to say it did not know
    // the address of a hotel whose address was sitting in the same response.
    const property = await describeProperty(shown.rooms[0]?.location ?? null, arrivalAirport);

    return {
      hotel: rules.hotel.name,
      travellers: rules.adults,
      ...(tooSmall > 0
        ? {
            roomsTooSmall: tooSmall,
            occupancyNote: `${tooSmall} room type(s) sleep fewer than ${rules.adults} and were left out.`,
          }
        : {}),
      ...(rules.adults > 1 && shown.rooms.length === 0
        ? {
            reason: 'NO_ROOM_SLEEPS_PARTY',
            message: `No room at this property is filed as sleeping ${rules.adults}. Tell the patient plainly rather than booking one that does not.`,
          }
        : {}),
      ...(property ? { property } : {}),
      checkIn,
      checkOut,
      ...(earlyArrival
        ? {
            earlyArrival,
            extraNight: nightBefore
              ? extraRows.length > 0
                ? {
                    checkIn: nightBefore,
                    checkOut,
                    rooms: extraRows.map((row) => ({ rateId: row.id, ...(row.summary as object) })),
                    note: `Booking from ${nightBefore} means the room is theirs the moment they land, instead of waiting until ${checkInFrom ?? 'check-in time'}. It is an ordinary paid night on the same terms as the rest of the stay, and these rateIds book it directly. The alternative is an early check-in request on the normal dates (earlyCheckIn on the booking), which costs nothing and the hotel may not honour.`,
                  }
                : {
                    checkIn: nightBefore,
                    available: false,
                    note: 'No room at this property is available from the night before, so the only option for an early landing is an early check-in request, which the hotel may not honour.',
                  }
              : undefined,
          }
        : {}),
      nights: rows[0] ? (rows[0].summary as { nights?: number }).nights : undefined,
      datesFrom: derivedFrom,
      checkInFrom,
      rooms: rows.map((row) => ({ rateId: row.id, ...(row.summary as object) })),
      note: 'Cheapest first. Totals include taxes. The rate is re-confirmed with the hotel when booking.',
    };
  },
});
