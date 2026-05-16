// Thumbnail proxy + disk cache for NFT images.
//
// Why this exists: NFT image URIs come from Helius DAS / off-chain JSON, which
// often resolves to slow or rate-limited gateways (Arweave, IPFS public
// gateways). Burner grids render up to 200 thumbnails at once; without a
// proxy/cache the browser fans out hundreds of cross-origin requests on every
// re-render. This route fetches once per URL, caches the bytes by hash, and
// serves with a long-lived Cache-Control so the browser also stops re-asking.
//
// The route is best-effort by design: if the upstream fetch fails or times
// out, we 404 and the frontend falls back to a neutral placeholder. Burn
// flows never depend on this route succeeding.
//
// No external image-resize lib (sharp) is bundled, so the original bytes are
// served unchanged. If sharp is later added we can resize to ~128×128 here.
//
// SECURITY HARDENING (C4):
// The original implementation accepted any http(s) URL and used `redirect:
// "follow"`, which made it an open SSRF + bandwidth proxy. This file now
// enforces, in order:
//   1. scheme allowlist (http/https only) + reject userinfo + reject
//      non-default ports
//   2. DNS resolve of every hop's hostname (incl. redirect targets) and
//      reject when ANY answer falls in a private / loopback / link-local /
//      CGNAT / multicast / reserved range
//   3. redirect:"manual" with re-validation per hop and a 3-hop cap
//   4. streamed body read with a strict size cap — buffer is bounded
//      DURING transfer, so an attacker-hosted chunked-multi-GB response
//      cannot OOM the worker
//   5. per-IP fixed-window rate limit to bound abuse across many unique
//      URLs (each fresh URL is otherwise a cache-miss that costs network)
//   6. only successful image responses get written to the on-disk cache
//      (failures, oversized, and non-image responses are never persisted)
// Residual risk: classic DNS-rebind (resolve to public, swap to private
// between lookup and TLS handshake) is not mitigated — Node's fetch reuses
// the resolver and SNI/cert binding makes pinning-to-IP non-trivial.

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { lookup } from "node:dns/promises";
import net from "node:net";
import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";

export const runtime = "nodejs";

// Bumped 5s → 10s — Arweave / IPFS public gateways routinely take 5–8s on
// first fetch, especially for cold images. The caller is non-blocking
// (lazy <img> with onError → placeholder), so a longer ceiling buys real
// hit-rate without harming UX.
const FETCH_TIMEOUT_MS = 10_000;
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB cap — NFT thumbnails are small
const CACHE_TTL_SECONDS = 60 * 60 * 24; // 24h browser cache
const CACHE_DIR = path.join(process.cwd(), "data", "image-cache");
const MAX_REDIRECTS = 3;

// Per-IP fixed-window rate limit. 120 req/min covers a cache-cold grid of
// ~200 thumbnails (subsequent renders are browser/disk-cached) while
// blocking an attacker probing thousands of unique URLs through the proxy.
const RATE_LIMIT_PER_MIN = 120;
const RATE_WINDOW_MS = 60_000;
interface Bucket { count: number; resetAt: number }

