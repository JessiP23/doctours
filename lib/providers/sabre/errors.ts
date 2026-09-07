/**
 * Normalized provider error codes. Tools and the agent only ever see these,
 * never raw HTTP details, so error handling is provider-agnostic.
 */
export type ProviderErrorCode =
  | 'AUTH_FAILED'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'UPSTREAM_ERROR'
  | 'BAD_REQUEST'
  | 'NOT_FOUND'
  | 'NO_AVAILABILITY'
  | 'OFFER_EXPIRED'
  | 'PRICE_CHANGED'
  | 'BOOKING_FAILED';

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly status: number | null;
  readonly details: unknown;

  constructor(
    code: ProviderErrorCode,
    message: string,
    opts: { status?: number | null; details?: unknown } = {},
  ) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.status = opts.status ?? null;
    this.details = opts.details;
  }

  /** Safe representation to hand back to the model / persist. Never includes secrets. */
  toJSON() {
    return { code: this.code, message: this.message, status: this.status };
  }
}

export function isProviderError(e: unknown): e is ProviderError {
  return e instanceof ProviderError;
}

export function codeFromStatus(status: number): ProviderErrorCode {
  if (status === 401 || status === 403) return 'AUTH_FAILED';
  if (status === 404) return 'NOT_FOUND';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'UPSTREAM_ERROR';
  return 'BAD_REQUEST';
}
