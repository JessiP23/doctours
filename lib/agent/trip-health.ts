import * as repo from '@/lib/db/repo';
import type { Json, TripEventRow } from '@/lib/db/types';
import { log } from '@/lib/log';
import { retrieveBooking } from '@/lib/providers/sabre';
import type { FlightSlice } from '@/lib/providers/types';
import { detectDisruption, type OrderFlight } from '@/lib/trip/disruption';

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

/**
 * The itinerary to compare the live order against.
 *
 * Preferred source is the booking row, which stores the slices we actually sold.
 * Rows written before that key existed fall back to the offer the booking was made
 * from — same flights, priced a few seconds earlier — so a trip booked last week is
 * still checkable instead of being written off as uncomparable.
 */
async function bookedItinerary(
  conversationId: string,
  booking: { raw: unknown; offer_id: string | null },
): Promise<FlightSlice[]> {
  const raw = (booking.raw ?? {}) as { bookedSlices?: FlightSlice[]; slices?: FlightSlice[] };
  const stored = raw.bookedSlices ?? raw.slices;
  if (stored?.length) return stored;

  if (!booking.offer_id) return [];
  const offer = await repo.getOffer(conversationId, booking.offer_id);
  const fromOffer = (offer?.raw ?? {}) as { slices?: FlightSlice[] };
  return fromOffer.slices ?? [];
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

  const booked = await bookedItinerary(conversationId, booking);

  const order = (await retrieveBooking(booking.booking_reference)).raw as {
    flights?: OrderFlight[];
  };
  const current = order.flights ?? [];

  // Without a baseline the statuses still tell the truth about a cancellation, so
  // the check runs either way and says which comparison it managed. What is lost
  // is a schedule change that moved the times while leaving the status on HK, and
  // a segment that vanished from the order entirely.
  const partial = booked.length === 0;
  const report = detectDisruption(booked, current);
  const note = partial
    ? 'Neither the booking row nor its offer held a comparable itinerary, so only per-segment statuses were checked; a schedule change that kept status HK would not be seen.'
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

  type LegDetail = { carrier?: string; departLocal?: string; arriveLocal?: string };
  const details = (booking.details ?? {}) as { outbound?: LegDetail; inbound?: LegDetail };
  const affected = leg === 'outbound' ? details.outbound : details.inbound;

  return repo.insertTripEvents(conversationId, [
    {
      bookingId: booking.id,
      kind,
      detail: {
        reference: booking.booking_reference,
        legs: [leg],
        segments: [
          {
            segment: `${affected?.carrier ?? 'the'} ${leg} flight`,
            status: kind === 'flight_cancelled' ? 'HX' : 'SC',
            statusName: kind === 'flight_cancelled' ? 'Cancelled by carrier' : 'Schedule change',
            kind,
            ...(affected?.departLocal
              ? {
                  was: {
                    departLocal: affected.departLocal,
                    arriveLocal: affected.arriveLocal ?? '',
                  },
                }
              : {}),
          },
        ],
      } as unknown as Json,
      source: 'simulated',
    },
  ]);
}