// Known-dead-gateway hosts whose timeouts aren't actionable signal:
// nft.storage retired its public IPFS gateway, w3s/dweb subdomain
// gateways are unreliable for old CIDs. Every NFT we still hold with
// art pinned to these hosts hangs for the full 10 s fetch timeout. One
// `[image-proxy] cache=miss reason=timeout` per thumbnail buries the
// channel under thousands of identical lines and hides real proxy
// errors. We roll up per-host timeout counts here and emit one summary
// every 60 s of activity (or whenever the window first elapses).
const DEAD_GATEWAY_HOST_HINTS = [
  "nftstorage.link",
  "w3s.link",
  "ipfs.dweb.link",
];
const DEAD_GATEWAY_ROLLUP_WINDOW_MS = 60_000;
interface DeadGatewayRollup { count: number; firstAt: number; lastAt: number }
const deadGatewayRollups = new Map<string, DeadGatewayRollup>();
function isKnownDeadGatewayHost(host: string): boolean {
  for (const hint of DEAD_GATEWAY_HOST_HINTS) {
    if (host.includes(hint)) return true;
  }
  return false;
}
function noteDeadGatewayTimeout(host: string): void {
  // Roll up under the bare host (no path) so per-CID thumbnails share
  // a single counter per gateway. Bounded by `DEAD_GATEWAY_HOST_HINTS`
  // — in practice 2-3 entries in the map ever.
  const key = host.split("/")[0] ?? host;
  const now = Date.now();
  const cur = deadGatewayRollups.get(key);
  if (!cur) {
    deadGatewayRollups.set(key, { count: 1, firstAt: now, lastAt: now });
    return;
  }
  cur.count++;
  cur.lastAt = now;
  if (now - cur.firstAt >= DEAD_GATEWAY_ROLLUP_WINDOW_MS) {
    console.warn(
      `[image-proxy] dead-gateway-rollup host=${key} timeouts=${cur.count} windowMs=${now - cur.firstAt}`,
    );
    deadGatewayRollups.delete(key);
  }
}
const buckets = new Map<string, Bucket>();

// Throttle the slow-path log so a 200-thumb grid that all misses cache
// doesn't spam the server logs. Uncached miss / failure paths still log
// concisely; cache HITs only log every Nth request to confirm the cache
// is actually warm.
const HIT_LOG_EVERY = 50;
let hitCounter = 0;

const ALLOWED_CONTENT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/svg+xml",
]);

// Once-per-process flag so we only attempt to create the cache dir on the
// first request, not on every fetch. Subsequent calls short-circuit.
let cacheDirReady: Promise<void> | null = null;
function ensureCacheDir(): Promise<void> {
  if (!cacheDirReady) {
    cacheDirReady = fs.mkdir(CACHE_DIR, { recursive: true }).then(
      () => undefined,
      (err: unknown) => {
        // Reset so a transient failure (e.g. permissions just fixed) can
        // be retried on the next request, not poisoned for the lifetime
        // of the worker.
        cacheDirReady = null;
        console.warn(
          `[image-proxy] cache dir mkdir failed at ${CACHE_DIR}: ${(err as Error)?.message ?? err}`,
        );
      },
    );
  }
  return cacheDirReady;
}

// Safe URL summary for logs — host + truncated path. Never logs full
// query strings (some gateways embed signed tokens / API keys there).
function logHost(url: string): string {
  try {
    const u = new URL(url);
    const p = u.pathname.length > 24 ? `${u.pathname.slice(0, 21)}…` : u.pathname;
    return `${u.host}${p}`;
  } catch {
    return "<unparseable>";
  }
}

function cachePathFor(url: string): { file: string; meta: string } {
  const hash = createHash("sha256").update(url).digest("hex");
  return {
    file: path.join(CACHE_DIR, `${hash}.bin`),
    meta: path.join(CACHE_DIR, `${hash}.json`),
  };
}

async function readCached(
  url: string,
): Promise<{ bytes: Buffer; contentType: string } | null> {
  const { file, meta } = cachePathFor(url);
  try {
    const [bytes, metaRaw] = await Promise.all([
      fs.readFile(file),
      fs.readFile(meta, "utf8"),
    ]);
    const parsed = JSON.parse(metaRaw) as { contentType?: unknown };
    const contentType =
      typeof parsed.contentType === "string"
        ? parsed.contentType
        : "application/octet-stream";
    return { bytes, contentType };
  } catch {
    return null;
  }
}

async function writeCached(
  url: string,
  bytes: Buffer,
  contentType: string,
): Promise<void> {
  const { file, meta } = cachePathFor(url);
  try {
    // Recursive ensure — covers the case where the cache dir was deleted
    // out from under the worker between requests.
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await Promise.all([
      fs.writeFile(file, bytes),
      fs.writeFile(meta, JSON.stringify({ contentType })),
    ]);
  } catch (err) {
    // Cache write failure shouldn't fail the response — log + continue.
    console.warn(
      `[image-proxy] cache write failed for ${logHost(url)}: ${(err as Error)?.message ?? err}`,
    );
  }
}

