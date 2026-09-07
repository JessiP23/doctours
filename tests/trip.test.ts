import { describe, expect, it } from 'vitest';
import type { FlightOffer, FlightSegment, FlightSlice } from '@/lib/providers/types';
import { TRIP_RULES } from '@/lib/trip/rules';
import {
  partitionOffers,
  validateOffer,
  validateOutbound,
  validateReturn,
} from '@/lib/trip/validate';
import { deriveStay } from '@/lib/trip/nights';

const JFK = { iata: 'JFK', tz: 'America/New_York' };
const IST = { iata: 'IST', tz: 'Europe/Istanbul' };
const FRA = { iata: 'FRA', tz: 'Europe/Berlin' };

function seg(
  p: Partial<FlightSegment> & Pick<FlightSegment, 'from' | 'to' | 'departLocal' | 'arriveLocal'>,
): FlightSegment {
  return { carrier: 'TK', flightNumber: '1', cabin: 'economy', durationMin: 600, ...p };
}
function slice(...segments: FlightSegment[]): FlightSlice {
  return { segments, stops: segments.length - 1, durationMin: 0 };
}
const outboundOk = slice(
  seg({ from: JFK, to: IST, departLocal: '2026-10-11T23:55', arriveLocal: '2026-10-12T17:15' }),
);
const returnOk = slice(
  seg({ from: IST, to: JFK, departLocal: '2026-10-17T14:30', arriveLocal: '2026-10-17T18:05' }),
);

function offer(slices: FlightSlice[], p: Partial<FlightOffer> = {}): FlightOffer {
  return {
    id: 'o1',
    provider: 'test',
    slices,
    price: { amount: 700, currency: 'USD' },
    cabin: 'economy',
    checkedBagsIncluded: 0,
    expiresAt: null,
    raw: {},
    ...p,
  };
}

describe('validateOutbound — must be on the ground by Oct 12 20:00 Istanbul', () => {
  it('accepts 19:59', () => {
    const s = slice(
      seg({ from: JFK, to: IST, departLocal: '2026-10-12T05:00', arriveLocal: '2026-10-12T19:59' }),
    );
    expect(validateOutbound(s, TRIP_RULES)).toEqual({ ok: true });
  });
  it('accepts exactly 20:00 (inclusive)', () => {
    const s = slice(
      seg({ from: JFK, to: IST, departLocal: '2026-10-12T05:00', arriveLocal: '2026-10-12T20:00' }),
    );
    expect(validateOutbound(s, TRIP_RULES)).toEqual({ ok: true });
  });
  it('rejects 20:01', () => {
    const s = slice(
      seg({ from: JFK, to: IST, departLocal: '2026-10-12T05:00', arriveLocal: '2026-10-12T20:01' }),
    );
    expect(validateOutbound(s, TRIP_RULES)).toMatchObject({ ok: false, code: 'ARRIVES_TOO_LATE' });
  });
  it('rejects an arrival on Oct 13 even at 00:05', () => {
    const s = slice(
      seg({ from: JFK, to: IST, departLocal: '2026-10-12T09:00', arriveLocal: '2026-10-13T00:05' }),
    );
    expect(validateOutbound(s, TRIP_RULES)).toMatchObject({ ok: false, code: 'ARRIVES_TOO_LATE' });
  });
  it('accepts an early arrival on Oct 11', () => {
    const s = slice(
      seg({ from: JFK, to: IST, departLocal: '2026-10-10T22:00', arriveLocal: '2026-10-11T15:30' }),
    );
    expect(validateOutbound(s, TRIP_RULES)).toEqual({ ok: true });
  });
  it('uses the final segment of a connecting itinerary', () => {
    const s = slice(
      seg({ from: JFK, to: FRA, departLocal: '2026-10-11T18:00', arriveLocal: '2026-10-12T07:30' }),
      seg({ from: FRA, to: IST, departLocal: '2026-10-12T17:00', arriveLocal: '2026-10-12T21:00' }),
    );
    expect(validateOutbound(s, TRIP_RULES)).toMatchObject({ ok: false, code: 'ARRIVES_TOO_LATE' });
  });
  it('rejects wrong destination', () => {
    const s = slice(
      seg({ from: JFK, to: FRA, departLocal: '2026-10-11T18:00', arriveLocal: '2026-10-12T07:30' }),
    );
    expect(validateOutbound(s, TRIP_RULES)).toMatchObject({ ok: false, code: 'WRONG_DESTINATION' });
  });
});

