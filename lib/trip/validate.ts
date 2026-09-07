import { DateTime } from 'luxon';
import type { FlightOffer, FlightSlice } from '@/lib/providers/types';
import type { TripRules } from './rules';

/**
 * Pure itinerary validation against the trip rules.
 *
 * Called twice: to filter search results before the model sees them, and again
 * immediately before an order is created. Never trust the model to do this.
 */
export type ValidationResult = { ok: true } | { ok: false; reason: string; code: ValidationCode };

export type ValidationCode =
  | 'ARRIVES_TOO_LATE'
  | 'RETURNS_TOO_EARLY'
  | 'WRONG_ORIGIN'
  | 'WRONG_DESTINATION'
  | 'WRONG_CABIN'
  | 'WRONG_CURRENCY'
  | 'MISSING_SLICE';

export function local(iso: string, tz: string): DateTime {
  const dt = DateTime.fromISO(iso, { zone: tz });
  if (!dt.isValid)
    throw new Error(`Invalid local datetime "${iso}" in zone ${tz}: ${dt.invalidReason}`);
  return dt;
}

function lastSegment(slice: FlightSlice) {
  return slice.segments[slice.segments.length - 1];
}

export function validateOutbound(slice: FlightSlice, rules: TripRules): ValidationResult {
  const first = slice.segments[0];
  const last = lastSegment(slice);
  if (!first || !last)
    return { ok: false, code: 'MISSING_SLICE', reason: 'Outbound has no segments' };
  if (first.from.iata !== rules.origin)
    return {
      ok: false,
      code: 'WRONG_ORIGIN',
      reason: `Outbound departs ${first.from.iata}, expected ${rules.origin}`,
    };
  if (last.to.iata !== rules.destination)
    return {
      ok: false,
      code: 'WRONG_DESTINATION',
      reason: `Outbound arrives ${last.to.iata}, expected ${rules.destination}`,
    };

  const arrival = local(last.arriveLocal, last.to.tz);
  const deadline = local(rules.mustArriveByLocal, rules.destinationTz);
  if (arrival > deadline) {
    return {
      ok: false,
      code: 'ARRIVES_TOO_LATE',
      reason: `Lands ${arrival.toFormat('ccc d LLL h:mm a')} local, after the ${deadline.toFormat('ccc d LLL h:mm a')} cutoff`,
    };
  }
  return { ok: true };
}

export function validateReturn(slice: FlightSlice, rules: TripRules): ValidationResult {
  const first = slice.segments[0];
  const last = lastSegment(slice);
  if (!first || !last)
    return { ok: false, code: 'MISSING_SLICE', reason: 'Return has no segments' };
  if (first.from.iata !== rules.destination)
    return {
      ok: false,
      code: 'WRONG_ORIGIN',
      reason: `Return departs ${first.from.iata}, expected ${rules.destination}`,
    };
  if (last.to.iata !== rules.origin)
    return {
      ok: false,
      code: 'WRONG_DESTINATION',
      reason: `Return arrives ${last.to.iata}, expected ${rules.origin}`,
    };

  const departure = local(first.departLocal, first.from.tz);
  const earliest = local(rules.earliestReturnDepartureLocal, rules.destinationTz);
  if (departure < earliest) {
    return {
      ok: false,
      code: 'RETURNS_TOO_EARLY',
      reason: `Departs ${departure.toFormat('ccc d LLL h:mm a')} local, before the earliest allowed ${earliest.toFormat('ccc d LLL h:mm a')}`,
    };
  }
  return { ok: true };
}

/** Validates a full offer: cabin, currency, and each slice against its rule. */
export function validateOffer(offer: FlightOffer, rules: TripRules): ValidationResult {
  if (offer.price.currency !== rules.currency)
    return {
      ok: false,
      code: 'WRONG_CURRENCY',
      reason: `Priced in ${offer.price.currency}, expected ${rules.currency}`,
    };
  for (const slice of offer.slices) {
    for (const seg of slice.segments) {
      if (seg.cabin !== rules.cabin)
        return {
          ok: false,
          code: 'WRONG_CABIN',
          reason: `${seg.carrier}${seg.flightNumber} is ${seg.cabin}, expected ${rules.cabin}`,
        };
    }
  }
  const [outbound, ret] = offer.slices;
  if (!outbound) return { ok: false, code: 'MISSING_SLICE', reason: 'Offer has no outbound slice' };
  const o = validateOutbound(outbound, rules);
  if (!o.ok) return o;
  if (ret) {
    const r = validateReturn(ret, rules);
    if (!r.ok) return r;
  }
  return { ok: true };
}

/** Splits a list of offers into those that satisfy the rules and those that don't (with reasons). */
export function partitionOffers(offers: FlightOffer[], rules: TripRules) {
  const valid: FlightOffer[] = [];
  const rejected: { offer: FlightOffer; reason: string; code: ValidationCode }[] = [];
  for (const offer of offers) {
    const v = validateOffer(offer, rules);
    if (v.ok) valid.push(offer);
    else rejected.push({ offer, reason: v.reason, code: v.code });
  }
  return { valid, rejected };
}
