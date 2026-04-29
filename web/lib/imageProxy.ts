// Build a same-origin proxy URL for an external image. The proxy route
// (/api/image-proxy) fetches once per hash, caches on disk, and serves with
// long Cache-Control so subsequent renders are instant. Callers should use
// this for any user-supplied / off-chain image URL — slow Arweave / IPFS
// gateways are the typical pain point.
//
// Pass-through behavior:
//   - null / empty → null (caller renders placeholder)
//   - data: URLs   → returned as-is (no fetch, instant render)
//   - other non-http(s) schemes → null (proxy refuses anyway)
//   - http(s) URLs → /api/image-proxy?url=<encoded>

export function proxyImageUrl(src: string | null | undefined): string | null {
  if (typeof src !== "string" || src.length === 0) return null;
  if (src.startsWith("data:")) return src;
  if (!/^https?:\/\//i.test(src)) return null;
  return `/api/image-proxy?url=${encodeURIComponent(src)}`;
}
