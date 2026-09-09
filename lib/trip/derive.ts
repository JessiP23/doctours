import { DateTime } from 'luxon';
import type { FlightSlice } from '@/lib/providers/types';
import type { TripRules } from './rules';
import { validateOutbound, validateReturn, type ValidationResult } from './validate';

/**
 * Every date in the trip contract follows from one fact: when the procedure is.
 *
 * Level 0 wrote the derived values out by hand — arrive by the evening before,
 * leave no earlier than four days after — because the date never moved. When a
 * clinic reschedules, all of them move together, and the honest way to do that is
 * to keep the derivation in one place and recompute, not to edit five fields and
 * hope they still agree. The offsets are the brief's; `TRIP_RULES` is what this
 * produces for 13 October, and a test holds the two identical so Level 0 cannot
 * drift.
 */
export const PROCEDURE_OFFSETS = {
  /** On the ground the evening before, by this local time. */
  arriveDaysBefore: 1,
  arriveByTime: '20:00',
  /** Recovery: no departure before this many days after, from this local time. */
  returnDaysAfter: 4,
  returnFromTime: '12:00',
  /** Which departure dates to shop, relative to the procedure day. Overnight eastbound
   * flights land the day after they leave, so the outbound shops two and three days
   * before; the return shops the first two allowed days. */
  outboundShopDaysBefore: [2, 3],
  returnShopDaysAfter: [4, 5],
} as const;

const LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/** Wall-clock local time, no offset — the shape every other rule field uses. */
function wall(dt: DateTime): string {
  return dt.toFormat("yyyy-LL-dd'T'HH:mm");
}

export function isLocalDateTime(value: string): boolean {
  return LOCAL.test(value) && DateTime.fromISO(value).isValid;
}

/**
 * The trip rules for a procedure at `procedureAtLocal` (destination local),
 * keeping everything that does not depend on the date — route, cabin, party,
 * hotel — exactly as it is on `base`.
 */
export function deriveRules(base: TripRules, procedureAtLocal: string): TripRules {
  if (!isLocalDateTime(procedureAtLocal)) {
    throw new Error(`Procedure time must be local YYYY-MM-DDTHH:mm, got "${procedureAtLocal}"`);
  }
  const procedure = DateTime.fromISO(procedureAtLocal, { zone: base.destinationTz });
  const day = procedure.startOf('day');
  const o = PROCEDURE_OFFSETS;

  const at = (daysFromProcedure: number, time: string) =>
    wall(DateTime.fromISO(`${day.plus({ days: daysFromProcedure }).toISODate()}T${time}`));

  return {
    ...base,
    procedureAtLocal: wall(procedure),
    mustArriveByLocal: at(-o.arriveDaysBefore, o.arriveByTime),
    earliestReturnDepartureLocal: at(o.returnDaysAfter, o.returnFromTime),
    outboundDepartureDates: o.outboundShopDaysBefore.map(
      (d) => day.minus({ days: d }).toISODate() as string,
    ),
    returnDepartureDates: o.returnShopDaysAfter.map(
      (d) => day.plus({ days: d }).toISODate() as string,
    ),
  };
}

export interface FlightFit {
  outbound: ValidationResult;
  return: ValidationResult;
  /** True when both legs still satisfy the rules. */
  fits: boolean;
}

/**
 * Whether flights already held still satisfy a set of rules — the question a
 * moved procedure asks of the booking. Uses the same validators the search and
 * the booking use, so "no longer fits" here means exactly what a search would
 * have refused.
 */
export function checkFlightFit(slices: FlightSlice[], rules: TripRules): FlightFit {
  const [outbound, ret] = slices;
  const o: ValidationResult = outbound
    ? validateOutbound(outbound, rules)
    : { ok: false, code: 'MISSING_SLICE', reason: 'No outbound on file' };
  const r: ValidationResult = ret
    ? validateReturn(ret, rules)
    : { ok: false, code: 'MISSING_SLICE', reason: 'No return on file' };
  return { outbound: o, return: r, fits: o.ok && r.ok };
}
