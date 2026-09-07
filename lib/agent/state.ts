import type { BookingRow, OfferRow } from '@/lib/db/types';
import type { TripRules } from '@/lib/trip/rules';

/**
 * TripState is the projection of DB rows the model is told about every turn.
 * The model never has to "remember" — it is shown what is booked, what offers
 * are on the table, and what is still missing.
 */
export interface TripState {
  rules: TripRules;
  bookings: { flight: BookingRow | null; hotel: BookingRow | null };
  offers: { flights: OfferRow[]; hotelRates: OfferRow[] };
}

export function buildTripState(
  rules: TripRules,
  bookings: BookingRow[],
  offers: OfferRow[],
): TripState {
  const live = bookings.filter((b) => b.status === 'confirmed');
  return {
    rules,
    bookings: {
      flight: live.find((b) => b.kind === 'flight') ?? null,
      hotel: live.find((b) => b.kind === 'hotel') ?? null,
    },
    offers: {
      flights: offers.filter((o) => o.kind === 'flight'),
      hotelRates: offers.filter((o) => o.kind === 'hotel_rate'),
    },
  };
}

export function nextStep(state: TripState): 'flight' | 'hotel' | 'done' {
  if (!state.bookings.flight) return 'flight';
  if (!state.bookings.hotel) return 'hotel';
  return 'done';
}
