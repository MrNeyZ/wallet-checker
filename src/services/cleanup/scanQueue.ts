// Per-wallet cleanup-scan queue with budget + 429 retry.
//
// Wraps `scanWalletForCleanup` (already cached + dedupe'd at the scanner
// layer) and adds the policy the batch endpoint needs:
//   - Per-wallet wall-clock budget (45s default).
//   - Retry on RPC rate-limit errors with backoffs from the spec.
//   - Per-wallet status tag (ok/cached/timeout/rate-limited/error) so the
//     batch endpoint can report aggregate progress.
//
// Concurrency control between wallets is the caller's job — for the batch
// endpoint this is just a sequential `for` loop. The scanner.ts cache +
// in-flight dedupe handles the case where two HTTP requests for the same
// wallet arrive at once (only one underlying RPC call).
//
// Burn candidates are kept in-house here too so a single per-wallet entry
// covers both the cleanup-scan and burn-candidate result that the
// frontend's CleanerRow consumes.

import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  isCleanupScanCached,
  scanWalletForCleanup,
  type CleanupScanResult,
} from "../../lib/scanner.js";
import { fetchAssetMetadataBatch } from "../helius/das.js";

const PER_WALLET_BUDGET_MS = 45_000;
// Summary scans skip DAS metadata enrichment so they finish much faster on
// average — a 30s budget is plenty and lets the group scan-all cap its
// total wall-clock at (wallets × 30s) instead of (wallets × 45s).
const PER_WALLET_BUDGET_MS_SUMMARY = 30_000;
const RETRY_BACKOFFS_MS = [10_000, 30_000, 60_000];
const RATE_LIMIT_PATTERN = /\b429\b|rate[\s-]?limit|too many requests/i;
const WSOL_MINT = "So11111111111111111111111111111111111111112";
const BURN_WARNING =
  "Burn is destructive and irreversible. Review every line of the preview, then explicitly sign to confirm.";

// Mirrors the inline shape returned by /api/wallet/:address/burn-candidates.
// Kept here so the batch endpoint and the per-wallet endpoint stay in lockstep.
export interface BurnCandidate {
  tokenAccount: string;
  mint: string;
  owner: string;
  amount: string;
  uiAmount: number;
  decimals: number;
  lamports: number;
  programId: string;
  estimatedReclaimSolAfterBurnAndClose: number;
  symbol: string | null;
  name: string | null;
  image: string | null;
  riskLevel: "unknown";
  burnRecommended: boolean;
  reason: string;
}

export interface BurnCandidatesResult {
  wallet: string;
  count: number;
  totalEstimatedReclaimSol: number;
  candidates: BurnCandidate[];
  warning: string;
}

export type ScanWalletStatus =
  | "ok" // fresh scan succeeded
  | "cached" // served from in-process scanner cache (fast)
  | "timeout" // exceeded per-wallet budget
  | "rate-limited" // backend RPC kept returning 429 across retries
  | "error"; // any other failure

export interface ScanWalletResult {
  address: string;
  status: ScanWalletStatus;
  scan?: CleanupScanResult;
  burn?: BurnCandidatesResult;
  error?: string;
  // Wall-clock total including retry waits. Useful for log/telemetry.
  durationMs: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function isRateLimit(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return RATE_LIMIT_PATTERN.test(msg);
}

async function withDeadline<T>(p: Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("Per-wallet budget exhausted");
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(
        () => reject(new Error("Per-wallet budget exceeded")),
        remaining,
      ),
    ),
  ]);
}

