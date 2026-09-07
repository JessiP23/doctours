import { describe, expect, it } from 'vitest';
import { checkReferences } from '@/lib/agent/guard';

describe('checkReferences', () => {
  it('passes a reference that matches a real booking', () => {
    expect(checkReferences(['You’re all set, your reference is ABC12D.'], ['ABC12D'])).toEqual({
      ok: true,
      violations: [],
    });
  });

  it('flags a fabricated reference when nothing is booked', () => {
    const r = checkReferences(['Booked! Your confirmation is XYZ789.'], []);
    expect(r.ok).toBe(false);
    expect(r.violations).toEqual(['XYZ789']);
  });

  it('flags a reference that differs from the one on file', () => {
    expect(checkReferences(['Reference ABCDEF.'], ['GHIJKL']).violations).toEqual(['ABCDEF']);
  });

  it('is case-insensitive about known references', () => {
    expect(checkReferences(['Reference ABC12D.'], ['abc12d']).ok).toBe(true);
  });

  it('ignores prices, times, airport codes and ordinary words', () => {
    const bubbles = [
      'Cheapest is $742 on Turkish, lands 4:15 pm local on the 12th.',
      'It’s JFK to IST, economy, no checked bags, 5 nights in ISTANBUL.',
      'That’s 2026, flight TK1, gate 10.',
    ];
    expect(checkReferences(bubbles, [])).toEqual({ ok: true, violations: [] });
  });

  it('does not flag all-caps travel words of locator length', () => {
    expect(checkReferences(['Your ECONOMY fare and REFUND terms.'], []).ok).toBe(true);
  });

  it('collects each violation once', () => {
    const r = checkReferences(['Ref QWE123.', 'Again QWE123 and RTY456.'], []);
    expect(r.violations.sort()).toEqual(['QWE123', 'RTY456']);
  });
});
