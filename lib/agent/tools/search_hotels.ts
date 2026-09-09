import { z } from 'zod';
import { DateTime } from 'luxon';
import * as repo from '@/lib/db/repo';
import type { Json } from '@/lib/db/types';
import { travelProvider } from '@/lib/providers/sabre';
import type { HotelProperty } from '@/lib/providers/types';
import { deriveStay } from '@/lib/trip/nights';
import { rulesFor } from './context';
import { defineTool } from './define';
import { bookedFlightSlices } from './hotel-booking';

/**
 * Other hotels, when the patient asks.
 *
 * The trip has a hotel by design — Doctours pins one, and every patient stays
 * there unless they say otherwise. This is the "otherwise": a real search around
 * the airport they land at, for the nights their flights imply, returning only
 * properties the provider actually quoted a rate for. Each one is persisted as an
 * offer so the id the model hands back to choose_hotel resolves to what Sabre
 * returned, not to a name the model remembered.
 *
 * Nothing here changes the trip. Choosing does.
 */
const MAX_SHOWN = 6;

export const searchHotelsTool = defineTool({
  name: 'search_hotels',
  description:
    'Only when the patient does not want the default hotel or asks what else there is: list other hotels near the airport they land at, for the nights their flights imply, each with its distance from the airport, address and the cheapest rate quoted for the stay. Returns hotelIds for choose_hotel. Does not change the trip.',
  schema: z.object({
    maxNightlyUSD: z
      .number()
      .positive()
      .optional()
      .describe('Only if the patient named a budget per night — leaves out hotels above it'),
  }),
  handler: async (input, ctx) => {
    const rules = await rulesFor(ctx.conversationId);

    // The stay the flights imply, or — before a flight is booked — the nights the
    // trip rules require, so the prices shown are for a stay that could be booked.
    const slices = await bookedFlightSlices(ctx.conversationId);
    const stay = slices
      ? deriveStay(slices[0], slices[1])
      : {
          checkIn: rules.mustArriveByLocal.slice(0, 10),
          checkOut: rules.earliestReturnDepartureLocal.slice(0, 10),
          nights: DateTime.fromISO(rules.earliestReturnDepartureLocal.slice(0, 10)).diff(
            DateTime.fromISO(rules.mustArriveByLocal.slice(0, 10)),
            'days',
          ).days,
        };
    const nearAirport = slices?.[0]?.segments.at(-1)?.to.iata ?? rules.destination;

    const properties = await travelProvider().searchHotels({
      nearAirport,
      checkIn: stay.checkIn,
      checkOut: stay.checkOut,
      adults: rules.adults,
      currency: rules.currency,
    });

    const withinBudget = input.maxNightlyUSD
      ? properties.filter(
          (p) => nightlyOf(p) === null || (nightlyOf(p) as number) <= input.maxNightlyUSD!,
        )
      : properties;
    const shown = withinBudget.slice(0, MAX_SHOWN);

    const rows = await repo.insertOffers(
      ctx.conversationId,
      shown.map((p) => ({
        kind: 'hotel_property' as const,
        provider: p.provider,
        providerOfferId: p.id,
        summary: {
          name: p.name,
          chain: p.chain,
          rating: p.rating,
          distanceFromAirport: p.distanceFromAirport,
          address: addressOf(p),
          leadTotalUSD: p.leadRate?.total.amount ?? null,
          leadNightlyUSD: nightlyOf(p),
          nights: p.leadRate?.nights ?? stay.nights,
          isCurrentHotel: p.id === rules.hotel.providerPropertyId,
        } as unknown as Json,
        raw: p as unknown as Json,
        expiresAt: null,
      })),
    );

    return {
      searchedAround: nearAirport,
      stay,
      travellers: rules.adults,
      currentHotel: rules.hotel.name,
      found: properties.length,
      ...(input.maxNightlyUSD
        ? { withinBudget: withinBudget.length, maxNightlyUSD: input.maxNightlyUSD }
        : {}),
      hotels: rows.map((row) => {
        const p = row.raw as unknown as HotelProperty;
        return {
          hotelId: row.id,
          ...(row.summary as object),
          distance: p.distanceFromAirport
            ? `${p.distanceFromAirport.miles} miles (${Math.round(p.distanceFromAirport.miles * 1.609344 * 10) / 10} km) from ${nearAirport}${p.distanceFromAirport.direction ? `, ${p.distanceFromAirport.direction}` : ''}`
            : 'distance not reported',
        };
      }),
      note:
        shown.length === 0
          ? 'No other hotel quoted a rate for these nights. Say so; do not name one the search did not return.'
          : `Cheapest first, priced for ${stay.nights} night(s) for ${rules.adults}. Distances are straight-line from the airport as the provider reports them. To switch the trip to one of these, call choose_hotel with its hotelId once the patient has picked it; then search_hotel_rates shows its rooms.`,
    };
  },
});

function nightlyOf(p: HotelProperty): number | null {
  if (p.leadRate?.nightly) return p.leadRate.nightly.amount;
  if (p.leadRate)
    return Number((p.leadRate.total.amount / Math.max(p.leadRate.nights, 1)).toFixed(2));
  return null;
}

function addressOf(p: HotelProperty): string | null {
  const l = p.location;
  if (!l) return null;
  const parts = [
    ...l.addressLines,
    [l.city, l.postalCode].filter(Boolean).join(' ').trim(),
    l.country,
  ].filter((x): x is string => typeof x === 'string' && x.length > 0);
  return parts.length > 0 ? parts.join(', ') : null;
}
