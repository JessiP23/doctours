import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Provider request tracing.
 *
 * Any code running inside `withProviderTrace()` can call `recordProviderRequest()`;
 * the collected entries are returned alongside the result. Tool handlers use this
 * to persist exactly which upstream calls a tool made (proof that Sabre was called),
 * without threading a trace object through every function signature.
 */
export interface ProviderRequestRecord {
  provider: string;
  method: string;
  url: string;
  status: number | null;
  durationMs: number;
  error?: string;
}

const storage = new AsyncLocalStorage<ProviderRequestRecord[]>();

export async function withProviderTrace<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; requests: ProviderRequestRecord[] }> {
  const requests: ProviderRequestRecord[] = [];
  const result = await storage.run(requests, fn);
  return { result, requests };
}

export function recordProviderRequest(record: ProviderRequestRecord): void {
  storage.getStore()?.push(record);
}
