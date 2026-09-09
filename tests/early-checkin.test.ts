import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRIP_RULES, type TripRules } from '@/lib/trip/rules';
import type { FlightSlice, HotelRate } from '@/lib/providers/types';
import { compareStay, earlyArrivalFor } from '@/lib/trip/nights';
import { buildCreateHotelBookingRequest } from '@/lib/providers/sabre/requests';

/**
 * "I land at six in the morning — can I get into the room?" has two honest answers:
 * book the night before (a paid night, with a price) or ask the hotel for early
 * check-in (a request, no promise). These pin that the search prices the first, the
 * booking files the second as an instruction the hotel actually receives, and that a
 * room deliberately booked from the night before is recorded as covering the
 * flights rather than as a room on the wrong dates.
 */
const mem = {
  rules: { ...TRIP_RULES } as TripRules,
  bookings: [] as Record<string, unknown>[],
  offers: new Map<string, Record<string, unknown>>(),
  inserted: [] as Record<string, unknown>[],
  searches: [] as { checkIn: string; checkOut: string }[],
  extraNightAvailable: true,
  lastBookingCall: null as null | { rate: HotelRate; options: unknown },
  bookingCalls: [] as unknown[],
  refuseInstruction: false,
};

vi.mock('@/lib/db/repo', () => ({
  getConversation: vi.fn(async () => ({ id: 'c1', trip_rules: mem.rules })),
  getLiveBooking: vi.fn(
    async (_id: string, kind: string) =>
      mem.bookings.find((b) => b.kind === kind && b.status === 'confirmed') ?? null,
  ),
  getOffer: vi.fn(async (_id: string, offerId: string) => mem.offers.get(offerId) ?? null),
  insertOffers: vi.fn(async (_id: string, offers: Record<string, unknown>[]) => {
    const rows = offers.map((o, i) => ({
      id: `rate-${mem.offers.size + i + 1}`,
      kind: 'hotel_rate',
      expires_at: null,
      ...o,
    }));
    for (const r of rows) mem.offers.set(r.id as string, r);
    return rows;
  }),
  insertBooking: vi.fn(async (_id: string, row: Record<string, unknown>) => {
    const saved = {
      id: `b${mem.inserted.length + 1}`,
      status: 'confirmed',
      booking_reference: row.bookingReference,
      ...row,
    };
    mem.inserted.push(saved);
    return saved;
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

function rate(checkIn: string, checkOut: string, nights: number): HotelRate {
  return {
    id: `sabre-${checkIn}`,
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
    nightly: { amount: 108, currency: 'USD' },
    total: { amount: 108 * nights, currency: 'USD' },
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

vi.mock('@/lib/providers/sabre', () => ({
  resolveAirportPoint: vi.fn(async () => null),
  travelProvider: () => ({
    searchHotelRates: vi.fn(async (q: { checkIn: string; checkOut: string }) => {
      mem.searches.push({ checkIn: q.checkIn, checkOut: q.checkOut });
      const nights = Number(q.checkOut.slice(8)) - Number(q.checkIn.slice(8));
      if (q.checkIn === '2026-10-11' && !mem.extraNightAvailable)
        throw new ProviderError('NO_AVAILABILITY');
      return [rate(q.checkIn, q.checkOut, nights)];
    }),
    createHotelBooking: vi.fn(async (r: HotelRate, guests: unknown[], options: unknown) => {
      mem.lastBookingCall = { rate: r, options };
      mem.bookingCalls.push(options);
      if (mem.refuseInstruction && (options as { specialInstruction?: string }).specialInstruction)
        throw new ProviderError('BOOKING_FAILED');
      return {
        id: 'order-1',
        bookingReference: 'HOTEL1',
        provider: 'sabre',
        rateId: r.id,
        propertyName: r.propertyName,
        roomName: r.roomName,
        checkIn: r.checkIn,
        checkOut: r.checkOut,
        total: r.total,
        guest: guests[0],
        raw: {},
      };
    }),
  }),
}));

const { searchHotelRatesTool } = await import('@/lib/agent/tools/search_hotel_rates');
const { createHotelBookingTool } = await import('@/lib/agent/tools/create_hotel_booking');
const { earlyCheckInInstruction } = await import('@/lib/agent/tools/hotel-booking');

const ctx = { conversationId: 'c1' };
const guest = {
  givenName: 'Jessi',
  familyName: 'Pavia',
  email: 'j@example.com',
  phone: '+15551234567',
};

function flightLanding(arriveLocal: string): FlightSlice[] {
  const seg = (from: string, to: string, departLocal: string, arrive: string) => ({
    carrier: 'TK',
    flightNumber: '1',
    from: { iata: from, tz: null },
    to: { iata: to, tz: null },
    departLocal,
    arriveLocal: arrive,
    cabin: 'economy' as const,
    durationMin: 600,
  });
  return [
    { segments: [seg('JFK', 'IST', '2026-10-11T12:50', arriveLocal)], stops: 0, durationMin: 600 },
    {
      segments: [seg('IST', 'JFK', '2026-10-17T14:00', '2026-10-17T18:00')],
      stops: 0,
      durationMin: 600,
    },
  ];
}
const bookedFlight = (arriveLocal: string) => ({
  id: 'f1',
  kind: 'flight',
  status: 'confirmed',
  booking_reference: 'FLT001',
  offer_id: null,
  raw: { bookedSlices: flightLanding(arriveLocal) },
  details: {},
});

beforeEach(() => {
  mem.rules = { ...TRIP_RULES };
  mem.bookings = [];
  mem.offers.clear();
  mem.inserted = [];
  mem.searches = [];
  mem.extraNightAvailable = true;
  mem.lastBookingCall = null;
  mem.bookingCalls = [];
  mem.refuseInstruction = false;
});

describe('compareStay', () => {
  const flights = { checkIn: '2026-10-12', checkOut: '2026-10-17' };
  it('matches when the room is exactly the flights', () => {
    expect(compareStay(flights, flights).coverage).toBe('matches');
  });
  it('covers when the room starts the night before or ends the night after', () => {
    expect(compareStay({ checkIn: '2026-10-11', checkOut: '2026-10-17' }, flights)).toEqual({
      coverage: 'covers',
      nightsBefore: 1,
      nightsAfter: 0,
    });
    expect(compareStay({ checkIn: '2026-10-12', checkOut: '2026-10-18' }, flights)).toMatchObject({
      coverage: 'covers',
      nightsAfter: 1,
    });
  });
  it('is a gap when the patient lands before the room starts or leaves after it ends', () => {
    expect(compareStay({ checkIn: '2026-10-13', checkOut: '2026-10-17' }, flights).coverage).toBe(
      'gap',
    );
    expect(compareStay({ checkIn: '2026-10-12', checkOut: '2026-10-16' }, flights).coverage).toBe(
      'gap',
    );
    // A spare night at one end does not excuse a gap at the other.
    expect(compareStay({ checkIn: '2026-10-11', checkOut: '2026-10-16' }, flights).coverage).toBe(
      'gap',
    );
  });
});

describe('earlyArrivalFor', () => {
  it('reports a landing two or more hours before check-in, and nothing otherwise', () => {
    expect(earlyArrivalFor('2026-10-12T11:55', '2026-10-12', '14:00', 'Europe/Istanbul')).toEqual({
      arriveLocal: '2026-10-12T11:55',
      checkInFrom: '14:00',
      hoursEarly: 2.1,
    });
    expect(
      earlyArrivalFor('2026-10-12T13:00', '2026-10-12', '14:00', 'Europe/Istanbul'),
    ).toBeNull();
    expect(
      earlyArrivalFor('2026-10-12T19:40', '2026-10-12', '14:00', 'Europe/Istanbul'),
    ).toBeNull();
  });

  it('does no arithmetic when the hotel has not said when check-in is', () => {
    expect(earlyArrivalFor('2026-10-12T05:30', '2026-10-12', null, 'Europe/Istanbul')).toBeNull();
    expect(earlyArrivalFor(undefined, '2026-10-12', '14:00', 'Europe/Istanbul')).toBeNull();
  });
});

describe('the room search when the flight lands early', () => {
  it('prices the night before alongside the normal nights, with bookable rateIds', async () => {
    mem.bookings.push(bookedFlight('2026-10-12T05:30'));
    const result = (await searchHotelRatesTool.handler({}, ctx)) as {
      checkIn: string;
      earlyArrival?: { hoursEarly: number };
      extraNight?: {
        checkIn: string;
        rooms: { rateId: string; totalUSD: number; nights: number }[];
      };
      rooms: { rateId: string }[];
    };
    expect(result.checkIn).toBe('2026-10-12');
    expect(result.earlyArrival?.hoursEarly).toBe(9.5);
    expect(mem.searches).toEqual([
      { checkIn: '2026-10-12', checkOut: '2026-10-17' },
      { checkIn: '2026-10-11', checkOut: '2026-10-17' },
    ]);
    expect(result.extraNight?.checkIn).toBe('2026-10-11');
    expect(result.extraNight?.rooms[0]).toMatchObject({ nights: 6, totalUSD: 648 });
    // The extra-night rate is a real offer the booking tool can load.
    const extraId = result.extraNight!.rooms[0].rateId;
    expect(mem.offers.get(extraId)).toMatchObject({ summary: { fromTheNightBefore: true } });
    expect(result.rooms[0].rateId).not.toBe(extraId);
  });

  it('says so when the night before is not available, rather than inventing one', async () => {
    mem.bookings.push(bookedFlight('2026-10-12T05:30'));
    mem.extraNightAvailable = false;
    const result = (await searchHotelRatesTool.handler({}, ctx)) as {
      extraNight?: { available?: boolean; note: string };
      rooms: unknown[];
    };
    expect(result.rooms).toHaveLength(1);
    expect(result.extraNight).toMatchObject({ available: false });
    expect(result.extraNight!.note).toMatch(/early check-in request/);
  });

  it('does not price an extra night when the flight lands after check-in time', async () => {
    mem.bookings.push(bookedFlight('2026-10-12T19:40'));
    const result = (await searchHotelRatesTool.handler({}, ctx)) as {
      earlyArrival?: unknown;
      extraNight?: unknown;
    };
    expect(mem.searches).toHaveLength(1);
    expect(result.earlyArrival).toBeUndefined();
    expect(result.extraNight).toBeUndefined();
  });
});

describe('early check-in as a request on the reservation', () => {
  it('builds the instruction from the itinerary, never from the model', () => {
    expect(earlyCheckInInstruction(flightLanding('2026-10-12T05:30'), TRIP_RULES)).toBe(
      'EARLY CHECK-IN REQUESTED IF AVAILABLE - GUEST ARRIVES 12OCT 0530',
    );
    expect(earlyCheckInInstruction(null, TRIP_RULES)).toBe('EARLY CHECK-IN REQUESTED IF AVAILABLE');
    // Hotel systems read free text as upper-case letters, digits, spaces and hyphens.
    expect(earlyCheckInInstruction(flightLanding('2026-10-12T05:30'), TRIP_RULES)).toMatch(
      /^[A-Z0-9 -]+$/,
    );
  });

  it('reaches Sabre as the hotel special instruction', () => {
    const body = buildCreateHotelBookingRequest({
      pcc: 'X',
      bookingKey: 'k',
      travelers: [{ givenName: 'Jessi', surname: 'Pavia' }],
      contact: { emails: ['j@example.com'], phones: ['+15551234567'] },
      paymentPolicy: 'LATE',
      card: null,
      specialInstruction: 'EARLY CHECK-IN REQUESTED IF AVAILABLE - GUEST ARRIVES 12OCT 0530',
    }) as { hotel: { specialInstruction?: string } };
    expect(body.hotel.specialInstruction).toMatch(/ARRIVES 12OCT 0530/);
    const without = buildCreateHotelBookingRequest({
      pcc: 'X',
      bookingKey: 'k',
      travelers: [{ givenName: 'Jessi', surname: 'Pavia' }],
      contact: { emails: ['j@example.com'], phones: ['+15551234567'] },
      paymentPolicy: 'LATE',
      card: null,
    }) as { hotel: { specialInstruction?: string } };
    expect(without.hotel).not.toHaveProperty('specialInstruction');
  });

  it('files the request when asked and says it is a request, and stores it on the booking', async () => {
    mem.bookings.push(bookedFlight('2026-10-12T05:30'));
    const search = (await searchHotelRatesTool.handler({}, ctx)) as { rooms: { rateId: string }[] };
    const result = (await createHotelBookingTool.handler(
      { rateId: search.rooms[0].rateId, guests: [guest], earlyCheckIn: true },
      ctx,
    )) as {
      booked: boolean;
      requestsFiled?: string[];
      requestsNote?: string;
      coversFlights?: boolean;
    };
    expect(result.booked).toBe(true);
    expect(mem.lastBookingCall?.options).toEqual({
      specialInstruction: 'EARLY CHECK-IN REQUESTED IF AVAILABLE - GUEST ARRIVES 12OCT 0530',
    });
    expect(result.requestsFiled).toHaveLength(1);
    expect(result.requestsNote).toMatch(/not guaranteed/);
    expect(result.coversFlights).toBe(true);
    expect((mem.inserted[0].details as { requests: string[] }).requests[0]).toMatch(/0530/);
  });

  it('books the room without the request when the hotel refuses it, and says so', async () => {
    // Live: the supplier answered "unable to process supplier response" with the
    // instruction attached. The room is what matters; the note is not worth losing it.
    mem.bookings.push(bookedFlight('2026-10-12T05:30'));
    mem.refuseInstruction = true;
    const search = (await searchHotelRatesTool.handler({}, ctx)) as { rooms: { rateId: string }[] };
    const result = (await createHotelBookingTool.handler(
      { rateId: search.rooms[0].rateId, guests: [guest], earlyCheckIn: true },
      ctx,
    )) as {
      booked: boolean;
      requestsFiled?: string[];
      requestNotFiled?: string;
      requestsNote?: string;
    };
    expect(result.booked).toBe(true);
    expect(mem.bookingCalls).toEqual([
      { specialInstruction: 'EARLY CHECK-IN REQUESTED IF AVAILABLE - GUEST ARRIVES 12OCT 0530' },
      {},
    ]);
    expect(result.requestsFiled).toBeUndefined();
    expect(result.requestNotFiled).toMatch(/EARLY CHECK-IN/);
    expect(result.requestsNote).toMatch(/Do not say it was requested/);
    expect(mem.inserted[0].details).not.toHaveProperty('requests');
  });

  it('does not retry a failure that had nothing to do with the request', async () => {
    mem.bookings.push(bookedFlight('2026-10-12T05:30'));
    mem.refuseInstruction = true;
    const search = (await searchHotelRatesTool.handler({}, ctx)) as { rooms: { rateId: string }[] };
    // No instruction asked for: a BOOKING_FAILED here is a real failure and surfaces.
    mem.bookingCalls = [];
    const original = mem.refuseInstruction;
    mem.refuseInstruction = false;
    await createHotelBookingTool.handler({ rateId: search.rooms[0].rateId, guests: [guest] }, ctx);
    expect(mem.bookingCalls).toEqual([{}]);
    mem.refuseInstruction = original;
  });

  it('files nothing when the patient did not ask', async () => {
    mem.bookings.push(bookedFlight('2026-10-12T05:30'));
    const search = (await searchHotelRatesTool.handler({}, ctx)) as { rooms: { rateId: string }[] };
    const result = (await createHotelBookingTool.handler(
      { rateId: search.rooms[0].rateId, guests: [guest] },
      ctx,
    )) as { requestsFiled?: string[] };
    expect(mem.lastBookingCall?.options).toEqual({});
    expect(result.requestsFiled).toBeUndefined();
    expect(mem.inserted[0].details).not.toHaveProperty('requests');
  });
});

describe('a room booked from the night before', () => {
  it('is recorded as covering the flights with one night before landing, not as the wrong dates', async () => {
    mem.bookings.push(bookedFlight('2026-10-12T05:30'));
    const search = (await searchHotelRatesTool.handler({}, ctx)) as {
      extraNight: { rooms: { rateId: string }[] };
    };
    const result = (await createHotelBookingTool.handler(
      { rateId: search.extraNight.rooms[0].rateId, guests: [guest] },
      ctx,
    )) as {
      booked: boolean;
      checkIn: string;
      coversFlights?: boolean;
      extraNights?: { before: number; after: number };
      nightsWarning?: string;
    };
    expect(result.booked).toBe(true);
    expect(result.checkIn).toBe('2026-10-11');
    expect(result.coversFlights).toBe(true);
    expect(result.extraNights).toMatchObject({ before: 1, after: 0 });
    expect(result.nightsWarning).toBeUndefined();
    expect(mem.inserted[0].details).toMatchObject({ nightsBeforeFlight: 1 });
  });
});
