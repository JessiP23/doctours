/**
 * Booking-reference guard.
 *
 * The one failure that ends the review is an agent reporting a booking it did
 * not make. Three layers defend against it:
 *   1. create_* tools copy the reference only from the provider response.
 *   2. The system prompt renders BOOKED state from the bookings table and says
 *      the model may only quote references listed there.
 *   3. This guard: before bubbles reach the user, any token that looks like a
 *      record locator is checked against the references actually in the DB.
 *
 * Sabre record locators are six alphanumeric characters. To keep false
 * positives low we only flag a token when it contains a digit, or is exactly
 * six uppercase letters and not an ordinary travel word.
 */
const CANDIDATE = /\b[A-Z0-9]{5,8}\b/g;

/** All-caps words that legitimately appear in travel prose and are not locators. */
const STOPWORDS = new Set([
  'ECONOMY',
  'BUSINESS',
  'PREMIUM',
  'ISTANBUL',
  'DOCTOURS',
  'TURKISH',
  'AIRLINES',
  'ARRIVAL',
  'DEPART',
  'FLIGHT',
  'HOTELS',
  'NIGHTS',
  'REFUND',
  'PASSPORT',
]);

export interface ReferenceCheck {
  ok: boolean;
  /** Locator-shaped tokens that do not correspond to a real booking. */
  violations: string[];
}

function isLocatorShaped(token: string): boolean {
  if (STOPWORDS.has(token)) return false;
  const hasDigit = /\d/.test(token);
  const hasLetter = /[A-Z]/.test(token);
  if (hasDigit && hasLetter) return true; // e.g. ABC12D
  if (hasDigit && !hasLetter) return false; // bare numbers: prices, counts, years
  return token.length === 6; // six uppercase letters, e.g. ABCDEF
}

/**
 * Flags locator-shaped tokens in outgoing bubbles that are not among the
 * references of bookings recorded for this conversation.
 */
export function checkReferences(bubbles: string[], knownReferences: string[]): ReferenceCheck {
  const known = new Set(knownReferences.map((r) => r.toUpperCase()));
  const violations = new Set<string>();

  for (const bubble of bubbles) {
    for (const match of bubble.match(CANDIDATE) ?? []) {
      if (!isLocatorShaped(match)) continue;
      if (!known.has(match)) violations.add(match);
    }
  }

  return { ok: violations.size === 0, violations: [...violations] };
}

/**
 * Announced-action guard.
 *
 * Saying "booking it now" or "let me pull up the room rates" and then ending the
 * turn without calling the tool tells the patient something is happening that is
 * not. It is a milder cousin of inventing a reference, and it has happened in
 * real conversations twice, so it is checked rather than trusted to the prompt.
 *
 * The promise is matched to the kind of work it implies: a booking phrase needs a
 * booking tool to have succeeded this turn, a retrieval phrase needs a search or
 * lookup to have been attempted. Only turn-closing replies are checked —
 * "I'll book it once you confirm" is a legitimate promise, and it waits for input.
 */
const BOOKING_PHRASE =
  /\b(booking (it|that|this|them)|i'?m booking|i'?ll book (it|that|this|them)|let me book|i'?ll go ahead and book|placing (the|your) booking|confirming (it|that) now|i'?ll get (that|it) booked)\b/i;

const RETRIEVAL_PHRASE =
  /\b(?:(?:let me|i'?ll|i'?m going to|i am going to)\s+(?:go\s+)?(?:pull up|pull|find|check|look up|look for|look at|search|see what|get you|get the|get a|grab|fetch)|(?:pulling|checking|looking|searching|fetching|getting)\s+(?:that|those|these|it|them|up|you)|one moment while i)\b/i;

/**
 * "Let me try again" after a failed tool is a promise of either kind: it is kept by
 * any tool call that could be the retry, and broken by a turn that ends with none.
 * Said verbatim to a patient after a hotel booking failed, followed by nothing.
 */
