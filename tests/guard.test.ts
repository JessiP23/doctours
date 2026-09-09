import { describe, expect, it } from 'vitest';
import { checkAnnouncedActions, checkReferences, checkRaisedEvents } from '@/lib/agent/guard';

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
  const idle = { bookedThisTurn: false, searchedThisTurn: false, expectsInput: false };
  const booked = { bookedThisTurn: true, searchedThisTurn: false, expectsInput: false };
  const searched = { bookedThisTurn: false, searchedThisTurn: true, expectsInput: false };

  it('flags a closing reply that says it is booking when nothing was booked', () => {
    const r = checkAnnouncedActions(
      ['You got it.', 'Booking it now with the details you gave me.'],
      idle,
    );
    expect(r.ok).toBe(false);
    expect(r.kind).toBe('booking');
    expect(r.announced).toMatch(/booking it/i);
  });

  it('allows it when a booking tool actually ran', () => {
    expect(checkAnnouncedActions(['Booking it now.'], booked).ok).toBe(true);
  });

  // Both of these were said in a real conversation, and neither tool was called.
  it('flags "let me find you a room" when no search ran', () => {
    const r = checkAnnouncedActions(
      ["You'll stay 6 nights.", 'Let me find you a room at the Holiday Inn City Istanbul now.'],
      booked, // the flight was booked this turn, but the promised room search was not
    );
    expect(r.ok).toBe(false);
    expect(r.kind).toBe('retrieval');
  });

  it('flags "let me pull up the room rates" when no search ran', () => {
    const r = checkAnnouncedActions(
      ["Let me pull up the room rates for your dates and we'll get you sorted."],
      idle,
    );
    expect(r.ok).toBe(false);
    expect(r.kind).toBe('retrieval');
  });

  it('allows a retrieval promise when the search did run', () => {
    expect(checkAnnouncedActions(['Let me pull up the room rates.'], searched).ok).toBe(true);
  });

  it('allows a conditional promise that waits for the patient', () => {
    expect(
      checkAnnouncedActions(["I'll book it as soon as you confirm the price."], {
        ...idle,
        expectsInput: true,
      }).ok,
    ).toBe(true);
  });

  it('leaves ordinary replies alone', () => {
    expect(checkAnnouncedActions(['The cheapest is $742 on Turkish.', 'Want it?'], idle).ok).toBe(
      true,
    );
    expect(checkAnnouncedActions(['Your flight is booked, reference ABC12D.'], booked).ok).toBe(
      true,
    );
  });

  it('does not mistake ordinary phrases for promises', () => {
    // "let me know" and "I'll get back to you" promise nothing the agent must do now.
    for (const phrase of [
      'Let me know which one you prefer.',
      "I'll get back to you with the confirmation by email.",
      'Check your email for the confirmation.',
    ]) {
      expect(checkAnnouncedActions([phrase], idle).ok, phrase).toBe(true);
    }
  });

  it('catches the other ways of announcing work', () => {
    for (const phrase of [
      "I'm booking that for you.",
      'Let me book this.',
      "I'll get that booked.",
    ]) {
      expect(checkAnnouncedActions([phrase], idle).kind, phrase).toBe('booking');
    }
    for (const phrase of [
      'Let me check the rates.',
      "I'll look up the options.",
      'Pulling those up now.',
      'One moment while I search.',
    ]) {
      expect(checkAnnouncedActions([phrase], idle).kind, phrase).toBe('retrieval');
    }
  });

  it('catches "let me try again" said after a failure with no retry behind it', () => {
    // Verbatim from a live run: the hotel booking failed, the agent said this, and
    // the turn ended. The patient waited on nothing.
    for (const phrase of [
      'I ran into an issue booking the room just now. Let me try again.',
      "I'll try that again.",
      'Trying again now.',
      "I'll give it another go.",
    ]) {
      expect(checkAnnouncedActions([phrase], idle).kind, phrase).toBe('retry');
    }
    // Kept by whichever tool could be the retry.
    expect(checkAnnouncedActions(['Let me try again.'], { ...idle, bookedThisTurn: true }).ok).toBe(
      true,
    );
    expect(
      checkAnnouncedActions(['Let me try again.'], { ...idle, searchedThisTurn: true }).ok,
    ).toBe(true);
    // And not when the turn waits for the patient.
    expect(checkAnnouncedActions(['Let me try again.'], { ...idle, expectsInput: true }).ok).toBe(
      true,
    );
  });
});