// IPv4 / IPv6 private-range classifier. `net.isIP` returns 0 for non-IPs so
// the caller must short-circuit before calling this. Lower-cases the input
// before checking IPv6 prefixes since some resolvers return mixed case.
function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const m = ip.match(/^(\d+)\.(\d+)\./);
    if (!m) return false;
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 0) return true;                         // 0.0.0.0/8 — "this host"
    if (a === 10) return true;                        // 10.0.0.0/8
    if (a === 127) return true;                       // 127.0.0.0/8 loopback
    if (a === 169 && b === 254) return true;          // 169.254.0.0/16 link-local (incl. cloud metadata)
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true;          // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true;// 100.64.0.0/10 CGNAT
    if (a >= 224) return true;                        // 224/4 multicast + 240/4 reserved
    return false;
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === "::" || v === "::1") return true;       // unspecified + loopback
    if (/^fc|^fd/.test(v)) return true;               // fc00::/7 unique-local
    if (/^fe[89ab]/.test(v)) return true;             // fe80::/10 link-local
    if (/^ff/.test(v)) return true;                   // ff00::/8 multicast
    // IPv4-mapped (::ffff:a.b.c.d) — re-check as IPv4
    const m = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return isPrivateIp(m[1]);
    return false;
  }
  return false;
}

// Reject the host part of a URL when any of these holds:
//   - it's a localhost shortname
//   - it's an IP literal in a private/reserved range
//   - any DNS answer for the hostname is in a private/reserved range
// Returns null on accept, or a short reason code on reject (used in logs).
async function assertPublicHost(hostname: string): Promise<string | null> {
  if (!hostname) return "empty_host";
  // URL.hostname keeps the brackets for IPv6 literals ("[::1]"); strip
  // them so net.isIP / DNS see a bare address.
  const h = (hostname.startsWith("[") && hostname.endsWith("]"))
    ? hostname.slice(1, -1)
    : hostname;
  const hLower = h.toLowerCase();
  if (hLower === "localhost" || hLower.endsWith(".localhost")) return "localhost_disallowed";

  const ipKind = net.isIP(h);
  if (ipKind !== 0) {
    return isPrivateIp(h) ? "private_ip_literal" : null;
  }

  let addrs: Array<{ address: string; family: number }>;
  try {
    addrs = await lookup(h, { all: true });
  } catch {
    return "dns_resolve_failed";
  }
  if (addrs.length === 0) return "dns_resolve_empty";
  for (const a of addrs) {
    if (isPrivateIp(a.address)) return "private_ip_resolved";
  }
  return null;
}

// Strict input-URL parser. Rejects anything that isn't a same-shape
// http(s) request to a hostname on standard ports with no credentials.
function parseSafeUrl(raw: string): URL | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  // No non-standard ports. Most image gateways serve on the scheme default
  // (80 for http, 443 for https); explicit non-default ports are very
  // unusual for legitimate NFT image traffic and a classic SSRF lever.
  if (u.port && u.port !== "80" && u.port !== "443") return null;
  if (!u.hostname || u.hostname.length > 253) return null;
  return u;
}

// Translate known-dead / deprecated gateway hosts to a live equivalent at
// fetch time so stale on-chain / DAS image URLs still resolve to real bytes.
// Returns a new URL when a rewrite applies, else null. The rewritten URL is
// re-validated by parseSafeUrl and still flows through safeFetch's per-hop
// assertPublicHost — SSRF protections are unchanged. The cache key stays the
// ORIGINAL url, so a repeat request for the dead URL still hits cache.
//
// Currently handles only the one gateway that's actually dead in practice:
// nft.storage retired its subdomain-style IPFS gateway
// (`<cidv1>.ipfs.nftstorage.link/...`) — those requests just hang until the
// 10s fetch timeout. The path-style gateway (`nftstorage.link/ipfs/<cid>/...`)
// still serves the same content, so we reshape to that. (The path-style host
// is left untouched — it works; w3s.link / dweb.link subdomain gateways are
// left untouched too — those are alive.)
const NFTSTORAGE_SUBDOMAIN_SUFFIX = ".ipfs.nftstorage.link";
function rewriteDeadGateway(u: URL): URL | null {
  const host = u.hostname.toLowerCase();
  if (host.endsWith(NFTSTORAGE_SUBDOMAIN_SUFFIX) && host.length > NFTSTORAGE_SUBDOMAIN_SUFFIX.length) {
    const cid = host.slice(0, host.length - NFTSTORAGE_SUBDOMAIN_SUFFIX.length);
    // The CID must be a single DNS label — no dots. Anything else isn't a
    // real subdomain-gateway URL; bail rather than guess.
    if (!cid || cid.includes(".")) return null;
    const path = u.pathname === "/" ? "" : u.pathname;
    try {
      return new URL(`https://nftstorage.link/ipfs/${cid}${path}${u.search}`);
    } catch {
      return null;
    }
  }
  return null;
}

