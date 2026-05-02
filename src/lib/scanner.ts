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

// A token account passing the NFT-shape gate (1 supply, 0 decimals) is
// only treated as a real burnable NFT if Helius DAS surfaces actual
// metadata for its mint. Spam / abandoned / non-Metaplex 1-supply
// tokens (no name, no symbol, no image) are demoted to
// `unknownTokenAccounts` instead of polluting the NFT burn flow.
//
// `uri` alone is intentionally NOT enough — a lot of spam tokens point
// at a 404 or an unreachable IPFS gateway with no actual content. We
// require at least one of the human-display fields to be present.
function isValidNft(meta: AssetMetadata | undefined): boolean {
  if (!meta) return false;
  return Boolean(meta.name || meta.symbol || meta.image);
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

  // Second pass: validate NFT-shape candidates against DAS metadata.
  // Only mints that resolve to a real NFT (has a name, symbol, or
  // image) stay classified as NFTs; the rest are demoted to
  // `unknownTokenAccounts` so the SPL/empty close paths can still see
  // them but the Legacy/pNFT burn flows don't.
  if (nftCandidates.length > 0) {
    const dasMap = await fetchAssetMetadataBatch(
      nftCandidates.map((c) => c.mint),
    );
    // Permissive fallback: when DAS returned NOTHING for any candidate
    // (typically `HELIUS_API_KEY` isn't configured, or the upstream is
    // down), we treat every shape-NFT as a candidate so we don't wipe
    // a user's NFT list silently. The diagnostic log below makes the
    // distinction visible to operators.
    const dasResolved = dasMap.size > 0;
    let demoted = 0;
    for (const acc of nftCandidates) {
      const meta = dasMap.get(acc.mint);
      if (isValidNft(meta) || !dasResolved) {
        result.nftTokenAccounts.push(acc);
      } else {
        result.unknownTokenAccounts.push(acc);
        demoted++;
      }
    }
    console.log(
      `[scanner] NFT filter for ${address}: candidates=${nftCandidates.length} valid=${result.nftTokenAccounts.length} demoted=${demoted} dasResolved=${dasResolved}`,
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
