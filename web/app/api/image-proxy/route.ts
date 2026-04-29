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

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";

export const runtime = "nodejs";

const FETCH_TIMEOUT_MS = 5_000;
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB cap — NFT thumbnails are small
const CACHE_TTL_SECONDS = 60 * 60 * 24; // 24h browser cache
const CACHE_DIR = path.join(process.cwd(), "data", "image-cache");

const ALLOWED_CONTENT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/svg+xml",
]);

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
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await Promise.all([
      fs.writeFile(file, bytes),
      fs.writeFile(meta, JSON.stringify({ contentType })),
    ]);
  } catch (err) {
    // Cache write failure shouldn't fail the response — log + continue.
    console.warn(
      `[image-proxy] cache write failed: ${(err as Error)?.message ?? err}`,
    );
  }
}

export async function GET(req: NextRequest): Promise<Response> {
  const url = req.nextUrl.searchParams.get("url");
  if (!url) {
    return NextResponse.json({ error: "Missing url" }, { status: 400 });
  }
  // SSRF guard: only allow http(s) — no file://, data:, javascript:, etc.
  if (!/^https?:\/\//i.test(url)) {
    return NextResponse.json({ error: "Invalid url scheme" }, { status: 400 });
  }

  // Cache hit short-circuit.
  const cached = await readCached(url);
  if (cached) {
    return new Response(new Uint8Array(cached.bytes), {
      status: 200,
      headers: {
        "content-type": cached.contentType,
        "cache-control": `public, max-age=${CACHE_TTL_SECONDS}, immutable`,
        "x-image-proxy-cache": "hit",
      },
    });
  }

  // Fetch with timeout. AbortController + setTimeout keeps slow gateways
  // from holding a Next.js worker for the full default fetch timeout.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let upstream: Response;
  try {
    upstream = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        // No referrer leak for same reason we set referrerPolicy on <img>.
        "user-agent": "wallet-checker-image-proxy/1.0",
      },
    });
  } catch (err) {
    clearTimeout(timer);
    return NextResponse.json(
      { error: `Upstream fetch failed: ${(err as Error)?.message ?? err}` },
      { status: 502 },
    );
  }
  clearTimeout(timer);

  if (!upstream.ok) {
    return NextResponse.json(
      { error: `Upstream ${upstream.status}` },
      { status: 502 },
    );
  }

  // Type sniff: only proxy bona-fide image responses. Untyped or HTML
  // responses (common with broken IPFS gateways) get 415'd so the browser
  // falls back to the placeholder.
  const ct = (upstream.headers.get("content-type") ?? "").split(";")[0].trim();
  if (ct && !ALLOWED_CONTENT_TYPES.has(ct)) {
    return NextResponse.json(
      { error: `Unsupported content-type ${ct}` },
      { status: 415 },
    );
  }

  // Read with size cap. Streaming-aware ArrayBuffer → Buffer conversion is
  // fine for thumbnails; full streaming is overkill at this size.
  const ab = await upstream.arrayBuffer();
  if (ab.byteLength > MAX_BYTES) {
    return NextResponse.json(
      { error: "Upstream image exceeds size cap" },
      { status: 413 },
    );
  }
  const bytes = Buffer.from(ab);
  const contentType = ct || "application/octet-stream";

  // Best-effort write — never blocks the response.
  void writeCached(url, bytes, contentType);

  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "content-type": contentType,
      "cache-control": `public, max-age=${CACHE_TTL_SECONDS}, immutable`,
      "x-image-proxy-cache": "miss",
    },
  });
}
