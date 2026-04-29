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
const cache = new Map<string, CacheEntry>();

const DAS_BATCH_LIMIT = 1000;

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
  | "exception";

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

// Wallet-scoped Core asset discovery via DAS. Returns a structured result
// (success or typed-failure) so the caller can log the exact reason for
// fallback. The `assets` payload is the same as before the diagnostic
// refactor; the wrapper just adds counts + timing.
export async function fetchCoreAssetsByOwner(
  owner: string,
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
  // DAS paginates at 1000 items/page. Loop until we read fewer than the
  // page size, capped at a generous safety limit so a runaway result set
  // can't loop forever.
  const PAGE_SIZE = 1000;
  const MAX_PAGES = 20;
  let pagesFetched = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    let body: { result?: { items?: DasAsset[] } } | undefined;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "wallet-checker-core-discovery",
          method: "getAssetsByOwner",
          params: {
            ownerAddress: owner,
            page,
            limit: PAGE_SIZE,
          },
        }),
      });
      if (!res.ok) {
        console.warn(
          `[helius-das] getAssetsByOwner HTTP ${res.status} for ${owner} (page ${page}) — falling back to on-chain scan`,
        );
        return {
          ok: false,
          reason: "http-error",
          detail: `HTTP ${res.status}`,
          durationMs: Date.now() - startedAt,
        };
      }
      body = (await res.json()) as { result?: { items?: DasAsset[] } };
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      console.warn(
        `[helius-das] getAssetsByOwner network error for ${owner} (page ${page}): ${msg}`,
      );
      return {
        ok: false,
        reason: "network-error",
        detail: msg,
        durationMs: Date.now() - startedAt,
      };
    }
    pagesFetched = page;
    const items = Array.isArray(body?.result?.items) ? body.result.items : [];
    if (items.length === 0) break;
    rawCount += items.length;
    for (const a of items) {
      if (!a || typeof a !== "object") continue;
      // Skip compressed NFTs — different program (Bubblegum); the Core
      // burn path can't handle them.
      if (a.compression && a.compression.compressed === true) continue;
      // Relaxed Core filter: accept any interface containing "MplCore"
      // (catches MplCoreAsset / MplCoreCollection / future variants).
      // Other interfaces (V1_NFT, ProgrammableNFT, FungibleToken, …) are
      // burned via different paths so we exclude them here. Live-state
      // verification at build time is the safety net for false positives.
      const ifaceStr = typeof a.interface === "string" ? a.interface : "";
      if (!ifaceStr.includes("MplCore")) continue;
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
    if (items.length < PAGE_SIZE) break;
  }
  return {
    ok: true,
    assets: out,
    pagesFetched,
    rawCount,
    durationMs: Date.now() - startedAt,
  };
}

export async function fetchAssetMetadataBatch(
  ids: string[],
): Promise<Map<string, AssetMetadata>> {
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

  for (let i = 0; i < fresh.length; i += DAS_BATCH_LIMIT) {
    const chunk = fresh.slice(i, i + DAS_BATCH_LIMIT);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "wallet-checker-das",
          method: "getAssetBatch",
          params: { ids: chunk },
        }),
      });
      if (!res.ok) {
        console.warn(
          `[helius-das] HTTP ${res.status} for ${chunk.length} ids — falling back to on-chain only`,
        );
        continue;
      }
      const body = (await res.json()) as { result?: DasAsset[] };
      const assets = Array.isArray(body.result) ? body.result : [];
      for (const a of assets) {
        if (!a || typeof a !== "object") continue;
        const id = strOrNull(a.id);
        if (!id) continue;
        const meta = parse(a);
        out.set(id, meta);
        cache.set(id, { meta, expiresAt: Date.now() + CACHE_TTL_MS });
      }
    } catch (err) {
      console.warn(
        `[helius-das] network error for ${chunk.length} ids: ${(err as Error)?.message ?? err}`,
      );
      // Continue — caller falls back to on-chain bytes for unresolved ids.
    }
  }

  return out;
}
