import { z } from 'zod';
import { log } from '@/lib/log';
import * as repo from '@/lib/db/repo';
import type { Json } from '@/lib/db/types';
import { rulesFor } from './context';
import { defineTool } from './define';

/**
 * How many people are travelling.
 *
 * This used to be a constant, which meant the app quietly assumed one and never
 * said so: a patient mentioned a friend halfway through and was told a twin room
 * "would work for both of you" when one seat and one guest had been booked. The
 * count now lives on the conversation's trip rules, so every later search, price
 * and booking obeys it, and the agent has to establish it rather than assume it.
 *
 * Changing it after a booking exists is a rebooking, not a setting, so it is
 * refused with the reason rather than silently applied to the next search only.
 */
export const MAX_TRAVELLERS = 4;

export const setPartySizeTool = defineTool({
  name: 'set_party_size',
  description:
    'Record how many people are travelling on this trip, including the patient. Call this as soon as you know, before searching flights, and again if the patient corrects you. Everything after it — flight prices, room occupancy, how many passports you need — follows from this number.',
  schema: z.object({
    travellers: z
      .number()
      .int()
      .min(1)
      .max(MAX_TRAVELLERS)
      .describe('Total people travelling, including the patient'),
  }),
  handler: async (input, ctx) => {
    const rules = await rulesFor(ctx.conversationId);

    if (rules.adults === input.travellers && rules.travellersConfirmed) {
      return {
        travellers: rules.adults,
        changed: false,
        message: `Already set to ${rules.adults}.`,
      };
    }

    // Confirming the default is not a change to the trip, so it needs no booking
    // check — it only records that someone actually asked.
    if (rules.adults === input.travellers) {
      await repo.updateTripRules(ctx.conversationId, {
        ...rules,
        travellersConfirmed: true,
      } as unknown as Json);
      return {
        travellers: rules.adults,
        changed: false,
        confirmed: true,
        message: `Confirmed: ${rules.adults} traveller(s).`,
      };
    }

    const [flight, hotel] = await Promise.all([
      repo.getLiveBooking(ctx.conversationId, 'flight'),
      repo.getLiveBooking(ctx.conversationId, 'hotel'),
    ]);
    const booked = [
      flight ? `flight ${flight.booking_reference}` : null,
      hotel ? `hotel ${hotel.booking_reference}` : null,
    ].filter(Boolean);

    if (booked.length > 0) {
      return {
        travellers: rules.adults,
        changed: false,
        reason: 'ALREADY_BOOKED',
        message: `This trip is already booked for ${rules.adults} (${booked.join(', ')}), so the number cannot just be changed — the existing booking would have to be cancelled and rebooked. Tell the patient that plainly and ask what they want to do.`,
      };
    }

    await repo.updateTripRules(ctx.conversationId, {
      ...rules,
      adults: input.travellers,
      travellersConfirmed: true,
    } as unknown as Json);
    log.info(
      { conversationId: ctx.conversationId, from: rules.adults, to: input.travellers },
      'party size set',
    );

    return {
      travellers: input.travellers,
      changed: true,
      message:
        input.travellers === 1
          ? 'Searching for one traveller. You will need one set of passport details.'
          : `Searching for ${input.travellers} travellers. Prices from here on are the total for all ${input.travellers}, rooms must sleep ${input.travellers}, and you will need passport details for each of them before booking.`,
    };
  },
});
