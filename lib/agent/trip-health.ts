import * as repo from '@/lib/db/repo';
import type { Json, TripEventRow } from '@/lib/db/types';
import { log } from '@/lib/log';
import { retrieveBooking } from '@/lib/providers/sabre';
import type { FlightSlice } from '@/lib/providers/types';
import { detectDisruption, reconcileSlices, type OrderFlight } from '@/lib/trip/disruption';

/**
 * Reads the live orders back from the provider and records anything that has
 * changed since booking.
 *
 * This is how the app learns about a disruption it was never told about. There is
 * no cancellation feed in the Sabre sandbox, so the honest mechanism is to re-read
 * the order: the per-segment status is authoritative, and comparing it with what we
 * stored at booking time is what turns "HX" into "your Frankfurt leg was cancelled".
 *
 * Called from the smoke script for a demo, and cheap enough to call before a turn
 * once a trip is booked.
 */
export interface HealthCheck {
  reference: string | null;
  healthy: boolean;
  eventsRecorded: number;
  findings: unknown[];
  note?: string;
}

/** The itinerary the booking row stores as sold, if it has one. */
function storedBaseline(booking: { raw: unknown }): FlightSlice[] {
  const raw = (booking.raw ?? {}) as { bookedSlices?: FlightSlice[] };
  return raw.bookedSlices ?? [];
}

export async function checkFlightHealth(conversationId: string): Promise<HealthCheck> {
  const booking = await repo.getLiveBooking(conversationId, 'flight');
  if (!booking)
    return {
      reference: null,
      healthy: true,
      eventsRecorded: 0,
      findings: [],
      note: 'No flight booked.',
    };

  const order = (await retrieveBooking(booking.booking_reference)).raw as {
    flights?: OrderFlight[];
  };
  const current = order.flights ?? [];

  // Trips booked before the row kept a baseline have only the offer, whose times
  // come from Flight Shop's cache and can be minutes off what the order holds. That
  // gap is not a disruption, so comparing against it would report one on every
  // check. Instead the order itself becomes the baseline, once: structure from the
  // offer, times from Sabre. Statuses are still read from the live order, so a
  // segment already cancelled is caught on this same pass rather than baked in.
  let booked = storedBaseline(booking);
  let baselineEstablished = false;
  if (booked.length === 0 && booking.offer_id) {
    const offer = await repo.getOffer(conversationId, booking.offer_id);
    const sold = ((offer?.raw ?? {}) as { slices?: FlightSlice[] }).slices ?? [];
    if (sold.length > 0) {
      booked = reconcileSlices(sold, current);
      await repo.setBookedItinerary(booking.id, booked as unknown as Json);
      baselineEstablished = true;
    }
  }

  const report = detectDisruption(booked, current);
  const note =
    booked.length === 0
      ? 'This booking has no itinerary to compare against and no offer to rebuild one from, so only per-segment statuses were checked; a schedule change that kept status HK would not be seen.'
      : baselineEstablished
        ? 'No baseline was stored for this booking, so the live order was recorded as one. Statuses were still checked; time comparisons start from the next check.'
        : undefined;
  if (report.healthy) {
    log.info(
      { conversationId, reference: booking.booking_reference },
      'flight order still held as booked',
    );
    return {
      reference: booking.booking_reference,
      healthy: true,
      eventsRecorded: 0,
      findings: [],
      ...(note ? { note } : {}),
    };
  }

  // One event per kind, carrying every affected segment, so the agent raises it once
  // rather than reciting four separate alerts for one cancellation.
  const byKind = new Map<string, typeof report.findings>();
  for (const finding of report.findings) {
    byKind.set(finding.kind, [...(byKind.get(finding.kind) ?? []), finding]);
  }

  const events = [...byKind.entries()].map(([kind, findings]) => ({
    bookingId: booking.id,
    kind: kind as 'flight_cancelled' | 'flight_schedule_change',
    detail: {
      reference: booking.booking_reference,
      legs: report.legs,
      segments: findings,
    } as unknown as Json,
    source: 'provider' as const,
  }));

  const recorded = await repo.insertTripEvents(conversationId, events);
  log.warn(
    { conversationId, reference: booking.booking_reference, findings: report.findings.length },
    'flight order changed since booking',
  );

  return {
    reference: booking.booking_reference,
    healthy: false,
    eventsRecorded: recorded.length,
    findings: report.findings,
    ...(note ? { note } : {}),
  };
}

