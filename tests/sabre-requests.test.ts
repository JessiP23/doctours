import { describe, expect, it } from 'vitest';
import { buildFlightShopRequest, buildHotelAvailRequest } from '@/lib/providers/sabre/requests';

describe('buildFlightShopRequest', () => {
  it('builds a round trip with cabin and ATPCO source', () => {
    const body = buildFlightShopRequest({
      origin: 'JFK',
      destination: 'IST',
      departDate: '2026-10-11',
      returnDate: '2026-10-17',
      adults: 1,
      cabin: 'economy',
      currency: 'USD',
    });
    expect(body.journeys).toHaveLength(2);
    expect(body.journeys[1]).toMatchObject({
      departureLocation: { airportCode: 'IST' },
      arrivalLocation: { airportCode: 'JFK' },
      departureDate: '2026-10-17',
    });
    expect(body.travelers).toEqual([{ passengerTypeCode: 'ADT' }]);
    expect(body.fare).toEqual({ cabin: { name: 'Economy' } });
    expect(body.sources.distributionModels).toEqual(['ATPCO']);
  });

  it('builds a one-way when returnDate is absent', () => {
    const body = buildFlightShopRequest({
      origin: 'JFK',
      destination: 'IST',
      departDate: '2026-10-11',
      adults: 2,
      cabin: 'business',
      currency: 'USD',
    });
    expect(body.journeys).toHaveLength(1);
    expect(body.travelers).toHaveLength(2);
    expect(body.fare.cabin.name).toBe('Business');
  });
});

describe('buildHotelAvailRequest', () => {
  const stay = { checkIn: '2026-10-12', checkOut: '2026-10-17', adults: 1, currency: 'USD' };
  it('targets specific hotel codes', () => {
    const body = buildHotelAvailRequest('ABCD', stay, { hotelCodes: ['100000238'] });
    const sc = body.GetHotelAvailRQ.SearchCriteria;
    expect(sc.HotelRefs?.HotelRef).toEqual([{ HotelCode: '100000238', CodeContext: 'GLOBAL' }]);
    expect(sc.GeoSearch).toBeUndefined();
    expect(sc.RateInfoRef.StayDateTimeRange).toEqual({
      StartDate: '2026-10-12',
      EndDate: '2026-10-17',
    });
    expect(body.GetHotelAvailRQ.POS.Source.PseudoCityCode).toBe('ABCD');
  });
  it('geo-searches around an airport code', () => {
    const body = buildHotelAvailRequest('ABCD', stay, { refPointCode: 'IST', radiusMiles: 15 });
    const sc = body.GetHotelAvailRQ.SearchCriteria;
    expect(sc.GeoSearch?.GeoRef.RefPoint).toEqual({
      Value: 'IST',
      ValueContext: 'CODE',
      RefPointType: '6',
    });
    expect(sc.GeoSearch?.GeoRef.Radius).toBe(15);
  });
});