// Magic-byte sniff for the raster image formats the proxy serves. Used only
// when the upstream's declared Content-Type is missing / unrecognised (e.g.
// gateway.irys.xyz serves real images as application/octet-stream). Returns
// the canonical image content-type or null. SVG is deliberately NOT sniffed —
// it's XML/text and the bytes are ambiguous with HTML; an SVG that wants
// through the proxy must declare `image/svg+xml`. Note: the bytes are served
// back via <img>, never executed, and we always set an `image/*` Content-Type
// on the response, so a polyglot is harmless here.
function sniffImageType(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  // PNG  — 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
      buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return "image/png";
  // JPEG — FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  // GIF  — "GIF87a" / "GIF89a"
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38 &&
      (buf[4] === 0x37 || buf[4] === 0x39) && buf[5] === 0x61) return "image/gif";
  // WebP — "RIFF" .... "WEBP"
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return "image/webp";
  // AVIF — ISO-BMFF `ftyp` box at bytes 4..7, brand "avif"/"avis" at 8..11
  if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) {
    const brand = buf.toString("ascii", 8, 12);
    if (brand === "avif" || brand === "avis") return "image/avif";
  }
  return null;
}

function checkRate(ip: string): boolean {
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + RATE_WINDOW_MS };
    buckets.set(ip, b);
  }
  b.count++;
  if (buckets.size > 256) {
    let n = 0;
    for (const [k, v] of buckets) {
      if (v.resetAt <= now) { buckets.delete(k); if (++n >= 16) break; }
    }
  }
  return b.count <= RATE_LIMIT_PER_MIN;
}

function clientIp(req: NextRequest): string {
  // nginx in front sets X-Forwarded-For = "<attacker>, <real_ip>" — the
  // last entry is the trusted one.
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1];
  }
  const xri = req.headers.get("x-real-ip");
  if (xri) return xri.trim();
  return "unknown";
}

// Read an upstream Response.body with a strict byte ceiling. Aborts the
// read (cancels the underlying stream) the moment the cap is exceeded, so
// a hostile chunked-encoding response that never sends Content-Length
// cannot bloat the buffer past MAX_BYTES. Returns null if oversized.
async function readBodyCapped(res: Response, maxBytes: number): Promise<Buffer | null> {
  if (!res.body) {
    // Spec allows a body-less Response; fall through to the buffered path
    // since there's nothing to stream anyway.
    const ab = await res.arrayBuffer();
    return ab.byteLength > maxBytes ? null : Buffer.from(ab);
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* best-effort */ }
        return null;
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* best-effort */ }
  }
  return Buffer.concat(chunks);
}

// Fetch with manual redirect handling and per-hop host validation. Returns
// either a Response (the final 2xx upstream response, body NOT yet read) or
// a structured error to be turned into a NextResponse by the caller.
type FetchOutcome =
  | { kind: "ok"; res: Response; finalUrl: URL }
  | { kind: "err"; reason: string; status: number };

