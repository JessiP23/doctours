import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRIP_RULES, type TripRules } from '@/lib/trip/rules';
import type { FlightOffer, FlightSlice, HotelRate } from '@/lib/providers/types';
import {
  cheapestPerStay,
  describeTradeoff,
  distinctStays,
  rankTripTotals,
  stayKey,
} from '@/lib/trip/totals';

/**
 * Money is tight, so the question is the total. The cheapest fare here lands a day
 * early: it saves $60 on the flight and costs $108 for the extra night. These pin
 * that the ranking is by flight + room, that the arithmetic and the trade-off
 * sentence come from code, and that everything shown is persisted and bookable.
 */
function seg(from: string, to: string, departLocal: string, arriveLocal: string, number = '1') {
  return {
    carrier: 'TK',
    flightNumber: number,
    from: { iata: from, tz: null },
    to: { iata: to, tz: null },
    departLocal,
    arriveLocal,
    cabin: 'economy' as const,
    durationMin: 600,
  };
}
function slice(...segments: ReturnType<typeof seg>[]): FlightSlice {
  return { segments, stops: segments.length - 1, durationMin: 600 };
}
function offer(id: string, price: number, landIST: string, leaveIST: string): FlightOffer {
  return {
    id,
    provider: 'sabre',
    slices: [
      // Distinct flight numbers per fixture, so they are distinct itineraries.
      slice(seg('JFK', 'IST', '2026-10-11T12:50', landIST, id)),
      slice(seg('IST', 'JFK', leaveIST, '2026-10-17T18:00')),
    ],
    price: { amount: price, currency: 'USD' },
    cabin: 'economy',
    checkedBagsIncluded: 0,
    expiresAt: null,
    raw: {},
  };
}
function room(checkIn: string, checkOut: string, nightly: number): HotelRate {
  const nights = Number(checkOut.slice(8)) - Number(checkIn.slice(8));
  return {
    id: `rate-${checkIn}-${checkOut}`,
    provider: 'sabre',
    propertyId: '100071112',
    propertyName: 'Holiday Inn City Istanbul',
    roomName: 'Standard Room',
    roomDescription: null,
    bedTypes: ['1 King'],
    maxOccupancy: 2,
    productCode: null,
    ratePlanName: null,
    checkIn,
    checkOut,
    nights,
    nightly: { amount: nightly, currency: 'USD' },
    total: { amount: nightly * nights, currency: 'USD' },
    taxes: null,
    refundable: true,
    cancelBy: null,
    mealPlan: null,
    prepaid: null,
    availableQuantity: null,
    expiresAt: null,
    location: null,
    policies: null,
    raw: {},
  };
}

// Lands the 12th, leaves the 17th: five nights. Lands the 11th (cheaper fare): six.
const normal = offer('f-normal', 760, '2026-10-12T05:30', '2026-10-17T14:00');
const early = offer('f-early', 700, '2026-10-11T19:40', '2026-10-17T14:00');
const pricier = offer('f-pricier', 900, '2026-10-12T11:55', '2026-10-17T14:00');
const rooms = new Map<string, HotelRate | null>([
  [
    stayKey({ checkIn: '2026-10-12', checkOut: '2026-10-17' }),
    room('2026-10-12', '2026-10-17', 108),
  ],
  [
    stayKey({ checkIn: '2026-10-11', checkOut: '2026-10-17' }),
    room('2026-10-11', '2026-10-17', 108),
  ],
]);

describe('ranking the whole trip', () => {
  it('finds the distinct stays a set of flights implies', () => {
    expect(distinctStays([normal, early, pricier]).map(stayKey)).toEqual([
      '2026-10-12|2026-10-17',
      '2026-10-11|2026-10-17',
    ]);
  });

  it('keeps the cheapest itineraries for each stay', () => {
    expect(cheapestPerStay([pricier, normal, early], 1).map((o) => o.id)).toEqual([
      'f-early',
      'f-normal',
    ]);
  });

  it('ranks by flight plus room, so the cheaper fare with the extra night comes second', () => {
    const ranked = rankTripTotals([early, normal, pricier], rooms);
    expect(ranked.map((t) => [t.offer.id, t.flightUSD, t.hotelUSD, t.totalUSD])).toEqual([
      ['f-normal', 760, 540, 1300],
      ['f-early', 700, 648, 1348],
      ['f-pricier', 900, 540, 1440],
    ]);
  });

  it('puts an option the hotel could not price last, with no total', () => {
    const partial = new Map(rooms);
    partial.set(stayKey({ checkIn: '2026-10-12', checkOut: '2026-10-17' }), null);
    const ranked = rankTripTotals([early, normal], partial);
    expect(ranked[0].offer.id).toBe('f-early');
    expect(ranked[1]).toMatchObject({ hotelUSD: null, totalUSD: null });
  });

  it('writes the trade-off sentence with the numbers, so the model never subtracts', () => {
    const t = describeTradeoff(rankTripTotals([early, normal, pricier], rooms));
    expect(t.sameOption).toBe(false);
    expect(t.savingsUSD).toBe(48);
    expect(t.summary).toBe(
      'The cheapest trip is $1300: $760 for the flights plus $540 for 5 night(s). The cheapest flight alone is $700, but it means 6 night(s) at $648, $1348 in all — $48 more.',
    );
  });

  it('says so when the cheapest flight is also the cheapest trip', () => {
    const t = describeTradeoff(rankTripTotals([normal, pricier], rooms));
    expect(t.sameOption).toBe(true);
    expect(t.summary).toMatch(/also the cheapest trip/);
  });
});

// ---- the tool ----------------------------------------------------------------

