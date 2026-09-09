import { DateTime } from 'luxon';
import type { BookingRow, OfferRow } from '@/lib/db/types';
import type { TripRules } from '@/lib/trip/rules';

/**
 * The options board: everything the agent has put on the table, laid out so it can
 * be compared at a glance instead of read out of chat bubbles.
 *
 * Nothing here is fetched or computed anew. Every card is an offer the agent has
 * already shown — the same rows the prompt renders and the booking tools accept —
 * so the board can never show a price the conversation did not, and choosing a
 * card is just saying so in the chat. The only additions are the facts a patient
 * compares on and the agent states in prose: how far inside the deadlines a flight
 * lands, how many nights it implies, and what the trip costs when a room for those
 * nights is also on the table.
 */
export interface FlightCard {
  kind: 'flight';
  id: string;
  carrier: string;
  priceUSD: number;
  outbound: { departLocal: string; arriveLocal: string; stops: number; via: string[] };
  inbound: { departLocal: string; arriveLocal: string; stops: number; via: string[] };
  nights: number;
  checkIn: string;
  checkOut: string;
  /** Hours between landing and the must-arrive-by deadline (positive = inside it). */
  hoursBeforeDeadline: number | null;
  /** Hours between the earliest allowed return and the actual departure. */
  hoursAfterEarliestReturn: number | null;
  badges: ('cheapest' | 'fewest stops' | 'shortest' | 'non-stop')[];
  /** A room on the table for exactly these nights, if any — makes a trip total. */
  room: { id: string; totalUSD: number; name: string } | null;
  tripTotalUSD: number | null;
  expired: boolean;
  booked: string | null;
  /** What the patient says to take it — the conversation stays the interface. */
  pick: string;
}

export interface RoomCard {
  kind: 'room';
  id: string;
  name: string;
  beds: string[];
  sleeps: number | null;
  nightlyUSD: number;
  totalUSD: number;
  nights: number;
  checkIn: string | null;
  checkOut: string | null;
  refundable: boolean | null;
  fromTheNightBefore: boolean;
  badges: ('cheapest' | 'refundable' | 'night before')[];
  booked: string | null;
  pick: string;
}

export interface HotelCard {
  kind: 'hotel';
  id: string;
  name: string;
  distance: string | null;
  address: string | null;
  leadTotalUSD: number | null;
  leadNightlyUSD: number | null;
  nights: number | null;
  isCurrentHotel: boolean;
  badges: ('current' | 'cheapest' | 'closest')[];
  pick: string;
}

export interface OptionBoard {
  flights: FlightCard[];
  rooms: RoomCard[];
  hotels: HotelCard[];
  /** How many cards there are to compare; the UI hides the board below two. */
  count: number;
  rules: {
    mustArriveByLocal: string;
    earliestReturnDepartureLocal: string;
    hotel: string;
    travellers: number;
  };
}

type FlightSummary = {
  priceUSD: number;
  carrier: string;
  outbound: {
    departLocal: string;
    arriveLocal: string;
    stops: number;
    via: string[];
    durationHours?: number;
  };
  inbound: { departLocal: string; arriveLocal: string; stops: number; via: string[] };
  hotelNights: number;
  checkIn: string;
  checkOut: string;
};

type RoomSummary = {
  room: string;
  beds?: string[];
  sleeps?: number | null;
  nightlyUSD: number;
  totalUSD: number;
  nights: number;
  checkIn?: string;
  checkOut?: string;
  refundable?: boolean | null;
  fromTheNightBefore?: boolean;
};

type HotelSummary = {
  name: string;
  distanceFromAirport?: { miles: number; direction: string | null } | null;
  address?: string | null;
  leadTotalUSD?: number | null;
  leadNightlyUSD?: number | null;
  nights?: number | null;
  isCurrentHotel?: boolean;
};

function hours(from: string, to: string, zone: string): number | null {
  const a = DateTime.fromISO(from, { zone });
  const b = DateTime.fromISO(to, { zone });
  if (!a.isValid || !b.isValid) return null;
  return Math.round(b.diff(a, 'hours').hours * 10) / 10;
}

function clock(local: string, zone: string): string {
  return DateTime.fromISO(local, { zone }).toFormat('d LLL, h:mm a');
}

