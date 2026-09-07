import { getEnv } from '@/lib/env';
import { log } from '@/lib/log';
import { getAccessToken, invalidateToken } from './auth';
import { ProviderError, codeFromStatus } from './errors';
import { recordProviderRequest } from '../trace';

/**
 * Thin fetch wrapper for Sabre REST calls.
 *
 * - Adds bearer auth, JSON headers and a timeout.
 * - Retries once on 401 (after refreshing the token) and once on 429/5xx with backoff.
 * - Records every attempt in the provider trace.
 * - Maps failures to `ProviderError`; never throws raw fetch errors.
 */
export interface SabreRequest {
  method: 'GET' | 'POST';
  path: string; // e.g. "/v5/offers/shop"
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Override the default timeout for slow endpoints (shopping). */
  timeoutMs?: number;
}

const RETRY_BACKOFF_MS = 750;

function buildUrl(base: string, path: string, query?: SabreRequest['query']): string {
  const url = new URL(path, base);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

async function attempt<T>(
  req: SabreRequest,
  url: string,
  timeoutMs: number,
): Promise<{ status: number; data: T }> {
  const token = await getAccessToken();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: req.method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(req.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
      signal: controller.signal,
    });
    const durationMs = Date.now() - started;
    recordProviderRequest({
      provider: 'sabre',
      method: req.method,
      url,
      status: res.status,
      durationMs,
    });
    log.debug({ method: req.method, url, status: res.status, durationMs }, 'sabre request');

    const text = await res.text();
    let data: unknown = text;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        /* keep text */
      }
    }
    if (!res.ok) {
      throw new ProviderError(
        codeFromStatus(res.status),
        `Sabre ${req.method} ${req.path} failed (${res.status})`,
        {
          status: res.status,
          details: data,
        },
      );
    }
    return { status: res.status, data: data as T };
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    const durationMs = Date.now() - started;
    const isTimeout = e instanceof Error && e.name === 'AbortError';
    recordProviderRequest({
      provider: 'sabre',
      method: req.method,
      url,
      status: null,
      durationMs,
      error: isTimeout ? 'timeout' : String(e),
    });
    throw new ProviderError(
      isTimeout ? 'TIMEOUT' : 'UPSTREAM_ERROR',
      `Sabre ${req.method} ${req.path} ${isTimeout ? 'timed out' : 'failed'}`,
      {
        details: String(e),
      },
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function sabreFetch<T = unknown>(req: SabreRequest): Promise<T> {
  const env = getEnv();
  const url = buildUrl(env.SABRE_BASE_URL, req.path, req.query);
  const timeoutMs = req.timeoutMs ?? env.SABRE_TIMEOUT_MS;

  try {
    return (await attempt<T>(req, url, timeoutMs)).data;
  } catch (e) {
    if (!(e instanceof ProviderError)) throw e;
    if (e.status === 401) {
      invalidateToken();
      log.warn({ path: req.path }, 'sabre 401, refreshing token and retrying once');
      return (await attempt<T>(req, url, timeoutMs)).data;
    }
    if (e.code === 'RATE_LIMITED' || e.code === 'UPSTREAM_ERROR') {
      log.warn({ path: req.path, code: e.code }, 'sabre transient error, retrying once');
      await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
      return (await attempt<T>(req, url, timeoutMs)).data;
    }
    throw e;
  }
}
