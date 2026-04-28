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
  content?: {
    metadata?: { name?: unknown; symbol?: unknown };
    files?: Array<{ uri?: unknown; cdn_uri?: unknown }>;
    links?: { image?: unknown };
    json_uri?: unknown;
  };
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
