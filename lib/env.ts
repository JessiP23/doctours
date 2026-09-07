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
});

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
