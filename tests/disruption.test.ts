import { describe, expect, it } from 'vitest';
import type { FlightSlice } from '@/lib/providers/types';
import { detectDisruption, type OrderFlight } from '@/lib/trip/disruption';

/**
 * Sabre's segment status is the only reliable signal that an airline has touched a
 * booking, and a schedule change can arrive while the status stays HK. Both paths
 * are covered here against the shapes Get Booking actually returns.
 */
const IST = { iata: 'IST', tz: 'Europe/Istanbul' };
const JFK = { iata: 'JFK', tz: 'America/New_York' };
const FRA = { iata: 'FRA', tz: 'Europe/Berlin' };

const seg = (
  from: typeof JFK,
  to: typeof JFK,
  carrier: string,
  flightNumber: string,
  departLocal: string,
  arriveLocal: string,
) => ({
  from,
  to,
  carrier,
  flightNumber,
  departLocal,
  arriveLocal,
  cabin: 'economy' as const,
  durationMin: 600,
});

const booked: FlightSlice[] = [
  {
    segments: [seg(JFK, IST, 'TK', '4', '2026-10-11T12:50', '2026-10-12T05:30')],
    stops: 0,
    durationMin: 640,
  },
  {
    segments: [seg(IST, JFK, 'TK', '11', '2026-10-17T18:40', '2026-10-17T22:30')],
    stops: 0,
    durationMin: 590,
  },
];

const order = (overrides: Partial<OrderFlight>[]): OrderFlight[] => [
  {
    airlineCode: 'TK',
    flightNumber: 4,
    fromAirportCode: 'JFK',
    toAirportCode: 'IST',
    departureDate: '2026-10-11',
    departureTime: '12:50:00',
    arrivalDate: '2026-10-12',
    arrivalTime: '05:30:00',
    flightStatusCode: 'HK',
    flightStatusName: 'Confirmed',
    ...overrides[0],
  },
  {
    airlineCode: 'TK',
    flightNumber: 11,
    fromAirportCode: 'IST',
    toAirportCode: 'JFK',
    departureDate: '2026-10-17',
    departureTime: '18:40:00',
    arrivalDate: '2026-10-17',
    arrivalTime: '22:30:00',
    flightStatusCode: 'HK',
    flightStatusName: 'Confirmed',
    ...overrides[1],
  },
];

describe('detectDisruption', () => {
  it('reports a healthy order when both segments are held as booked', () => {
    expect(detectDisruption(booked, order([{}, {}]))).toEqual({
      healthy: true,
      findings: [],
      legs: [],
    });
  });

  it('reads a carrier cancellation on the outbound', () => {
    const report = detectDisruption(
      booked,
      order([{ flightStatusCode: 'HX', flightStatusName: 'Cancelled' }, {}]),
    );
    expect(report.healthy).toBe(false);
    expect(report.legs).toEqual(['outbound']);
    expect(report.findings[0]).toMatchObject({
      kind: 'flight_cancelled',
      status: 'HX',
      segment: 'TK4 JFK→IST',
    });
  });

  it('reads a cancellation on the return, which is the one that adds hotel nights', () => {
    const report = detectDisruption(booked, order([{}, { flightStatusCode: 'UN' }]));
    expect(report.legs).toEqual(['return']);
    expect(report.findings[0].kind).toBe('flight_cancelled');
  });

  it('catches a schedule change even while the status is still HK', () => {
    const report = detectDisruption(
      booked,
      order([
        { departureTime: '16:20:00', arrivalDate: '2026-10-12', arrivalTime: '09:05:00' },
        {},
      ]),
    );
    expect(report.healthy).toBe(false);
    expect(report.findings[0]).toMatchObject({
      kind: 'flight_schedule_change',
      was: { departLocal: '2026-10-11T12:50', arriveLocal: '2026-10-12T05:30' },
      now: { departLocal: '2026-10-11T16:20', arriveLocal: '2026-10-12T09:05' },
    });
  });

  it('treats a segment that vanished from the order as cancelled', () => {
    const report = detectDisruption(booked, [order([{}, {}])[1]]);
    expect(report.findings).toEqual([
      { segment: 'TK4 JFK→IST', status: 'MISSING', kind: 'flight_cancelled' },
    ]);
    expect(report.legs).toEqual(['outbound']);
  });

  it('reports an unrecognised status rather than assuming it is fine', () => {
    const report = detectDisruption(booked, order([{ flightStatusCode: 'ZZ' }, {}]));
    expect(report.healthy).toBe(false);
    expect(report.findings[0].status).toBe('ZZ');
  });

  it('names both legs when the whole trip is cancelled', () => {
    const report = detectDisruption(
      booked,
      order([{ flightStatusCode: 'HX' }, { flightStatusCode: 'HX' }]),
    );
    expect(report.legs.sort()).toEqual(['outbound', 'return']);
    expect(report.findings).toHaveLength(2);
  });

  it('matches connecting segments on carrier and route, not on order', () => {
    const connecting: FlightSlice[] = [
      {
        segments: [
          seg(JFK, FRA, 'LH', '401', '2026-10-10T15:40', '2026-10-11T05:25'),
          seg(FRA, IST, 'LH', '1300', '2026-10-11T13:00', '2026-10-11T17:05'),
        ],
        stops: 1,
        durationMin: 900,
      },
    ];
    const shuffled: OrderFlight[] = [
      {
        airlineCode: 'LH',
        flightNumber: 1300,
        fromAirportCode: 'FRA',
        toAirportCode: 'IST',
        departureDate: '2026-10-11',
        departureTime: '13:00:00',
        arrivalDate: '2026-10-11',
        arrivalTime: '17:05:00',
        flightStatusCode: 'HK',
      },
      {
        airlineCode: 'LH',
        flightNumber: 401,
        fromAirportCode: 'JFK',
        toAirportCode: 'FRA',
        departureDate: '2026-10-10',
        departureTime: '15:40:00',
        arrivalDate: '2026-10-11',
        arrivalTime: '05:25:00',
        flightStatusCode: 'HX',
      },
    ];
    const report = detectDisruption(connecting, shuffled);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({
      segment: 'LH401 JFK→FRA',
      kind: 'flight_cancelled',
    });
  });

  it('still catches a cancellation with no stored itinerary to compare against', () => {
    // Bookings made before the baseline was kept have no slices on the row. The
    // statuses are still authoritative, so the check must not silently pass —
    // this is the path that reported findings but recorded nothing.
    const report = detectDisruption([], order([{ flightStatusCode: 'HX' }, {}]));
    expect(report.healthy).toBe(false);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({ segment: 'TK4 JFK→IST', kind: 'flight_cancelled' });
    // Which direction it was cannot be known without the baseline, and is not guessed.
    expect(report.legs).toEqual([]);
  });

  it('cannot see a schedule change without a baseline, and does not pretend to', () => {
    const moved = order([{ departureTime: '19:05:00', arrivalTime: '11:45:00' }, {}]);
    expect(detectDisruption([], moved).healthy).toBe(true);
    expect(detectDisruption(booked, moved).findings[0]).toMatchObject({
      kind: 'flight_schedule_change',
    });
  });
});
