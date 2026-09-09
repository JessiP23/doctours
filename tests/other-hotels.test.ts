import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { TRIP_RULES, type TripRules } from '@/lib/trip/rules';
import type { HotelProperty } from '@/lib/providers/types';
import {
  mapHotelAvailResponse,
  type HotelAvailResponse,
} from '@/lib/providers/sabre/hotel-mappers';

/**
 * The hotel is set by design; a patient who does not want it gets real alternatives
 * and can make one of them the trip's hotel. These pin that the alternatives are
 * exactly what Sabre returned (names, distances, prices), that choosing changes the
 * trip's rules and nothing else, and that a room already held is left for
 * rebook_hotel rather than silently orphaned.
 */
const probe = JSON.parse(readFileSync('tests/fixtures/sabre/probe-3.json', 'utf8')) as {
  response: HotelAvailResponse;
};

describe('mapping a geo availability response', () => {
  it('returns every property Sabre priced, with its distance and lead rate as sent', () => {
    const { properties, unpriced } = mapHotelAvailResponse(probe.response, {
      checkIn: '2026-10-12',
      checkOut: '2026-10-17',
    });
    expect(unpriced).toBe(0);
    expect(properties.map((p) => p.name)).toEqual([
      'The Ritz-carlton Istanbul',
      'Holiday Inn City Istanbul',
      'Hilton Istanbul',
    ]);
    const holidayInn = properties[1];
    expect(holidayInn.id).toBe('100071112');
    expect(holidayInn.distanceFromAirport).toEqual({ miles: 20.06, direction: 'SE' });
    expect(holidayInn.leadRate).toMatchObject({
      total: { amount: 539.72, currency: 'USD' },
      nightly: { amount: 107.94, currency: 'USD' },
      nights: 5,
    });
    expect(holidayInn.rating).toBe('5.0');
  });

  it('reads coordinates that arrive as strings', () => {
    const { properties } = mapHotelAvailResponse(probe.response, {
      checkIn: '2026-10-12',
      checkOut: '2026-10-17',
    });
    expect(properties[0].location?.coords).toEqual({ latitude: 41.009633, longitude: 28.965165 });
    expect(properties[0].location?.addressLines).toEqual(['Suzer Plaza', 'Askerocagi Cad. No. 9']);
  });

  it('leaves out a property with no quoted rate and counts it', () => {
    const { properties, unpriced } = mapHotelAvailResponse(
      {
        GetHotelAvailRS: {
          HotelAvailInfos: {
            HotelAvailInfo: [
              { HotelInfo: { HotelCode: '1', HotelName: 'No Price Inn' } },
              {
                HotelInfo: { HotelCode: '2', HotelName: 'Priced Inn', Distance: '3.5', UOM: 'MI' },
                HotelRateInfo: {
                  RateInfos: {
                    ConvertedRateInfo: { AmountAfterTax: '400', CurrencyCode: 'USD' },
                  },
                },
              },
            ],
          },
        },
      },
      { checkIn: '2026-10-12', checkOut: '2026-10-16' },
    );
    expect(unpriced).toBe(1);
    expect(properties).toHaveLength(1);
    expect(properties[0]).toMatchObject({
      name: 'Priced Inn',
      distanceFromAirport: { miles: 3.5, direction: null },
      leadRate: { total: { amount: 400, currency: 'USD' }, nightly: null, nights: 4 },
    });
  });

  it('is empty, not broken, when Sabre returns nothing', () => {
    expect(mapHotelAvailResponse({}, { checkIn: 'x', checkOut: 'y' })).toEqual({
      properties: [],
      unpriced: 0,
    });
  });
});

// ---- the tools ---------------------------------------------------------------

const mem = {
  rules: { ...TRIP_RULES } as TripRules,
  bookings: [] as Record<string, unknown>[],
  offers: new Map<string, Record<string, unknown>>(),
  lastAreaSearch: null as null | Record<string, unknown>,
};

vi.mock('@/lib/db/repo', () => ({
  getConversation: vi.fn(async () => ({ id: 'c1', trip_rules: mem.rules })),
  updateTripRules: vi.fn(async (_id: string, rules: unknown) => {
    mem.rules = rules as TripRules;
  }),
  getLiveBooking: vi.fn(
    async (_id: string, kind: string) =>
      mem.bookings.find((b) => b.kind === kind && b.status === 'confirmed') ?? null,
  ),
  getOffer: vi.fn(async (_id: string, offerId: string) => mem.offers.get(offerId) ?? null),
  insertOffers: vi.fn(async (_id: string, offers: Record<string, unknown>[]) => {
    const rows = offers.map((o, i) => ({ id: `h-${mem.offers.size + i + 1}`, ...o }));
    for (const r of rows) mem.offers.set(r.id as string, r);
    return rows;
  }),
}));

vi.mock('@/lib/providers/sabre', () => ({
  travelProvider: () => ({
    searchHotels: vi.fn(async (q: Record<string, unknown>) => {
      mem.lastAreaSearch = q;
      return mapHotelAvailResponse(probe.response, q as { checkIn: string; checkOut: string })
        .properties;
    }),
  }),
}));

const { searchHotelsTool } = await import('@/lib/agent/tools/search_hotels');
const { chooseHotelTool } = await import('@/lib/agent/tools/choose_hotel');
const ctx = { conversationId: 'c1' };

beforeEach(() => {
  mem.rules = { ...TRIP_RULES };
  mem.bookings = [];
  mem.offers.clear();
  mem.lastAreaSearch = null;
});