const mem = {
  rules: { ...TRIP_RULES, travellersConfirmed: true } as TripRules,
  offers: [] as Record<string, unknown>[],
  roomSearches: [] as string[],
  noRoomFor: null as string | null,
  bookedFlight: null as null | Record<string, unknown>,
};

vi.mock('@/lib/db/repo', () => ({
  getConversation: vi.fn(async () => ({ id: 'c1', trip_rules: mem.rules })),
  getLiveBooking: vi.fn(async (_id: string, kind: string) =>
    kind === 'flight' ? mem.bookedFlight : null,
  ),
  listOpenTripEvents: vi.fn(async () => []),
  insertOffers: vi.fn(async (_id: string, offers: Record<string, unknown>[]) => {
    const rows = offers.map((o, i) => ({
      id: `${o.kind}-${mem.offers.length + i + 1}`,
      provider_offer_id: o.providerOfferId,
      expires_at: null,
      ...o,
    }));
    mem.offers.push(...rows);
    return rows;
  }),
}));

class ProviderError extends Error {
  constructor(public code: string) {
    super(code);
  }
}
vi.mock('@/lib/providers/sabre/errors', () => ({
  ProviderError,
  isProviderError: (e: unknown) => e instanceof ProviderError,
}));

vi.mock('@/lib/providers/sabre', () => ({
  travelProvider: () => ({
    searchFlights: vi.fn(async (q: { departDate: string }) =>
      // The shop for the 11th returns both fares; the 10th nothing.
      q.departDate === '2026-10-11' ? [early, normal, pricier] : [],
    ),
    priceFlightOffer: vi.fn(async (o: FlightOffer) => o),
    searchHotelRates: vi.fn(async (q: { checkIn: string; checkOut: string }) => {
      mem.roomSearches.push(q.checkIn);
      if (mem.noRoomFor === q.checkIn) throw new ProviderError('NO_AVAILABILITY');
      return [room(q.checkIn, q.checkOut, 108)];
    }),
  }),
}));

const { compareTripTotalsTool } = await import('@/lib/agent/tools/compare_trip_totals');
const ctx = { conversationId: 'c1' };

beforeEach(() => {
  mem.rules = { ...TRIP_RULES, travellersConfirmed: true };
  mem.offers = [];
  mem.roomSearches = [];
  mem.noRoomFor = null;
  mem.bookedFlight = null;
});

describe('compare_trip_totals', () => {
  it('prices one room per distinct stay and ranks by the total', async () => {
    const result = (await compareTripTotalsTool.handler({}, ctx)) as {
      options: { offerId: string; rateId: string | null; totalUSD: number; nights: number }[];
      tradeoff: string;
      cheapestFlightIsCheapestTrip: boolean;
      extraCostOfCheapestFlightUSD: number;
      staysCompared: number;
    };
    expect(mem.roomSearches.sort()).toEqual(['2026-10-11', '2026-10-12']);
    expect(result.staysCompared).toBe(2);
    expect(result.options.map((o) => [o.totalUSD, o.nights])).toEqual([
      [1300, 5],
      [1348, 6],
      [1440, 5],
    ]);
    expect(result.cheapestFlightIsCheapestTrip).toBe(false);
    expect(result.extraCostOfCheapestFlightUSD).toBe(48);
    expect(result.tradeoff).toMatch(/\$48 more/);
    // Both halves of every option are persisted and bookable by id.
    for (const o of result.options) {
      expect(mem.offers.find((row) => row.id === o.offerId)).toMatchObject({ kind: 'flight' });
      expect(mem.offers.find((row) => row.id === o.rateId)).toMatchObject({ kind: 'hotel_rate' });
    }
  });

  it('says when an option lands before the room is ready, since no room search runs on this path', async () => {
    const result = (await compareTripTotalsTool.handler({}, ctx)) as {
      options: { nights: number; earlyArrival?: { hoursEarly: number; checkInFrom: string } }[];
    };
    // f-normal lands 05:30 on the 12th; check-in is the rule's 15:00 (the fixture rate
    // states no policy). f-early lands 19:40 the evening before, after check-in.
    expect(result.options[0].earlyArrival).toEqual({
      arriveLocal: '2026-10-12T05:30',
      checkInFrom: '15:00',
      hoursEarly: 9.5,
    });
    expect(result.options[1].earlyArrival).toBeUndefined();
  });

  it('shows an option without a total when the hotel has nothing for its nights', async () => {
    mem.noRoomFor = '2026-10-11';
    const result = (await compareTripTotalsTool.handler({}, ctx)) as {
      options: { offerId: string; rateId: string | null; totalUSD: number | null; note?: string }[];
    };
    const last = result.options.at(-1)!;
    expect(last.totalUSD).toBeNull();
    expect(last.rateId).toBeNull();
    expect(last.note).toMatch(/no room for these nights/);
    expect(result.options[0].totalUSD).toBe(1300);
  });

  it('will not compare before the party size is known', async () => {
    mem.rules = { ...TRIP_RULES };
    const result = (await compareTripTotalsTool.handler({}, ctx)) as { reason?: string };
    expect(result.reason).toBe('PARTY_SIZE_UNKNOWN');
    expect(mem.roomSearches).toEqual([]);
  });

  it('points at rebook_flight when a flight is already held', async () => {
    mem.bookedFlight = { booking_reference: 'HELD01' };
    const result = (await compareTripTotalsTool.handler({}, ctx)) as {
      alreadyBooked?: string;
      note?: string;
    };
    expect(result.alreadyBooked).toBe('HELD01');
    expect(result.note).toMatch(/rebook_flight/);
  });
});
