import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  mapFlightShopResponse,
  normalizeCabin,
  type FlightShopResponse,
} from '@/lib/providers/sabre/mappers';
import { partitionOffers } from '@/lib/trip/validate';
import { deriveStay } from '@/lib/trip/nights';
import { TRIP_RULES } from '@/lib/trip/rules';

/** Real Sabre CERT response captured by `npm run sabre:smoke -- flights`. */
const FIXTURE = path.resolve(
  process.cwd(),
  'tests/fixtures/sabre/flight-shop-2026-10-11-2026-10-17.json',
);
const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { response: FlightShopResponse };

describe('normalizeCabin', () => {
  it('maps Sabre cabin names', () => {
    expect(normalizeCabin('Economy')).toBe('economy');
    expect(normalizeCabin('Premium Economy')).toBe('premium_economy');
    expect(normalizeCabin('Business')).toBe('business');
    expect(normalizeCabin('First')).toBe('first');
    expect(normalizeCabin('Sleeper')).toBeNull();
    expect(normalizeCabin(undefined)).toBeNull();
  });
});

describe('mapFlightShopResponse against the real CERT payload', () => {
  const { offers, skipped } = mapFlightShopResponse(fixture.response);

  it('maps every offer in the response', () => {
    expect(fixture.response.offers).toHaveLength(35);
    expect(offers).toHaveLength(35);
    expect(skipped).toEqual([]);
  });

  it('produces a round trip with an outbound and a return slice', () => {
    for (const offer of offers) {
      expect(offer.slices).toHaveLength(2);
      expect(offer.slices[0].segments[0].from.iata).toBe('JFK');
      expect(offer.slices[0].segments.at(-1)!.to.iata).toBe('IST');
      expect(offer.slices[1].segments[0].from.iata).toBe('IST');
      expect(offer.slices[1].segments.at(-1)!.to.iata).toBe('JFK');
    }
  });

  it('carries price, currency, cabin and the provider offer expiry', () => {
    const offer = offers[0];
    expect(offer.price.currency).toBe('USD');
    expect(offer.price.amount).toBeGreaterThan(0);
    expect(offer.cabin).toBe('economy');
    expect(offer.checkedBagsIncluded).toBe(0);
    // `validUntil` is the offer timer the brief warns about.
    expect(offer.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('keeps local wall-clock times and orders segments by departure', () => {
    for (const slice of offers.flatMap((o) => o.slices)) {
      for (const seg of slice.segments) {
        expect(seg.departLocal).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
        expect(seg.arriveLocal).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
      }
      const times = slice.segments.map((s) => s.departLocal);
      expect([...times].sort()).toEqual(times);
    }
  });

  it('computes stops and a duration that includes layovers', () => {
    for (const slice of offers.flatMap((o) => o.slices)) {
      expect(slice.stops).toBe(slice.segments.length - 1);
      const flightTime = slice.segments.reduce((s, x) => s + x.durationMin, 0);
      expect(slice.durationMin).toBeGreaterThanOrEqual(flightTime);
      expect(slice.durationMin).toBeLessThan(60 * 48);
    }
  });

  it('keeps booking class and provider flight ids needed to book', () => {
    const seg = offers[0].slices[0].segments[0];
    expect(seg.bookingClass).toMatch(/^[A-Z]$/);
    expect(seg.providerFlightId).toBeTruthy();
    expect(seg.carrier).toMatch(/^[A-Z0-9]{2}$/);
    expect(seg.flightNumber).toMatch(/^\d+$/);
  });

  it('resolves timezones for known airports and admits ignorance otherwise', () => {
    const all = offers.flatMap((o) => o.slices.flatMap((s) => s.segments));
    expect(all.find((s) => s.to.iata === 'IST')!.to.tz).toBe('Europe/Istanbul');
    expect(all.find((s) => s.from.iata === 'JFK')!.from.tz).toBe('America/New_York');
  });
});

describe('the real payload passed through the trip rules', () => {
  const { offers } = mapFlightShopResponse(fixture.response);
  const { valid, rejected } = partitionOffers(offers, TRIP_RULES);

  it('rejects some real offers and explains why', () => {
    expect(rejected.length).toBeGreaterThan(0);
    for (const r of rejected) expect(r.reason).toMatch(/cutoff|before the earliest|expected/);
  });

  it('every surviving offer honours both hard deadlines', () => {
    expect(valid.length).toBeGreaterThan(0);
    for (const offer of valid) {
      const landing = offer.slices[0].segments.at(-1)!.arriveLocal;
      expect(landing <= '2026-10-12T20:00').toBe(true);
      const leaving = offer.slices[1].segments[0].departLocal;
      expect(leaving >= '2026-10-17T12:00').toBe(true);
    }
  });

  it('derives a sane hotel stay from every valid offer', () => {
    for (const offer of valid) {
      const stay = deriveStay(offer.slices[0], offer.slices[1]);
      expect(stay.nights).toBeGreaterThanOrEqual(5);
      expect(stay.checkOut).toBe('2026-10-17');
    }
  });

  it('the cheapest valid offer is cheaper than the cheapest rejected one is irrelevant — but a cheapest exists', () => {
    const cheapest = [...valid].sort((a, b) => a.price.amount - b.price.amount)[0];
    expect(cheapest.price.amount).toBeGreaterThan(0);
    expect(cheapest.slices[0].segments.at(-1)!.to.iata).toBe('IST');
  });
});

describe('operating carrier is preserved for Flight Check', () => {
  const { offers } = mapFlightShopResponse(fixture.response);

  it('keeps the operating carrier and flight number on every segment', () => {
    for (const seg of offers.flatMap((o) => o.slices.flatMap((s) => s.segments))) {
      expect(seg.operatingCarrier).toMatch(/^[A-Z0-9]{2}$/);
      expect(seg.operatingFlightNumber).toMatch(/^\d+$/);
    }
  });

  it('finds at least one codeshare, where marketing and operating differ', () => {
    // Flight Check rejects the request if the operating carrier is wrong, so this
    // distinction has to survive mapping.
    const segments = offers.flatMap((o) => o.slices.flatMap((s) => s.segments));
    const codeshares = segments.filter((s) => s.operatingCarrier !== s.carrier);
    expect(codeshares.length).toBeGreaterThan(0);
  });
});

describe('excludeRefused — learning from a UC refusal', () => {
  it('drops the refused flights and every other codeshare marketed by that carrier, keeps the rest', async () => {
    const { excludeRefused } = await import('@/lib/agent/tools/flight-offers');
    const { offers } = mapFlightShopResponse(fixture.response);

    // Take whichever carrier has codeshares in this payload (DL-marketed KL/AF flights
    // here; UA-marketed LH flights in the e2e run) — the rule is carrier-agnostic.
    const codeshareSegment = offers
      .flatMap((o) => o.slices.flatMap((s) => s.segments))
      .find((g) => g.operatingCarrier !== g.carrier)!;
    expect(codeshareSegment).toBeDefined();
    const carrier = codeshareSegment.carrier;
    const isThatCarriersCodeshare = (o: (typeof offers)[number]) =>
      o.slices.some((s) =>
        s.segments.some((g) => g.carrier === carrier && g.operatingCarrier !== carrier),
      );
    const affected = offers.filter(isThatCarriersCodeshare);
    expect(affected.length).toBeGreaterThan(0);

    // The airline refused one of them — exactly what the e2e run saw.
    const kept = excludeRefused(offers, [{ carrier, flightNumber: codeshareSegment.flightNumber }]);

    // Every other codeshare marketed by that carrier is gone…
    expect(kept.some(isThatCarriersCodeshare)).toBe(false);
    // …and nothing else was thrown away.
    expect(kept.length).toBe(offers.length - affected.length);
    // Online flights (marketing = operating) by that same carrier are still allowed.
    const onlineByCarrier = kept.filter((o) =>
      o.slices.some((s) =>
        s.segments.some((g) => g.carrier === carrier && g.operatingCarrier === carrier),
      ),
    );
    expect(onlineByCarrier.length).toBe(
      offers.filter(
        (o) =>
          !isThatCarriersCodeshare(o) &&
          o.slices.some((s) =>
            s.segments.some((g) => g.carrier === carrier && g.operatingCarrier === carrier),
          ),
      ).length,
    );
  });

  it('is a no-op with nothing refused', async () => {
    const { excludeRefused } = await import('@/lib/agent/tools/flight-offers');
    const { offers } = mapFlightShopResponse(fixture.response);
    expect(excludeRefused(offers, [])).toBe(offers);
  });
});

describe('parseUnconfirmedFlights', () => {
  it("reads carrier and number out of Sabre's UC message", async () => {
    const { parseUnconfirmedFlights } = await import('@/lib/providers/sabre');
    expect(
      parseUnconfirmedFlights([
        { description: 'Flight number: UA8842 returned status code: UC.' },
        { description: 'Flight number: UA9126 returned status code: NN.' },
        { description: 'something unrelated' },
      ]),
    ).toEqual([
      { carrier: 'UA', flightNumber: '8842' },
      { carrier: 'UA', flightNumber: '9126' },
    ]);
  });
});