export function buildOptionBoard(
  rules: TripRules,
  bookings: BookingRow[],
  offers: OfferRow[],
  now = DateTime.now(),
): OptionBoard {
  const live = bookings.filter((b) => b.status === 'confirmed');
  const bookedByOffer = new Map(
    live.filter((b) => b.offer_id).map((b) => [b.offer_id as string, b.booking_reference]),
  );
  const tz = rules.destinationTz;

  const roomRows = offers.filter((o) => o.kind === 'hotel_rate');
  const rooms: RoomCard[] = roomRows.map((row) => {
    const s = row.summary as RoomSummary;
    return {
      kind: 'room',
      id: row.id,
      name: s.room,
      beds: s.beds ?? [],
      sleeps: s.sleeps ?? null,
      nightlyUSD: s.nightlyUSD,
      totalUSD: s.totalUSD,
      nights: s.nights,
      checkIn: s.checkIn ?? null,
      checkOut: s.checkOut ?? null,
      refundable: s.refundable ?? null,
      fromTheNightBefore: s.fromTheNightBefore === true,
      badges: [],
      booked: bookedByOffer.get(row.id) ?? null,
      pick: `I'll take the ${s.room} for $${s.totalUSD}${s.fromTheNightBefore ? ', from the night before' : ''}.`,
    };
  });
  if (rooms.length > 0) {
    const cheapest = Math.min(...rooms.map((r) => r.totalUSD));
    for (const r of rooms) {
      if (r.totalUSD === cheapest) r.badges.push('cheapest');
      if (r.refundable) r.badges.push('refundable');
      if (r.fromTheNightBefore) r.badges.push('night before');
    }
  }

  const flightRows = offers.filter((o) => o.kind === 'flight');
  const flights: FlightCard[] = flightRows.map((row) => {
    const s = row.summary as FlightSummary;
    const stops = s.outbound.stops + s.inbound.stops;
    // The cheapest room on the table for exactly these nights, not from the night
    // before: the total is what this flight costs with a room that matches it.
    const matching = rooms
      .filter((r) => r.checkIn === s.checkIn && r.checkOut === s.checkOut && !r.fromTheNightBefore)
      .sort((a, b) => a.totalUSD - b.totalUSD)[0];
    return {
      kind: 'flight',
      id: row.id,
      carrier: s.carrier,
      priceUSD: s.priceUSD,
      outbound: {
        departLocal: s.outbound.departLocal,
        arriveLocal: s.outbound.arriveLocal,
        stops: s.outbound.stops,
        via: s.outbound.via,
      },
      inbound: {
        departLocal: s.inbound.departLocal,
        arriveLocal: s.inbound.arriveLocal,
        stops: s.inbound.stops,
        via: s.inbound.via,
      },
      nights: s.hotelNights,
      checkIn: s.checkIn,
      checkOut: s.checkOut,
      hoursBeforeDeadline: hours(s.outbound.arriveLocal, rules.mustArriveByLocal, tz),
      hoursAfterEarliestReturn: hours(
        rules.earliestReturnDepartureLocal,
        s.inbound.departLocal,
        tz,
      ),
      badges: stops === 0 ? ['non-stop'] : [],
      room: matching ? { id: matching.id, totalUSD: matching.totalUSD, name: matching.name } : null,
      tripTotalUSD: matching ? Math.round((s.priceUSD + matching.totalUSD) * 100) / 100 : null,
      expired: row.expires_at ? DateTime.fromISO(row.expires_at) < now : false,
      booked: bookedByOffer.get(row.id) ?? null,
      pick: `I'll take the ${s.carrier} flight leaving ${clock(s.outbound.departLocal, rules.originTz)} for $${s.priceUSD}.`,
    };
  });
  if (flights.length > 0) {
    const cheapest = Math.min(...flights.map((f) => f.priceUSD));
    const fewest = Math.min(...flights.map((f) => f.outbound.stops + f.inbound.stops));
    for (const f of flights) {
      if (f.priceUSD === cheapest) f.badges.push('cheapest');
      if (f.outbound.stops + f.inbound.stops === fewest && flights.length > 1)
        f.badges.push('fewest stops');
    }
  }

  const hotelRows = offers.filter((o) => o.kind === 'hotel_property');
  const hotels: HotelCard[] = hotelRows.map((row) => {
    const s = row.summary as HotelSummary;
    const d = s.distanceFromAirport;
    return {
      kind: 'hotel',
      id: row.id,
      name: s.name,
      distance: d
        ? `${d.miles} mi (${Math.round(d.miles * 1.609344 * 10) / 10} km) from the airport`
        : null,
      address: s.address ?? null,
      leadTotalUSD: s.leadTotalUSD ?? null,
      leadNightlyUSD: s.leadNightlyUSD ?? null,
      nights: s.nights ?? null,
      isCurrentHotel: s.isCurrentHotel === true,
      badges: s.isCurrentHotel ? ['current'] : [],
      pick: `I'd like to stay at ${s.name}.`,
    };
  });
  if (hotels.length > 0) {
    const priced = hotels.filter((h) => h.leadTotalUSD !== null);
    const cheapest = Math.min(...priced.map((h) => h.leadTotalUSD as number));
    for (const h of priced) if (h.leadTotalUSD === cheapest) h.badges.push('cheapest');
    const withDistance = hotelRows
      .map((row, i) => ({ i, miles: (row.summary as HotelSummary).distanceFromAirport?.miles }))
      .filter((x): x is { i: number; miles: number } => typeof x.miles === 'number');
    if (withDistance.length > 1) {
      const closest = withDistance.reduce((a, b) => (b.miles < a.miles ? b : a));
      hotels[closest.i].badges.push('closest');
    }
  }

  return {
    flights,
    rooms,
    hotels,
    count: flights.length + rooms.length + hotels.length,
    rules: {
      mustArriveByLocal: rules.mustArriveByLocal,
      earliestReturnDepartureLocal: rules.earliestReturnDepartureLocal,
      hotel: rules.hotel.name,
      travellers: rules.adults,
    },
  };
}
