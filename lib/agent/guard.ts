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
