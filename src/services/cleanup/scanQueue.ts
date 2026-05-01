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

function isRateLimit(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return RATE_LIMIT_PATTERN.test(msg);
}

function abortError(): Error {
  return new Error("aborted");
}

async function withDeadline<T>(
  p: Promise<T>,
  deadline: number,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) throw abortError();
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("Per-wallet budget exhausted");
  // Race the work against the per-wallet budget AND the abort signal so a
  // user-cancel resolves immediately instead of waiting for whatever DAS
  // / RPC promise was in flight.
  const racers: Promise<T>[] = [
    p,
    new Promise<T>((_, reject) =>
      setTimeout(
        () => reject(new Error("Per-wallet budget exceeded")),
        remaining,
      ),
    ),
  ];
  if (signal) {
    racers.push(
      new Promise<T>((_, reject) => {
        const onAbort = () => reject(abortError());
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }),
    );
  }
  return Promise.race(racers);
}

async function buildBurnCandidates(
  address: string,
  scan: CleanupScanResult,
  opts: { summary?: boolean; signal?: AbortSignal; logPrefix?: string } = {},
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

  // Summary mode (group scan-all) skips ALL heavy discovery paths — DAS
  // metadata enrichment, Helius getAssetsByOwner (Core), legacy/pNFT/Core
  // burn discovery builders, and SolanaTracker enrichment. The consumer of
  // this path (CleanerRow scan registry) only reads count + total reclaim
  // for the row tile; everything heavier loads lazily when the user
  // expands a specific wallet section. Per-wallet detailed scan
  // (CleanerRow.handleScan) calls /burn-candidates directly and hydrates
  // names / symbols / images there.
  //
  // Explicit guard ensures a future regression that wires heavy work
  // into this code path is impossible without editing this branch. The
  // per-wallet skip log fires only when DEBUG_SCAN=true to keep the
  // happy path quiet; slow runs are still surfaced by the >1000ms
  // timing log at the scanWalletQueued level.
  let candidates = baseCandidates;
  if (opts.summary) {
    if (process.env.DEBUG_SCAN === "true") {
      const prefix = opts.logPrefix ? `${opts.logPrefix} ` : "";
      console.log(
        `${prefix}[cleanupScan] summary mode: skipped heavy discovery for ${address}`,
      );
    }
  } else {
    if (opts.signal?.aborted) throw abortError();
    const dasMap = await fetchAssetMetadataBatch(
      baseCandidates.map((c) => c.mint),
      opts.signal,
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
  // Cooperative cancellation. Aborts any pending DAS / RPC await and
  // breaks out of the retry loop so a client disconnect (group scan-all
  // batched endpoint) frees the queue immediately. The signal is also
  // forwarded to fetchAssetMetadataBatch so in-flight HTTP requests
  // tear down at the network layer.
  signal?: AbortSignal;
  // Optional log prefix for cross-call correlation (e.g. group scan-all
  // emits one scanId for the batch and threads it through every wallet).
  logPrefix?: string;
}

// In-flight dedupe across concurrent identical scan-wallet requests.
// When two callers ask for the same (address, force, summary) tuple at
// once (group scan-all + a manual rescan, etc.) they share one underlying
// promise instead of issuing duplicate RPC + DAS work. Entries are
// removed in `finally` so the map size is naturally bounded by the
// number of in-flight scans.
const inFlightScans = new Map<string, Promise<ScanWalletResult>>();

export async function scanWalletQueued(
  address: string,
  opts: ScanWalletQueuedOptions = {},
): Promise<ScanWalletResult> {
  // A caller that arrives with an already-aborted signal must NOT join
  // an in-flight shared promise — they don't want to wait, and we don't
  // want to mistakenly return their stale aborted result to other
  // callers. Bail with the immediate aborted shape instead.
  if (opts.signal?.aborted) {
    return { address, status: "error", error: "aborted", durationMs: 0 };
  }
  const dedupeKey = `${address}:${opts.force ? "force" : "cached"}:${opts.summary ? "summary" : "full"}`;
  const existing = inFlightScans.get(dedupeKey);
  if (existing) return existing;
  const promise = runScanWalletQueued(address, opts);
  inFlightScans.set(dedupeKey, promise);
  promise.finally(() => {
    if (inFlightScans.get(dedupeKey) === promise) {
      inFlightScans.delete(dedupeKey);
    }
  });
  return promise;
}

async function runScanWalletQueued(
  address: string,
  opts: ScanWalletQueuedOptions,
): Promise<ScanWalletResult> {
  const start = Date.now();
  const budgetMs =
    opts.budgetMs ??
    (opts.summary ? PER_WALLET_BUDGET_MS_SUMMARY : PER_WALLET_BUDGET_MS);
  const deadline = start + budgetMs;
  const wasCached = !opts.force && isCleanupScanCached(address);
  const logPrefix = opts.logPrefix ? `${opts.logPrefix} ` : "";

  const aborted = (): ScanWalletResult => ({
    address,
    status: "error",
    error: "aborted",
    durationMs: Date.now() - start,
  });

  let lastErr: string | undefined;
  let attempt = 0;
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) return aborted();
    try {
      const scan = await withDeadline(
        scanWalletForCleanup(address, { refresh: opts.force }),
        deadline,
        opts.signal,
      );
      if (opts.signal?.aborted) return aborted();
      const burn = await withDeadline(
        buildBurnCandidates(address, scan, {
          summary: opts.summary,
          signal: opts.signal,
          logPrefix: opts.logPrefix,
        }),
        deadline,
        opts.signal,
      );
      const durationMs = Date.now() - start;
      // Slow-path timing log for summary scans only — the heavy detailed
      // scan logs separately via DAS_SLOW_LOG_MS. Sub-second runs stay
      // silent so the happy path doesn't flood production logs.
      if (opts.summary && durationMs > 1000) {
        console.log(
          `${logPrefix}[cleanupScan] ${address} summary took ${durationMs}ms`,
        );
      }
      return {
        address,
        status: wasCached ? "cached" : "ok",
        scan,
        burn,
        durationMs,
      };
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
      if (opts.signal?.aborted || /^aborted$/i.test(lastErr)) {
        return aborted();
      }
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
        const remaining = deadline - Date.now() - wait;
        if (
          remaining <= 0 ||
          wait + 1000 > deadline - Date.now() ||
          attempt >= RETRY_BACKOFFS_MS.length
        ) {
          // Sleep alone would burn more budget than we have left — exit
          // with a timeout marker rather than waiting only to discover
          // the budget is gone.
          return {
            address,
            status: remaining <= 0 ? "timeout" : "rate-limited",
            error:
              remaining <= 0
                ? `Per-wallet ${Math.round(budgetMs / 1000)}s budget exceeded during retry backoff`
                : "RPC rate limit. Try again later or use cached result.",
            durationMs: Date.now() - start,
          };
        }
        console.warn(
          `${logPrefix}[cleanupScan] 429 on ${address} — retry ${attempt + 1}/${RETRY_BACKOFFS_MS.length} in ${Math.round(wait / 1000)}s`,
        );
        attempt++;
        // Race the backoff against the abort signal so cancel doesn't
        // wait for the full sleep.
        await new Promise<void>((resolve) => {
          if (opts.signal?.aborted) return resolve();
          const t = setTimeout(resolve, wait);
          opts.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(t);
              resolve();
            },
            { once: true },
          );
        });
        if (opts.signal?.aborted) return aborted();
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
