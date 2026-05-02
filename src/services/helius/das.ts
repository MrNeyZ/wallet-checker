// Helius DAS (Digital Asset Standard) client — used to enrich NFT burn
// candidates with off-chain metadata (name, symbol, image). Many real NFTs
// store the human-readable name in their off-chain JSON, leaving the on-chain
// Metaplex `Metadata.data.name` field empty/padded. Reading on-chain bytes
// alone leaves most candidates with null names, which surfaces as
// "metadata not yet loaded" in the UI. DAS resolves both layers in a single
// HTTP call (batched up to 1000 mints).
//
// Failure mode: graceful degradation. If HELIUS_API_KEY is missing or the
// call fails, we return an empty map so callers fall back to whatever
// on-chain bytes they already extracted. Burn flows MUST continue to work
// even if Helius is unavailable.

import { env } from "../../config/env.js";
import { runWithConcurrency } from "../../lib/concurrency.js";
import { CappedLruMap } from "../../lib/lruCache.js";

export interface AssetMetadata {
  name: string | null;
  symbol: string | null;
  image: string | null;
  uri: string | null;
}

interface CacheEntry {
  meta: AssetMetadata;
  expiresAt: number;
}

const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 1000;
// Capped LRU keeps the per-mint metadata cache from growing unbounded
// across long-lived servers. TTL stays enforced at the call site
// (`expiresAt > now`).
const cache = new CappedLruMap<string, CacheEntry>(CACHE_MAX);

const DAS_BATCH_LIMIT = 1000;
// Maximum HTTP requests issued in parallel against Helius DAS for both
// pagination (getAssetsByOwner) and batch metadata (getAssetBatch). Capped
// at 3 by spec — Helius rate-limits aggressively above that.
const DAS_PARALLEL = 3;
// Per-call latency above which we surface a single-line timing log so a
// slow DAS endpoint is visible in production logs without flooding the
// happy-path. Sub-second calls stay silent.
const DAS_SLOW_LOG_MS = 1000;

