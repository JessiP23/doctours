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

  /**
   * Safe representation to persist and hand back. Includes a trimmed preview of
   * the upstream body: without it a 400 says nothing about what was wrong.
   */
  toJSON() {
    return {
      code: this.code,
      message: this.message,
      status: this.status,
      ...(this.details !== undefined ? { details: previewOf(this.details) } : {}),
    };
  }
}

const DETAILS_PREVIEW_CHARS = 1500;

function previewOf(details: unknown): string {
  const text = typeof details === 'string' ? details : JSON.stringify(details);
  if (!text) return '';
  return text.length > DETAILS_PREVIEW_CHARS ? `${text.slice(0, DETAILS_PREVIEW_CHARS)}…` : text;
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
