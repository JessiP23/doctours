import { describe, expect, it } from 'vitest';
import {
  buildCreateFlightBookingRequest,
  buildCreateHotelBookingRequest,
  buildFlightCheckRequest,
  buildFlightShopRequest,
  buildHotelAvailRequest,
  normalizeName,
  normalizePhone,
  sabreGender,
} from '@/lib/providers/sabre/requests';

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

/**
 * Patterns copied from Sabre's OpenAPI specs (Flight Check v1, Booking Management v1).
 * Anything that fails these is a 400 before the airline is ever consulted.
 */
const TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const PHONE = /^[0-9+-]+$/;
const NAME = /^[^\s]+(\s[^\s]+)*$/;
const SURNAME = /^[^\d\s]+( [^\d\s]+)*$/;

describe('buildFlightCheckRequest matches the Flight Check spec', () => {
  const flight = {
    departureAirportCode: 'JFK',
    departureDate: '2026-10-11',
    departureTime: '15:40',
    arrivalAirportCode: 'FRA',
    arrivalDate: '2026-10-12',
    arrivalTime: '05:15',
    operatingAirlineCode: 'LH',
    operatingFlightNumber: 401,
    marketingAirlineCode: 'UA',
    marketingFlightNumber: 8840,
    segmentDetails: { bookingClassCode: 'K' },
  };
  const body = buildFlightCheckRequest([[flight]], {
    adults: 1,
    pcc: 'ABCD',
    currency: 'USD',
    cabin: 'economy',
  });

  it('sends the PCC in processingOptions and fare qualifiers', () => {
    expect(body.processingOptions).toEqual({ pseudoCityCode: 'ABCD' });
    expect(body.fare).toEqual({ currencyCode: 'USD', cabin: { name: 'Economy' } });
    expect(body.travelers).toEqual([{ passengerTypeCode: 'ADT' }]);
  });

  it('keeps times as HH:mm and preserves the operating carrier on a codeshare', () => {
    const sent = body.journeys[0].flights[0];
    expect(sent.departureTime).toMatch(TIME);
    expect(sent.arrivalTime).toMatch(TIME);
    expect(sent.operatingAirlineCode).toBe('LH');
    expect(sent.marketingAirlineCode).toBe('UA');
    expect(sent.segmentDetails).toEqual({ bookingClassCode: 'K' });
  });
});

describe('Create Booking input normalization', () => {
  it('phones lose spaces and punctuation the spec rejects', () => {
    expect(normalizePhone('+1 646 387 5453')).toBe('+16463875453');
    expect(normalizePhone('(646) 387-5453')).toMatch(PHONE);
    expect(normalizePhone('+1 (646) 387 5453')).toMatch(PHONE);
    expect(normalizePhone('6463875453')).toBe('6463875453');
  });

  it('names collapse whitespace so they satisfy the name patterns', () => {
    expect(normalizeName('  Patricio   Estrella ')).toBe('Patricio Estrella');
    expect(normalizeName('  Patricio   Estrella ')).toMatch(NAME);
    expect(normalizeName('De la  Cruz')).toMatch(SURNAME);
  });

  it('maps passport gender codes to the Sabre enum', () => {
    expect(sabreGender('M')).toBe('MALE');
    expect(sabreGender('F')).toBe('FEMALE');
    expect(sabreGender('X')).toBe('UNDISCLOSED');
    expect(sabreGender(undefined)).toBeUndefined();
  });

  it('the flight booking request applies them and keeps HH:mm departure times', () => {
    const body = buildCreateFlightBookingRequest({
      pcc: 'ABCD',
      flights: [
        {
          flightNumber: 8840,
          airlineCode: 'UA',
          fromAirportCode: 'JFK',
          toAirportCode: 'FRA',
          departureDate: '2026-10-11',
          departureTime: '15:40',
          bookingClass: 'K',
        },
      ],
      travelers: [
        { givenName: ' Patricio ', surname: 'Estrella', birthDate: '1985-01-01', gender: 'MALE' },
      ],
      contact: { emails: ['p@example.com'], phones: ['+1 646 387 5453'] },
    });
    expect(body.travelers[0]).toMatchObject({
      givenName: 'Patricio',
      surname: 'Estrella',
      gender: 'MALE',
      passengerCode: 'ADT',
    });
    expect(body.contactInfo.phones).toEqual(['+16463875453']);
    expect(body.flightDetails.flights[0].departureTime).toMatch(TIME);
    expect(body.flightDetails.flights[0].flightStatusCode).toBe('NN');
    expect(body.targetPcc).toBe('ABCD');
  });
});

describe('buildCreateHotelBookingRequest', () => {
  const base = {
    pcc: 'ABCD',
    bookingKey: 'key-1',
    travelers: [{ givenName: 'Parkul', surname: 'Gumesh' }],
    contact: { emails: ['p@example.com'], phones: ['+1 646 387 5453'] },
    paymentPolicy: 'DEPOSIT',
  };
  const card = {
    type: 'VI',
    number: '4111111111111111',
    expiry: '2028-12',
    securityCode: '123',
    holder: { givenName: 'Doctours', surname: 'Travel' },
  };

  it('attaches the agency card and points the room at it when a card is configured', () => {
    const body = buildCreateHotelBookingRequest({ ...base, card });
    expect(body.hotel.formOfPayment).toBe(1);
    expect(body.payment?.formsOfPayment).toHaveLength(1);
    expect(body.payment?.formsOfPayment[0]).toMatchObject({
      type: 'PAYMENTCARD',
      cardTypeCode: 'VI',
      cardNumber: '4111111111111111',
      expiryDate: '2028-12',
      cardSecurityCode: '123',
      cardHolder: { givenName: 'Doctours', surname: 'Travel', phone: '+16463875453' },
    });
    expect(body.hotel).toMatchObject({
      useCsl: true,
      bookingKey: 'key-1',
      paymentPolicy: 'DEPOSIT',
    });
    expect(body.hotel.rooms).toEqual([{ travelerIndices: [1] }]);
  });

  it('sends no payment block when no card is configured', () => {
    const body = buildCreateHotelBookingRequest({ ...base, card: null });
    expect(body.payment).toBeUndefined();
    expect(body.hotel.formOfPayment).toBeUndefined();
  });

  it('normalizes the phone in both contact info and card holder', () => {
    const body = buildCreateHotelBookingRequest({ ...base, card });
    expect(body.contactInfo.phones).toEqual(['+16463875453']);
    expect(body.payment?.formsOfPayment[0].cardHolder.phone).toMatch(PHONE);
  });
});
