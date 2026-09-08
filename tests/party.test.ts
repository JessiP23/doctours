import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRIP_RULES, type TripRules } from '@/lib/trip/rules';

/**
 * The traveller count used to be a constant nobody stated, so the app assumed one
 * person and never said so. A patient mentioned a friend mid-conversation and was
 * told a twin room "would work for both of you" — one seat was ticketed and one
 * guest was on the room.
 *
 * These cover the two halves of the fix: the count is trip state that has to be
 * established, and the booking tools refuse to disagree with it.
 */
const mem = {
  rules: { ...TRIP_RULES } as TripRules,
  bookings: [] as { kind: string; status: string; booking_reference: string }[],
};

vi.mock('@/lib/db/repo', () => ({
  getConversation: vi.fn(async () => ({ id: 'c1', trip_rules: mem.rules })),
  updateTripRules: vi.fn(async (_id: string, rules: unknown) => {
    mem.rules = rules as TripRules;
  }),
  getLiveBooking: vi.fn(async (_id: string, kind: string) => {
    return mem.bookings.find((b) => b.kind === kind && b.status === 'confirmed') ?? null;
  }),
}));

const { setPartySizeTool } = await import('@/lib/agent/tools/set_party_size');
const { createFlightOrderTool } = await import('@/lib/agent/tools/create_flight_order');
const { createHotelBookingTool } = await import('@/lib/agent/tools/create_hotel_booking');

const ctx = { conversationId: 'c1' };
const passenger = {
  givenName: 'Jessi',
  familyName: 'Pavia',
  dateOfBirth: '1990-05-02',
  gender: 'F' as const,
  email: 'j@example.com',
  phone: '+15551234567',
};
const guest = {
  givenName: 'Jessi',
  familyName: 'Pavia',
  email: 'j@example.com',
  phone: '+15551234567',
};

beforeEach(() => {
  mem.rules = { ...TRIP_RULES };
  mem.bookings = [];
});

describe('set_party_size', () => {
  it('records the count on the trip so every later search obeys it', async () => {
    const result = (await setPartySizeTool.handler({ travellers: 2 }, ctx)) as {
      travellers: number;
      changed: boolean;
    };
    expect(result).toMatchObject({ travellers: 2, changed: true });
    expect(mem.rules.adults).toBe(2);
    expect(mem.rules.travellersConfirmed).toBe(true);
  });

  it('distinguishes a confirmed one from a default one', async () => {
    // The default is one traveller. Until someone asks, that is an assumption, and
    // the prompt has to be able to tell the difference.
    expect(mem.rules.travellersConfirmed).toBeUndefined();
    const result = (await setPartySizeTool.handler({ travellers: 1 }, ctx)) as {
      changed: boolean;
      confirmed?: boolean;
    };
    expect(result.changed).toBe(false);
    expect(result.confirmed).toBe(true);
    expect(mem.rules.travellersConfirmed).toBe(true);
    expect(mem.rules.adults).toBe(1);
  });

  it('refuses to change the count once something is booked, and says why', async () => {
    mem.bookings.push({ kind: 'flight', status: 'confirmed', booking_reference: 'RFTEWX' });
    const result = (await setPartySizeTool.handler({ travellers: 3 }, ctx)) as {
      reason?: string;
      message: string;
      travellers: number;
    };
    expect(result.reason).toBe('ALREADY_BOOKED');
    expect(result.message).toContain('RFTEWX');
    expect(result.message).toMatch(/cancelled and rebooked/);
    // Nothing changed: a booked trip is not reconfigured by a setting.
    expect(mem.rules.adults).toBe(1);
    expect(result.travellers).toBe(1);
  });

  it('will not accept a count outside what can be booked', () => {
    for (const travellers of [0, 5, 2.5, -1]) {
      expect(setPartySizeTool.schema.safeParse({ travellers }).success).toBe(false);
    }
  });
});

describe('bookings match the party', () => {
  it('refuses a flight with fewer passports than travellers, before touching the provider', async () => {
    mem.rules = { ...TRIP_RULES, adults: 2, travellersConfirmed: true };
    const result = (await createFlightOrderTool.handler(
      { offerId: 'o1', passengers: [passenger] },
      ctx,
    )) as { booked: boolean; reason?: string; message?: string };
    expect(result.booked).toBe(false);
    expect(result.reason).toBe('TRAVELLER_COUNT_MISMATCH');
    expect(result.message).toContain('2');
  });

  it('refuses a flight with more passports than travellers', async () => {
    mem.rules = { ...TRIP_RULES, adults: 1, travellersConfirmed: true };
    const result = (await createFlightOrderTool.handler(
      { offerId: 'o1', passengers: [passenger, { ...passenger, givenName: 'Sam' }] },
      ctx,
    )) as { booked: boolean; reason?: string };
    expect(result.booked).toBe(false);
    expect(result.reason).toBe('TRAVELLER_COUNT_MISMATCH');
  });

  it('refuses a room that does not carry every traveller', async () => {
    mem.rules = { ...TRIP_RULES, adults: 2, travellersConfirmed: true };
    const result = (await createHotelBookingTool.handler(
      { rateId: 'r1', guests: [guest] },
      ctx,
    )) as { booked: boolean; reason?: string; message?: string };
    expect(result.booked).toBe(false);
    expect(result.reason).toBe('GUEST_COUNT_MISMATCH');
    expect(result.message).toMatch(/Every traveller goes on the room/);
  });
});