function endpoint(): string | null {
  const key = env.HELIUS_API_KEY;
  if (!key) return null;
  return `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`;
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

// Helius DAS shape (subset). The full response carries plenty more (creators,
// supply, ownership, etc.) but we only need a tiny slice for the burn UI.
interface DasAsset {
  id?: string;
  interface?: string;
  content?: {
    metadata?: { name?: unknown; symbol?: unknown };
    files?: Array<{ uri?: unknown; cdn_uri?: unknown }>;
    links?: { image?: unknown };
    json_uri?: unknown;
  };
  // Sometimes present on getAssetsByOwner. We only need the verified
  // collection group_value when present.
  grouping?: Array<{ group_key?: unknown; group_value?: unknown }>;
  // Compressed NFTs (cNFT) — different program (Bubblegum); the Core burn
  // path can't handle them so we drop them during discovery.
  compression?: { compressed?: unknown };
}

// ── Supported-asset allowlist ─────────────────────────────────────────────
// Strict allowlist applied at the DAS-parsing layer BEFORE any heavy
// processing (metadata parse, hydration, image extraction). Prevents
// compressed NFTs (cNFT — Bubblegum program, no on-chain account to
// close) and unknown / future asset interfaces from ever reaching the
// burn discovery logic.
//
// Burnable interfaces only:
//   FungibleToken / FungibleAsset    → SPL burn flow
//   NonFungibleToken                 → Legacy Metaplex BurnV1
//   ProgrammableNFT                  → pNFT BurnV1 (with token-record + auth-rules)
//   NonFungibleEdition               → Metaplex master/print edition burn
//   MplCoreAsset                     → Metaplex Core BurnV1
//
// Anything else (V1_NFT compression flag, V2_NFT, FungibleEdition,
// MplCoreCollection, future variants) is treated as out-of-scope.
const SUPPORTED_ASSET_INTERFACES: ReadonlySet<string> = new Set([
  "FungibleToken",
  "FungibleAsset",
  "NonFungibleToken",
  "ProgrammableNFT",
  "NonFungibleEdition",
  "MplCoreAsset",
]);

// Exported so any future caller (group cleaner scan-all, future shared
// DAS util) can reuse the same allowlist instead of redefining it.
export function isSupportedAsset(asset: DasAsset | null | undefined): boolean {
  if (!asset || typeof asset !== "object") return false;
  if (asset.compression && asset.compression.compressed === true) return false;
  if (typeof asset.interface !== "string") return false;
  return SUPPORTED_ASSET_INTERFACES.has(asset.interface);
}

function parse(asset: DasAsset): AssetMetadata {
  const name = strOrNull(asset.content?.metadata?.name);
  const symbol = strOrNull(asset.content?.metadata?.symbol);
  const image =
    strOrNull(asset.content?.links?.image) ??
    strOrNull(asset.content?.files?.[0]?.cdn_uri) ??
    strOrNull(asset.content?.files?.[0]?.uri);
  const uri = strOrNull(asset.content?.json_uri);
  return { name, symbol, image, uri };
}

// Resolves metadata for a list of asset ids (NFT mints OR Core asset ids).
// Returns a Map keyed by id. Missing entries simply aren't in the map; the
// caller should fall back to whatever it already has for those ids.
// Wallet-scoped Core asset discovery via DAS. Returns null when DAS isn't
// available (no API key, network failure, non-OK response) so the caller
// can transparently fall back to the slower on-chain getProgramAccounts
// scan. Filters server-side via the `MplCoreAsset` interface — Helius
// supports this since 2024 and it's much faster than scanning the entire
// Core program for accounts owned by a wallet.
//
// Output shape mirrors what the txBuilder needs to construct candidates;
// lamports are NOT included (DAS doesn't surface raw account state) and
// must be hydrated separately via getMultipleAccountsInfo on the asset
// addresses. Owner is implicit (we filtered by ownerAddress).
export interface CoreAssetFromDas {
  asset: string;
  collection: string | null;
  name: string | null;
  uri: string | null;
  image: string | null;
}

// Reason returned alongside null so the txBuilder log can attribute the
// fallback to a specific cause without re-deriving it from console output.
export type CoreAssetsByOwnerError =
  | "no-api-key"
  | "http-error"
  | "network-error"
  | "exception"
  | "aborted";

export interface CoreAssetsByOwnerOk {
  ok: true;
  assets: CoreAssetFromDas[];
  pagesFetched: number;
  rawCount: number; // total items received from DAS pre-filter
  durationMs: number;
}

export interface CoreAssetsByOwnerFail {
  ok: false;
  reason: CoreAssetsByOwnerError;
  detail?: string;
  durationMs: number;
}

export type CoreAssetsByOwnerResult =
  | CoreAssetsByOwnerOk
  | CoreAssetsByOwnerFail;

// Fetches one DAS getAssetsByOwner page. Internal helper for the parallel
// pagination loop in fetchCoreAssetsByOwner.
type PageFetchResult =
  | { ok: true; items: DasAsset[] }
  | { ok: false; reason: CoreAssetsByOwnerError; detail: string };

async function fetchOneOwnerPage(
  url: string,
  owner: string,
  page: number,
  pageSize: number,
  signal?: AbortSignal,
): Promise<PageFetchResult> {
  try {
    if (signal?.aborted) {
      return { ok: false, reason: "aborted", detail: "aborted" };
    }
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "wallet-checker-core-discovery",
        method: "getAssetsByOwner",
        params: { ownerAddress: owner, page, limit: pageSize },
      }),
      signal,
    });
    if (!res.ok) {
      console.warn(
        `[helius-das] getAssetsByOwner HTTP ${res.status} for ${owner} (page ${page}) — falling back to on-chain scan`,
      );
      return { ok: false, reason: "http-error", detail: `HTTP ${res.status}` };
    }
    const body = (await res.json()) as { result?: { items?: DasAsset[] } };
    const items = Array.isArray(body?.result?.items) ? body.result.items : [];
    return { ok: true, items };
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    if (signal?.aborted) {
      return { ok: false, reason: "aborted", detail: msg };
    }
    console.warn(
      `[helius-das] getAssetsByOwner network error for ${owner} (page ${page}): ${msg}`,
    );
    return { ok: false, reason: "network-error", detail: msg };
  }
}

