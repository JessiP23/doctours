import 'server-only';
import { cookies } from 'next/headers';
import { timingSafeEqual } from 'node:crypto';
import { getEnv } from '@/lib/env';

/**
 * Gate for the operator console.
 *
 * The console plays the airline, the clinic and the hotel, so it must not be open
 * to anyone who finds the URL — but it is a sandbox tool, not a product surface, so
 * accounts would be theatre. One shared token from the environment, presented once
 * and kept in a cookie. Unset token means the console does not exist.
 */
export const OPS_COOKIE = 'ops_token';

export function opsEnabled(): boolean {
  return Boolean(getEnv().OPS_TOKEN);
}

function tokenMatches(candidate: string | undefined): boolean {
  const expected = getEnv().OPS_TOKEN;
  if (!expected || !candidate) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** True when the request carries the operator cookie. */
export async function opsAuthorised(): Promise<boolean> {
  const store = await cookies();
  return tokenMatches(store.get(OPS_COOKIE)?.value);
}

/** Validates a token presented on login; the caller sets the cookie. */
export function opsTokenValid(token: string | undefined): boolean {
  return tokenMatches(token);
}
