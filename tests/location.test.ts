import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { distanceKm, describeDistance } from '@/lib/trip/geo';
import {
  mapHotelDetailsResponse,
  type HotelDetailsResponse,
} from '@/lib/providers/sabre/hotel-mappers';
import { mapFlightShopResponse, type FlightShopResponse } from '@/lib/providers/sabre/mappers';

/**
 * A patient asked where their hotel was and was told the app did not know, while
 * the address sat in the response the room search had just made. A patient asked
 * which terminal and was told one nobody had sent. Both details are in the provider
 * payloads; these assert they survive the mappers, against the real fixtures.
 */
const fixture = <T>(name: string): T =>
  JSON.parse(readFileSync(path.resolve(process.cwd(), 'tests/fixtures/sabre', name), 'utf8'))
    .response as T;

describe('distance', () => {
  it('measures a known separation', () => {
    // Istanbul Airport as Sabre resolves IST, and the pinned property's coordinates.
    const airport = { latitude: 41.270556, longitude: 28.7425 };
    const hotel = { latitude: 41.0166, longitude: 28.929311 };
    const km = distanceKm(airport, hotel);
    expect(km).toBeGreaterThan(30);
    expect(km).toBeLessThan(40);
  });

  it('is zero for the same point and symmetric between two', () => {
    const a = { latitude: 41.0166, longitude: 28.929311 };
    const b = { latitude: -33.9249, longitude: 18.4241 };
    expect(distanceKm(a, a)).toBe(0);
    expect(distanceKm(a, b)).toBeCloseTo(distanceKm(b, a), 6);
  });

  it('reports whole units and says what kind of distance it is', () => {
    const described = describeDistance(
      { latitude: 41.270556, longitude: 28.7425 },
      { latitude: 41.0166, longitude: 28.929311 },
    );
    expect(Number.isInteger(described.km)).toBe(true);
    expect(Number.isInteger(described.miles)).toBe(true);
    expect(described.km).toBeGreaterThan(described.miles);
    expect(described.note).toMatch(/straight-line/i);
  });
});

describe('hotel location', () => {
  const response = fixture<HotelDetailsResponse>(
    'hotel-details-100071112-2026-10-12-2026-10-17.json',
  );

  it('carries the address, phone and coordinates the provider sent', () => {
    const { rates } = mapHotelDetailsResponse(
      response,
      { checkIn: '2026-10-12', checkOut: '2026-10-17', propertyId: '100071112' },
      'sabre',
    );
    expect(rates.length).toBeGreaterThan(0);
    const location = rates[0].location;
    expect(location?.addressLines[0]).toBeTruthy();
    expect(location?.city).toBe('Istanbul');
    expect(location?.country).toBe('Turkey');
    expect(location?.phone).toBeTruthy();
    expect(location?.coords?.latitude).toBeCloseTo(41.0166, 3);
  });

  it('reports no location rather than an empty one when the provider sends none', () => {
    const bare = {
      GetHotelDetailsRS: {
        ...response.GetHotelDetailsRS,
        HotelDetailsInfo: {
          ...response.GetHotelDetailsRS?.HotelDetailsInfo,
          HotelDescriptiveInfo: undefined,
        },
      },
    } as HotelDetailsResponse;
    const { rates } = mapHotelDetailsResponse(
      bare,
      { checkIn: '2026-10-12', checkOut: '2026-10-17', propertyId: '100071112' },
      'sabre',
    );
    expect(rates[0].location).toBeNull();
  });
});

describe('flight terminals', () => {
  it('carries a terminal through only when the provider filed one', () => {
    const { offers } = mapFlightShopResponse(
      fixture<FlightShopResponse>('flight-shop-2026-10-11-2026-10-17.json'),
      'sabre',
    );
    const segments = offers.flatMap((o) => o.slices.flatMap((s) => s.segments));
    expect(segments.length).toBeGreaterThan(0);
    // At least one real segment has a filed terminal, and none has an invented one:
    // every value present is a non-empty string, never a placeholder.
    const withTerminal = segments.filter((s) => s.departureTerminal || s.arrivalTerminal);
    expect(withTerminal.length).toBeGreaterThan(0);
    for (const s of segments) {
      if (s.departureTerminal !== undefined) expect(s.departureTerminal).not.toBe('');
      if (s.arrivalTerminal !== undefined) expect(s.arrivalTerminal).not.toBe('');
    }
  });
});

describe('describeProperty', () => {
  /**
   * The address formatting has to hold for whatever subset a provider sends: a
   * property with no postcode, no phone, no coordinates. Nothing may be filled in,
   * and a location with nothing usable must read as no location at all.
   */
  it('joins only the parts the provider gave', async () => {
    const { describeProperty } = await import('@/lib/agent/tools/property');
    const described = await describeProperty(
      {
        addressLines: ['Millet Cad 187'],
        city: 'Istanbul',
        postalCode: '34280',
        country: 'Turkey',
        phone: '90-212-5309900',
        coords: { latitude: 41.0166, longitude: 28.929311 },
      },
      undefined,
    );
    expect(described?.address).toBe('Millet Cad 187, Istanbul 34280, Turkey');
    expect(described?.phone).toBe('90-212-5309900');
    // No arrival airport was given, so no distance is claimed.
    expect(described?.distanceFromArrival).toBeUndefined();
  });

  it('omits what is missing instead of leaving a gap in the address', async () => {
    const { describeProperty } = await import('@/lib/agent/tools/property');
    const described = await describeProperty(
      {
        addressLines: ['12 Rue de Rivoli'],
        city: 'Paris',
        postalCode: null,
        country: null,
        phone: null,
        coords: null,
      },
      undefined,
    );
    expect(described?.address).toBe('12 Rue de Rivoli, Paris');
    expect(described?.phone).toBeUndefined();
    expect(described?.coordinates).toBeUndefined();
  });

  it('is null when there is no location to describe', async () => {
    const { describeProperty } = await import('@/lib/agent/tools/property');
    expect(await describeProperty(null, 'IST')).toBeNull();
  });
});