// Wallet-scoped Core asset discovery via DAS. Returns a structured result
// (success or typed-failure) so the caller can log the exact reason for
// fallback. The `assets` payload is the same as before the diagnostic
// refactor; the wrapper just adds counts + timing.
//
// Pagination is parallelised in WAVES of `DAS_PARALLEL` pages so a wallet
// with many Core assets still finishes quickly without exceeding Helius's
// per-second budget. Within a wave, pages are processed in order so a
// short page (== last page) cleanly stops the loop.
export async function fetchCoreAssetsByOwner(
  owner: string,
  signal?: AbortSignal,
): Promise<CoreAssetsByOwnerResult> {
  const startedAt = Date.now();
  const url = endpoint();
  if (!url) {
    return {
      ok: false,
      reason: "no-api-key",
      durationMs: Date.now() - startedAt,
    };
  }
  const out: CoreAssetFromDas[] = [];
  let rawCount = 0;
  // Per-call drop counters — accumulated across every wave so the
  // function-exit log can show the full breakdown of what got filtered.
  let totalDroppedCompressed = 0;
  let totalDroppedUnsupported = 0;
  // DAS paginates at 1000 items/page. Loop until we read fewer than the
  // page size, capped at a generous safety limit so a runaway result set
  // can't loop forever.
  const PAGE_SIZE = 1000;
  const MAX_PAGES = 20;
  let pagesFetched = 0;
  let stop = false;

  for (let basePage = 1; basePage <= MAX_PAGES && !stop; basePage += DAS_PARALLEL) {
    if (signal?.aborted) {
      return {
        ok: false,
        reason: "aborted",
        detail: "aborted",
        durationMs: Date.now() - startedAt,
      };
    }
    const pages: number[] = [];
    for (let i = 0; i < DAS_PARALLEL && basePage + i <= MAX_PAGES; i++) {
      pages.push(basePage + i);
    }
    const settled = await runWithConcurrency(pages, DAS_PARALLEL, (p) =>
      fetchOneOwnerPage(url, owner, p, PAGE_SIZE, signal),
    );
    // Two-phase processing of the wave. Phase 1: bail on any error so we
    // never consume a partial result set. Phase 2: process EVERY returned
    // page, even if a lower-numbered one came back empty — the upstream
    // is monotonic in practice, but a transient empty-in-the-middle must
    // not silently drop pages we already fetched in parallel. The stop
    // signal is read from the HIGHEST page in the wave only (the last
    // index is the highest-numbered page since `pages` is built in order).
    for (let i = 0; i < settled.length; i++) {
      const sr = settled[i];
      if (sr.status === "rejected") {
        const msg = sr.reason instanceof Error ? sr.reason.message : String(sr.reason);
        return {
          ok: false,
          reason: "exception",
          detail: msg,
          durationMs: Date.now() - startedAt,
        };
      }
      if (!sr.value.ok) {
        return {
          ok: false,
          reason: sr.value.reason,
          detail: sr.value.detail,
          durationMs: Date.now() - startedAt,
        };
      }
    }
    let lastWaveItems = 0;
    let droppedCompressed = 0;
    let droppedUnsupported = 0;
    for (let i = 0; i < settled.length; i++) {
      const sr = settled[i];
      // Errors already filtered above — narrow the type.
      if (sr.status !== "fulfilled" || !sr.value.ok) continue;
      const items = sr.value.items;
      pagesFetched = pages[i];
      rawCount += items.length;
      for (const a of items) {
        if (!a || typeof a !== "object") continue;
        // Step 1: shared allowlist — drops compressed cNFTs + any
        // interface we don't have a burn path for. Counts each rejection
        // reason so the wave log can show the breakdown.
        if (a.compression && a.compression.compressed === true) {
          droppedCompressed++;
          continue;
        }
        if (!isSupportedAsset(a)) {
          droppedUnsupported++;
          continue;
        }
        // Step 2: this function specifically discovers Metaplex Core
        // assets — narrow further. `isSupportedAsset` already excluded
        // FungibleToken / NonFungibleToken / ProgrammableNFT, but we
        // want a firm MplCore-only result here for the Core burn flow.
        if (a.interface !== "MplCoreAsset") {
          droppedUnsupported++;
          continue;
        }
        const id = strOrNull(a.id);
        if (!id) continue;
        const meta = parse(a);
        // Verified-collection extraction. MplCore uses a single grouping
        // entry with group_key === "collection".
        let collection: string | null = null;
        if (Array.isArray(a.grouping)) {
          for (const g of a.grouping) {
            if (
              g &&
              typeof g === "object" &&
              g.group_key === "collection" &&
              typeof g.group_value === "string" &&
              g.group_value.length > 0
            ) {
              collection = g.group_value;
              break;
            }
          }
        }
        out.push({
          asset: id,
          collection,
          name: meta.name,
          uri: meta.uri,
          image: meta.image,
        });
      }
      if (i === settled.length - 1) lastWaveItems = items.length;
    }
    // Roll up this wave's drop counts into the function-level totals so
    // the post-loop log shows the full breakdown.
    totalDroppedCompressed += droppedCompressed;
    totalDroppedUnsupported += droppedUnsupported;
    // Only stop based on the highest-numbered page in this wave.
    if (lastWaveItems < PAGE_SIZE) stop = true;
  }
  const durationMs = Date.now() - startedAt;
  if (durationMs > DAS_SLOW_LOG_MS) {
    console.log(
      `[DAS] fetchCoreAssetsByOwner ${owner} took ${durationMs}ms (pages=${pagesFetched}, raw=${rawCount})`,
    );
  }
  // Asset-filter telemetry — fires whenever the supported-asset
  // allowlist actually rejected something. Helps confirm the filter is
  // working and shows the rejection breakdown when debugging "why is
  // this asset missing from my burner UI?" tickets.
  if (totalDroppedCompressed > 0 || totalDroppedUnsupported > 0) {
    console.log(
      `[burner] filtered Core assets for ${owner}: total=${rawCount} kept=${out.length} skippedCompressed=${totalDroppedCompressed} skippedUnsupported=${totalDroppedUnsupported}`,
    );
  }
  return {
    ok: true,
    assets: out,
    pagesFetched,
    rawCount,
    durationMs,
  };
}