async function safeFetch(initial: URL): Promise<FetchOutcome> {
  let current: URL = initial;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const hostErr = await assertPublicHost(current.hostname);
    if (hostErr) return { kind: "err", reason: hostErr, status: 400 };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(current.toString(), {
        signal: controller.signal,
        redirect: "manual",
        headers: {
          // No referer leak; some gateways inspect referer to bill or
          // throttle, but we want a neutral identity for the proxy.
          "user-agent": "wallet-checker-image-proxy/1.0",
        },
      });
    } catch (err) {
      clearTimeout(timer);
      const aborted = controller.signal.aborted;
      return {
        kind: "err",
        reason: aborted ? "timeout" : "fetch_failed",
        status: 502,
      };
    }
    clearTimeout(timer);

    // Manual redirect handling: validate every hop. Drain the body of the
    // 3xx response immediately so the socket gets reclaimed.
    if (res.status >= 300 && res.status < 400 && res.status !== 304) {
      const loc = res.headers.get("location");
      try { await res.body?.cancel(); } catch { /* best-effort */ }
      if (!loc) return { kind: "err", reason: "redirect_no_location", status: 502 };
      if (hop >= MAX_REDIRECTS) return { kind: "err", reason: "too_many_redirects", status: 502 };
      let next: URL;
      try { next = new URL(loc, current); } catch { return { kind: "err", reason: "redirect_unparseable", status: 502 }; }
      const safe = parseSafeUrl(next.toString());
      if (!safe) return { kind: "err", reason: "redirect_unsafe_url", status: 400 };
      current = safe;
      continue;
    }

    return { kind: "ok", res, finalUrl: current };
  }
  return { kind: "err", reason: "too_many_redirects", status: 502 };
}

