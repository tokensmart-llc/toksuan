/**
 * Minimal LRU-with-TTL cache. Used by `CachingKeyProvider` to memoize
 * `decrypt(envelope)` → plaintext across requests so an agent loop against
 * the same BYO key doesn't hit KMS on every call.
 *
 * Design notes:
 *   - `get()` refreshes LRU position on hit (move-to-end of the Map).
 *   - `get()` of an expired entry deletes it + returns undefined.
 *   - `set()` evicts in strict insertion order when over capacity; expired
 *     entries near the front are cleaned up opportunistically during that
 *     sweep so we don't grow unbounded if there's a steady set/get mix.
 *
 * Deliberately NOT using a weak reference or finalization — the values
 * here are plaintext secrets; we want deterministic control over how long
 * they live in memory.
 */
export class LruTtlCache<V> {
  private map = new Map<string, { v: V; expiresAt: number }>();

  constructor(
    private readonly maxSize: number,
    private readonly ttlMs: number
  ) {
    if (maxSize < 0) throw new Error("maxSize must be >= 0");
    if (ttlMs < 0) throw new Error("ttlMs must be >= 0");
  }

  /** When disabled (either limit is 0), get/set short-circuit. */
  get enabled(): boolean {
    return this.maxSize > 0 && this.ttlMs > 0;
  }

  get(key: string): V | undefined {
    if (!this.enabled) return undefined;
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return undefined;
    }
    // Refresh LRU position — move to end.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.v;
  }

  set(key: string, value: V): void {
    if (!this.enabled) return;
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { v: value, expiresAt: Date.now() + this.ttlMs });

    // Evict. Sweep expired entries from the front first (they're the
    // oldest by insertion); if we're still over cap, drop the head.
    const now = Date.now();
    while (this.map.size > this.maxSize) {
      const firstKey = this.map.keys().next().value;
      if (firstKey === undefined) break;
      const first = this.map.get(firstKey)!;
      if (now > first.expiresAt || this.map.size > this.maxSize) {
        this.map.delete(firstKey);
      } else {
        break;
      }
    }
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}