const RETRY_PHRASE =
  /\b((?:let me|i'?ll|i will|i'?m going to)\s+(?:just\s+)?(?:try|attempt)(?:\s+(?:that|this|it))?\s+again|(?:trying|attempting)(?:\s+(?:that|this|it))?\s+again|(?:let me|i'?ll) (?:retry|re-try|give (?:it|that) another (?:go|try)))\b/i;

export interface PromiseCheck {
  ok: boolean;
  /** The phrase that announced work which never happened. */
  announced: string | null;
  kind: 'booking' | 'retrieval' | 'retry' | null;
}

export interface TurnActivity {
  /** A create_* or rebook_* tool succeeded. */
  bookedThisTurn: boolean;
  /**
   * A search_* tool was called, whether or not it succeeded.
   *
   * Reading the trip's own state does not count. "Let me get the hotel rate" was
   * treated as kept because `get_trip_state` had run, and the patient was left
   * waiting on a search that never happened.
   */
  searchedThisTurn: boolean;
  expectsInput: boolean;
}

export function checkAnnouncedActions(bubbles: string[], activity: TurnActivity): PromiseCheck {
  const clean: PromiseCheck = { ok: true, announced: null, kind: null };
  if (activity.expectsInput) return clean;

  for (const bubble of bubbles) {
    if (!activity.bookedThisTurn) {
      const booking = bubble.match(BOOKING_PHRASE);
      if (booking) return { ok: false, announced: booking[0], kind: 'booking' };
    }
    if (!activity.searchedThisTurn) {
      const retrieval = bubble.match(RETRIEVAL_PHRASE);
      if (retrieval) return { ok: false, announced: retrieval[0], kind: 'retrieval' };
    }
    if (!activity.bookedThisTurn && !activity.searchedThisTurn) {
      const retry = bubble.match(RETRY_PHRASE);
      if (retry) return { ok: false, announced: retry[0], kind: 'retry' };
    }
  }
  return clean;
}

/**
 * Did the reply actually raise the change the patient was never told about?
 *
 * An airline cancellation outranks whatever the patient typed, and the prompt puts
 * it first for that reason — but a model that decides to answer the question instead
 * leaves a patient believing they still have a flight. The check is deliberately
 * shallow: it asks whether the words for that kind of change appear anywhere in the
 * bubbles, not whether the explanation is good. Missing it is a false negative that
 * costs one retry; passing it wrongly is not something a regex can prevent.
 */
const RAISED: Record<string, RegExp> = {
  flight_cancelled:
    /\b(cancel(?:led|ed|s|ling)?|dropped|no longer (?:flying|operating|running))\b/i,
  hotel_cancelled: /\b(cancel(?:led|ed|s|ling)?|dropped|released|no longer (?:has|holds|have))\b/i,
  flight_schedule_change:
    /\b(schedul\w*|time[sd]?|moved|shifted|changed|earlier|later|delay\w*)\b/i,
  procedure_moved:
    /\b(moved|resched\w*|new date|pushed (?:back|forward|out)|brought forward|changed the date|date (?:has |was )?changed|now on)\b/i,
};

export interface EventCheck {
  ok: boolean;
  /** Event kinds the reply never mentioned. */
  unraised: string[];
}

export function checkRaisedEvents(bubbles: string[], eventKinds: string[]): EventCheck {
  // The first bubble, not the whole reply. "Here are your replacement options …
  // same price as your cancelled flight" mentions the word and buries the news; the
  // patient reads options before they know anything went wrong. Raising it means
  // leading with it.
  const lead = bubbles[0] ?? '';
  const unraised = [...new Set(eventKinds)].filter((kind) => {
    const pattern = RAISED[kind];
    // An unknown kind has no words to look for, so it cannot be judged here.
    return pattern ? !pattern.test(lead) : false;
  });
  return { ok: unraised.length === 0, unraised };
}