export async function fetchAssetMetadataBatch(
  ids: string[],
  signal?: AbortSignal,
): Promise<Map<string, AssetMetadata>> {
  const startedAt = Date.now();
  const out = new Map<string, AssetMetadata>();
  if (ids.length === 0) return out;

  const now = Date.now();
  const fresh: string[] = [];
  // De-dupe + cache lookup. Hot-path for repeat scans of the same wallet.
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const cached = cache.get(id);
    if (cached && cached.expiresAt > now) {
      out.set(id, cached.meta);
    } else {
      fresh.push(id);
    }
  }
  if (fresh.length === 0) return out;

  const url = endpoint();
  if (!url) return out; // No key configured — caller falls back gracefully.

  const chunks: string[][] = [];
  for (let i = 0; i < fresh.length; i += DAS_BATCH_LIMIT) {
    chunks.push(fresh.slice(i, i + DAS_BATCH_LIMIT));
  }

  const settled = await runWithConcurrency(chunks, DAS_PARALLEL, async (chunk) => {
    if (signal?.aborted) throw new Error("aborted");
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "wallet-checker-das",
        method: "getAssetBatch",
        params: { ids: chunk },
      }),
      signal,
    });
    if (!res.ok) {
      console.warn(
        `[helius-das] HTTP ${res.status} for ${chunk.length} ids — falling back to on-chain only`,
      );
      return null;
    }
    const body = (await res.json()) as { result?: DasAsset[] };
    return Array.isArray(body.result) ? body.result : [];
  });

  let metaTotal = 0;
  let metaSkippedCompressed = 0;
  let metaSkippedUnsupported = 0;
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i];
    if (r.status === "rejected") {
      const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
      console.warn(
        `[helius-das] network error for ${chunks[i].length} ids: ${msg}`,
      );
      // Caller falls back to on-chain bytes for unresolved ids.
      continue;
    }
    if (!r.value) continue;
    for (const a of r.value) {
      if (!a || typeof a !== "object") continue;
      const id = strOrNull(a.id);
      if (!id) continue;
      metaTotal++;
      // Defensive supported-asset filter — we don't enrich metadata for
      // assets the burn flow can't act on. Compressed cNFTs and any
      // future / unknown asset interface are dropped here so a stale
      // entry can never poison the metadata cache + leak an unsupported
      // asset's name/image into a burn-card UI. Counters fuel the
      // diagnostic log below.
      if (a.compression && a.compression.compressed === true) {
        metaSkippedCompressed++;
        continue;
      }
      if (!isSupportedAsset(a)) {
        metaSkippedUnsupported++;
        continue;
      }
      const meta = parse(a);
      out.set(id, meta);
      cache.set(id, { meta, expiresAt: Date.now() + CACHE_TTL_MS });
    }
  }

  const durationMs = Date.now() - startedAt;
  if (durationMs > DAS_SLOW_LOG_MS) {
    console.log(
      `[DAS] fetchAssetMetadataBatch ${fresh.length} ids took ${durationMs}ms (chunks=${chunks.length})`,
    );
  }
  // Asset-filter telemetry — only fires when the supported-asset
  // allowlist actually rejected something during metadata enrichment.
  if (metaSkippedCompressed > 0 || metaSkippedUnsupported > 0) {
    console.log(
      `[burner] filtered metadata batch: total=${metaTotal} kept=${out.size - (ids.length - fresh.length)} skippedCompressed=${metaSkippedCompressed} skippedUnsupported=${metaSkippedUnsupported}`,
    );
  }

  return out;
}
