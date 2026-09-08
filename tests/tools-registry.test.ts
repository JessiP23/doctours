import { describe, expect, it } from 'vitest';
import { anthropicTools, getTool, listTools } from '@/lib/agent/tools';

describe('the tool set the model is given', () => {
  it('is exactly the registered set, with reply last', () => {
    expect(listTools().map((t) => t.name)).toEqual([
      'get_trip_state',
      'set_party_size',
      'search_flights',
      'create_flight_order',
      'search_hotel_rates',
      'create_hotel_booking',
      'rebook_flight',
      'rebook_hotel',
      'cancel_trip',
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
    // Ranking, soft preferences, and narrowing to a date the rules already allow.
    expect(properties).toEqual([
      'rankBy',
      'maxStops',
      'airlines',
      'departBetween',
      'returnBetween',
      'departOn',
      'returnOn',
    ]);
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

  it('requires passport details for every traveller to book a flight', () => {
    const schema = getTool('create_flight_order')!.schema;
    const passenger = {
      givenName: 'Jessi',
      familyName: 'Pavia',
      dateOfBirth: '1990-05-02',
      gender: 'F',
      email: 'j@example.com',
      phone: '+1 555 123 4567',
    };
    expect(schema.safeParse({ offerId: 'x' }).success).toBe(false);
    // An empty list is not a booking, and a single passenger is no longer a special case.
    expect(schema.safeParse({ offerId: 'x', passengers: [] }).success).toBe(false);
    expect(schema.safeParse({ offerId: 'x', passengers: [passenger] }).success).toBe(true);
    expect(
      schema.safeParse({
        offerId: 'x',
        passengers: [passenger, { ...passenger, givenName: 'Sam' }],
      }).success,
    ).toBe(true);
  });

  it('will not let the model choose the traveller count out of range', () => {
    const schema = getTool('set_party_size')!.schema;
    expect(schema.safeParse({ travellers: 0, theyToldMe: true }).success).toBe(false);
    expect(schema.safeParse({ travellers: 1, theyToldMe: true }).success).toBe(true);
    expect(schema.safeParse({ travellers: 4, theyToldMe: true }).success).toBe(true);
    expect(schema.safeParse({ travellers: 5, theyToldMe: true }).success).toBe(false);
    expect(schema.safeParse({ travellers: 2.5, theyToldMe: true }).success).toBe(false);
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

describe('cancel_trip cannot be called casually', () => {
  const schema = () => getTool('cancel_trip')!.schema;

  it('refuses without an explicit confirmation', () => {
    expect(
      schema().safeParse({ scope: 'both', reason: 'patient changed their mind' }).success,
    ).toBe(false);
    expect(
      schema().safeParse({ scope: 'both', confirmed: false, reason: 'patient changed their mind' })
        .success,
    ).toBe(false);
  });

  it('requires a reason, so the operator record is never empty', () => {
    expect(schema().safeParse({ scope: 'both', confirmed: true }).success).toBe(false);
    expect(schema().safeParse({ scope: 'both', confirmed: true, reason: 'x' }).success).toBe(false);
  });

  it('accepts a confirmed cancellation with a reason', () => {
    expect(
      schema().safeParse({
        scope: 'both',
        confirmed: true,
        reason: 'Procedure postponed indefinitely',
      }).success,
    ).toBe(true);
  });

  it('can cancel a single leg', () => {
    for (const scope of ['flight', 'hotel', 'both']) {
      expect(
        schema().safeParse({ scope, confirmed: true, reason: 'patient asked' }).success,
        scope,
      ).toBe(true);
    }
    expect(
      schema().safeParse({ scope: 'everything', confirmed: true, reason: 'patient asked' }).success,
    ).toBe(false);
  });

  it('defaults to cancelling the whole trip', () => {
    const parsed = schema().safeParse({ confirmed: true, reason: 'patient asked to cancel' });
    expect(parsed.success).toBe(true);
    expect(parsed.success && (parsed.data as { scope: string }).scope).toBe('both');
  });
});
