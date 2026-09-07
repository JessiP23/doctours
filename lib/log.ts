import pino, { type Logger } from 'pino';

/**
 * Structured server logger.
 *
 * - JSON lines in production (Vercel captures stdout).
 * - Pretty output in development.
 * - Credentials and auth headers are redacted at the logger level so a careless
 *   `log.info({ req })` can never leak a token.
 *
 * Use child loggers with context: `log.child({ conversationId })`.
 */
const isProd = process.env.NODE_ENV === 'production';
const level = process.env.LOG_LEVEL ?? (isProd ? 'info' : 'debug');

export const log: Logger = pino({
  level,
  base: { service: 'doctours-agent' },
  redact: {
    paths: [
      'headers.authorization',
      '*.headers.authorization',
      'authorization',
      'password',
      '*.password',
      'access_token',
      '*.access_token',
      'SABRE_PASSWORD',
      'ANTHROPIC_API_KEY',
      'SUPABASE_SERVICE_ROLE_KEY',
      'PAYMENT_CARD_NUMBER',
      'PAYMENT_CARD_SECURITY_CODE',
      'cardNumber',
      '*.cardNumber',
      'cardSecurityCode',
      '*.cardSecurityCode',
    ],
    censor: '[redacted]',
  },
  ...(isProd
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,service' },
        },
      }),
});

export type { Logger };
