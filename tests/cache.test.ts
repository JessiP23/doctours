import { describe, expect, it, vi } from 'vitest';
import { TtlCache } from '@/lib/providers/cache';

describe('TtlCache', () => {
  it('serves a repeated call from memory inside the window', async () => {
    const cache = new TtlCache<number>('t', { ttlMs: 1000 });
    const load = vi.fn(async () => 1);
    expect(await cache.get('k', load)).toBe(1);
    expect(await cache.get('k', load)).toBe(1);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('collapses concurrent identical calls into one upstream request', async () => {
    const cache = new TtlCache<number>('t', { ttlMs: 1000 });
    const load = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return 2;
    });
    const results = await Promise.all([
      cache.get('k', load),
      cache.get('k', load),
      cache.get('k', load),
    ]);
    expect(results).toEqual([2, 2, 2]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('reloads after the window closes', async () => {
    vi.useFakeTimers();
    const cache = new TtlCache<number>('t', { ttlMs: 1000 });
    let n = 0;
    const load = async () => ++n;
    expect(await cache.get('k', load)).toBe(1);
    vi.advanceTimersByTime(1001);
    expect(await cache.get('k', load)).toBe(2);
    vi.useRealTimers();
  });

  it('keeps different keys apart', async () => {
    const cache = new TtlCache<string>('t', { ttlMs: 1000 });
    expect(await cache.get('a', async () => 'A')).toBe('A');
    expect(await cache.get('b', async () => 'B')).toBe('B');
    expect(await cache.get('a', async () => 'changed')).toBe('A');
  });

  it('does not cache a failure, so one blip does not poison the window', async () => {
    const cache = new TtlCache<number>('t', { ttlMs: 1000 });
    await expect(
      cache.get('k', async () => {
        throw new Error('upstream down');
      }),
    ).rejects.toThrow('upstream down');
    expect(await cache.get('k', async () => 7)).toBe(7);
  });

  it('bounds its own size', async () => {
    const cache = new TtlCache<number>('t', { ttlMs: 10_000, maxEntries: 3 });
    for (let i = 0; i < 10; i++) await cache.get(`k${i}`, async () => i);
    expect(cache.size).toBeLessThanOrEqual(3);
  });
});