describe('validateReturn — cannot fly home before Oct 17 12:00 Istanbul', () => {
  it('accepts exactly 12:00', () => {
    const s = slice(
      seg({ from: IST, to: JFK, departLocal: '2026-10-17T12:00', arriveLocal: '2026-10-17T16:00' }),
    );
    expect(validateReturn(s, TRIP_RULES)).toEqual({ ok: true });
  });
  it('rejects 11:59', () => {
    const s = slice(
      seg({ from: IST, to: JFK, departLocal: '2026-10-17T11:59', arriveLocal: '2026-10-17T16:00' }),
    );
    expect(validateReturn(s, TRIP_RULES)).toMatchObject({ ok: false, code: 'RETURNS_TOO_EARLY' });
  });
  it('accepts Oct 18', () => {
    const s = slice(
      seg({ from: IST, to: JFK, departLocal: '2026-10-18T07:00', arriveLocal: '2026-10-18T11:00' }),
    );
    expect(validateReturn(s, TRIP_RULES)).toEqual({ ok: true });
  });
});

describe('validateOffer', () => {
  it('accepts a compliant round trip', () => {
    expect(validateOffer(offer([outboundOk, returnOk]), TRIP_RULES)).toEqual({ ok: true });
  });
  it('rejects non-USD pricing', () => {
    expect(
      validateOffer(
        offer([outboundOk, returnOk], { price: { amount: 700, currency: 'EUR' } }),
        TRIP_RULES,
      ),
    ).toMatchObject({ code: 'WRONG_CURRENCY' });
  });
  it('rejects a business-class segment', () => {
    const biz = slice({ ...outboundOk.segments[0], cabin: 'business' });
    expect(validateOffer(offer([biz, returnOk]), TRIP_RULES)).toMatchObject({
      code: 'WRONG_CABIN',
    });
  });
  it('partitions offers with reasons', () => {
    const late = slice(
      seg({ from: JFK, to: IST, departLocal: '2026-10-12T09:00', arriveLocal: '2026-10-12T23:00' }),
    );
    const { valid, rejected } = partitionOffers(
      [offer([outboundOk, returnOk], { id: 'good' }), offer([late, returnOk], { id: 'late' })],
      TRIP_RULES,
    );
    expect(valid.map((o) => o.id)).toEqual(['good']);
    expect(rejected[0]).toMatchObject({ code: 'ARRIVES_TOO_LATE' });
    expect(rejected[0].reason).toMatch(/11:00 PM/);
  });
});

describe('deriveStay', () => {
  it('Oct 12 arrival, Oct 17 departure → 5 nights', () => {
    expect(deriveStay(outboundOk, returnOk)).toEqual({
      checkIn: '2026-10-12',
      checkOut: '2026-10-17',
      nights: 5,
    });
  });
  it('Oct 11 arrival adds a night', () => {
    const early = slice(
      seg({ from: JFK, to: IST, departLocal: '2026-10-10T22:00', arriveLocal: '2026-10-11T15:30' }),
    );
    expect(deriveStay(early, returnOk)).toEqual({
      checkIn: '2026-10-11',
      checkOut: '2026-10-17',
      nights: 6,
    });
  });
  it('uses the arrival date in Istanbul time, not the departure date', () => {
    const overnight = slice(
      seg({ from: JFK, to: IST, departLocal: '2026-10-11T23:55', arriveLocal: '2026-10-12T17:15' }),
    );
    expect(deriveStay(overnight, returnOk).checkIn).toBe('2026-10-12');
  });
});

describe('codeshare sourcing rule', () => {
  const codeshareOut = slice({
    ...outboundOk.segments[0],
    carrier: 'UA',
    flightNumber: '8842',
    operatingCarrier: 'LH',
    operatingFlightNumber: '405',
  });
  const onlineOut = slice({
    ...outboundOk.segments[0],
    carrier: 'TK',
    flightNumber: '12',
    operatingCarrier: 'TK',
    operatingFlightNumber: '12',
  });

  it('rejects an itinerary with a codeshare segment when the rules disallow them, naming both airlines', () => {
    const r = validateOffer(offer([codeshareOut, returnOk]), {
      ...TRIP_RULES,
      allowCodeshares: false,
    });
    expect(r).toMatchObject({ ok: false, code: 'CODESHARE_NOT_ALLOWED' });
    expect((r as { reason: string }).reason).toMatch(/UA8842.*sold by UA.*flown by LH/);
  });

  it('accepts the same itinerary when codeshares are allowed', () => {
    expect(
      validateOffer(offer([codeshareOut, returnOk]), { ...TRIP_RULES, allowCodeshares: true }),
    ).toEqual({ ok: true });
  });

  it('accepts flights operated by the airline that sells them', () => {
    expect(
      validateOffer(offer([onlineOut, returnOk]), { ...TRIP_RULES, allowCodeshares: false }),
    ).toEqual({ ok: true });
  });

  it('does not treat a segment with no operating carrier information as a codeshare', () => {
    expect(
      validateOffer(offer([outboundOk, returnOk]), { ...TRIP_RULES, allowCodeshares: false }),
    ).toEqual({ ok: true });
  });
});

