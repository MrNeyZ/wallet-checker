// Tiny per-IP rate limiter for Next.js Route Handlers in wallet-checker.
//
// wallet-checker doesn't have the shared Express middleware nft-live-feed
// uses, and we don't want a third-party rate-limit dep here. This module
// supplies the same fixed-window primitive: each route imports a local
// Map keyed on `clientIp(req)` and asks `allowed()` per request.
//
// The Map is module-scope so it persists across requests inside one Next
// worker. Single-process production today (next start -p 3003) keeps the
// counter authoritative; multi-process would need Redis.

interface Bucket { count: number; resetAt: number }

export function makeRateLimiter(opts: { limit: number; windowMs: number; label: string }) {
  const buckets = new Map<string, Bucket>();
  return {
    /** Returns true when the call is within budget, false to reject. */
    allowed(ip: string): boolean {
      const now = Date.now();
      let b = buckets.get(ip);
      if (!b || b.resetAt <= now) {
        b = { count: 0, resetAt: now + opts.windowMs };
        buckets.set(ip, b);
      }
      b.count++;
      if (buckets.size > 256) {
        let n = 0;
        for (const [k, v] of buckets) {
          if (v.resetAt <= now) { buckets.delete(k); if (++n >= 16) break; }
        }
      }
      if (b.count > opts.limit) {
        console.warn(`[rate-limit] ${opts.label}  429 ip=${ip}  count=${b.count}/${opts.limit}`);
        return false;
      }
      return true;
    },
  };
}

/** Extract the connecting client's IP. nginx puts the real IP as the
 *  LAST entry of X-Forwarded-For (the value it appended to whatever the
 *  client supplied). Reading the first entry would let a hostile client
 *  forge any IP by setting their own XFF header before the proxy hop. */
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1];
  }
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}
