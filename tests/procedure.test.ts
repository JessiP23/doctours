import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DateTime } from 'luxon';
import { TRIP_RULES } from '@/lib/trip/rules';

/**
 * Moving the procedure is one function with two doors — the patient reporting it
 * and the clinic doing it from the console. These pin what both share: the rules
 * are recomputed and persisted, the bookings are judged against the new rules
 * rather than re-described, and nothing is rebooked here. What differs is the
 * event: written when the patient has not been told, not when they told us.
 */
const mem = {
  rules: { ...TRIP_RULES } as Record<string, unknown>,
  flight: null as null | Record<string, unknown>,
  hotel: null as null | Record<string, unknown>,
  events: [] as Record<string, unknown>[],
};

vi.mock('@/lib/db/repo', () => ({
  getConversation: vi.fn(async () => ({ id: 'c1', trip_rules: mem.rules })),
  updateTripRules: vi.fn(async (_id: string, rules: Record<string, unknown>) => {
    mem.rules = rules;
  }),
  getLiveBooking: vi.fn(async (_id: string, kind: string) =>
    kind === 'flight' ? mem.flight : mem.hotel,
  ),
  getOffer: vi.fn(async () => ({ raw: { slices: bookedFlight.raw.bookedSlices } })),
  insertTripEvents: vi.fn(async (_id: string, events: Record<string, unknown>[]) => {
    const rows = events.map((e, i) => ({ id: `e${mem.events.length + i + 1}`, ...e }));
    mem.events.push(...rows);
    return rows;
  }),
}));

const { moveProcedure, ProcedureDateError } = await import('@/lib/agent/procedure');

const NOW = DateTime.fromISO('2026-09-09T12:00', { zone: 'Europe/Istanbul' }) as DateTime<true>;

const seg = (from: string, to: string, departLocal: string, arriveLocal: string) => ({
  carrier: 'QR',
  flightNumber: '704',
  from: { iata: from },
  to: { iata: to },
  departLocal,
  arriveLocal,
  cabin: 'economy',
  durationMin: 600,
});
const bookedFlight = {
  id: 'b-flight',
  booking_reference: 'ABC12D',
  raw: {
    bookedSlices: [
      { segments: [seg('JFK', 'IST', '2026-10-11T12:50', '2026-10-12T05:30')], stops: 0 },
      { segments: [seg('IST', 'JFK', '2026-10-17T14:00', '2026-10-17T18:00')], stops: 0 },
    ],
  },
  details: {},
};
const bookedHotel = {
  id: 'b-hotel',
  booking_reference: 'HOTEL9',
  details: { checkIn: '2026-10-12', checkOut: '2026-10-17' },
};

beforeEach(() => {
  mem.rules = { ...TRIP_RULES };
  mem.flight = null;
  mem.hotel = null;
  mem.events = [];
});

describe('moveProcedure', () => {
  it('recomputes and persists the rules from the new date', async () => {
    const { move } = await moveProcedure('c1', '2026-10-20T08:00', 'patient', NOW);
    expect(move.was).toBe('2026-10-13T08:00');
    expect(move.now).toBe('2026-10-20T08:00');
    expect(mem.rules).toMatchObject({
      procedureAtLocal: '2026-10-20T08:00',
      mustArriveByLocal: '2026-10-19T20:00',
      earliestReturnDepartureLocal: '2026-10-24T12:00',
      outboundDepartureDates: ['2026-10-18', '2026-10-17'],
    });
  });

  it('writes no event when the patient is the one who said so', async () => {
    const { event } = await moveProcedure('c1', '2026-10-20T08:00', 'patient', NOW);
    expect(event).toBeNull();
    expect(mem.events).toEqual([]);
  });

  it('writes a procedure_moved event when the clinic did it, so the agent raises it', async () => {
    mem.flight = bookedFlight;
    mem.hotel = bookedHotel;
    const { event } = await moveProcedure('c1', '2026-10-20T08:00', 'simulated', NOW);
    expect(event).toMatchObject({
      kind: 'procedure_moved',
      source: 'simulated',
      bookingId: 'b-flight',
    });
    const detail = event!.detail as Record<string, unknown>;
    expect(detail).toMatchObject({
      was: '2026-10-13T08:00',
      now: '2026-10-20T08:00',
      mustArriveBy: '2026-10-19T20:00',
      earliestReturn: '2026-10-24T12:00',
    });
    expect(detail.flight).toMatchObject({ reference: 'ABC12D', fits: false });
    expect(detail.hotel).toMatchObject({ reference: 'HOTEL9', checkIn: '2026-10-12' });
  });

  it('judges the booked flights against the new rules with the same validators the search uses', async () => {
    mem.flight = bookedFlight;
    const { move } = await moveProcedure('c1', '2026-10-20T08:00', 'patient', NOW);
    expect(move.flight).toMatchObject({
      reference: 'ABC12D',
      fits: false,
      outbound: 'still fits',
    });
    expect(move.flight!.return).toMatch(/before the earliest allowed/);
    expect(move.nextStep).toMatch(/rebook_flight, then rebook_hotel/);
  });

  it('says so when the flights still fit, rather than sending the patient through a rebooking', async () => {
    mem.flight = bookedFlight;
    mem.hotel = bookedHotel;
    // One day later: land by the 13th (they land the 12th), leave from the 18th at
    // noon — the 17th afternoon departure is too early, so this one does not fit…
    const later = await moveProcedure('c1', '2026-10-14T08:00', 'patient', NOW);
    expect(later.move.flight!.fits).toBe(false);
    // …but a same-day time change does.
    mem.rules = { ...TRIP_RULES };
    const sameDay = await moveProcedure('c1', '2026-10-13T11:00', 'patient', NOW);
    expect(sameDay.move.flight!.fits).toBe(true);
    expect(sameDay.move.nextStep).toMatch(/nothing has to move/);
  });

  it('falls back to the offer for a booking that predates the stored baseline', async () => {
    mem.flight = { ...bookedFlight, raw: {}, offer_id: 'o1' };
    const { move } = await moveProcedure('c1', '2026-10-20T08:00', 'patient', NOW);
    expect(move.flight).toMatchObject({ fits: false, outbound: 'still fits' });
    expect(move.flight!.return).not.toMatch(/No return on file/);
  });

  it('tells the agent to carry on when nothing is booked yet', async () => {
    const { move } = await moveProcedure('c1', '2026-10-20T08:00', 'patient', NOW);
    expect(move.flight).toBeNull();
    expect(move.hotel).toBeNull();
    expect(move.nextStep).toMatch(/search_flights already uses the new dates/);
  });

  it('refuses the date it already has, an unparseable one, and one too close to shop', async () => {
    await expect(moveProcedure('c1', '2026-10-13T08:00', 'patient', NOW)).rejects.toMatchObject({
      code: 'UNCHANGED',
    });
    await expect(moveProcedure('c1', 'next Tuesday', 'patient', NOW)).rejects.toMatchObject({
      code: 'INVALID_DATE',
    });
    await expect(moveProcedure('c1', '2026-09-11T08:00', 'patient', NOW)).rejects.toBeInstanceOf(
      ProcedureDateError,
    );
    // Nothing was written on any refusal.
    expect(mem.rules.procedureAtLocal).toBe('2026-10-13T08:00');
    expect(mem.events).toEqual([]);
  });
});
