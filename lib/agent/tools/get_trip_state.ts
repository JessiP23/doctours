import { z } from 'zod';
import { DateTime } from 'luxon';
import * as repo from '@/lib/db/repo';
import type { TripRules } from '@/lib/trip/rules';
import { buildTripState, nextStep } from '../state';
import { defineTool } from './define';

/**
 * Read-only orientation tool.
 *
 * The system prompt already carries live state every turn, so the model rarely
 * needs this — but when a conversation resumes after a refresh, or the model is
 * unsure whether something was actually booked, this is the authoritative answer
 * and it comes from the database rather than from the transcript.
 */
export const getTripStateTool = defineTool({
  name: 'get_trip_state',
  description:
    'Look up the authoritative state of this trip from the database: what is booked (with real references), which options the patient has been shown, and what still needs doing. Use when resuming a conversation or when unsure whether something was actually booked.',
  schema: z.object({}),
  handler: async (_input, ctx) => {
    const [conversation, bookings, flightOffers, hotelOffers, hotelProperties] = await Promise.all([
      repo.getConversation(ctx.conversationId),
      repo.listBookingHistory(ctx.conversationId),
      repo.listRecentOffers(ctx.conversationId, 'flight', 6),
      repo.listRecentOffers(ctx.conversationId, 'hotel_rate', 6),
      repo.listRecentOffers(ctx.conversationId, 'hotel_property', 6),
    ]);
    if (!conversation) throw new Error(`Conversation ${ctx.conversationId} not found`);

    const rules = conversation.trip_rules as unknown as TripRules;
    const state = buildTripState(rules, bookings, [
      ...flightOffers,
      ...hotelOffers,
      ...hotelProperties,
    ]);
    const now = DateTime.now();
    const describeOffer = (o: (typeof flightOffers)[number]) => ({
      offerId: o.id,
      summary: o.summary,
      expiresAt: o.expires_at,
      expired: o.expires_at ? DateTime.fromISO(o.expires_at) < now : false,
    });

    return {
      trip: {
        route: `${rules.origin} → ${rules.destination} → ${rules.origin}`,
        procedureAt: `${rules.procedureAtLocal} (${rules.destinationTz})`,
        mustBeOnTheGroundBy: `${rules.mustArriveByLocal} (${rules.destinationTz})`,
        earliestReturnDeparture: `${rules.earliestReturnDepartureLocal} (${rules.destinationTz})`,
        cabin: rules.cabin,
        checkedBags: rules.checkedBags,
        travellers: rules.adults,
        travellersConfirmed: rules.travellersConfirmed ?? false,
        currency: rules.currency,
        hotel: `${rules.hotel.name}${rules.hotel.isDefault === false ? ' (chosen by the patient)' : ' (default)'}`,
      },
      booked: {
        flight: state.bookings.flight
          ? {
              reference: state.bookings.flight.booking_reference,
              details: state.bookings.flight.details,
            }
          : null,
        hotel: state.bookings.hotel
          ? {
              reference: state.bookings.hotel.booking_reference,
              details: state.bookings.hotel.details,
            }
          : null,
      },
      optionsShown: {
        flights: state.offers.flights.map(describeOffer),
        rooms: state.offers.hotelRates.map(describeOffer),
        hotels: state.offers.hotels.map(describeOffer),
      },
      // History, so the agent can answer "what happened to my original flight?"
      // without ever mistaking a dead booking for a live one.
      history: bookings
        .filter((b) => b.status !== 'confirmed')
        .map((b) => ({
          kind: b.kind,
          reference: b.booking_reference,
          status: b.status,
          reason: b.change_reason,
          replacedByReference: b.replaced_by
            ? (bookings.find((x) => x.id === b.replaced_by)?.booking_reference ?? null)
            : null,
        })),
      nextStep: nextStep(state),
    };
  },
});
