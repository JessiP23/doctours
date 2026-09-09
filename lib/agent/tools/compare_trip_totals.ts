import { z } from 'zod';
import { DateTime } from 'luxon';
import * as repo from '@/lib/db/repo';
import { log } from '@/lib/log';
import { travelProvider } from '@/lib/providers/sabre';
import type { FlightOffer, HotelRate } from '@/lib/providers/types';
import { earlyArrivalFor } from '@/lib/trip/nights';
import { applyPreferences, distinctItineraries, excludeCancelled } from '@/lib/trip/select';
import {
  cheapestPerStay,
  describeTradeoff,
  distinctStays,
  rankTripTotals,
  stayKey,
} from '@/lib/trip/totals';
import { rulesFor } from './context';
import { defineTool } from './define';
import { persistFlightOffers, searchAllowedFlights, summarizeFlightOffer } from './flight-offers';
import { cancelledFlightsFor } from './search_flights';
import { insertRateOffers, noRoomsIsAnAnswer, pickRooms } from './search_hotel_rates';

/**
 * The whole trip, priced.
 *
 * A patient who says money is tight is asking about the total, and the cheapest
 * flight is not it: the fare that lands a day early adds a night the fare never
 * mentioned. So: the rule-valid flights, the distinct stays they imply (usually two
 * to four), the cheapest room at the trip hotel for each of those stays priced
 * concurrently, and the options ranked by the sum. Every flight shown is re-priced
 * live and every room is a real rate, both persisted so the option the patient
 * picks is bookable with the ordinary tools. The arithmetic is done here; the
 * agent only repeats it.
 */
const FLIGHTS_PER_STAY = 2;
const MAX_SHOWN = 4;

