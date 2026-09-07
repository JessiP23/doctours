import { getEnv } from '@/lib/env';
import { log } from '@/lib/log';
import { ProviderError } from './errors';
import { recordProviderRequest } from '../trace';

/**
 * Sabre REST session-less authentication (OAuth2 client_credentials).
 *
 * client_id     = base64("V1:<EPR>:<PCC>:<DOMAIN>")
 * client_secret = base64(<password>)
 * Authorization: Basic base64(client_id + ":" + client_secret)
 * POST {base}/v2/auth/token  grant_type=client_credentials
 *
 * The token is cached in module memory until shortly before expiry and refreshed
 * on demand. `invalidateToken()` is called by the HTTP layer on a 401 so a single
 * retry picks up a fresh token.
 */
interface TokenState {
  accessToken: string;
  expiresAt: number; // epoch ms
}

let state: TokenState | undefined;
let inflight: Promise<TokenState> | undefined;

const REFRESH_SKEW_MS = 60_000;

/** Builds the V1 user identity, accepting either a bare EPR or an already-complete V1 string. */
export function buildClientId(userId: string, pcc: string, domain: string): string {
  const trimmed = userId.trim();
  const parts = trimmed.split(':');
  const full =
    parts.length === 4 && parts[0] === 'V1' ? trimmed : `V1:${parts.at(-1)}:${pcc}:${domain}`;
  return Buffer.from(full, 'utf8').toString('base64');
}

export function buildBasicCredentials(
  userId: string,
  password: string,
  pcc: string,
  domain: string,
): string {
  const clientId = buildClientId(userId, pcc, domain);
  const clientSecret = Buffer.from(password, 'utf8').toString('base64');
  return Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64');
}

async function requestToken(): Promise<TokenState> {
  const env = getEnv();
  const url = `${env.SABRE_BASE_URL}/v2/auth/token`;
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.SABRE_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${buildBasicCredentials(env.SABRE_USER_ID, env.SABRE_PASSWORD, env.SABRE_PCC, env.SABRE_DOMAIN)}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: 'grant_type=client_credentials',
      signal: controller.signal,
    });
    const durationMs = Date.now() - started;
    recordProviderRequest({
      provider: 'sabre',
      method: 'POST',
      url,
      status: res.status,
      durationMs,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      log.error({ status: res.status, body }, 'sabre auth failed');
      throw new ProviderError('AUTH_FAILED', `Sabre authentication failed (${res.status})`, {
        status: res.status,
        details: body,
      });
    }

    const json = (await res.json()) as {
      access_token: string;
      expires_in: number;
      token_type: string;
    };
    const expiresAt = Date.now() + json.expires_in * 1000;
    log.info({ expiresInSec: json.expires_in, durationMs }, 'sabre token acquired');
    return { accessToken: json.access_token, expiresAt };
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    const durationMs = Date.now() - started;
    const isTimeout = e instanceof Error && e.name === 'AbortError';
    recordProviderRequest({
      provider: 'sabre',
      method: 'POST',
      url,
      status: null,
      durationMs,
      error: isTimeout ? 'timeout' : String(e),
    });
    throw new ProviderError(
      isTimeout ? 'TIMEOUT' : 'UPSTREAM_ERROR',
      'Sabre authentication request failed',
      {
        details: String(e),
      },
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function getAccessToken(): Promise<string> {
  if (state && state.expiresAt - REFRESH_SKEW_MS > Date.now()) return state.accessToken;
  inflight ??= requestToken().finally(() => {
    inflight = undefined;
  });
  state = await inflight;
  return state.accessToken;
}

export function invalidateToken(): void {
  state = undefined;
}

/** Exposed for the smoke script / health check. */
export function tokenExpiresAt(): Date | null {
  return state ? new Date(state.expiresAt) : null;
}
