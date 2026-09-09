import { DateTime } from 'luxon';
import type { FlightSlice } from '@/lib/providers/types';

/**
 * Derives the hotel stay from the flights actually booked:
 *   check-in  = local arrival date of the outbound's last segment
 *   check-out = local departure date of the return's first segment
 *
 * Never assumed from the rules — a flight landing a day early means an extra
 * night. Only the date part is used, and provider times are already local wall
 * clock at the airport, so no timezone conversion is involved.
 */
export interface Stay {
  checkIn: string; // YYYY-MM-DD (destination local)
  checkOut: string; // YYYY-MM-DD (destination local)
  nights: number;
}

function localDate(localIso: string): string {
  const date = localIso.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Cannot read a date from "${localIso}"`);
  return date;
}

export function deriveStay(outbound: FlightSlice, ret: FlightSlice): Stay {
  const last = outbound.segments[outbound.segments.length - 1];
  const first = ret.segments[0];
  if (!last || !first) throw new Error('Cannot derive stay from empty slices');

  const checkIn = localDate(last.arriveLocal);
  const checkOut = localDate(first.departLocal);
  const nights = nightsBetween(checkIn, checkOut);
  if (nights < 1)
    throw new Error(`Stay would have ${nights} nights (arrive ${checkIn}, depart ${checkOut})`);

  return { checkIn, checkOut, nights };
}

export function nightsBetween(checkIn: string, checkOut: string): number {
  const from = DateTime.fromISO(checkIn, { zone: 'utc' });
  const to = DateTime.fromISO(checkOut, { zone: 'utc' });
  if (!from.isValid || !to.isValid) throw new Error(`Invalid stay dates ${checkIn} → ${checkOut}`);
  return Math.round(to.diff(from, 'days').days);
}

/**
 * How a room's nights relate to the nights the flights imply.
 *
 * `matches` is the default case. `covers` means the room starts earlier or ends
 * later than the flights need — a night booked on purpose so the room is ready
 * when an early flight lands, or a spare one left behind by a flight change. Only
 * `gap` is a broken trip: the patient lands before the room starts, or leaves
 * after it ends.
 */
export interface StayCoverage {
  coverage: 'matches' | 'covers' | 'gap';
  /** Nights the room holds before the flight lands / after it leaves (0 when none). */
  nightsBefore: number;
  nightsAfter: number;
}

export function compareStay(
  room: { checkIn: string; checkOut: string },
  flights: { checkIn: string; checkOut: string },
): StayCoverage {
  const nightsBefore = nightsBetween(room.checkIn, flights.checkIn);
  const nightsAfter = nightsBetween(flights.checkOut, room.checkOut);
  if (nightsBefore === 0 && nightsAfter === 0)
    return { coverage: 'matches', nightsBefore, nightsAfter };
  if (nightsBefore < 0 || nightsAfter < 0) {
    return {
      coverage: 'gap',
      nightsBefore: Math.max(0, nightsBefore),
      nightsAfter: Math.max(0, nightsAfter),
    };
  }
  return { coverage: 'covers', nightsBefore, nightsAfter };
}

/** Landing this many hours or more before check-in time is worth a word — and a price. */
export const EARLY_ARRIVAL_HOURS = 2;

export interface EarlyArrival {
  arriveLocal: string;
  checkInFrom: string;
  hoursEarly: number;
}

/**
 * Whether a flight lands well before the room is ready. Null when it does not, or
 * when the hotel has not said when check-in is — no arithmetic on a guess.
 */
export function earlyArrivalFor(
  arriveLocal: string | undefined,
  checkIn: string,
  checkInFrom: string | null | undefined,
  zone: string,
): EarlyArrival | null {
  if (!arriveLocal || !checkInFrom) return null;
  const arrival = DateTime.fromISO(arriveLocal, { zone });
  const ready = DateTime.fromISO(`${checkIn}T${checkInFrom}`, { zone });
  if (!arrival.isValid || !ready.isValid) return null;
  const hoursEarly = ready.diff(arrival, 'hours').hours;
  if (hoursEarly < EARLY_ARRIVAL_HOURS) return null;
  return { arriveLocal, checkInFrom, hoursEarly: Math.round(hoursEarly * 10) / 10 };
}
