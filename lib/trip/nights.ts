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
