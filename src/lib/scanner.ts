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
const SCAN_TTL_MS = 10 * 60 * 1000;
const SCAN_CACHE_MAX = 1000;
type CacheEntry = { ts: number; promise: Promise<CleanupScanResult> };
// Capped LRU keeps memory bounded under a long-running pm2 process
// scanning many unique wallets. TTL is still enforced at the call site.
const scanCache = new CappedLruMap<string, CacheEntry>(SCAN_CACHE_MAX);

async function fetchTokenAccountsForProgram(owner: PublicKey, programId: PublicKey) {
  const res = await getParsedTokenAccountsByOwnerThrottled(connection, owner, programId);
  return res.value.map((entry) => ({ entry, programId: programId.toBase58() }));
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

async function performScan(address: string): Promise<CleanupScanResult> {
  const owner = new PublicKey(address);

  const [classic, token2022] = await Promise.all([
    fetchTokenAccountsForProgram(owner, TOKEN_PROGRAM_ID),
    fetchTokenAccountsForProgram(owner, TOKEN_2022_PROGRAM_ID),
  ]);

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
  if (nftCandidates.length > 0) {
    const dasMap = await fetchAssetMetadataBatch(
      nftCandidates.map((c) => c.mint),
    );
    const dasResolved = dasMap.size > 0;
    for (const acc of nftCandidates) {
      const meta = dasMap.get(acc.mint);
      const cls = classifyNftCandidate(meta);
      // Permissive fallback: if DAS didn't resolve at all (no API key,
      // outage), or this specific mint wasn't returned, accept it as
      // an NFT candidate. The per-section discovery (Legacy / pNFT)
      // does its own on-chain Token Metadata read and will skip
      // mismatched mints with a clear reason.
      if (cls === null || !dasResolved) {
        result.nftTokenAccounts.push(acc);
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
    }
    console.log(
      `[scanner] nft routing ${JSON.stringify({
        candidates: nftCandidates.length,
        legacy: legacyKept,
        pnft: pnftKept,
        unknown: unknownDropped,
        dasResolved,
      })}`,
    );
  }

  return result;
}

export interface ScanOptions {
  // When true, bypass the in-process TTL cache and fetch fresh on-chain data.
  // The fresh result then OVERWRITES the cache so subsequent normal callers
  // also see the up-to-date data. Used by the cleaner full-clean loop right
  // after a close-account tx so the next iteration sees post-close state
  // without waiting for the 30 s TTL to expire.
  refresh?: boolean;
}

export async function scanWalletForCleanup(
  address: string,
  opts: ScanOptions = {},
): Promise<CleanupScanResult> {
  const now = Date.now();
  const cached = scanCache.get(address);
  if (!opts.refresh && cached && now - cached.ts < SCAN_TTL_MS) {
    return cached.promise;
  }
  const promise = performScan(address);
  scanCache.set(address, { ts: now, promise });
  // If the underlying scan rejects, drop the entry so the next call retries
  // instead of returning the cached failure forever.
  promise.catch(() => {
    if (scanCache.get(address)?.promise === promise) {
      scanCache.delete(address);
    }
  });
  return promise;
}

// Test helper / admin escape hatch — currently unused but exported so a
// future endpoint or test can clear stale cache without restarting.
export function clearScanCache(address?: string): void {
  if (address) scanCache.delete(address);
  else scanCache.clear();
}

// Lets the batch scan endpoint distinguish a "cached" outcome (fast,
// served from this in-process map) from a "ok" outcome (fresh on-chain
// scan) when reporting progress to the UI. Returns true if a non-expired
// entry exists for `address`.
export function isCleanupScanCached(address: string): boolean {
  const cached = scanCache.get(address);
  if (!cached) return false;
  return Date.now() - cached.ts < SCAN_TTL_MS;
}
