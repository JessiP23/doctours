import type { FlightSlice } from '@/lib/providers/types';

/**
 * Reading a disruption out of an order.
 *
 * Sabre reports a per-segment status. `HK` means the seat is held; anything else
 * means the airline has done something to it. A schedule change can also arrive
 * while the status stays `HK` — the times simply move — so both the status and the
 * times are compared against what was booked.
 *
 * Pure on purpose: it takes what we stored and what Sabre says now, and returns
 * findings. Fetching and persisting happen elsewhere.
 */

/** Statuses that mean the seat is still held. */
const HELD = new Set(['HK', 'RR', 'KK']);

/** Statuses that mean the segment is gone. */
const GONE = new Set(['HX', 'UN', 'UC', 'US', 'NO', 'WK']);

/** Statuses that mean it still exists but has moved. */
const MOVED = new Set(['SC', 'TK', 'KL']);

export interface OrderFlight {
  airlineCode?: string;
  flightNumber?: number;
  fromAirportCode?: string;
  toAirportCode?: string;
  departureDate?: string;
  departureTime?: string;
  arrivalDate?: string;
  arrivalTime?: string;
  flightStatusCode?: string;
  flightStatusName?: string;
}

export type DisruptionKind = 'flight_cancelled' | 'flight_schedule_change';

export interface SegmentFinding {
  segment: string;
  status: string;
  statusName?: string;
  kind: DisruptionKind;
  /** Structured identity, so a replacement search can leave this exact flight out. */
  carrier?: string;
  flightNumber?: string;
  date?: string;
  /** Present for a schedule change: what we booked versus what the order says now. */
  was?: { departLocal: string; arriveLocal: string };
  now?: { departLocal: string; arriveLocal: string };
}

export interface DisruptionReport {
  healthy: boolean;
  findings: SegmentFinding[];
  /** Which direction is affected, when it can be told from the booked itinerary. */
  legs: ('outbound' | 'return')[];
}

function local(date: string | undefined, time: string | undefined): string {
  return `${date ?? '????-??-??'}T${(time ?? '??:??').slice(0, 5)}`;
}

function label(f: OrderFlight): string {
  return `${f.airlineCode ?? '??'}${f.flightNumber ?? ''} ${f.fromAirportCode ?? '???'}→${f.toAirportCode ?? '???'}`;
}

function orderKey(f: OrderFlight): string {
  return `${f.airlineCode}${f.flightNumber}|${f.fromAirportCode}|${f.toAirportCode}`;
}

/**
 * Replaces the shopped times on a sold itinerary with the times the order holds.
 *
 * Flight Shop is cache-based, so its schedule can be minutes off what Sabre
 * actually sells: the same QR246 was cached as landing 00:10 and held as landing
 * 00:30. That gap is not a disruption, and comparing a live order against shopped
 * times manufactures one on every check — while quoting shopped times tells the
 * patient an arrival the airline never agreed to.
 *
 * The order is authoritative, so the itinerary keeps its structure (which slice,
 * which segments, in which order) and takes its times from Get Booking. A segment
 * the order does not mention is left exactly as sold, so the caller still sees it
 * is missing rather than having it quietly rewritten.
 */
export function reconcileSlices(sold: FlightSlice[], live: OrderFlight[]): FlightSlice[] {
  const byKey = new Map(live.map((f) => [orderKey(f), f]));
  return sold.map((slice) => ({
    ...slice,
    segments: slice.segments.map((s) => {
      const flight = byKey.get(`${s.carrier}${s.flightNumber}|${s.from.iata}|${s.to.iata}`);
      if (!flight) return s;
      return {
        ...s,
        departLocal: local(flight.departureDate, flight.departureTime),
        arriveLocal: local(flight.arrivalDate, flight.arrivalTime),
      };
    }),
  }));
}

/**
 * Compares the order as Sabre reports it now against the itinerary that was booked.
 *
 * `booked` is the flight slices we stored at booking time; `current` is the flat
 * flight list Get Booking returns. Segments are matched on carrier, number and
 * route, so a re-ordered list still lines up.
 */
export function detectDisruption(booked: FlightSlice[], current: OrderFlight[]): DisruptionReport {
  const findings: SegmentFinding[] = [];
  const legs = new Set<'outbound' | 'return'>();

  const bookedSegments = booked.flatMap((slice, sliceIndex) =>
    slice.segments.map((s) => ({
      key: `${s.carrier}${s.flightNumber}|${s.from.iata}|${s.to.iata}`,
      carrier: s.carrier,
      flightNumber: s.flightNumber,
      leg: (sliceIndex === 0 ? 'outbound' : 'return') as 'outbound' | 'return',
      departLocal: s.departLocal,
      arriveLocal: s.arriveLocal,
      display: `${s.carrier}${s.flightNumber} ${s.from.iata}→${s.to.iata}`,
    })),
  );

  const seen = new Set<string>();

  for (const flight of current) {
    const key = `${flight.airlineCode}${flight.flightNumber}|${flight.fromAirportCode}|${flight.toAirportCode}`;
    const booking = bookedSegments.find((b) => b.key === key);
    if (booking) seen.add(booking.key);

    const status = (flight.flightStatusCode ?? '').toUpperCase();
    const departLocal = local(flight.departureDate, flight.departureTime);
    const arriveLocal = local(flight.arrivalDate, flight.arrivalTime);

    if (GONE.has(status)) {
      findings.push({
        segment: label(flight),
        status,
        statusName: flight.flightStatusName,
        kind: 'flight_cancelled',
        carrier: flight.airlineCode,
        flightNumber: String(flight.flightNumber ?? ''),
        date: flight.departureDate,
      });
      if (booking) legs.add(booking.leg);
      continue;
    }

    const timesMoved =
      booking !== undefined &&
      (booking.departLocal !== departLocal || booking.arriveLocal !== arriveLocal);

    if (MOVED.has(status) || timesMoved) {
      findings.push({
        segment: label(flight),
        status,
        statusName: flight.flightStatusName,
        kind: 'flight_schedule_change',
        ...(booking
          ? { was: { departLocal: booking.departLocal, arriveLocal: booking.arriveLocal } }
          : {}),
        now: { departLocal, arriveLocal },
      });
      if (booking) legs.add(booking.leg);
      continue;
    }

    if (!HELD.has(status) && status !== '') {
      // An unrecognised status is reported rather than assumed to be fine.
      findings.push({
        segment: label(flight),
        status,
        statusName: flight.flightStatusName,
        kind: 'flight_schedule_change',
        now: { departLocal, arriveLocal },
      });
      if (booking) legs.add(booking.leg);
    }
  }

  // A segment that was booked and is no longer in the order at all is cancelled.
  for (const booking of bookedSegments) {
    if (seen.has(booking.key)) continue;
    findings.push({
      segment: booking.display,
      status: 'MISSING',
      kind: 'flight_cancelled',
      carrier: booking.carrier,
      flightNumber: booking.flightNumber,
      date: booking.departLocal.slice(0, 10),
    });
    legs.add(booking.leg);
  }

  return { healthy: findings.length === 0, findings, legs: [...legs] };
}
