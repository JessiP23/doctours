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
  /\b(?:(?:let me|i'?ll|i'?m going to|i am going to)\s+(?:go\s+)?(?:pull up|pull|find|check|look up|look for|look at|search|grab|fetch)|(?:pulling|checking|looking|searching|fetching)\s+(?:that|those|these|it|them|up)|one moment while i)\b/i;

export interface PromiseCheck {
  ok: boolean;
  /** The phrase that announced work which never happened. */
  announced: string | null;
  kind: 'booking' | 'retrieval' | null;
}

export interface TurnActivity {
  /** A create_* tool succeeded. */
  bookedThisTurn: boolean;
  /** A search_* or get_* tool was called, whether or not it succeeded. */
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
  }
  return clean;
}
