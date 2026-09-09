import { describe, expect, it } from 'vitest';
import { checkFlightFit, deriveRules, isLocalDateTime } from '@/lib/trip/derive';
import { TRIP_RULES } from '@/lib/trip/rules';
import type { FlightSlice } from '@/lib/providers/types';

/**
 * Every date on the trip follows from the procedure. Level 0 wrote them by hand, so
 * the first thing to prove is that the derivation reproduces them exactly — then a
 * moved procedure is just the same function on a different input.
 */
describe('deriveRules', () => {
  it('reproduces the Level 0 contract for 13 October, field for field', () => {
    expect(deriveRules(TRIP_RULES, '2026-10-13T08:00')).toEqual(TRIP_RULES);
  });

  it('moves every dependent date together when the procedure moves', () => {
    const moved = deriveRules(TRIP_RULES, '2026-10-20T08:00');
    expect(moved).toMatchObject({
      procedureAtLocal: '2026-10-20T08:00',
      mustArriveByLocal: '2026-10-19T20:00',
      earliestReturnDepartureLocal: '2026-10-24T12:00',
      outboundDepartureDates: ['2026-10-18', '2026-10-17'],
      returnDepartureDates: ['2026-10-24', '2026-10-25'],
    });
  });

  it('keeps everything that does not depend on the date', () => {
    const base = { ...TRIP_RULES, adults: 2, travellersConfirmed: true };
    const moved = deriveRules(base, '2026-11-02T14:30');
    expect(moved.adults).toBe(2);
    expect(moved.travellersConfirmed).toBe(true);
    expect(moved.hotel).toEqual(TRIP_RULES.hotel);
    expect(moved.cabin).toBe(TRIP_RULES.cabin);
    expect(moved.origin).toBe('JFK');
    // The time of day is kept, the offsets still count in whole days.
    expect(moved.procedureAtLocal).toBe('2026-11-02T14:30');
    expect(moved.mustArriveByLocal).toBe('2026-11-01T20:00');
  });

  it('crosses month and year boundaries by the calendar', () => {
    const moved = deriveRules(TRIP_RULES, '2027-01-01T09:00');
    expect(moved.mustArriveByLocal).toBe('2026-12-31T20:00');
    expect(moved.outboundDepartureDates).toEqual(['2026-12-30', '2026-12-29']);
    expect(moved.earliestReturnDepartureLocal).toBe('2027-01-05T12:00');
  });

  it('refuses anything that is not a local date-time', () => {
    for (const bad of ['2026-10-20', '20 October', '2026-10-20T08:00:00Z', '2026-13-01T08:00']) {
      expect(isLocalDateTime(bad)).toBe(false);
      expect(() => deriveRules(TRIP_RULES, bad)).toThrow(/local YYYY-MM-DDTHH:mm/);
    }
  });
});

describe('checkFlightFit', () => {
  const seg = (from: string, to: string, departLocal: string, arriveLocal: string) => ({
    carrier: 'TK',
    flightNumber: '1',
    from: { iata: from, tz: from === 'JFK' ? 'America/New_York' : 'Europe/Istanbul' },
    to: { iata: to, tz: to === 'JFK' ? 'America/New_York' : 'Europe/Istanbul' },
    departLocal,
    arriveLocal,
    cabin: 'economy' as const,
    durationMin: 600,
  });
  const booked: FlightSlice[] = [
    {
      segments: [seg('JFK', 'IST', '2026-10-11T12:50', '2026-10-12T05:30')],
      durationMin: 600,
      stops: 0,
    },
    {
      segments: [seg('IST', 'JFK', '2026-10-17T14:00', '2026-10-17T18:00')],
      durationMin: 600,
      stops: 0,
    },
  ];

  it('says a booking still fits the rules it was booked under', () => {
    expect(checkFlightFit(booked, TRIP_RULES).fits).toBe(true);
  });

  it('names which leg stops fitting when the procedure moves later', () => {
    const fit = checkFlightFit(booked, deriveRules(TRIP_RULES, '2026-10-20T08:00'));
    expect(fit.fits).toBe(false);
    // Landing on the 12th is early for the 19th, which is allowed; leaving on the
    // 17th is before the 24th, which is not.
    expect(fit.outbound.ok).toBe(true);
    expect(fit.return).toMatchObject({ ok: false, code: 'RETURNS_TOO_EARLY' });
  });

  it('names the outbound when the procedure moves earlier', () => {
    const fit = checkFlightFit(booked, deriveRules(TRIP_RULES, '2026-10-12T08:00'));
    expect(fit.outbound).toMatchObject({ ok: false, code: 'ARRIVES_TOO_LATE' });
  });

  it('does not pretend an itinerary with no slices fits', () => {
    const fit = checkFlightFit([], TRIP_RULES);
    expect(fit.fits).toBe(false);
    expect(fit.outbound).toMatchObject({ code: 'MISSING_SLICE' });
  });
});
