import { z } from 'zod';

/**
 * Single source of truth for configuration.
 *
 * Every variable the app reads is declared here. Access `env` instead of
 * `process.env` anywhere on the server so that a missing or malformed value
 * fails fast, once, with a readable message — not at the first Sabre call.
 *
 * Server-only: never import this from a client component.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  // Anthropic
  ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY is required'),
  ANTHROPIC_MODEL: z.string().min(1).default('claude-sonnet-4-5'),

  // Sabre (CERT by default)
  SABRE_BASE_URL: z.url().default('https://api.cert.platform.sabre.com'),
  SABRE_USER_ID: z.string().min(1, 'SABRE_USER_ID is required'),
  SABRE_PASSWORD: z.string().min(1, 'SABRE_PASSWORD is required'),
  SABRE_PCC: z.string().min(1, 'SABRE_PCC is required'),
  SABRE_DOMAIN: z.string().min(1).default('AA'),
  SABRE_TIMEOUT_MS: z.coerce.number().int().positive().default(25_000),

  // Supabase (optional until the DB commit lands; the loader enforces presence in production)
  SUPABASE_URL: z.url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),

  // Agency form of payment. Doctours pays; the patient is never asked for a card.
  // Hotel rates with a DEPOSIT or GUARANTEE policy cannot be booked without it.
  // In CERT this is a sandbox test card, not a real one.
  PAYMENT_CARD_TYPE: z
    .string()
    .regex(/^[A-Z]{2}$/, 'two-letter card code, e.g. VI')
    .optional(),
  PAYMENT_CARD_NUMBER: z
    .string()
    .regex(/^\d{12,19}$/)
    .optional(),
  PAYMENT_CARD_EXPIRY: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'YYYY-MM')
    .optional(),
  PAYMENT_CARD_SECURITY_CODE: z
    .string()
    .regex(/^\d{3,4}$/)
    .optional(),
  PAYMENT_CARD_HOLDER_GIVEN_NAME: z.string().min(1).default('Doctours'),
  PAYMENT_CARD_HOLDER_SURNAME: z.string().min(1).default('Travel'),

  // Operator console at /ops. Unset means the console is off. It plays the airline,
  // the clinic and the hotel for scenarios the Sabre sandbox cannot originate.
  OPS_TOKEN: z.string().min(12, 'OPS_TOKEN must be at least 12 characters').optional(),
});

export interface PaymentCard {
  type: string;
  number: string;
  expiry: string; // YYYY-MM
  securityCode?: string;
  holder: { givenName: string; surname: string };
}

/** The agency card, or null when not configured (hotel booking then fails with a clear message). */
export function paymentCard(env: Env): PaymentCard | null {
  if (!env.PAYMENT_CARD_TYPE || !env.PAYMENT_CARD_NUMBER || !env.PAYMENT_CARD_EXPIRY) return null;
  return {
    type: env.PAYMENT_CARD_TYPE,
    number: env.PAYMENT_CARD_NUMBER,
    expiry: env.PAYMENT_CARD_EXPIRY,
    securityCode: env.PAYMENT_CARD_SECURITY_CODE,
    holder: {
      givenName: env.PAYMENT_CARD_HOLDER_GIVEN_NAME,
      surname: env.PAYMENT_CARD_HOLDER_SURNAME,
    },
  };
}

export type Env = z.infer<typeof schema>;

function load(): Env {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

let cached: Env | undefined;

/** Lazily parsed so that importing this module in tests without a full env doesn't throw. */
export function getEnv(): Env {
  cached ??= load();
  return cached;
}

/** Test helper: force re-parsing after mutating process.env. */
export function resetEnvForTests(): void {
  cached = undefined;
}