describe('search_hotels', () => {
  it('searches around the destination for the nights the rules require when no flight is booked', async () => {
    const result = (await searchHotelsTool.handler({}, ctx)) as unknown as {
      searchedAround: string;
      stay: { checkIn: string; checkOut: string; nights: number };
      hotels: {
        hotelId: string;
        name: string;
        distance: string;
        leadTotalUSD: number;
        isCurrentHotel: boolean;
      }[];
    };
    expect(mem.lastAreaSearch).toMatchObject({
      nearAirport: 'IST',
      checkIn: '2026-10-12',
      checkOut: '2026-10-17',
      adults: 1,
      currency: 'USD',
    });
    expect(result.searchedAround).toBe('IST');
    expect(result.stay.nights).toBe(5);
    expect(result.hotels.map((h) => h.name)).toEqual([
      'The Ritz-carlton Istanbul',
      'Holiday Inn City Istanbul',
      'Hilton Istanbul',
    ]);
    // The default is in the list and marked, so the agent can say "the one you have".
    expect(result.hotels[1].isCurrentHotel).toBe(true);
    expect(result.hotels[0].isCurrentHotel).toBe(false);
    expect(result.hotels[1].distance).toBe('20.06 miles (32.3 km) from IST, SE');
    expect(result.hotels[1].leadTotalUSD).toBe(539.72);
    // Every hotel shown is a persisted offer the choose tool can load.
    for (const h of result.hotels) expect(mem.offers.get(h.hotelId)).toBeDefined();
  });

  it('respects a nightly budget the patient named, and says how many fit', async () => {
    const result = (await searchHotelsTool.handler({ maxNightlyUSD: 150 }, ctx)) as unknown as {
      found: number;
      withinBudget: number;
      hotels: { name: string }[];
    };
    expect(result.found).toBe(3);
    expect(result.withinBudget).toBe(1);
    expect(result.hotels.map((h) => h.name)).toEqual(['Holiday Inn City Istanbul']);
  });
});

describe('choose_hotel', () => {
  async function shortlist() {
    const result = (await searchHotelsTool.handler({}, ctx)) as unknown as {
      hotels: { hotelId: string; name: string }[];
    };
    return Object.fromEntries(result.hotels.map((h) => [h.name, h.hotelId]));
  }

  it('makes the chosen property the trip hotel, with only what the property stated', async () => {
    const ids = await shortlist();
    const result = (await chooseHotelTool.handler(
      { hotelId: ids['Hilton Istanbul'], theyToldMe: true },
      ctx,
    )) as {
      changed: boolean;
      hotel: string;
      previousHotel: string;
      checkInFrom: string;
      nextStep: string;
    };
    expect(result.changed).toBe(true);
    expect(result.hotel).toBe('Hilton Istanbul');
    expect(result.previousHotel).toBe('Holiday Inn City Istanbul');
    expect(mem.rules.hotel).toMatchObject({
      providerPropertyId: '100162280',
      name: 'Hilton Istanbul',
      isDefault: false,
    });
    // The avail response carries no check-in policy, so none is invented.
    expect(mem.rules.hotel.checkInTime).toBeNull();
    expect(result.checkInFrom).toBe('not stated by the hotel');
    expect(result.nextStep).toMatch(/search_hotel_rates/);
    // Nothing else about the trip moved.
    expect(mem.rules.adults).toBe(TRIP_RULES.adults);
    expect(mem.rules.procedureAtLocal).toBe(TRIP_RULES.procedureAtLocal);
  });

  it('is a no-op when they pick the hotel they already have', async () => {
    const ids = await shortlist();
    const result = (await chooseHotelTool.handler(
      { hotelId: ids['Holiday Inn City Istanbul'], theyToldMe: true },
      ctx,
    )) as { changed: boolean };
    expect(result.changed).toBe(false);
    expect(mem.rules.hotel.isDefault).toBe(true);
  });

  it('refuses an id that did not come from a search', async () => {
    await expect(
      chooseHotelTool.handler({ hotelId: 'made-up', theyToldMe: true }, ctx),
    ).rejects.toThrow(/use search_hotels first/);
    expect(mem.rules.hotel.providerPropertyId).toBe('100071112');
  });

  it('leaves a room already held where it is and says how to move it', async () => {
    mem.bookings.push({ kind: 'hotel', status: 'confirmed', booking_reference: 'ROOM01' });
    const ids = await shortlist();
    const result = (await chooseHotelTool.handler(
      { hotelId: ids['The Ritz-carlton Istanbul'], theyToldMe: true },
      ctx,
    )) as { roomStillHeldAt?: { reference: string }; nextStep: string };
    expect(result.roomStillHeldAt?.reference).toBe('ROOM01');
    expect(result.nextStep).toMatch(/rebook_hotel/);
    expect(mem.rules.hotel.name).toBe('The Ritz-carlton Istanbul');
  });

  it('will not accept a choice the patient did not make', () => {
    expect(chooseHotelTool.schema.safeParse({ hotelId: 'h-1' }).success).toBe(false);
    expect(chooseHotelTool.schema.safeParse({ hotelId: 'h-1', theyToldMe: false }).success).toBe(
      false,
    );
  });
});

describe('the properties as offers', () => {
  it('stores the provider result whole, so nothing about a hotel is reconstructed later', async () => {
    await searchHotelsTool.handler({}, ctx);
    const stored = [...mem.offers.values()][0];
    expect(stored.kind).toBe('hotel_property');
    const raw = stored.raw as HotelProperty;
    expect(raw.name).toBe('The Ritz-carlton Istanbul');
    expect(raw.location?.phone).toBe('90-212-3344444');
  });
});
