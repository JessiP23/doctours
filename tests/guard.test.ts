import { describe, expect, it } from 'vitest';
import { checkAnnouncedActions, checkReferences } from '@/lib/agent/guard';

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

describe('checkAnnouncedActions', () => {
  const acted = { actedThisTurn: true, expectsInput: false };
  const idle = { actedThisTurn: false, expectsInput: false };

  it('flags a closing reply that says it is booking when nothing was booked', () => {
    const r = checkAnnouncedActions(
      ['You got it.', 'Booking it now with the details you gave me.'],
      idle,
    );
    expect(r.ok).toBe(false);
    expect(r.announced).toMatch(/booking it/i);
  });

  it('allows it when a booking tool actually ran', () => {
    expect(checkAnnouncedActions(['Booking it now.'], acted).ok).toBe(true);
  });

  it('allows a conditional promise that waits for the patient', () => {
    expect(
      checkAnnouncedActions(["I'll book it as soon as you confirm the price."], {
        actedThisTurn: false,
        expectsInput: true,
      }).ok,
    ).toBe(true);
  });

  it('leaves ordinary replies alone', () => {
    expect(checkAnnouncedActions(['The cheapest is $742 on Turkish.', 'Want it?'], idle).ok).toBe(
      true,
    );
    expect(checkAnnouncedActions(['Your flight is booked, reference ABC12D.'], idle).ok).toBe(true);
  });

  it('catches the other ways of announcing a booking', () => {
    for (const phrase of [
      "I'm booking that for you.",
      'Let me book this.',
      "I'll get that booked.",
    ]) {
      expect(checkAnnouncedActions([phrase], idle).ok).toBe(false);
    }
  });
});
