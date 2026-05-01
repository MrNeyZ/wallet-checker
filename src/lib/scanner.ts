import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { connection } from "./solana.js";
import { getParsedTokenAccountsByOwnerThrottled } from "./rpc.js";
import { CappedLruMap } from "./lruCache.js";

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
      result.nftTokenAccounts.push(account);
    } else if (amountBig > 0n && decimals > 0) {
      result.fungibleTokenAccounts.push(account);
    } else {
      result.unknownTokenAccounts.push(account);
    }
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