export const compareTripTotalsTool = defineTool({
  name: 'compare_trip_totals',
  description:
    'When the patient wants the cheapest trip overall or says money is tight: prices flights and hotel together. For each valid flight option it works out the nights it implies, prices the cheapest room at the trip hotel for those nights, and ranks by flight + hotel. Returns offerIds and rateIds you can book, and the trade-off in words. Use this instead of search_flights when the question is about the total.',
  schema: z.object({
    maxStops: z.number().int().min(0).max(3).optional().describe('Only if the patient asked'),
    airlines: z
      .array(z.string().regex(/^[A-Z0-9]{2}$/))
      .max(5)
      .optional()
      .describe('Only if the patient asked for particular airlines'),
  }),
  handler: async (input, ctx) => {
    const rules = await rulesFor(ctx.conversationId);
    if (!rules.travellersConfirmed) {
      return {
        options: [],
        reason: 'PARTY_SIZE_UNKNOWN',
        message:
          'The patient has not said how many people are travelling; both the fares and the room depend on it. Ask, call set_party_size, then compare.',
      };
    }

    const { offers: found, failures } = await searchAllowedFlights(rules);
    const cancelled = await cancelledFlightsFor(ctx.conversationId);
    const valid = applyPreferences(excludeCancelled(found, cancelled), {
      rankBy: 'price',
      maxStops: input.maxStops,
      airlines: input.airlines,
    });
    if (valid.length === 0) {
      return {
        options: [],
        message:
          found.length > 0
            ? 'Flights came back but none satisfy the trip rules and the preferences given.'
            : 'No flights came back for the allowed dates.',
        ...(failures.length > 0 ? { searchFailures: failures } : {}),
      };
    }

    // The cheapest couple of itineraries for each distinct stay, re-priced live —
    // the same discipline as search_flights: only a price that will book is shown.
    const provider = travelProvider();
    const candidates = cheapestPerStay(
      distinctItineraries(valid, Number.POSITIVE_INFINITY),
      FLIGHTS_PER_STAY,
    );
    const repriced = await Promise.allSettled(candidates.map((o) => provider.priceFlightOffer(o)));
    const live: FlightOffer[] = [];
    for (const [i, r] of repriced.entries()) {
      if (r.status === 'fulfilled') live.push(r.value);
      else log.info({ offerId: candidates[i].id, reason: String(r.reason) }, 'dropped at re-price');
    }
    if (live.length === 0) {
      return {
        options: [],
        message: 'Every candidate fare had changed or expired when re-priced live. Try again.',
      };
    }

    // One room search per distinct stay, all at once.
    const stays = distinctStays(live);
    const roomSearches = await Promise.all(
      stays.map((stay) =>
        provider
          .searchHotelRates({
            propertyId: rules.hotel.providerPropertyId,
            checkIn: stay.checkIn,
            checkOut: stay.checkOut,
            adults: rules.adults,
            currency: rules.currency,
          })
          .catch(noRoomsIsAnAnswer)
          .then(
            (rates) => [stayKey(stay), pickRooms(rates, rules.adults, 1).rooms[0] ?? null] as const,
          ),
      ),
    );
    const roomByStay = new Map<string, HotelRate | null>(roomSearches);

    const ranked = rankTripTotals(live, roomByStay).slice(0, MAX_SHOWN);
    const tradeoff = describeTradeoff(ranked);

    // Persist what is shown so both halves are bookable by id.
    const flightRows = await persistFlightOffers(
      ctx.conversationId,
      ranked.map((t) => t.offer),
    );
    const rooms = [
      ...new Map(ranked.flatMap((t) => (t.room ? [[t.room.id, t.room]] : []))).values(),
    ];
    const roomRows = await insertRateOffers(ctx.conversationId, rooms, { extraNight: false });
    const rateIdFor = new Map(roomRows.map((row) => [row.provider_offer_id, row.id]));

    const bookedFlight = await repo.getLiveBooking(ctx.conversationId, 'flight');
    const expiresAt = flightRows[0]?.expires_at ?? null;

    return {
      rankedBy: 'flight + cheapest room for the nights the flight implies',
      hotel: rules.hotel.name,
      travellers: rules.adults,
      options: ranked.map((t, i) => {
        // The same fact search_hotel_rates would report, so a patient booking
        // straight from the comparison still hears that they land before the room
        // is ready — this path never runs that search.
        const earlyArrival = earlyArrivalFor(
          t.offer.slices[0].segments.at(-1)?.arriveLocal,
          t.stay.checkIn,
          t.room?.policies?.checkInTime ?? rules.hotel.checkInTime,
          rules.destinationTz,
        );
        return {
          rank: i + 1,
          offerId: flightRows[i].id,
          rateId: t.room ? (rateIdFor.get(t.room.id) ?? null) : null,
          flightUSD: t.flightUSD,
          hotelUSD: t.hotelUSD,
          totalUSD: t.totalUSD,
          nights: t.stay.nights,
          checkIn: t.stay.checkIn,
          checkOut: t.stay.checkOut,
          room: t.room ? { name: t.room.roomName, refundable: t.room.refundable } : null,
          ...(t.totalUSD === null
            ? { note: 'The hotel had no room for these nights, so this option has no total.' }
            : {}),
          ...(earlyArrival
            ? {
                earlyArrival,
                earlyArrivalNote: `Lands ${earlyArrival.hoursEarly} hours before check-in (${earlyArrival.checkInFrom}). Say so when presenting it; if they want the room on landing, search_hotel_rates prices the night before.`,
              }
            : {}),
          flight: summarizeFlightOffer(t.offer),
        };
      }),
      tradeoff: tradeoff.summary,
      cheapestFlightIsCheapestTrip: tradeoff.sameOption,
      extraCostOfCheapestFlightUSD: tradeoff.savingsUSD,
      staysCompared: stays.length,
      flightsConsidered: valid.length,
      pricesAreLive: true,
      offersExpireAt: expiresAt,
      offerValidMinutes: expiresAt
        ? Math.max(0, Math.round(DateTime.fromISO(expiresAt).diffNow('minutes').minutes))
        : null,
      ...(bookedFlight
        ? {
            alreadyBooked: bookedFlight.booking_reference,
            note: `A flight is already booked (${bookedFlight.booking_reference}). Switching to one of these is rebook_flight, and the room follows with rebook_hotel.`,
          }
        : {
            nextStep:
              'When the patient picks one: create_flight_order with its offerId, then create_hotel_booking with its rateId (or search_hotel_rates for other rooms on those nights).',
          }),
      ...(failures.length > 0 ? { searchFailures: failures } : {}),
    };
  },
});
