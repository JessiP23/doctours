import { log } from '@/lib/log';

/**
 * Short-lived in-process memo for provider reads.
 *
 * Flight Shop is Sabre's own cache and takes five to eight seconds. A patient
 * refining a request ("non-stop", "only Turkish", "what about EgyptAir") makes
 * the agent search several times in one turn, and re-shopping identical criteria
 * each time is what pushed a turn to 44 seconds — close to the platform's limit.
 *
 * This is safe *because* every option is re-priced live with Flight Check before
 * it is shown: a slightly stale shop result can only affect which itineraries are
 * considered, never the price quoted or the fare booked.
 *
 * Concurrent identical calls share one in-flight promise, so four parallel
 * searches for the same criteria hit Sabre once.
 */
export interface CacheOptions {
  ttlMs: number;
  maxEntries?: number;
}

interface Entry<T> {
  value: Promise<T>;
  expiresAt: number;
}

export class TtlCache<T> {
  private readonly entries = new Map<string, Entry<T>>();

  constructor(
    private readonly name: string,
    private readonly options: CacheOptions,
  ) {}

  async get(key: string, load: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const existing = this.entries.get(key);
    if (existing && existing.expiresAt > now) {
      log.debug({ cache: this.name, key }, 'cache hit');
      return existing.value;
    }

    const value = load();
    this.entries.set(key, { value, expiresAt: now + this.options.ttlMs });
    // A failed load must not be cached, or one blip poisons the window.
    value.catch(() => this.entries.delete(key));
    this.evict(now);
    return value;
  }

  private evict(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
    const max = this.options.maxEntries ?? 50;
    while (this.entries.size > max) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  /** Test helper. */
  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