async function buildBurnCandidates(
  address: string,
  scan: CleanupScanResult,
  opts: { summary?: boolean } = {},
): Promise<BurnCandidatesResult> {
  const baseCandidates: BurnCandidate[] = scan.fungibleTokenAccounts
    .filter((acc) => acc.mint !== WSOL_MINT)
    .map((acc) => ({
      tokenAccount: acc.tokenAccount,
      mint: acc.mint,
      owner: acc.owner,
      amount: acc.amount,
      uiAmount: Number(acc.amount) / 10 ** acc.decimals,
      decimals: acc.decimals,
      lamports: acc.lamports,
      programId: acc.programId,
      estimatedReclaimSolAfterBurnAndClose: acc.lamports / LAMPORTS_PER_SOL,
      symbol: null,
      name: null,
      image: null,
      riskLevel: "unknown" as const,
      burnRecommended: false,
      reason: "Manual review required before destructive burn.",
    }));

  // Summary mode (group scan-all) skips DAS — the consumer of that path
  // (CleanerRow scan registry) only reads count + total reclaim, so the
  // ~1 RPC-per-wallet DAS round-trip is pure overhead. Per-wallet detailed
  // scan (CleanerRow.handleScan) calls /burn-candidates directly and
  // hydrates names/symbols/images there.
  let candidates = baseCandidates;
  if (!opts.summary) {
    const dasMap = await fetchAssetMetadataBatch(
      baseCandidates.map((c) => c.mint),
    );
    candidates = baseCandidates.map((c) => {
      const m = dasMap.get(c.mint);
      if (!m) return c;
      return {
        ...c,
        name: c.name ?? m.name,
        symbol: c.symbol ?? m.symbol,
        image: c.image ?? m.image,
      };
    });
  }

  return {
    wallet: address,
    count: candidates.length,
    totalEstimatedReclaimSol: candidates.reduce(
      (sum, c) => sum + c.estimatedReclaimSolAfterBurnAndClose,
      0,
    ),
    candidates,
    warning: BURN_WARNING,
  };
}

export interface ScanWalletQueuedOptions {
  // When true, bypass the in-process scanner cache and force a fresh
  // on-chain scan. Burn-candidate enrichment still uses its own DAS
  // cache (separate concern).
  force?: boolean;
  // Override per-wallet wall-clock budget. Defaults to PER_WALLET_BUDGET_MS
  // (or PER_WALLET_BUDGET_MS_SUMMARY when summary mode is on).
  budgetMs?: number;
  // Summary mode: skip DAS metadata enrichment for SPL burn candidates.
  // Used by the group scan-all batch endpoint where the consumer only
  // needs counts + reclaim totals. Per-wallet detailed scans
  // (/api/wallet/:address/burn-candidates) keep DAS on.
  summary?: boolean;
}

export async function scanWalletQueued(
  address: string,
  opts: ScanWalletQueuedOptions = {},
): Promise<ScanWalletResult> {
  const start = Date.now();
  const budgetMs =
    opts.budgetMs ??
    (opts.summary ? PER_WALLET_BUDGET_MS_SUMMARY : PER_WALLET_BUDGET_MS);
  const deadline = start + budgetMs;
  const wasCached = !opts.force && isCleanupScanCached(address);

  let lastErr: string | undefined;
  let attempt = 0;
  while (Date.now() < deadline) {
    try {
      const scan = await withDeadline(
        scanWalletForCleanup(address, { refresh: opts.force }),
        deadline,
      );
      const burn = await withDeadline(
        buildBurnCandidates(address, scan, { summary: opts.summary }),
        deadline,
      );
      return {
        address,
        status: wasCached ? "cached" : "ok",
        scan,
        burn,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
      // Per-wallet budget exhausted — bail with timeout marker. Don't
      // retry; the budget is the contract.
      if (
        /budget exceeded|budget exhausted/i.test(lastErr) ||
        Date.now() >= deadline
      ) {
        return {
          address,
          status: "timeout",
          error: `Per-wallet ${Math.round(budgetMs / 1000)}s budget exceeded`,
          durationMs: Date.now() - start,
        };
      }
      // Rate-limit retry within the remaining budget.
      if (isRateLimit(err)) {
        const wait =
          RETRY_BACKOFFS_MS[Math.min(attempt, RETRY_BACKOFFS_MS.length - 1)];
        const remaining = deadline - Date.now();
        if (wait + 1000 > remaining || attempt >= RETRY_BACKOFFS_MS.length) {
          // Not enough room to retry meaningfully — accept and report.
          return {
            address,
            status: "rate-limited",
            error: "RPC rate limit. Try again later or use cached result.",
            durationMs: Date.now() - start,
          };
        }
        console.warn(
          `[cleanupScan] 429 on ${address} — retry ${attempt + 1}/${RETRY_BACKOFFS_MS.length} in ${Math.round(wait / 1000)}s`,
        );
        attempt++;
        await sleep(wait);
        continue;
      }
      // Non-rate-limit error — bail out.
      return {
        address,
        status: "error",
        error: lastErr,
        durationMs: Date.now() - start,
      };
    }
  }

  return {
    address,
    status: "timeout",
    error: lastErr ?? `Per-wallet ${Math.round(budgetMs / 1000)}s budget exceeded`,
    durationMs: Date.now() - start,
  };
}
