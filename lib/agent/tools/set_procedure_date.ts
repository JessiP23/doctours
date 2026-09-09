import { z } from 'zod';
import { moveProcedure, ProcedureDateError } from '@/lib/agent/procedure';
import { defineTool } from './define';

/**
 * The patient tells us the clinic moved their procedure.
 *
 * Every hard date on the trip — when they must land, when they may leave, which
 * days to shop — is derived from the procedure, so this is the one field that
 * moves the whole contract. The derivation is code; the model only supplies the
 * date it was given. It reports which bookings no longer fit, and the rebooking
 * tools do the rest, one confirmed step at a time.
 *
 * The console's "clinic moves the procedure" goes through the same function and
 * additionally records an event, because there the patient has not been told yet.
 */
export const setProcedureDateTool = defineTool({
  name: 'set_procedure_date',
  description:
    'Record a new date and time for the procedure, as the patient reported it from the clinic. Recomputes every trip rule that depends on it (arrival deadline, earliest return, dates to shop) and tells you which existing bookings no longer fit. It does not rebook anything — follow with search_flights, rebook_flight and rebook_hotel.',
  schema: z.object({
    procedureAtLocal: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
      .describe(
        'New procedure date and time, destination local, as YYYY-MM-DDTHH:mm. If the patient gave only a date, keep the current time of day.',
      ),
    theyToldMe: z
      .literal(true)
      .describe(
        'Only true if the patient has actually said, in this conversation, that the procedure was moved and to when. Never a guess and never a date you proposed.',
      ),
  }),
  refreshesRules: true,
  handler: async (input, ctx) => {
    try {
      const { move } = await moveProcedure(ctx.conversationId, input.procedureAtLocal, 'patient');
      return {
        changed: true,
        procedureWas: move.was,
        procedureNow: move.now,
        mustBeOnTheGroundBy: move.rules.mustArriveByLocal,
        earliestReturnDeparture: move.rules.earliestReturnDepartureLocal,
        flight: move.flight,
        hotel: move.hotel,
        nextStep: move.nextStep,
      };
    } catch (e) {
      if (e instanceof ProcedureDateError) {
        return { changed: false, reason: e.code, message: e.message };
      }
      throw e;
    }
  },
});
