import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { connection } from "./solana.js";
import { getParsedTokenAccountsByOwnerThrottled } from "./rpc.js";
import { CappedLruMap } from "./lruCache.js";
import {
  fetchAssetMetadataBatch,
  type AssetMetadata,
} from "../services/helius/das.js";

export interface ScannedTokenAccount {
  tokenAccount: string;
  mint: string;
  owner: string;
  amount: string;
  decimals: number;
  lamports: number;
  estimatedReclaimSol: number;
  programId: string;
}

export interface CleanupScanResult {
  wallet: string;
  totals: {
    tokenAccounts: number;
    estimatedReclaimSol: number;
  };
  emptyTokenAccounts: ScannedTokenAccount[];
  fungibleTokenAccounts: ScannedTokenAccount[];
  nftTokenAccounts: ScannedTokenAccount[];
  unknownTokenAccounts: ScannedTokenAccount[];
}

// 10-minute scan cache. Bumped from 30s so the batch group-scan endpoint
// can serve repeat scans of the same wallet from cache instead of hitting
// the RPC again. Concurrent calls for the same wallet share the in-flight
// promise so a single user action that fans out (e.g. cleanup-scan +
// burn-candidates fired together) only triggers one underlying scan.
// The full-clean loop bypasses with `refresh: true` after each close-tx.
//
// The cap is a GLOBAL entry count, not per-address. With the
// summary/full key split each address can occupy up to 2 slots, so the
// effective unique-address capacity is roughly SCAN_CACHE_MAX/2 worst
// case. SCAN_CACHE_MAX was chosen with that headroom in mind — a
// pm2 process scanning ~500 unique addresses across both modes is well
// within bounds; a less common multi-thousand-address workload will
// see LRU eviction of the coldest entries, which is the intended
// behavior (eviction = "next call refetches", never a correctness bug).
const SCAN_TTL_MS = 10 * 60 * 1000;
const SCAN_CACHE_MAX = 1000;
// Per-bucket soft cap for raw token-account counts. Pure telemetry —
// we do NOT truncate the bucket because the close-empty flow needs to
// see every empty account or the user can't fully clean their wallet.
// Crossing the threshold is logged once per scan so a pathological
// wallet (post-airdrop spam, attacker dust) is visible in operator
// logs without changing scan semantics.
const BUCKET_BLOAT_WARN = 5000;
// `rejected` is set synchronously in the same microtask tick as the
// underlying scan's rejection. Concurrent readers that arrive between
// the rejection and the cache `.delete()` then treat the entry as a
// miss and start a fresh scan instead of inheriting the poisoned
// promise. Without this flag, a transient RPC failure could be served
// to N parallel callers as a cached error for the brief drain window.
type CacheEntry = {
  ts: number;
  promise: Promise<CleanupScanResult>;
  rejected: boolean;
};
// Capped LRU keeps memory bounded under a long-running pm2 process
// scanning many unique wallets. TTL is still enforced at the call site.
const scanCache = new CappedLruMap<string, CacheEntry>(SCAN_CACHE_MAX);

