import { DateTime } from 'luxon';
import * as repo from '@/lib/db/repo';
import type { Json, TripEventRow, TripEventSource } from '@/lib/db/types';
import { log } from '@/lib/log';
import type { FlightSlice } from '@/lib/providers/types';
import { checkFlightFit, deriveRules, isLocalDateTime } from '@/lib/trip/derive';
import type { TripRules } from '@/lib/trip/rules';

/**
 * The clinic moved the procedure.
 *
 * One change, two doors: the patient can report it in the chat, or the clinic can
 * (through the operator console, since the sandbox has no clinic). Both go through
 * here so the trip ends up in the same state either way — new rules derived from
 * the new date, and a plain account of which bookings no longer fit them. Nothing
 * is rebooked: that is the agent's sequence with the patient, one confirmed step at
 * a time. What differs is only whether the patient already knows. When they told
 * us, no event is written; when the clinic did, a `procedure_moved` event is, and
 * the agent raises it before anything else.
 */
export interface ProcedureMove {
  was: string;
  now: string;
  rules: TripRules;
  flight: {
    reference: string;
    fits: boolean;
    outbound: string;
    return: string;
  } | null;
  hotel: {
    reference: string;
    checkIn: string | null;
    checkOut: string | null;
  } | null;
  /** What has to happen next, in the order it has to happen. */
  nextStep: string;
}

export class ProcedureDateError extends Error {
  constructor(
    public readonly code: 'INVALID_DATE' | 'IN_THE_PAST' | 'UNCHANGED',
    message: string,
  ) {
    super(message);
  }
}

export async function moveProcedure(
  conversationId: string,
  procedureAtLocal: string,
  source: 'patient' | Exclude<TripEventSource, 'provider'>,
  now = DateTime.now(),
): Promise<{ move: ProcedureMove; event: TripEventRow | null }> {
  const conversation = await repo.getConversation(conversationId);
  if (!conversation) throw new Error(`Conversation ${conversationId} not found`);
  const rules = conversation.trip_rules as unknown as TripRules;

  if (!isLocalDateTime(procedureAtLocal)) {
    throw new ProcedureDateError(
      'INVALID_DATE',
      `The procedure time must be a local date and time like 2026-10-20T08:00, not "${procedureAtLocal}".`,
    );
  }
  const derived = deriveRules(rules, procedureAtLocal);
  if (derived.procedureAtLocal === rules.procedureAtLocal) {
    throw new ProcedureDateError(
      'UNCHANGED',
      `The procedure is already set for ${rules.procedureAtLocal}; nothing to move.`,
    );
  }
  // The outbound is shopped up to three days before the procedure; a date closer
  // than that has no flights to find, so refuse it plainly rather than search into
  // the past.
  const earliestUsable = now.setZone(rules.destinationTz).plus({ days: 4 }).startOf('day');
  if (DateTime.fromISO(derived.procedureAtLocal, { zone: rules.destinationTz }) < earliestUsable) {
    throw new ProcedureDateError(
      'IN_THE_PAST',
      `A procedure on ${derived.procedureAtLocal} leaves no travel dates to shop — the outbound is searched up to three days before it. It has to be at least ${earliestUsable.toISODate()}.`,
    );
  }

  await repo.updateTripRules(conversationId, derived as unknown as Json);

  const [flight, hotel] = await Promise.all([
    repo.getLiveBooking(conversationId, 'flight'),
    repo.getLiveBooking(conversationId, 'hotel'),
  ]);

  let flightReport: ProcedureMove['flight'] = null;
  if (flight) {
    // The itinerary the order holds; for a booking older than the baseline, the
    // offer it was sold from. Judging an empty itinerary would report a booking as
    // broken for lack of data, which is not what a moved date did to it.
    let slices = ((flight.raw ?? {}) as { bookedSlices?: FlightSlice[] }).bookedSlices ?? [];
    if (slices.length === 0 && flight.offer_id) {
      const offer = await repo.getOffer(conversationId, flight.offer_id);
      slices = ((offer?.raw ?? {}) as { slices?: FlightSlice[] }).slices ?? [];
    }
    const fit = checkFlightFit(slices, derived);
    flightReport = {
      reference: flight.booking_reference,
      fits: fit.fits,
      outbound: fit.outbound.ok ? 'still fits' : fit.outbound.reason,
      return: fit.return.ok ? 'still fits' : fit.return.reason,
    };
  }

  const hotelDetails = (hotel?.details ?? {}) as { checkIn?: string; checkOut?: string };
  const hotelReport: ProcedureMove['hotel'] = hotel
    ? {
        reference: hotel.booking_reference,
        checkIn: hotelDetails.checkIn ?? null,
        checkOut: hotelDetails.checkOut ?? null,
      }
    : null;

  const nextStep = !flight
    ? 'Nothing is booked against the old date. Carry on: search_flights already uses the new dates.'
    : flightReport?.fits
      ? hotel
        ? 'The flights still satisfy the new dates, and the room follows the flights, so nothing has to move. Tell the patient so.'
        : 'The flights still satisfy the new dates. Book the room for the nights they imply.'
      : `The flights no longer fit. Search flights (the new dates are already in force), agree on one with the patient, call rebook_flight, then rebook_hotel for the nights it reports${hotel ? '' : ' — or create_hotel_booking, since no room is held yet'}.`;

  const move: ProcedureMove = {
    was: rules.procedureAtLocal,
    now: derived.procedureAtLocal,
    rules: derived,
    flight: flightReport,
    hotel: hotelReport,
    nextStep,
  };

  log.info(
    {
      conversationId,
      was: move.was,
      now: move.now,
      source,
      flightFits: flightReport?.fits ?? null,
    },
    'procedure moved',
  );

  if (source === 'patient') return { move, event: null };

  const [event] = await repo.insertTripEvents(conversationId, [
    {
      bookingId: flight?.id ?? null,
      kind: 'procedure_moved',
      detail: {
        was: move.was,
        now: move.now,
        mustArriveBy: derived.mustArriveByLocal,
        earliestReturn: derived.earliestReturnDepartureLocal,
        flight: flightReport,
        hotel: hotelReport,
        statusName: 'Procedure rescheduled by the clinic',
      } as unknown as Json,
      source,
    },
  ]);
  return { move, event: event ?? null };
}