/** Records a disruption without waiting for one, so the flow can be demonstrated. */
export async function simulateFlightDisruption(
  conversationId: string,
  leg: 'outbound' | 'return',
  kind: 'flight_cancelled' | 'flight_schedule_change',
): Promise<TripEventRow[]> {
  const booking = await repo.getLiveBooking(conversationId, 'flight');
  if (!booking) throw new Error('No flight is booked on this trip');

  // Same shape a real detection writes, down to the per-segment naming, so the
  // agent cannot behave differently for a simulated one. Times come from the stored
  // baseline — the order — not from the shopped summary in `details`, which is what
  // put times in a patient's ear that the airline never held.
  const baseline = storedBaseline(booking);
  const slice = baseline[leg === 'outbound' ? 0 : 1];

  type LegDetail = { carrier?: string; departLocal?: string; arriveLocal?: string };
  const details = (booking.details ?? {}) as { outbound?: LegDetail; inbound?: LegDetail };
  const summary = leg === 'outbound' ? details.outbound : details.inbound;

  const segments = slice
    ? slice.segments.map((s) => ({
        segment: `${s.carrier}${s.flightNumber} ${s.from.iata}→${s.to.iata}`,
        status: kind === 'flight_cancelled' ? 'HX' : 'SC',
        statusName: kind === 'flight_cancelled' ? 'Cancelled by carrier' : 'Schedule change',
        kind,
        carrier: s.carrier,
        flightNumber: s.flightNumber,
        date: s.departLocal.slice(0, 10),
        was: { departLocal: s.departLocal, arriveLocal: s.arriveLocal },
      }))
    : [
        {
          // No baseline yet: name the leg rather than invent a segment.
          segment: `${summary?.carrier ?? 'the'} ${leg} flight`,
          status: kind === 'flight_cancelled' ? 'HX' : 'SC',
          statusName: kind === 'flight_cancelled' ? 'Cancelled by carrier' : 'Schedule change',
          kind,
          ...(summary?.departLocal
            ? {
                was: {
                  departLocal: summary.departLocal,
                  arriveLocal: summary.arriveLocal ?? '',
                },
              }
            : {}),
        },
      ];

  return repo.insertTripEvents(conversationId, [
    {
      bookingId: booking.id,
      kind,
      detail: {
        reference: booking.booking_reference,
        legs: [leg],
        segments,
      } as unknown as Json,
      source: 'simulated',
    },
  ]);
}

/**
 * A hotel dropping a reservation. Same shape and same reason as the flight version:
 * CERT cannot originate it, so the operator console writes what a real notice would.
 * The room the patient holds is named from the booking, never invented.
 */
export async function simulateHotelCancellation(conversationId: string): Promise<TripEventRow[]> {
  const booking = await repo.getLiveBooking(conversationId, 'hotel');
  if (!booking) throw new Error('No room is booked on this trip');

  const details = (booking.details ?? {}) as {
    hotel?: string;
    room?: string;
    checkIn?: string;
    checkOut?: string;
    nights?: number;
  };

  return repo.insertTripEvents(conversationId, [
    {
      bookingId: booking.id,
      kind: 'hotel_cancelled',
      detail: {
        reference: booking.booking_reference,
        hotel: details.hotel ?? null,
        room: details.room ?? null,
        was: {
          checkIn: details.checkIn ?? null,
          checkOut: details.checkOut ?? null,
          nights: details.nights ?? null,
        },
        statusName: 'Cancelled by the hotel',
      } as unknown as Json,
      source: 'simulated',
    },
  ]);
}
