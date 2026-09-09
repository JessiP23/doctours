import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRIP_RULES, type TripRules } from '@/lib/trip/rules';

/**
 * Rebooking is where a cancelled flight stops being an announcement and becomes a
 * repaired trip. The order of operations is the whole safety argument: the
 * replacement is sold first, so a failure leaves the patient holding exactly what
 * they held, and the old order is only released once the new one exists.
 *
 * The provider and the repository are stood in for, so these assert the sequence
 * and what the patient is told — not Sabre, which the smoke script covers.
 */
const passenger = {
  givenName: 'Jessi',
  familyName: 'Pavia',
  dateOfBirth: '1990-05-02',
  gender: 'F' as const,
  email: 'j@example.com',
  phone: '+15551234567',
};

type Row = {
  id: string;
  kind: string;
  status: string;
  booking_reference: string;
  offer_id: string | null;
  details: Record<string, unknown>;
  raw: Record<string, unknown>;
  replaced_by?: string | null;
  change_reason?: string | null;
};

const mem = {
  rules: { ...TRIP_RULES } as TripRules,
  rows: [] as Row[],
  events: [] as string[],
  sellFails: false,
  cancelFails: false,
  recordFails: false,
};

const slice = (from: string, to: string, depart: string, arrive: string) => ({
  segments: [
    {
      from: { iata: from, tz: 'UTC' },
      to: { iata: to, tz: 'UTC' },
      departLocal: depart,
      arriveLocal: arrive,
      carrier: 'QR',
      flightNumber: '1',
      cabin: 'economy' as const,
      durationMin: 600,
      bookingClass: 'T',
    },
  ],
  stops: 0,
  durationMin: 600,
});

vi.mock('@/lib/db/repo', () => ({
  getConversation: vi.fn(async () => ({ id: 'c1', trip_rules: mem.rules })),
  getLiveBooking: vi.fn(
    async (_c: string, kind: string) =>
      mem.rows.find((r) => r.kind === kind && r.status === 'confirmed') ?? null,
  ),
  getOffer: vi.fn(async (_c: string, id: string) => offerRow(id)),
  // The failure path re-shops to offer alternatives; nothing here needs to come back.
  insertOffers: vi.fn(async () => []),
  insertBooking: vi.fn(async (_c: string, b: Record<string, unknown>) => {
    const row: Row = {
      id: `row-${mem.rows.length + 1}`,
      kind: b.kind as string,
      status: 'confirmed',
      booking_reference: b.bookingReference as string,
      offer_id: (b.offerId as string) ?? null,
      details: b.details as Record<string, unknown>,
      raw: b.raw as Record<string, unknown>,
    };
    mem.rows.push(row);
    return row;
  }),
  supersedeBookingRow: vi.fn(async (oldId: string, newId: string, reason: string) => {
    const row = mem.rows.find((r) => r.id === oldId)!;
    row.status = 'superseded';
    row.replaced_by = newId;
    row.change_reason = reason;
    mem.events.push(`supersede:${oldId}->${newId}`);
    return row;
  }),
  replaceBooking: vi.fn(
    async (c: string, oldId: string, reason: string, replacement: Record<string, unknown>) => {
      if (mem.recordFails) throw new Error('db.linkReplacement: boom');
      const repo = await import('@/lib/db/repo');
      const inserted = await repo.insertBooking(c, replacement as never);
      await repo.supersedeBookingRow(oldId, inserted.id, reason);
      return inserted;
    },
  ),
}));

vi.mock('@/lib/providers/sabre', () => ({
  travelProvider: () => ({
    priceFlightOffer: vi.fn(async (o: unknown) => o),
    searchFlights: vi.fn(async () => []),
    createFlightOrder: vi.fn(async (offer: { slices: unknown[]; price: unknown }) => {
      mem.events.push('sell');
      if (mem.sellFails) {
        const { ProviderError } = await import('@/lib/providers/sabre/errors');
        throw new ProviderError('NO_AVAILABILITY', 'airline refused');
      }
      return {
        id: 'ord-new',
        bookingReference: 'RNEW11',
        provider: 'sabre',
        offerId: 'o2',
        slices: offer.slices,
        price: offer.price,
        passengers: [passenger],
        raw: {},
      };
    }),
    cancelBooking: vi.fn(async (reference: string) => {
      mem.events.push(`cancel:${reference}`);
      if (mem.cancelFails) return { reference, cancelled: false, remaining: ['1 flight'], raw: {} };
      return { reference, cancelled: true, remaining: [], raw: {} };
    }),
  }),
  unconfirmedFlightsOf: () => [],
  resolveAirportPoint: async () => null,
}));

