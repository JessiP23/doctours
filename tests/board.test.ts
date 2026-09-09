import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { buildOptionBoard } from '@/lib/agent/board';
import { TRIP_RULES } from '@/lib/trip/rules';
import type { BookingRow, OfferRow } from '@/lib/db/types';

/**
 * The comparison view shows exactly what the agent has already put on the table —
 * same offers, same prices — plus the facts a patient compares on. These pin that
 * nothing is invented (a flight with no matching room has no total), that the
 * badges and deadline arithmetic are right, and that a booked option is marked
 * rather than offered again.
 */
const NOW = DateTime.fromISO('2026-09-09T12:00Z') as DateTime<true>;

function offer(
  kind: OfferRow['kind'],
  id: string,
  summary: unknown,
  expiresAt: string | null = null,
) {
  return {
    id,
    kind,
    summary,
    expires_at: expiresAt,
    raw: {},
    conversation_id: 'c1',
    provider: 'sabre',
    provider_offer_id: id,
    created_at: '',
  } as unknown as OfferRow;
}

const flight = (id: string, price: number, arrive: string, stops: number, checkIn: string) =>
  offer('flight', id, {
    priceUSD: price,
    carrier: 'QR',
    outbound: {
      departLocal: '2026-10-11T11:20',
      arriveLocal: arrive,
      stops,
      via: stops ? ['DOH'] : [],
    },
    inbound: {
      departLocal: '2026-10-17T20:05',
      arriveLocal: '2026-10-18T08:50',
      stops,
      via: stops ? ['DOH'] : [],
    },
    hotelNights: checkIn === '2026-10-12' ? 5 : 6,
    checkIn,
    checkOut: '2026-10-17',
  });

const room = (id: string, total: number, checkIn: string, extra = false) =>
  offer('hotel_rate', id, {
    room: 'Standard Room',
    beds: ['1 King'],
    sleeps: 2,
    nightlyUSD: 108,
    totalUSD: total,
    nights: checkIn === '2026-10-12' ? 5 : 6,
    checkIn,
    checkOut: '2026-10-17',
    refundable: false,
    ...(extra ? { fromTheNightBefore: true } : {}),
  });

describe('buildOptionBoard', () => {
  it('lays out flights with deadline margins, nights and badges', () => {
    const board = buildOptionBoard(
      TRIP_RULES,
      [],
      [
        flight('f1', 833, '2026-10-12T11:55', 1, '2026-10-12'),
        flight('f2', 1100, '2026-10-12T05:30', 0, '2026-10-12'),
      ],
      NOW,
    );
    expect(board.count).toBe(2);
    const [f1, f2] = board.flights;
    expect(f1.hoursBeforeDeadline).toBe(8.1); // lands 11:55, deadline 20:00
    expect(f1.hoursAfterEarliestReturn).toBe(8.1); // leaves 20:05, earliest noon
    expect(f1.badges).toEqual(['cheapest']);
    expect(f2.badges).toEqual(['non-stop', 'fewest stops']);
    expect(f1.nights).toBe(5);
    expect(f1.pick).toMatch(/QR flight leaving 11 Oct, 11:20 AM for \$833/);
    expect(f1.tripTotalUSD).toBeNull();
  });

  it('adds a trip total only when a room for exactly those nights is on the table', () => {
    const board = buildOptionBoard(
      TRIP_RULES,
      [],
      [
        flight('f1', 833, '2026-10-12T11:55', 1, '2026-10-12'),
        flight('f2', 700, '2026-10-11T19:40', 1, '2026-10-11'),
        room('r1', 540, '2026-10-12'),
        room('r2', 648, '2026-10-11', true),
      ],
      NOW,
    );
    const [f1, f2] = board.flights;
    expect(f1.room?.id).toBe('r1');
    expect(f1.tripTotalUSD).toBe(1373);
    // r2 is the night-before rate, not a room for f2's own nights.
    expect(f2.room).toBeNull();
    expect(f2.tripTotalUSD).toBeNull();
    expect(board.rooms.find((r) => r.id === 'r2')?.badges).toEqual(['night before']);
    expect(board.rooms.find((r) => r.id === 'r1')?.badges).toEqual(['cheapest']);
  });

  it('marks a booked option instead of offering it again, and an expired one as expired', () => {
    const booked = {
      status: 'confirmed',
      offer_id: 'f1',
      booking_reference: 'ABC12D',
    } as BookingRow;
    const board = buildOptionBoard(
      TRIP_RULES,
      [booked],
      [
        flight('f1', 833, '2026-10-12T11:55', 1, '2026-10-12'),
        offer(
          'flight',
          'f3',
          (flight('f3', 900, '2026-10-12T11:55', 1, '2026-10-12') as OfferRow).summary,
          '2026-09-09T11:00Z',
        ),
      ],
      NOW,
    );
    expect(board.flights[0].booked).toBe('ABC12D');
    expect(board.flights[1].expired).toBe(true);
  });

  it('lists other hotels with distance, lead price and which one is current', () => {
    const board = buildOptionBoard(
      TRIP_RULES,
      [],
      [
        offer('hotel_property', 'h1', {
          name: 'Hilton Istanbul',
          distanceFromAirport: { miles: 20.22, direction: 'SE' },
          leadTotalUSD: 1912.73,
          leadNightlyUSD: 382.55,
          nights: 5,
          isCurrentHotel: false,
        }),
        offer('hotel_property', 'h2', {
          name: 'Holiday Inn City Istanbul',
          distanceFromAirport: { miles: 20.06, direction: 'SE' },
          address: 'Millet Cad 187, Istanbul',
          leadTotalUSD: 539.72,
          isCurrentHotel: true,
        }),
      ],
      NOW,
    );
    expect(board.hotels[0].distance).toBe('20.22 mi (32.5 km) from the airport');
    expect(board.hotels[0].badges).toEqual([]);
    expect(board.hotels[1].badges).toEqual(['current', 'cheapest', 'closest']);
    expect(board.hotels[0].pick).toBe("I'd like to stay at Hilton Istanbul.");
  });

  it('is empty, with a count of zero, when nothing has been shown', () => {
    const board = buildOptionBoard(TRIP_RULES, [], [], NOW);
    expect(board.count).toBe(0);
    expect(board.rules.hotel).toBe('Holiday Inn City Istanbul');
  });
});
