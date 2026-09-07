import { describe, expect, it } from 'vitest';
import { anthropicTools, getTool, listTools } from '@/lib/agent/tools';

describe('the tool set the model is given', () => {
  it('is exactly the Level 0 six, with reply last', () => {
    expect(listTools().map((t) => t.name)).toEqual([
      'get_trip_state',
      'search_flights',
      'create_flight_order',
      'search_hotel_rates',
      'create_hotel_booking',
      'reply',
    ]);
  });

  it('exposes every tool with a valid object schema', () => {
    for (const tool of anthropicTools()) {
      expect(tool.input_schema.type).toBe('object');
      expect(tool.description!.length).toBeGreaterThan(30);
      expect(tool.input_schema).not.toHaveProperty('$schema');
    }
  });

  it('never lets the model set cabin, baggage, passengers or the route', () => {
    const properties = Object.keys(
      (getTool('search_flights')!.schema as unknown as { shape: Record<string, unknown> }).shape,
    );
    // Ranking and narrowing to a date the rules already allow are the only choices.
    expect(properties).toEqual(['rankBy', 'departOn', 'returnOn']);
    for (const forbidden of [
      'cabin',
      'checkedBags',
      'adults',
      'origin',
      'destination',
      'currency',
    ]) {
      expect(properties).not.toContain(forbidden);
    }
  });

  it('treats the date filters as optional so the default search covers every allowed date', () => {
    const schema = getTool('search_flights')!.schema;
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ rankBy: 'fewest_stops' }).success).toBe(true);
    expect(schema.safeParse({ returnOn: '17 October' }).success).toBe(false);
  });

  it('requires passport details to book a flight', () => {
    const schema = getTool('create_flight_order')!.schema;
    expect(schema.safeParse({ offerId: 'x' }).success).toBe(false);
    expect(
      schema.safeParse({
        offerId: 'x',
        passenger: {
          givenName: 'Jessi',
          familyName: 'Pavia',
          dateOfBirth: '1990-05-02',
          gender: 'F',
          email: 'j@example.com',
          phone: '+1 555 123 4567',
        },
      }).success,
    ).toBe(true);
  });

  it('rejects a malformed date of birth and a bad email', () => {
    const schema = getTool('create_flight_order')!.schema;
    const base = {
      offerId: 'x',
      passenger: {
        givenName: 'A',
        familyName: 'B',
        dateOfBirth: '02/05/1990',
        gender: 'F' as const,
        email: 'j@example.com',
        phone: '+15551234567',
      },
    };
    expect(schema.safeParse(base).success).toBe(false);
    expect(
      schema.safeParse({
        ...base,
        passenger: { ...base.passenger, dateOfBirth: '1990-05-02', email: 'nope' },
      }).success,
    ).toBe(false);
  });

  it('lets the hotel search run with no arguments so dates come from the flight', () => {
    expect(getTool('search_hotel_rates')!.schema.safeParse({}).success).toBe(true);
  });
});