describe('applyPreferences — patient wishes over the rule-valid set', () => {
  const tk = (id: string, stops: number, depart: string, ret: string, price: number) =>
    offer(
      [
        stops === 0
          ? slice(
              seg({
                from: JFK,
                to: IST,
                departLocal: depart,
                arriveLocal: '2026-10-12T17:00',
                carrier: 'TK',
              }),
            )
          : slice(
              seg({
                from: JFK,
                to: FRA,
                departLocal: depart,
                arriveLocal: '2026-10-12T07:00',
                carrier: 'LH',
              }),
              seg({
                from: FRA,
                to: IST,
                departLocal: '2026-10-12T09:00',
                arriveLocal: '2026-10-12T13:00',
                carrier: 'LH',
              }),
            ),
        slice(
          seg({
            from: IST,
            to: JFK,
            departLocal: ret,
            arriveLocal: '2026-10-17T22:00',
            carrier: 'TK',
          }),
        ),
      ],
      { id, price: { amount: price, currency: 'USD' } },
    );
  const pool = [
    tk('nonstop-evening', 0, '2026-10-11T23:55', '2026-10-17T14:00', 1200),
    tk('nonstop-morning', 0, '2026-10-11T08:10', '2026-10-17T14:00', 1300),
    tk('onestop-cheap', 1, '2026-10-11T18:00', '2026-10-17T14:00', 900),
  ];

  it('defaults to cheapest', async () => {
    const { applyPreferences } = await import('@/lib/trip/select');
    expect(applyPreferences(pool, {}).map((o) => o.id)).toEqual([
      'onestop-cheap',
      'nonstop-evening',
      'nonstop-morning',
    ]);
  });

  it('non-stop only', async () => {
    const { applyPreferences } = await import('@/lib/trip/select');
    expect(applyPreferences(pool, { maxStops: 0 }).map((o) => o.id)).toEqual([
      'nonstop-evening',
      'nonstop-morning',
    ]);
  });

  it('restricts to an airline, case-insensitively', async () => {
    const { applyPreferences } = await import('@/lib/trip/select');
    expect(applyPreferences(pool, { airlines: ['tk'] }).map((o) => o.id)).toEqual([
      'nonstop-evening',
      'nonstop-morning',
    ]);
    expect(applyPreferences(pool, { airlines: ['LH'] })).toEqual([]); // the return is TK, so nothing is all-LH
  });

  it('a morning departure window', async () => {
    const { applyPreferences } = await import('@/lib/trip/select');
    expect(
      applyPreferences(pool, { departBetween: { from: '06:00', to: '12:00' } }).map((o) => o.id),
    ).toEqual(['nonstop-morning']);
  });

  it('a window crossing midnight catches the 23:55 departure', async () => {
    const { applyPreferences } = await import('@/lib/trip/select');
    expect(
      applyPreferences(pool, { departBetween: { from: '22:00', to: '02:00' } }).map((o) => o.id),
    ).toEqual(['nonstop-evening']);
  });

  it('ranks by fewest stops with price as the tie-break', async () => {
    const { applyPreferences } = await import('@/lib/trip/select');
    expect(applyPreferences(pool, { rankBy: 'fewest_stops' }).map((o) => o.id)).toEqual([
      'nonstop-evening',
      'nonstop-morning',
      'onestop-cheap',
    ]);
  });

  it('describes what exists so the agent can answer "is there a non-stop?" truthfully', async () => {
    const { describeChoices } = await import('@/lib/trip/select');
    expect(describeChoices(pool)).toEqual({
      total: 3,
      nonStop: 2,
      carriers: { TK: 2, LH: 1 },
      cheapestUSD: 900,
    });
  });
});
