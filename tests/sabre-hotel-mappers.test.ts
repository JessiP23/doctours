import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  cheapestFirst,
  mapHotelDetailsResponse,
  type HotelDetailsResponse,
} from '@/lib/providers/sabre/hotel-mappers';
import { TRIP_RULES } from '@/lib/trip/rules';

/** Real Get Hotel Details response for the pinned property, from the CERT smoke run. */
const FIXTURE = path.resolve(
  process.cwd(),
  'tests/fixtures/sabre/hotel-details-100071112-2026-10-12-2026-10-17.json',
);
const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { response: HotelDetailsResponse };
const fallback = { checkIn: '2026-10-12', checkOut: '2026-10-17', propertyId: '100071112' };

describe('mapHotelDetailsResponse against the real CERT payload', () => {
  const { rates, skipped } = mapHotelDetailsResponse(fixture.response, fallback);

  it('finds bookable room rates and skips nothing', () => {
    expect(rates.length).toBeGreaterThan(20);
    expect(skipped).toEqual([]);
  });

  it('identifies the pinned property', () => {
    expect(rates[0].propertyId).toBe(TRIP_RULES.hotel.providerPropertyId);
    expect(rates[0].propertyName).toBe(TRIP_RULES.hotel.name);
  });

  it('carries what booking needs: rate key and product code', () => {
    for (const rate of rates) {
      expect(rate.id.length).toBeGreaterThan(50); // opaque Sabre RateKey
      expect(rate.productCode).toBeTruthy();
    }
  });

  it('prices the stay in USD with a total that covers the nights', () => {
    for (const rate of rates) {
      expect(rate.total.currency).toBe('USD');
      expect(rate.total.amount).toBeGreaterThan(0);
      expect(rate.nights).toBe(5);
      expect(rate.checkIn).toBe('2026-10-12');
      expect(rate.checkOut).toBe('2026-10-17');
    }
  });

  it('describes the room well enough to choose between options', () => {
    const withBeds = rates.filter((r) => r.bedTypes.length > 0);
    expect(withBeds.length).toBeGreaterThan(0);
    const standard = rates.find((r) => r.roomName.toLowerCase().includes('standard'));
    expect(standard?.roomDescription).toMatch(/Bed|Room/i);
    expect(rates.some((r) => r.maxOccupancy !== null)).toBe(true);
    expect(rates.some((r) => r.mealPlan)).toBe(true);
  });

  it('reports cancellation terms when the provider states them', () => {
    const refundable = rates.filter((r) => r.refundable === true);
    expect(refundable.length).toBeGreaterThan(0);
    expect(refundable[0].cancelBy).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('cheapestFirst puts the lowest total first', () => {
    const sorted = cheapestFirst(rates);
    const totals = sorted.map((r) => r.total.amount);
    expect([...totals].sort((a, b) => a - b)).toEqual(totals);
    expect(sorted[0].total.amount).toBeLessThanOrEqual(rates[0].total.amount);
  });
});

describe('mapHotelDetailsResponse fails soft', () => {
  it('skips a rate plan with no RateKey and keeps the rest', () => {
    const response = {
      GetHotelDetailsRS: {
        HotelDetailsInfo: {
          HotelInfo: { HotelCode: 'H1', HotelName: 'Test Hotel' },
          HotelRateInfo: {
            RoomSets: {
              // a single object rather than an array — Sabre does this
              RoomSet: {
                Room: [
                  {
                    RoomType: 'Standard Room',
                    RatePlans: {
                      RatePlan: [
                        {
                          RatePlanName: 'no key',
                          ConvertedRateInfo: { AmountAfterTax: '100.00', CurrencyCode: 'USD' },
                        },
                        {
                          RatePlanName: 'good',
                          RateKey: 'K'.repeat(60),
                          ProductCode: 'PC1',
                          ConvertedRateInfo: {
                            StartDate: '2026-10-12',
                            EndDate: '2026-10-17',
                            AmountAfterTax: '500.00',
                            CurrencyCode: 'USD',
                          },
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        },
      },
    };
    const { rates, skipped } = mapHotelDetailsResponse(response, fallback);
    expect(rates).toHaveLength(1);
    expect(rates[0].ratePlanName).toBe('good');
    // nightly is derived when the provider omits an average
    expect(rates[0].nightly.amount).toBe(100);
    expect(skipped).toEqual([
      { room: 'Standard Room / no key', reason: 'rate plan has no RateKey' },
    ]);
  });

  it('returns nothing rather than throwing on an empty response', () => {
    expect(mapHotelDetailsResponse({}, fallback)).toEqual({ rates: [], skipped: [] });
  });
});