function offerRow(id: string) {
  return {
    id,
    kind: 'flight',
    expires_at: null,
    summary: {},
    raw: {
      id,
      provider: 'sabre',
      price: { amount: 900, currency: 'USD' },
      slices: [
        // Lands a day later than the original, so the hotel must move.
        slice('JFK', 'IST', '2026-10-10T11:20', '2026-10-11T11:55'),
        slice('IST', 'JFK', '2026-10-18T20:05', '2026-10-19T08:50'),
      ],
      expiresAt: null,
      raw: {},
    },
  };
}

const { rebookFlightTool, hotelFit } = await import('@/lib/agent/tools/rebook_flight');

const ctx = { conversationId: 'c1' };
const args = { offerId: 'o2', confirmed: true as const, reason: 'Qatar cancelled the outbound' };

function bookedFlight(): Row {
  return {
    id: 'row-flight',
    kind: 'flight',
    status: 'confirmed',
    booking_reference: 'ROLD11',
    offer_id: 'o1',
    details: { priceUSD: 833.23 },
    raw: {
      bookedSlices: [
        slice('JFK', 'IST', '2026-10-11T11:20', '2026-10-12T11:55'),
        slice('IST', 'JFK', '2026-10-18T20:05', '2026-10-19T08:50'),
      ],
      travellers: [passenger],
    },
  };
}

beforeEach(() => {
  mem.rules = { ...TRIP_RULES, travellersConfirmed: true };
  mem.rows = [];
  mem.events = [];
  mem.sellFails = false;
  mem.cancelFails = false;
  mem.recordFails = false;
});

