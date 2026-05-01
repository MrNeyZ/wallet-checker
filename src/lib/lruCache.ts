// Tiny size-capped Map that evicts least-recently-used entries when full.
// Used as a backing store for in-process caches that already enforce TTL
// via a timestamp stored in the value — this helper bounds memory only;
// callers are responsible for skipping stale entries with their own
// `now - cached.ts < TTL` check (or `expiresAt > now`, etc.).
//
// Why local instead of `lru-cache`: we don't ship that package, and the
// only feature any of our caches need is "evict the oldest entry once
// `size > max`". 30 LOC of dependency-free code beats pulling in another
// transitive tree. TTL is intentionally NOT enforced here so existing
// call sites in scanner / txBuilder / das keep their current shape.

export class CappedLruMap<K, V> {
  private readonly m = new Map<K, V>();
  constructor(private readonly max: number) {
    if (max < 1) throw new Error("CappedLruMap: max must be >= 1");
  }

  get(key: K): V | undefined {
    const v = this.m.get(key);
    if (v === undefined) return undefined;
    // Re-insert to refresh insertion order — turns the underlying Map
    // (which iterates oldest-first) into an LRU recency queue. The cost
    // is one delete + one set on every cache hit; negligible vs the
    // RPC / DAS round-trips this layer protects.
    this.m.delete(key);
    this.m.set(key, v);
    return v;
  }

  set(key: K, value: V): void {
    if (this.m.has(key)) this.m.delete(key);
    this.m.set(key, value);
    while (this.m.size > this.max) {
      const oldest = this.m.keys().next().value;
      if (oldest === undefined) break;
      this.m.delete(oldest);
    }
  }

  delete(key: K): boolean {
    return this.m.delete(key);
  }

  has(key: K): boolean {
    return this.m.has(key);
  }

  clear(): void {
    this.m.clear();
  }

  get size(): number {
    return this.m.size;
  }
}
