import { z } from 'zod';
import { log } from '@/lib/log';
import * as repo from '@/lib/db/repo';
import type { Json } from '@/lib/db/types';
import type { HotelProperty } from '@/lib/providers/types';
import type { HotelRule } from '@/lib/trip/rules';
import { rulesFor } from './context';
import { defineTool } from './define';

/**
 * The patient picked a different hotel.
 *
 * The hotel is trip state, like the traveller count: `search_hotel_rates` and both
 * room booking tools read it from the rules, so once it changes here they follow
 * without knowing anything happened. The property comes from a `search_hotels`
 * result the provider returned — never from a name — and the check-in time is what
 * the property stated, or null; a hotel that has not said when the room is ready is
 * not given a time it never gave.
 *
 * A room already held at the previous hotel is left alone: moving it is
 * `rebook_hotel` after a room search here, with the patient's agreement.
 */
export const chooseHotelTool = defineTool({
  name: 'choose_hotel',
  description:
    'Make a hotel from search_hotels the hotel for this trip, once the patient has picked it. From then on search_hotel_rates and the room booking tools use it. If a room is already booked at the previous hotel, this does not move it — search rooms here and use rebook_hotel.',
  schema: z.object({
    hotelId: z.string().describe('hotelId from search_hotels'),
    theyToldMe: z
      .literal(true)
      .describe(
        'Only true if the patient has actually said, in this conversation, that they want this hotel. Never a choice you made for them.',
      ),
  }),
  refreshesRules: true,
  handler: async (input, ctx) => {
    const rules = await rulesFor(ctx.conversationId);
    const row = await repo.getOffer(ctx.conversationId, input.hotelId);
    if (!row || row.kind !== 'hotel_property') {
      throw new Error(
        `No hotel with id ${input.hotelId} in this conversation — use search_hotels first`,
      );
    }
    const property = row.raw as unknown as HotelProperty;

    if (property.id === rules.hotel.providerPropertyId) {
      return {
        changed: false,
        hotel: rules.hotel.name,
        message: `${rules.hotel.name} is already this trip's hotel.`,
      };
    }

    const hotel: HotelRule = {
      providerPropertyId: property.id,
      name: property.name,
      city: property.location?.city ?? rules.hotel.city,
      checkInTime: property.policies?.checkInTime ?? null,
      checkOutTime: property.policies?.checkOutTime ?? null,
      isDefault: false,
    };
    await repo.updateTripRules(ctx.conversationId, { ...rules, hotel } as unknown as Json);

    const booked = await repo.getLiveBooking(ctx.conversationId, 'hotel');
    log.info(
      { conversationId: ctx.conversationId, from: rules.hotel.providerPropertyId, to: property.id },
      'hotel chosen',
    );

    return {
      changed: true,
      hotel: hotel.name,
      previousHotel: rules.hotel.name,
      checkInFrom: hotel.checkInTime ?? 'not stated by the hotel',
      leadRateUSD: property.leadRate?.total.amount ?? null,
      ...(booked
        ? {
            roomStillHeldAt: { hotel: rules.hotel.name, reference: booked.booking_reference },
            nextStep: `A room is still booked at ${rules.hotel.name} (${booked.booking_reference}). Search rooms at ${hotel.name}, tell the patient the price and terms, and use rebook_hotel once they agree — it books the new room before releasing the old one.`,
          }
        : { nextStep: `Search rooms at ${hotel.name} with search_hotel_rates and offer them.` }),
    };
  },
});
