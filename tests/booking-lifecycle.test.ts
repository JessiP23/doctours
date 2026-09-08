import { describe, expect, it } from 'vitest';
import type { BookingRow } from '@/lib/db/types';
import { buildTripState, nextStep } from '@/lib/agent/state';
import { TRIP_RULES } from '@/lib/trip/rules';

/**
 * The state projection is what the prompt is built from, so a cancelled or
 * superseded booking leaking into it would make the agent tell a patient they
 * hold a trip they do not.
 */
function booking(
  p: Partial<BookingRow> & Pick<BookingRow, 'kind' | 'status' | 'booking_reference'>,
): BookingRow {
  return {
    id: p.booking_reference,
    conversation_id: 'c1',
    provider: 'sabre',
    provider_order_id: p.booking_reference,
    replaced_by: null,
    cancelled_at: null,
    change_reason: null,
    offer_id: null,
    details: {},
    raw: {},
    created_at: '2026-09-07T00:00:00Z',
    updated_at: '2026-09-07T00:00:00Z',
    ...p,
  } as BookingRow;
}

describe('live trip projection across the booking lifecycle', () => {
  it('counts only confirmed bookings as held', () => {
    const state = buildTripState(
      TRIP_RULES,
      [
        booking({ kind: 'flight', status: 'superseded', booking_reference: 'OLD111' }),
        booking({ kind: 'flight', status: 'confirmed', booking_reference: 'NEW222' }),
        booking({ kind: 'hotel', status: 'cancelled', booking_reference: 'DEAD33' }),
      ],
      [],
    );
    expect(state.bookings.flight?.booking_reference).toBe('NEW222');
    expect(state.bookings.hotel).toBeNull();
  });

  it('a cancelled flight leaves the trip needing a flight again', () => {
    const state = buildTripState(
      TRIP_RULES,
      [booking({ kind: 'flight', status: 'cancelled', booking_reference: 'GONE11' })],
      [],
    );
    expect(state.bookings.flight).toBeNull();
    expect(nextStep(state)).toBe('flight');
  });

  it('a rebooked flight with the hotel still held moves on to the hotel', () => {
    const state = buildTripState(
      TRIP_RULES,
      [
        booking({
          kind: 'flight',
          status: 'superseded',
          booking_reference: 'OLD111',
          replaced_by: 'NEW222',
        }),
        booking({ kind: 'flight', status: 'confirmed', booking_reference: 'NEW222' }),
      ],
      [],
    );
    expect(nextStep(state)).toBe('hotel');
  });

  it('both confirmed means nothing left to do', () => {
    const state = buildTripState(
      TRIP_RULES,
      [
        booking({ kind: 'flight', status: 'confirmed', booking_reference: 'FLT111' }),
        booking({ kind: 'hotel', status: 'confirmed', booking_reference: 'HTL222' }),
      ],
      [],
    );
    expect(nextStep(state)).toBe('done');
  });

  it('an empty history is a trip that has not started', () => {
    const state = buildTripState(TRIP_RULES, [], []);
    expect(nextStep(state)).toBe('flight');
    expect(state.bookings).toEqual({ flight: null, hotel: null });
  });
});