describe('checkRaisedEvents', () => {
  /**
   * An airline cancellation outranks whatever the patient typed. The check is
   * shallow by design — it asks whether the words appear at all, not whether the
   * explanation is good — because the failure it exists to stop is the reply that
   * answers the question and never mentions the cancellation.
   */
  it('passes a reply that names the cancellation', () => {
    expect(
      checkRaisedEvents(
        ['Qatar cancelled your outbound flight.', 'Let me find you another way in.'],
        ['flight_cancelled'],
      ).ok,
    ).toBe(true);
  });

  it('fails a reply that buries the cancellation after the options', () => {
    // Verbatim from a live run: the word appears, the news does not. The patient read
    // two replacement flights before learning anything had gone wrong.
    const check = checkRaisedEvents(
      [
        'Here are your replacement options, all on Qatar Airways:',
        'Option 1: Leave JFK October 11 at 11:20 am … $833 total.',
        'Both are the same price as your cancelled flight and work with your hotel dates.',
      ],
      ['flight_cancelled'],
    );
    expect(check.ok).toBe(false);
  });

  it('fails a reply that answers the question and skips the cancellation', () => {
    const check = checkRaisedEvents(
      ['You land at 11:55 am local on the 12th.', 'Anything else?'],
      ['flight_cancelled'],
    );
    expect(check.ok).toBe(false);
    expect(check.unraised).toEqual(['flight_cancelled']);
  });

  it('accepts the words a schedule change is actually described with', () => {
    for (const bubble of [
      'Your return times moved by twenty minutes.',
      'Qatar shifted the Doha connection earlier.',
      'There is a schedule change on the way home.',
    ]) {
      expect(checkRaisedEvents([bubble], ['flight_schedule_change']).ok).toBe(true);
    }
  });

  it('is silent when there is nothing untold', () => {
    expect(checkRaisedEvents(['You land at 11:55 am.'], []).ok).toBe(true);
  });

  it('knows the words a hotel cancellation is described with', () => {
    expect(
      checkRaisedEvents(['The hotel has released your room for the 12th.'], ['hotel_cancelled']).ok,
    ).toBe(true);
    expect(
      checkRaisedEvents(['Your flights are all set for the 11th.'], ['hotel_cancelled']).ok,
    ).toBe(false);
  });

  it('knows the words a moved procedure is described with', () => {
    for (const bubble of [
      'The clinic has moved your procedure to Tuesday 20 October at 8:00 am.',
      'Your procedure has been rescheduled — it is now on the 20th.',
      'Your appointment is now on 20 October, a week later than planned.',
    ]) {
      expect(checkRaisedEvents([bubble], ['procedure_moved']).ok).toBe(true);
    }
    expect(checkRaisedEvents(['You land at 5:30 am on the 12th.'], ['procedure_moved']).ok).toBe(
      false,
    );
  });

  it('does not judge a kind it has no words for', () => {
    expect(checkRaisedEvents(['Anything else?'], ['hotel_closed']).ok).toBe(true);
  });
});

describe('checkReferences over a trip that has history', () => {
  /**
   * A cancelled booking is still a real booking. "Your room RHESBH is cancelled"
   * was blocked as a fabrication because the guard only knew the confirmed ones,
   * and the model had to be corrected before it could tell the truth.
   */
  it('accepts a reference that exists but is no longer live', () => {
    expect(checkReferences(['Your room RHESBH is cancelled.'], ['RHESBH']).ok).toBe(true);
  });

  it('still blocks one that never existed', () => {
    const check = checkReferences(['Your room XYZ123 is cancelled.'], ['RHESBH']);
    expect(check.ok).toBe(false);
    expect(check.violations).toEqual(['XYZ123']);
  });
});

describe('promises the last run let through', () => {
  const noWork = { bookedThisTurn: false, searchedThisTurn: false, expectsInput: false };

  it('catches "let me get" the way it catches "let me pull up"', () => {
    for (const bubble of [
      'Now let me get the hotel rate for 6 nights.',
      "I'll get you the room options for those dates.",
      'Let me see what rooms are available.',
      'Getting those for you now.',
    ]) {
      expect(checkAnnouncedActions([bubble], noWork).ok, bubble).toBe(false);
    }
  });

  it('is satisfied by a real search', () => {
    expect(
      checkAnnouncedActions(['Now let me get the hotel rate for 6 nights.'], {
        ...noWork,
        searchedThisTurn: true,
      }).ok,
    ).toBe(true);
  });

  it('still lets ordinary sentences through', () => {
    for (const bubble of [
      'Let me know if you need anything else.',
      'Get in touch with the airline for seat selection.',
      "I'll get back to you if anything changes.",
    ]) {
      expect(checkAnnouncedActions([bubble], noWork).ok, bubble).toBe(true);
    }
  });
});