// Mints flagged for verbose tracing through the full scan/classify
// pipeline. Set via DEBUG_MINTS env (comma-separated) so we can ship
// the trace harness without cluttering steady-state logs.
//
// Lazy init: do NOT read process.env at module-evaluation time. ESM
// imports are eager and depending on the import graph, this module
// can evaluate BEFORE `import "dotenv/config"` has populated
// process.env — which would silently freeze DEBUG_MINTS to an empty
// set forever. The lazy getter below re-checks process.env on first
// use, by which time dotenv has run.
let DEBUG_MINTS: ReadonlySet<string> | null = null;
let DEBUG_MINTS_ANNOUNCED = false;
function getDebugMints(): ReadonlySet<string> {
  if (DEBUG_MINTS === null) {
    const raw = process.env.DEBUG_MINTS ?? "";
    const parsed = new Set(
      raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
    DEBUG_MINTS = parsed;
    if (!DEBUG_MINTS_ANNOUNCED) {
      DEBUG_MINTS_ANNOUNCED = true;
      // Single startup line so the operator can verify the env var
      // actually reached Node. Useful when "the trace logs aren't
      // firing" — if this line says count=0, the env var isn't set
      // (or got eaten by pm2 / docker / nginx layer).
      console.log(
        `[debugMint] DEBUG_MINTS active: count=${parsed.size} mints=${
          parsed.size === 0 ? "<none>" : [...parsed].join(",")
        }`,
      );
    }
  }
  return DEBUG_MINTS;
}
export function isDebugMint(mint: string): boolean {
  return getDebugMints().has(mint);
}

async function fetchTokenAccountsForProgram(
  owner: PublicKey,
  programId: PublicKey,
  signal?: AbortSignal,
) {
  const res = await getParsedTokenAccountsByOwnerThrottled(
    connection,
    owner,
    programId,
    signal,
  );
  return res.value.map((entry) => ({ entry, programId: programId.toBase58() }));
}

// Hard cap on NFT-shape candidates we'll forward to the DAS metadata
// pass. A wallet with thousands of 1-supply / 0-decimal token accounts
// is almost certainly junk (post-burn dust or attacker spam) — beyond
// this point we keep them in `unknownTokenAccounts` so close-empty
// still works but the burn UI doesn't choke on a 5k-entry list. The
// per-call DAS chunking (1000/batch, 3 parallel waves) means uncapped
// we'd issue up to 5 sequential batches per pathological wallet,
// which both spikes memory and burns Helius quota.
const MAX_NFT_CANDIDATES_FOR_DAS = 2000;

function abortedError(): Error {
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}

// Classify a 1-supply / 0-decimal token account by what Helius DAS says
// about the mint. We route on `interface` / `tokenStandard` — NOT on
// whether the metadata happens to surface a name/symbol/image. The
// previous name+image gate dropped legitimate NFTs whose off-chain
// metadata had been pruned by hosting providers; the actual on-chain
// Token Metadata account is what determines burnability.
//
// Returns:
//   "legacy"   → Token Metadata NonFungible       → Legacy section
//   "pnft"     → Token Metadata ProgrammableNFT   → pNFT section
//   "unknown"  → DAS resolved but it's something else (e.g. cNFT,
//                 fungible-asset misshape, MplCoreCollection, etc.) —
//                 demote to unknownTokenAccounts so the burn flows
//                 don't see it.
//   null       → DAS didn't return an entry at all → treat as a
//                 candidate (permissive fallback) so a missing
//                 HELIUS_API_KEY / outage doesn't silently wipe the
//                 user's NFT list.
function classifyNftCandidate(
  meta: AssetMetadata | undefined,
): "legacy" | "pnft" | "unknown" | null {
  if (!meta) return null;
  const iface = meta.iface;
  const std = meta.tokenStandard;
  if (iface === "ProgrammableNFT") return "pnft";
  if (iface === "NonFungibleToken" || iface === "NonFungibleEdition") {
    // tokenStandard is the secondary classifier: occasionally DAS surfaces
    // ProgrammableNonFungible under the NonFungibleToken interface.
    if (std === "ProgrammableNonFungible") return "pnft";
    return "legacy";
  }
  if (std === "NonFungible") return "legacy";
  if (std === "ProgrammableNonFungible") return "pnft";
  return "unknown";
}

async function performScan(
  address: string,
  signal?: AbortSignal,
  summaryOnly: boolean = false,
): Promise<CleanupScanResult> {
  const owner = new PublicKey(address);

  if (signal?.aborted) throw abortedError();
  const [classic, token2022] = await Promise.all([
    fetchTokenAccountsForProgram(owner, TOKEN_PROGRAM_ID, signal),
    fetchTokenAccountsForProgram(owner, TOKEN_2022_PROGRAM_ID, signal),
  ]);
  if (signal?.aborted) throw abortedError();
  // Soft-warning telemetry only — getParsedTokenAccountsByOwner has no
  // upstream limit knob, so the raw response is already materialised in
  // memory by the time we see it here. The MAX_NFT_CANDIDATES_FOR_DAS
  // cap below is what actually bounds the DAS metadata map. Logging the
  // count lets us spot pathological wallets in production logs without
  // changing scan semantics.
  const rawTotal = classic.length + token2022.length;
  if (rawTotal > 5000) {
    console.warn(
      `[scanner] large wallet ${address}: ${rawTotal} token accounts (classic=${classic.length}, t22=${token2022.length})`,
    );
  }

  const result: CleanupScanResult = {
    wallet: owner.toBase58(),
    totals: { tokenAccounts: 0, estimatedReclaimSol: 0 },
    emptyTokenAccounts: [],
    fungibleTokenAccounts: [],
    nftTokenAccounts: [],
    unknownTokenAccounts: [],
  };

  // First pass: shape-only classification. NFT-shape candidates land in
  // `nftCandidates` for the metadata-validation second pass below;
  // everything else is final.
  const nftCandidates: ScannedTokenAccount[] = [];
  for (const { entry, programId } of [...classic, ...token2022]) {
    const info = entry.account.data.parsed?.info;
    const tokenAmount = info?.tokenAmount;

    const lamports = entry.account.lamports;
    const amountRaw: string = tokenAmount?.amount ?? "0";
    const decimals: number = typeof tokenAmount?.decimals === "number" ? tokenAmount.decimals : 0;
    const amountBig = BigInt(amountRaw);

    const isEmpty = amountBig === 0n;
    const reclaimSol = isEmpty ? lamports / LAMPORTS_PER_SOL : 0;

    const account: ScannedTokenAccount = {
      tokenAccount: entry.pubkey.toBase58(),
      mint: info?.mint ?? "",
      owner: info?.owner ?? "",
      amount: amountRaw,
      decimals,
      lamports,
      estimatedReclaimSol: reclaimSol,
      programId,
    };

    result.totals.tokenAccounts += 1;
    result.totals.estimatedReclaimSol += reclaimSol;

    if (isEmpty) {
      result.emptyTokenAccounts.push(account);
    } else if (amountBig === 1n && decimals === 0) {
      // Hold for metadata validation rather than landing directly in
      // nftTokenAccounts.
      nftCandidates.push(account);
    } else if (amountBig > 0n && decimals > 0) {
      result.fungibleTokenAccounts.push(account);
    } else {
      result.unknownTokenAccounts.push(account);
    }

    if (getDebugMints().has(account.mint)) {
      console.log(
        `[debugMint] scanner mint=${account.mint} bucket=${
          isEmpty
            ? "empty"
            : amountBig === 1n && decimals === 0
              ? "nftCandidate"
              : amountBig > 0n && decimals > 0
                ? "fungible"
                : "unknown"
        } amount=${amountRaw} decimals=${decimals} programId=${programId} owner=${account.owner} tokenAccount=${account.tokenAccount}`,
      );
    }
  }

  // Second pass: classify NFT-shape candidates by what DAS reports for
  // their mint. Legacy + pNFT both land in `nftTokenAccounts` (the
  // Legacy and pNFT burn sections each filter that list down by their
  // own tokenStandard check during discovery). Unknown / cNFT / Core /
  // FungibleAsset misshapes are demoted to `unknownTokenAccounts`
  // so they're still cleanable via the close-empty path but never
  // appear in the burn flows.
  let legacyKept = 0;
  let pnftKept = 0;
  let unknownDropped = 0;
  // summaryOnly fast path: skip the DAS classification pass entirely and
  // route every NFT-shape candidate straight into nftTokenAccounts. This
  // matches the existing permissive-fallback behavior (DAS unresolved),
  // so the downstream count is at worst slightly inflated by cNFT /
  // FungibleAsset-misshape mints that would otherwise have been demoted
  // to unknownTokenAccounts. The group scan-all consumer reads
  // `nftTokenAccounts.length` only, so the small accuracy hit is
  // acceptable; the saving is one DAS `getAssetBatch` call (up to
  // 1000 mints per chunk, 3 parallel chunks) per wallet.
  if (summaryOnly && nftCandidates.length > 0) {
    for (const acc of nftCandidates) result.nftTokenAccounts.push(acc);
    console.log(
      `[scanner] nft routing ${JSON.stringify({
        mode: "summaryOnly",
        candidates: nftCandidates.length,
        examined: 0,
        skippedDas: nftCandidates.length,
      })}`,
    );
  } else if (nftCandidates.length > 0) {
    if (signal?.aborted) throw abortedError();
    // Memory/quota guard: a wallet with absurd numbers of 1-supply
    // candidates would force an oversized DAS batch (and a giant
    // dasMap held in memory). Past the cap we route the excess to
    // unknownTokenAccounts so they're still cleanable via close-empty
    // but never reach the burn UI.
    let dasInput = nftCandidates;
    let overflow: ScannedTokenAccount[] = [];
    if (nftCandidates.length > MAX_NFT_CANDIDATES_FOR_DAS) {
      console.warn(
        `[scanner] nft candidate cap hit for ${address}: ${nftCandidates.length} > ${MAX_NFT_CANDIDATES_FOR_DAS} — routing overflow to unknownTokenAccounts`,
      );
      dasInput = nftCandidates.slice(0, MAX_NFT_CANDIDATES_FOR_DAS);
      overflow = nftCandidates.slice(MAX_NFT_CANDIDATES_FOR_DAS);
      for (const acc of overflow) result.unknownTokenAccounts.push(acc);
    }
    const dasMap = await fetchAssetMetadataBatch(
      dasInput.map((c) => c.mint),
      signal,
    );
    if (signal?.aborted) throw abortedError();
    const dasResolved = dasMap.size > 0;
    for (const acc of dasInput) {
      const meta = dasMap.get(acc.mint);
      const cls = classifyNftCandidate(meta);
      const isDebug = getDebugMints().has(acc.mint);
      // Permissive fallback: if DAS didn't resolve at all (no API key,
      // outage), or this specific mint wasn't returned, accept it as
      // an NFT candidate. The per-section discovery (Legacy / pNFT)
      // does its own on-chain Token Metadata read and will skip
      // mismatched mints with a clear reason.
      if (cls === null || !dasResolved) {
        result.nftTokenAccounts.push(acc);
        if (isDebug) {
          console.log(
            `[debugMint] scanner.routing mint=${acc.mint} dasMetaPresent=${!!meta} dasResolved=${dasResolved} classification=${cls ?? "null"} routedTo=nftTokenAccounts(permissiveFallback) iface=${meta?.iface ?? "null"} tokenStandard=${meta?.tokenStandard ?? "null"}`,
          );
        }
        continue;
      }
      if (cls === "legacy") {
        result.nftTokenAccounts.push(acc);
        legacyKept++;
      } else if (cls === "pnft") {
        result.nftTokenAccounts.push(acc);
        pnftKept++;
      } else {
        result.unknownTokenAccounts.push(acc);
        unknownDropped++;
      }
      if (isDebug) {
        console.log(
          `[debugMint] scanner.routing mint=${acc.mint} dasMetaPresent=${!!meta} dasResolved=${dasResolved} classification=${cls} routedTo=${cls === "unknown" ? "unknownTokenAccounts" : "nftTokenAccounts"} iface=${meta?.iface ?? "null"} tokenStandard=${meta?.tokenStandard ?? "null"}`,
        );
      }
    }
    console.log(
      `[scanner] nft routing ${JSON.stringify({
        candidates: nftCandidates.length,
        examined: dasInput.length,
        overflowDropped: overflow.length,
        legacy: legacyKept,
        pnft: pnftKept,
        unknown: unknownDropped,
        dasResolved,
      })}`,
    );
  }

  // Per-bucket bloat telemetry — fires once per scan if any individual
  // bucket exceeds the threshold. Helps spot wallets whose result
  // arrays will dominate the scanCache memory footprint for the TTL
  // window. Threshold + buckets logged as a single object so it's grep-
  // and ingest-friendly.
  const bloat: Record<string, number> = {};
  if (result.emptyTokenAccounts.length > BUCKET_BLOAT_WARN)
    bloat.empty = result.emptyTokenAccounts.length;
  if (result.fungibleTokenAccounts.length > BUCKET_BLOAT_WARN)
    bloat.fungible = result.fungibleTokenAccounts.length;
  if (result.nftTokenAccounts.length > BUCKET_BLOAT_WARN)
    bloat.nft = result.nftTokenAccounts.length;
  if (result.unknownTokenAccounts.length > BUCKET_BLOAT_WARN)
    bloat.unknown = result.unknownTokenAccounts.length;
  if (Object.keys(bloat).length > 0) {
    console.warn(
      `[scanner] bucket bloat ${address}: ${JSON.stringify({ ...bloat, threshold: BUCKET_BLOAT_WARN })} — held in cache for ${SCAN_TTL_MS / 60_000}min`,
    );
  }

  return result;
}

export interface ScanOptions {
  // When true, bypass the in-process TTL cache and fetch fresh on-chain data.
  // The fresh result then OVERWRITES the cache so subsequent normal callers
  // also see the up-to-date data. Used by the cleaner full-clean loop right
  // after a close-account tx so the next iteration sees post-close state
  // without waiting for the 10-minute TTL to expire.
  refresh?: boolean;
  // Cooperative cancellation. Propagated down into the throttled RPC
  // wrapper (which bails between calls + aborts retry sleeps) and into
  // the DAS metadata batch (which aborts in-flight fetches at the
  // network layer). The cache entry is NOT signal-scoped: a second
  // concurrent caller for the same wallet without a signal will still
  // see the in-flight promise as a hit, which is correct — only the
  // aborted caller stops waiting.
  signal?: AbortSignal;
  // Aggressive savings mode for group scan-all. Skips the NFT-shape
  // classification DAS pass — all 1-supply / 0-decimal candidates land
  // directly in `nftTokenAccounts` without metadata lookup. The result
  // is cached under a separate key (`address|summary`) so a follow-up
  // single-wallet scan does NOT inherit the trimmed classification.
  summaryOnly?: boolean;
}

// Cache key folds in the summaryOnly flag so a summary scan and a full
// scan for the same wallet live in independent slots. Without this a
// fast group scan-all would write a trimmed classification to the
// shared cache and a subsequent per-wallet scan would inherit it
// (and miss the legacy/pnft routing).
function cacheKey(address: string, summaryOnly: boolean): string {
  return `${address}|${summaryOnly ? "s" : "f"}`;
}

export async function scanWalletForCleanup(
  address: string,
  opts: ScanOptions = {},
): Promise<CleanupScanResult> {
  if (opts.signal?.aborted) throw abortedError();
  const summaryOnly = opts.summaryOnly === true;
  const key = cacheKey(address, summaryOnly);
  const now = Date.now();
  const cached = scanCache.get(key);
  if (
    !opts.refresh &&
    cached &&
    !cached.rejected &&
    now - cached.ts < SCAN_TTL_MS
  ) {
    return cached.promise;
  }
  const promise = performScan(address, opts.signal, summaryOnly);
  const entry: CacheEntry = { ts: now, promise, rejected: false };
  scanCache.set(key, entry);
  // If the underlying scan rejects, mark the entry as rejected
  // synchronously (so concurrent readers in the same microtask drain
  // fall through to a fresh scan), then drop it from the cache so the
  // next call retries instead of returning the cached failure forever.
  // Aborted runs are also dropped from the cache so the next non-aborted
  // caller can populate a fresh entry.
  promise.catch(() => {
    entry.rejected = true;
    if (scanCache.get(key) === entry) {
      scanCache.delete(key);
    }
  });
  return promise;
}

// Test helper / admin escape hatch — currently unused but exported so a
// future endpoint or test can clear stale cache without restarting. With
// the summaryOnly split each address has up to two cache slots; clear
// both when an address-targeted clear is requested.
export function clearScanCache(address?: string): void {
  if (address) {
    scanCache.delete(cacheKey(address, true));
    scanCache.delete(cacheKey(address, false));
  } else {
    scanCache.clear();
  }
}

// Diagnostic-only — used by the group cleanup-scan-all log path when
// DEBUG_SCAN=true to surface cache pressure. Cheap (returns counters
// already maintained by CappedLruMap), no allocations beyond the
// returned object.
export function getScanCacheStats(): { size: number; max: number; ttlMs: number } {
  return { size: scanCache.size, max: SCAN_CACHE_MAX, ttlMs: SCAN_TTL_MS };
}

// Lets the batch scan endpoint distinguish a "cached" outcome (fast,
// served from this in-process map) from a "ok" outcome (fresh on-chain
// scan) when reporting progress to the UI. Returns true if a non-expired
// entry exists for `address` under the requested mode.
export function isCleanupScanCached(
  address: string,
  summaryOnly: boolean = false,
): boolean {
  const cached = scanCache.get(cacheKey(address, summaryOnly));
  if (!cached) return false;
  return Date.now() - cached.ts < SCAN_TTL_MS;
}
