import { DateTime } from 'luxon';
import type { FlightSlice } from '@/lib/providers/types';
import { local } from './validate';

/**
 * Derives the hotel stay from the flights actually booked:
 *   check-in  = local arrival date of the outbound's last segment
 *   check-out = local departure date of the return's first segment
 * Never assumed from the rules — a flight landing on the 11th means an extra night.
 */
export interface Stay {
  checkIn: string; // YYYY-MM-DD (destination local)
  checkOut: string; // YYYY-MM-DD (destination local)
  nights: number;
}

export function deriveStay(outbound: FlightSlice, ret: FlightSlice): Stay {
  const last = outbound.segments[outbound.segments.length - 1];
  const first = ret.segments[0];
  if (!last || !first) throw new Error('Cannot derive stay from empty slices');

  const arrival = local(last.arriveLocal, last.to.tz).startOf('day');
  const departure = local(first.departLocal, first.from.tz).startOf('day');
  const nights = Math.round(departure.diff(arrival, 'days').days);
  if (nights < 1)
    throw new Error(
      `Stay would have ${nights} nights (arrive ${arrival.toISODate()}, depart ${departure.toISODate()})`,
    );

  return { checkIn: arrival.toISODate()!, checkOut: departure.toISODate()!, nights };
}

export function nightsBetween(checkIn: string, checkOut: string): number {
  const a = DateTime.fromISO(checkIn);
  const b = DateTime.fromISO(checkOut);
  return Math.round(b.diff(a, 'days').days);
}