describe('rebook_flight', () => {
  it('sells the replacement before releasing the old order', async () => {
    mem.rows.push(bookedFlight());
    const result = (await rebookFlightTool.handler(args, ctx)) as {
      rebooked: boolean;
      bookingReference: string;
      replaced: string;
      oldOrderReleased: boolean;
    };
    expect(result.rebooked).toBe(true);
    expect(result.bookingReference).toBe('RNEW11');
    expect(result.replaced).toBe('ROLD11');
    expect(result.oldOrderReleased).toBe(true);
    // The sell strictly precedes the cancel. Reversing these is how a patient ends
    // up with no flight at all.
    expect(mem.events.indexOf('sell')).toBeLessThan(mem.events.indexOf('cancel:ROLD11'));
  });

  it('leaves the patient on their original flight when the sell fails', async () => {
    mem.rows.push(bookedFlight());
    mem.sellFails = true;
    const result = (await rebookFlightTool.handler(args, ctx)) as {
      rebooked: boolean;
      stillBooked: string;
    };
    expect(result.rebooked).toBe(false);
    expect(result.stillBooked).toBe('ROLD11');
    // Nothing was retired and nothing was cancelled.
    expect(mem.rows[0].status).toBe('confirmed');
    expect(mem.events.some((e) => e.startsWith('cancel'))).toBe(false);
  });

  it('links the old booking to its replacement instead of just cancelling it', async () => {
    mem.rows.push(bookedFlight());
    await rebookFlightTool.handler(args, ctx);
    const old = mem.rows.find((r) => r.booking_reference === 'ROLD11')!;
    expect(old.status).toBe('superseded');
    expect(old.replaced_by).toBe(mem.rows.find((r) => r.booking_reference === 'RNEW11')!.id);
    expect(old.change_reason).toBe('Qatar cancelled the outbound');
  });

  it('never calls the old order cancelled when the release failed', async () => {
    mem.rows.push(bookedFlight());
    mem.cancelFails = true;
    const result = (await rebookFlightTool.handler(args, ctx)) as {
      rebooked: boolean;
      oldOrderReleased: boolean;
      warning?: string;
    };
    // The new flight is real and the patient must be told so; the old one is not
    // described as cancelled, because it is not.
    expect(result.rebooked).toBe(true);
    expect(result.oldOrderReleased).toBe(false);
    expect(result.warning).toContain('ROLD11');
    expect(result.warning).toMatch(/do not describe it as cancelled/i);
  });

  it('reports that the hotel no longer covers the new flights', async () => {
    mem.rows.push(bookedFlight());
    mem.rows.push({
      id: 'row-hotel',
      kind: 'hotel',
      status: 'confirmed',
      booking_reference: 'RHOT11',
      offer_id: 'h1',
      details: { checkIn: '2026-10-12', checkOut: '2026-10-18' },
      raw: {},
    });
    const result = (await rebookFlightTool.handler(args, ctx)) as {
      hotelNeedsRealignment?: { reference: string; now: { checkIn: string } };
      nextStep: string;
    };
    // The replacement lands on the 11th, so the room starting on the 12th is wrong.
    expect(result.hotelNeedsRealignment?.reference).toBe('RHOT11');
    expect(result.hotelNeedsRealignment?.now.checkIn).toBe('2026-10-11');
    expect(result.nextStep).toMatch(/rebook_hotel/);
  });

  it('refuses when there is nothing booked to replace', async () => {
    const result = (await rebookFlightTool.handler(args, ctx)) as { reason?: string };
    expect(result.reason).toBe('NOTHING_TO_REPLACE');
  });

  it('will not rebook a booking whose traveller details cannot be read back', async () => {
    const row = bookedFlight();
    row.raw = { bookedSlices: row.raw.bookedSlices };
    mem.rows.push(row);
    const result = (await rebookFlightTool.handler(args, ctx)) as {
      reason?: string;
      message?: string;
    };
    expect(result.reason).toBe('TRAVELLER_DETAILS_UNAVAILABLE');
    expect(result.message).toContain('ROLD11');
    expect(mem.events).toEqual([]);
  });

  it('never loses a reference it has already sold', async () => {
    // A status precondition on the wrong step once threw here, after a real flight
    // had been sold: two live orders, no record of the second, and the tool
    // reporting only a database error. The seat exists, so the reference does too.
    mem.rows.push(bookedFlight());
    mem.recordFails = true;
    const result = (await rebookFlightTool.handler(args, ctx)) as {
      rebooked: boolean;
      reason?: string;
      soldReference?: string;
      stillBooked?: string;
      message?: string;
    };
    expect(result.rebooked).toBe(false);
    expect(result.reason).toBe('SOLD_BUT_NOT_RECORDED');
    expect(result.soldReference).toBe('RNEW11');
    expect(result.stillBooked).toBe('ROLD11');
    expect(result.message).toMatch(/both bookings are live/i);
    // Nothing is cancelled on this path: an operator sorts it out, not a retry.
    expect(mem.events.some((e) => e.startsWith('cancel'))).toBe(false);
  });

  it('cannot be called while merely discussing a change', () => {
    expect(rebookFlightTool.schema.safeParse({ offerId: 'o2', reason: 'because' }).success).toBe(
      false,
    );
    expect(
      rebookFlightTool.schema.safeParse({ offerId: 'o2', confirmed: false, reason: 'because' })
        .success,
    ).toBe(false);
  });
});

describe('hotelFit', () => {
  const stay = { checkIn: '2026-10-12', checkOut: '2026-10-18', nights: 6 };

  it('is silent when the nights already match', () => {
    expect(
      hotelFit({ details: { checkIn: '2026-10-12', checkOut: '2026-10-18' } } as never, stay),
    ).toBeNull();
  });

  it('is silent when there is no room to realign', () => {
    expect(hotelFit(null, stay)).toBeNull();
  });

  it('reports a gap with both the old nights and the new ones', () => {
    const result = hotelFit(
      {
        booking_reference: 'RHOT11',
        details: { checkIn: '2026-10-13', checkOut: '2026-10-18' },
      } as never,
      stay,
    );
    expect(result).toEqual({
      coverage: 'gap',
      nightsBefore: 0,
      nightsAfter: 0,
      reference: 'RHOT11',
      was: { checkIn: '2026-10-13', checkOut: '2026-10-18' },
      now: stay,
    });
  });

  it('calls a room that starts the night before the flight lands covered, not wrong', () => {
    // An early arrival booked from the 11th on purpose, or a spare night left by a
    // flight change: either way the patient has a room when they land.
    const result = hotelFit(
      {
        booking_reference: 'RHOT11',
        details: { checkIn: '2026-10-11', checkOut: '2026-10-18' },
      } as never,
      stay,
    );
    expect(result).toMatchObject({ coverage: 'covers', nightsBefore: 1, nightsAfter: 0 });
  });

  it('treats a room with no dates on file as a gap rather than a match', () => {
    expect(hotelFit({ booking_reference: 'X', details: {} } as never, stay)).toMatchObject({
      coverage: 'gap',
    });
  });
});