export async function GET(req: NextRequest): Promise<Response> {
  const rawUrl = req.nextUrl.searchParams.get("url");
  if (!rawUrl) {
    return NextResponse.json({ error: "Missing url" }, { status: 400 });
  }
  const parsed = parseSafeUrl(rawUrl);
  if (!parsed) {
    return NextResponse.json({ error: "Invalid url" }, { status: 400 });
  }

  // Per-IP rate limit. Applied AFTER URL parse (so garbage-URL probes are
  // cheaper than a real fetch) but BEFORE any DNS/socket work.
  const ip = clientIp(req);
  if (!checkRate(ip)) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "retry-after": "60" } },
    );
  }

  // Cache dir is best-effort; failure here is logged but doesn't block.
  await ensureCacheDir();

  // Use the ORIGINAL (post-parse) URL as the cache key. Redirect targets
  // are not used as keys because a flipping upstream redirect would split
  // the cache and we'd never warm a single hot entry.
  const cacheKey = parsed.toString();
  const hostLog = logHost(cacheKey);
  const startedAt = Date.now();

  const cached = await readCached(cacheKey);
  if (cached) {
    hitCounter++;
    if (hitCounter % HIT_LOG_EVERY === 0) {
      console.log(
        `[image-proxy] cache=hit count=${hitCounter} host=${hostLog} ms=${Date.now() - startedAt}`,
      );
    }
    return new Response(new Uint8Array(cached.bytes), {
      status: 200,
      headers: {
        "content-type": cached.contentType,
        "cache-control": `public, max-age=${CACHE_TTL_SECONDS}, immutable`,
        "x-image-proxy-cache": "hit",
      },
    });
  }

  // Known-dead-gateway rewrite (e.g. `*.ipfs.nftstorage.link` → path-style).
  // The rewritten URL is re-validated by parseSafeUrl and still gets the full
  // per-hop assertPublicHost treatment inside safeFetch; the cache key above
  // stays the original so a repeat request for the dead URL hits cache.
  let fetchUrl = parsed;
  const rewritten = rewriteDeadGateway(parsed);
  if (rewritten) {
    const safe = parseSafeUrl(rewritten.toString());
    if (safe) {
      fetchUrl = safe;
      console.log(
        `[image-proxy] gateway rewrite ${hostLog} -> ${logHost(safe.toString())}`,
      );
    }
  }

  const fetched = await safeFetch(fetchUrl);
  if (fetched.kind === "err") {
    // Demote routine timeouts against known-dead public gateways to a
    // sampled per-host rollup. Every other error path (4xx/5xx,
    // fetch_failed, non-dead-host timeouts) still logs immediately so
    // real proxy regressions stay visible.
    if (
      fetched.reason === "timeout" &&
      isKnownDeadGatewayHost(hostLog)
    ) {
      noteDeadGatewayTimeout(hostLog);
    } else {
      console.warn(
        `[image-proxy] cache=miss reason=${fetched.reason} host=${hostLog} ms=${Date.now() - startedAt}`,
      );
    }
    return NextResponse.json(
      { error: fetched.reason },
      { status: fetched.status },
    );
  }

  const upstream = fetched.res;
  if (!upstream.ok) {
    try { await upstream.body?.cancel(); } catch { /* best-effort */ }
    console.warn(
      `[image-proxy] cache=miss reason=http-${upstream.status} host=${hostLog} ms=${Date.now() - startedAt}`,
    );
    return NextResponse.json(
      { error: `Upstream ${upstream.status}` },
      { status: 502 },
    );
  }

  // Reject responses claiming oversize via Content-Length before we even
  // start reading. Some hostile servers omit Content-Length; the streamed
  // size cap below catches them.
  const cl = upstream.headers.get("content-length");
  if (cl && Number(cl) > MAX_BYTES) {
    try { await upstream.body?.cancel(); } catch { /* best-effort */ }
    console.warn(
      `[image-proxy] cache=miss reason=too-large-declared len=${cl} host=${hostLog} ms=${Date.now() - startedAt}`,
    );
    return NextResponse.json(
      { error: "Upstream image exceeds size cap" },
      { status: 413 },
    );
  }

  const declaredCt = (upstream.headers.get("content-type") ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();

  // Streamed read with hard byte cap. Avoids buffering attacker-supplied
  // multi-GB chunked responses (the old `await arrayBuffer()` first / cap
  // after pattern was an OOM lever). We read BEFORE finalising the
  // content-type so we can magic-byte-sniff responses that arrive without a
  // usable Content-Type (gateway.irys.xyz and other raw-bytes gateways serve
  // real images as application/octet-stream / no type).
  const bytes = await readBodyCapped(upstream, MAX_BYTES);
  if (bytes === null) {
    console.warn(
      `[image-proxy] cache=miss reason=too-large-streamed host=${hostLog} ms=${Date.now() - startedAt}`,
    );
    return NextResponse.json(
      { error: "Upstream image exceeds size cap" },
      { status: 413 },
    );
  }

  // Content-type resolution: trust an explicit allowlisted type; otherwise
  // fall back to magic-byte sniffing and accept ONLY real raster image bytes
  // (PNG/JPEG/GIF/WebP/AVIF). HTML error pages, JSON, plain text — anything
  // that isn't a recognised image — is still rejected with 415, so a broken
  // gateway can't smuggle markup through the proxy.
  let contentType: string | null = ALLOWED_CONTENT_TYPES.has(declaredCt)
    ? declaredCt
    : null;
  let sniffed = false;
  if (!contentType) {
    const guess = sniffImageType(bytes);
    if (!guess) {
      console.warn(
        `[image-proxy] cache=miss reason=bad-ct ct=${declaredCt || "<none>"} sniff=none bytes=${bytes.byteLength} host=${hostLog} ms=${Date.now() - startedAt}`,
      );
      return NextResponse.json(
        { error: `Unsupported content-type ${declaredCt || "(none)"}` },
        { status: 415 },
      );
    }
    contentType = guess;
    sniffed = true;
  }

  // Only persist successful, type-validated (declared OR sniffed), size-
  // bounded bodies. Failure paths above never reach this line, so the cache
  // cannot retain a poisoned or oversized record.
  void writeCached(cacheKey, bytes, contentType);

  console.log(
    `[image-proxy] cache=miss reason=ok status=${upstream.status} ct=${contentType}${sniffed ? "(sniffed)" : ""} bytes=${bytes.byteLength} host=${hostLog} ms=${Date.now() - startedAt}`,
  );

  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "content-type": contentType,
      "cache-control": `public, max-age=${CACHE_TTL_SECONDS}, immutable`,
      "x-image-proxy-cache": "miss",
    },
  });
}
